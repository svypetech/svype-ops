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

router.post("/migrate-state", auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT doc, rev FROM app_state WHERE id=1");
    if (!r.rowCount) return res.json({ ok: true, moved: 0, freedMb: 0 });
    const doc = r.rows[0].doc || {};
    const rev = +r.rows[0].rev || 0;
    const before = Buffer.byteLength(JSON.stringify(doc));
    let moved = 0;

    // employee documents
    for (const emp of doc.employees || []) {
      for (const d of emp.docs || []) {
        for (const key of ["img", "file"]) {
          if (typeof d[key] === "string" && DATA_URL.test(d[key])) {
            const f = await stash(d[key], d.name || key);
            if (f) { d.fileId = f.id; d.mime = f.mime; d[key] = null; moved++; }
          }
        }
      }
    }
    // reimbursement receipts and payment proofs
    for (const p of doc.payables || []) {
      if (typeof p.receipt === "string" && DATA_URL.test(p.receipt)) {
        const f = await stash(p.receipt, p.receiptName || "receipt");
        if (f) { p.receiptFileId = f.id; p.receiptMime = f.mime; p.receipt = null; moved++; }
      }
    }
    for (const p of doc.payroll || []) {
      if (typeof p.proof === "string" && DATA_URL.test(p.proof)) {
        const f = await stash(p.proof, "payment-proof");
        if (f) { p.proofFileId = f.id; p.proofMime = f.mime; p.proof = null; moved++; }
      }
    }
    for (const b of doc.vendorBills || []) {
      if (typeof b.bill === "string" && DATA_URL.test(b.bill)) {
        const f = await stash(b.bill, b.billName || "bill");
        if (f) { b.billFileId = f.id; b.billMime = f.mime; b.bill = null; moved++; }
      }
    }

    const after = Buffer.byteLength(JSON.stringify(doc));
    if (moved) {
      await pool.query("UPDATE app_state SET doc=$1::jsonb, rev=rev+1, updated_at=now() WHERE id=1 AND rev=$2", [JSON.stringify(doc), rev]);
    }
    res.json({ ok: true, moved, beforeMb: +(before / 1048576).toFixed(2), afterMb: +(after / 1048576).toFixed(2) });
  } catch (e) {
    res.status(500).json({ error: "Cleanup failed: " + (e.message || "") });
  }
});

// Size report so the problem is visible before and after.
router.get("/_/state-size", auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT pg_column_size(doc) AS bytes FROM app_state WHERE id=1");
    const bytes = r.rowCount ? +r.rows[0].bytes : 0;
    const f = await pool.query("SELECT count(*)::int AS n, COALESCE(sum(size),0)::bigint AS total FROM files");
    res.json({ docMb: +(bytes / 1048576).toFixed(2), files: f.rows[0].n, filesMb: +(f.rows[0].total / 1048576).toFixed(2) });
  } catch (e) {
    res.status(500).json({ error: e.message || "Could not measure." });
  }
});

module.exports = router;
