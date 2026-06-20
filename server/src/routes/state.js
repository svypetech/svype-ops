const express = require("express");
const { pool } = require("../db");
const { auth, staffOnly } = require("../middleware/auth");
const router = express.Router();

// One shared application-state document (the whole `data` blob from the app),
// plus brand. Stored as JSONB so the entire existing UI works unchanged.
router.get("/", auth, async (req, res) => {
  const r = await pool.query("SELECT doc, brand FROM app_state WHERE id=1");
  if (!r.rowCount) return res.json({ doc: null, brand: null });
  res.json({ doc: r.rows[0].doc, brand: r.rows[0].brand });
});

router.put("/", auth, async (req, res) => {
  const { doc, brand } = req.body;
  await pool.query(
    `INSERT INTO app_state (id, doc, brand) VALUES (1,$1,$2)
     ON CONFLICT (id) DO UPDATE SET doc=COALESCE($1, app_state.doc), brand=COALESCE($2, app_state.brand), updated_at=now()`,
    [doc ? JSON.stringify(doc) : null, brand ? JSON.stringify(brand) : null]
  );
  res.json({ ok: true });
});

module.exports = router;
