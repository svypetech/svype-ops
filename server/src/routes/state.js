const express = require("express");
const { pool } = require("../db");
const { auth, staffOnly } = require("../middleware/auth");
const router = express.Router();

// One shared application-state document (the whole `data` blob from the app),
// plus brand. Stored as JSONB so the entire existing UI works unchanged.
// A revision counter (rev) prevents stale tabs from overwriting newer data:
// every PUT must state the rev it based its changes on; if the server has moved
// on, the write is rejected (409) and the client re-applies its change on the
// latest doc and retries.
// NOTE: keep SERVER_BUILD in sync with APP_BUILD in client/src/App.jsx on every release.
const SERVER_BUILD = "Build 29 Jul 2026 · chat-unread-v1";
router.get("/", auth, async (req, res) => {
  const known = req.query.knownRev != null ? +req.query.knownRev : null;
  if (known != null) {
    // Cheap poll: if nothing changed, don't ship the (heavy) document at all.
    const rv = await pool.query("SELECT rev FROM app_state WHERE id=1");
    const rev = rv.rowCount ? +rv.rows[0].rev : 0;
    if (rev === known) return res.json({ unchanged: true, rev, build: SERVER_BUILD });
  }
  const r = await pool.query("SELECT doc, brand, rev FROM app_state WHERE id=1");
  if (!r.rowCount) return res.json({ doc: null, brand: null, rev: 0, build: SERVER_BUILD });
  res.json({ doc: r.rows[0].doc, brand: r.rows[0].brand, rev: +r.rows[0].rev, build: SERVER_BUILD });
});

router.put("/", auth, async (req, res) => {
  const { doc, brand, baseRev, patchDoc } = req.body;
  // Fast path: only the changed top-level keys are sent; Postgres merges them into the
  // stored document atomically, still guarded by the revision compare-and-swap.
  if (patchDoc !== undefined && baseRev !== undefined && baseRev !== null) {
    const upd = await pool.query(
      `UPDATE app_state SET doc = COALESCE(doc,'{}'::jsonb) || $1::jsonb, brand=COALESCE($2, brand), rev=rev+1, updated_at=now()
       WHERE id=1 AND rev=$3 RETURNING rev`,
      [JSON.stringify(patchDoc), brand ? JSON.stringify(brand) : null, +baseRev]
    );
    if (upd.rowCount) return res.json({ ok: true, rev: +upd.rows[0].rev });
    const cur = await pool.query("SELECT doc, rev FROM app_state WHERE id=1");
    if (!cur.rowCount) {
      const ins = await pool.query(`INSERT INTO app_state (id, doc, brand, rev) VALUES (1,$1,$2,1) RETURNING rev`,
        [JSON.stringify(patchDoc), brand ? JSON.stringify(brand) : null]);
      return res.json({ ok: true, rev: +ins.rows[0].rev });
    }
    return res.status(409).json({ error: "stale", doc: cur.rows[0].doc, rev: +cur.rows[0].rev });
  }
  // Atomic compare-and-swap when the client states its base revision (new clients do):
  // the UPDATE only applies if the server's rev still equals baseRev.
  if (doc !== undefined && baseRev !== undefined && baseRev !== null) {
    const upd = await pool.query(
      `UPDATE app_state SET doc=$1, brand=COALESCE($2, brand), rev=rev+1, updated_at=now()
       WHERE id=1 AND rev=$3 RETURNING rev`,
      [JSON.stringify(doc), brand ? JSON.stringify(brand) : null, +baseRev]
    );
    if (upd.rowCount) return res.json({ ok: true, rev: +upd.rows[0].rev });
    // Row missing (fresh install) or rev mismatch (stale tab)
    const cur = await pool.query("SELECT doc, rev FROM app_state WHERE id=1");
    if (!cur.rowCount) {
      const ins = await pool.query(
        `INSERT INTO app_state (id, doc, brand, rev) VALUES (1,$1,$2,1) RETURNING rev`,
        [JSON.stringify(doc), brand ? JSON.stringify(brand) : null]
      );
      return res.json({ ok: true, rev: +ins.rows[0].rev });
    }
    return res.status(409).json({ error: "stale", doc: cur.rows[0].doc, rev: +cur.rows[0].rev });
  }
  // Legacy / brand-only path (no conflict check)
  const r = await pool.query(
    `INSERT INTO app_state (id, doc, brand, rev) VALUES (1,$1,$2,1)
     ON CONFLICT (id) DO UPDATE SET
       doc=COALESCE($1, app_state.doc),
       brand=COALESCE($2, app_state.brand),
       rev=app_state.rev + 1,
       updated_at=now()
     RETURNING rev`,
    [doc ? JSON.stringify(doc) : null, brand ? JSON.stringify(brand) : null]
  );
  res.json({ ok: true, rev: +r.rows[0].rev });
});

module.exports = router;
