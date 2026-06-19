const express = require("express");
const { pool } = require("../db");
const { auth } = require("../middleware/auth");
const { rowOut } = require("./crud");
const router = express.Router();

// List channels the user can see: all 'channel' kind + DMs they're a member of
router.get("/channels", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM channels ORDER BY kind, lower(name)");
  const uid = req.user.id;
  const visible = r.rows.filter((c) => c.kind === "channel" || (c.members || []).includes(uid));
  res.json(visible.map(rowOut));
});

// Create a channel (open to all)
router.post("/channels", auth, async (req, res) => {
  const name = (req.body.name || "").trim().replace(/^#/, "");
  if (!name) return res.status(400).json({ error: "Channel name required" });
  const exists = await pool.query("SELECT 1 FROM channels WHERE kind='channel' AND lower(name)=lower($1)", [name]);
  if (exists.rowCount) return res.status(400).json({ error: "Channel already exists" });
  const r = await pool.query(
    "INSERT INTO channels (name, kind, members, created_by) VALUES ($1,'channel','[]',$2) RETURNING *",
    [name, req.user.id]
  );
  res.json(rowOut(r.rows[0]));
});

// Start or fetch a DM with another user
router.post("/dm", auth, async (req, res) => {
  const other = +req.body.userId;
  if (!other || other === req.user.id) return res.status(400).json({ error: "Invalid user" });
  const pair = [req.user.id, other].sort((a, b) => a - b);
  const all = await pool.query("SELECT * FROM channels WHERE kind='dm'");
  let dm = all.rows.find((c) => {
    const m = [...(c.members || [])].sort((a, b) => a - b);
    return m.length === 2 && m[0] === pair[0] && m[1] === pair[1];
  });
  if (!dm) {
    const ou = await pool.query("SELECT username FROM users WHERE id=$1", [other]);
    const name = ou.rows[0]?.username || "dm";
    dm = (await pool.query(
      "INSERT INTO channels (name, kind, members, created_by) VALUES ($1,'dm',$2,$3) RETURNING *",
      [name, JSON.stringify(pair), req.user.id]
    )).rows[0];
  }
  res.json(rowOut(dm));
});

// Messages in a channel
router.get("/channels/:id/messages", auth, async (req, res) => {
  const r = await pool.query(
    "SELECT * FROM messages WHERE channel_id=$1 ORDER BY created_at ASC LIMIT 200",
    [req.params.id]
  );
  res.json(r.rows.map(rowOut));
});

// Post a message (REST fallback; realtime broadcast handled in server.js)
router.post("/channels/:id/messages", auth, async (req, res) => {
  const body = (req.body.body || "").trim();
  if (!body) return res.status(400).json({ error: "Empty message" });
  const r = await pool.query(
    "INSERT INTO messages (channel_id, user_id, username, body) VALUES ($1,$2,$3,$4) RETURNING *",
    [req.params.id, req.user.id, req.user.username, body]
  );
  const msg = rowOut(r.rows[0]);
  if (req.app.get("broadcast")) req.app.get("broadcast")(+req.params.id, msg);
  res.json(msg);
});

// Directory of people to message
router.get("/directory", auth, async (req, res) => {
  const r = await pool.query("SELECT id, username, role, emp_id FROM users WHERE active=TRUE ORDER BY username");
  res.json(r.rows.map(rowOut).filter((u) => u.id !== req.user.id));
});

module.exports = router;
