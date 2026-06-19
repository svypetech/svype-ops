const express = require("express");
const { pool } = require("../db");
const { auth } = require("../middleware/auth");

// camelCase <-> snake_case
const toSnake = (s) => s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const rowOut = (row) => {
  if (!row) return row;
  const o = {};
  for (const k in row) o[toCamel(k)] = row[k];
  return o;
};

/**
 * Build a CRUD router for a table.
 * cols: array of allowed JS field names (camelCase). JSON fields listed in jsonCols are stringified.
 */
function crud(table, cols, opts = {}) {
  const router = express.Router();
  const jsonCols = new Set(opts.jsonCols || []);
  const order = opts.order || "id DESC";

  router.get("/", auth, async (req, res) => {
    const r = await pool.query(`SELECT * FROM ${table} ORDER BY ${order}`);
    res.json(r.rows.map(rowOut));
  });

  router.post("/", auth, async (req, res) => {
    const keys = cols.filter((c) => req.body[c] !== undefined);
    const sqlCols = keys.map(toSnake);
    const vals = keys.map((k) => (jsonCols.has(k) ? JSON.stringify(req.body[k]) : req.body[k]));
    const ph = keys.map((_, i) => "$" + (i + 1));
    const r = await pool.query(
      `INSERT INTO ${table} (${sqlCols.join(",")}) VALUES (${ph.join(",")}) RETURNING *`,
      vals
    );
    res.json(rowOut(r.rows[0]));
  });

  router.put("/:id", auth, async (req, res) => {
    const keys = cols.filter((c) => req.body[c] !== undefined);
    if (!keys.length) {
      const cur = await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]);
      return res.json(rowOut(cur.rows[0]));
    }
    const sets = keys.map((k, i) => `${toSnake(k)}=$${i + 2}`);
    const vals = keys.map((k) => (jsonCols.has(k) ? JSON.stringify(req.body[k]) : req.body[k]));
    const r = await pool.query(
      `UPDATE ${table} SET ${sets.join(",")} WHERE id=$1 RETURNING *`,
      [req.params.id, ...vals]
    );
    res.json(rowOut(r.rows[0]));
  });

  router.delete("/:id", auth, async (req, res) => {
    await pool.query(`DELETE FROM ${table} WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { crud, rowOut, toSnake, toCamel };
