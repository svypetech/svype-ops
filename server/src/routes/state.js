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
router.get("/", auth, async (req, res) => {
  const r = await pool.query("SELECT doc, brand, rev FROM app_state WHERE id=1");
  if (!r.rowCount) return res.json({ doc: null, brand: null, rev: 0 });
  res.json({ doc: r.rows[0].doc, brand: r.rows[0].brand, rev: +r.rows[0].rev });
});

router.put("/", auth, async (req, res) => {
  const { doc, brand, baseRev } = req.body;
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
