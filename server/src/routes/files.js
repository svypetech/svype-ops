const express = require("express");
const { pool } = require("../db");
const { auth } = require("../middleware/auth");
const router = express.Router();

// Uploaded files used to live inside the single app_state JSON document. That meant
// saving one employee re-sent EVERY document in the company (tens of megabytes), which
// exhausted the server's memory and killed the process — the 502s and "not saved"
// errors. Files now live in their own table and the document only keeps a small id.

const newId = () => "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Store a file. Body: { name, mime, data } where data is base64 (no data: prefix).
router.post("/", auth, async (req, res) => {
  try {
    const { name, mime, data } = req.body || {};
    if (!data) return res.status(400).json({ error: "No file data received." });
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length) return res.status(400).json({ error: "The file appears to be empty." });
    if (bytes.length > 20 * 1024 * 1024) return res.status(413).json({ error: "That file is larger than 20 MB. Please compress it first." });
    const id = newId();
    await pool.query(
      "INSERT INTO files (id, name, mime, size, bytes) VALUES ($1,$2,$3,$4,$5)",
      [id, String(name || "file").slice(0, 200), String(mime || "application/octet-stream").slice(0, 100), bytes.length, bytes]
    );
    res.json({ ok: true, id, size: bytes.length });
  } catch (e) {
    res.status(500).json({ error: "Could not store the file. " + (e.message || "") });
  }
});

// Fetch a stored file.
router.get("/:id", auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT name, mime, bytes FROM files WHERE id=$1", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "File not found." });
    const row = r.rows[0];
    res.setHeader("Content-Type", row.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${String(row.name || "file").replace(/[^\w.\- ]+/g, "_")}"`);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(row.bytes);
  } catch {
    res.status(500).json({ error: "Could not read the file." });
  }
});

router.delete("/:id", auth, async (req, res) => {
  try { await pool.query("DELETE FROM files WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch { res.status(500).json({ error: "Could not delete the file." }); }
});

// ---- one-time cleanup ----
// Walks the saved document, moves any embedded file data into the files table and
// replaces it with a reference. Runs entirely on the server, so nothing large has to
// travel over the network — important, because the oversized payload is the very
// thing that was crashing the app.
const DATA_URL = /^data:([^;,]+)?(;base64)?,/i;
async function stash(dataUrl, name) {
  const m = DATA_URL.exec(dataUrl || "");
  if (!m) return null;
  const bytes = Buffer.from(String(dataUrl).slice(String(dataUrl).indexOf(",") + 1), "base64");
  if (!bytes.length) return null;
  const id = newId();
  await pool.query("INSERT INTO files (id, name, mime, size, bytes) VALUES ($1,$2,$3,$4,$5)",
    [id, String(name || "file").slice(0, 200), m[1] || "application/octet-stream", bytes.length, bytes]);
  return { id, size: bytes.length, mime: m[1] || "application/octet-stream" };
}

// Move embedded files out, ONE RECORD AT A TIME. Loading the whole document into
// memory is exactly what was killing the process, so every step below reads and writes
// a single element via jsonb paths and never materialises the full document.
const docSizeMb = async () => {
  const r = await pool.query("SELECT octet_length(doc::text) AS b FROM app_state WHERE id=1");
  return r.rowCount ? +(+r.rows[0].b / 1048576).toFixed(2) : 0;
};
const arrLen = async (key) => {
  const r = await pool.query(`SELECT jsonb_array_length(COALESCE(doc->'${key}','[]'::jsonb)) AS n FROM app_state WHERE id=1`);
  return r.rowCount ? +r.rows[0].n || 0 : 0;
};

async function tidyFiles() {
  const beforeMb = await docSizeMb();
  let moved = 0;

  // employee documents (the big one: several files per person)
  const empCount = await arrLen("employees");
  for (let i = 0; i < empCount; i++) {
    const r = await pool.query("SELECT doc->'employees'->($1::int)->'docs' AS docs FROM app_state WHERE id=1", [i]);
    const docs = r.rows[0] && r.rows[0].docs;
    if (!Array.isArray(docs) || !docs.length) continue;
    let changed = false;
    for (const d of docs) {
      for (const key of ["img", "file"]) {
        if (typeof d[key] === "string" && DATA_URL.test(d[key])) {
          const f = await stash(d[key], d.name || key);
          if (f) { d.fileId = f.id; d.mime = f.mime; d[key] = null; changed = true; moved++; }
        }
      }
    }
    if (changed) {
      await pool.query(
        "UPDATE app_state SET doc = jsonb_set(doc, ARRAY['employees',$1::text,'docs'], $2::jsonb), rev = rev+1, updated_at = now() WHERE id=1",
        [String(i), JSON.stringify(docs)]
      );
    }
  }

  // single-attachment records
  for (const [arr, field] of [["payables", "receipt"], ["payroll", "proof"], ["vendorBills", "bill"]]) {
    const n = await arrLen(arr);
    for (let i = 0; i < n; i++) {
      const r = await pool.query(`SELECT doc->'${arr}'->($1::int)->>'${field}' AS v FROM app_state WHERE id=1`, [i]);
      const v = r.rows[0] && r.rows[0].v;
      if (typeof v === "string" && DATA_URL.test(v)) {
        const f = await stash(v, field);
        if (!f) continue;
        await pool.query(
          `UPDATE app_state SET doc = jsonb_set(jsonb_set(jsonb_set(doc,
              ARRAY['${arr}',$1::text,'${field}'], 'null'::jsonb),
              ARRAY['${arr}',$1::text,'${field}FileId'], to_jsonb($2::text)),
              ARRAY['${arr}',$1::text,'${field}Mime'], to_jsonb($3::text)),
            rev = rev+1, updated_at = now() WHERE id=1`,
          [String(i), f.id, f.mime]
        );
        moved++;
      }
    }
  }

  const afterMb = await docSizeMb();
  return { moved, beforeMb, afterMb };
}

router.post("/migrate-state", auth, async (req, res) => {
  try { res.json({ ok: true, ...(await tidyFiles()) }); }
  catch (e) { res.status(500).json({ error: "Cleanup failed: " + (e.message || "") }); }
});

// Runs once on start-up. A deploy alone is enough to heal an oversized record —
// nobody has to find a button for the portal to become usable again.
async function autoTidyOnBoot() {
  try {
    const mb = await docSizeMb();
    if (mb < 2) return;
    console.log(`[files] data record is ${mb} MB — moving embedded uploads into file storage…`);
    const r = await tidyFiles();
    console.log(`[files] moved ${r.moved} file(s); ${r.beforeMb} MB -> ${r.afterMb} MB`);
  } catch (e) {
    console.error("[files] automatic cleanup failed:", e.message);
  }
}

// Size report so the problem is visible before and after.
router.get("/_/state-size", auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT octet_length(doc::text) AS bytes FROM app_state WHERE id=1");
    const bytes = r.rowCount ? +r.rows[0].bytes : 0;
    const f = await pool.query("SELECT count(*)::int AS n, COALESCE(sum(size),0)::bigint AS total FROM files");
    res.json({ docMb: +(bytes / 1048576).toFixed(2), files: f.rows[0].n, filesMb: +(f.rows[0].total / 1048576).toFixed(2) });
  } catch (e) {
    res.status(500).json({ error: e.message || "Could not measure." });
  }
});

module.exports = router;
module.exports.autoTidyOnBoot = autoTidyOnBoot;
