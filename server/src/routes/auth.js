const express = require("express");
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const { sign, auth, adminOnly, staffOnly } = require("../middleware/auth");
const router = express.Router();

const pub = (u) => ({ id: u.id, username: u.username, role: u.role, empId: u.emp_id, active: u.active, perms: u.perms || {} });

async function logAudit(who, action) {
  try { await pool.query("INSERT INTO audit (who, action) VALUES ($1,$2)", [who, action]); } catch {}
}

// Is first-run? (no admin/hr accounts yet)
router.get("/state", async (req, res) => {
  try {
    const a = await pool.query("SELECT doc FROM app_state WHERE id=1");
    const doc = a.rows[0]?.doc;
    const users = (doc && doc.users) || [];
    const docFounders = Array.isArray(users) && users.some(u => u && (u.role === "admin" || u.role === "hr"));
    if (docFounders) return res.json({ hasFounders: true });
    const r = await pool.query("SELECT COUNT(*) FILTER (WHERE role IN ('admin','hr')) AS founders FROM users");
    res.json({ hasFounders: +r.rows[0].founders > 0 });
  } catch (e) {
    res.json({ hasFounders: true });
  }
});

// First-run: create founding admin/hr account
router.post("/setup", async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !["admin", "hr"].includes(role))
    return res.status(400).json({ error: "Invalid setup data" });
  const exists = await pool.query("SELECT 1 FROM users WHERE lower(username)=lower($1)", [username]);
  if (exists.rowCount) return res.status(400).json({ error: "Username taken" });
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    "INSERT INTO users (username, password, role, active) VALUES (lower($1),$2,$3,TRUE) RETURNING *",
    [username, hash, role]
  );
  await logAudit(username, `Created first ${role} account`);
  res.json({ token: sign(r.rows[0]), user: pub(r.rows[0]) });
});

// Login
router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const r = await pool.query("SELECT * FROM users WHERE lower(username)=lower($1)", [username || ""]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password || "", u.password)))
    return res.status(401).json({ error: "Incorrect username or password" });
  if (!u.active) return res.status(403).json({ error: "Account deactivated. Contact HR." });
  res.json({ token: sign(u), user: pub(u) });
});

// Current user
router.get("/me", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM users WHERE id=$1", [req.user.id]);
  if (!r.rowCount) return res.status(401).json({ error: "Gone" });
  res.json(pub(r.rows[0]));
});

// ===== User management (staff only) =====
router.get("/users", auth, staffOnly, async (req, res) => {
  const r = await pool.query("SELECT * FROM users ORDER BY id");
  res.json(r.rows.map(pub));
});

router.post("/users", auth, staffOnly, async (req, res) => {
  const { username, password, role, empId } = req.body;
  if (!username || !password || !["admin", "hr", "employee"].includes(role))
    return res.status(400).json({ error: "Invalid user data" });
  const exists = await pool.query("SELECT 1 FROM users WHERE lower(username)=lower($1)", [username]);
  if (exists.rowCount) return res.status(400).json({ error: "Username taken" });
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    "INSERT INTO users (username, password, role, emp_id, active) VALUES (lower($1),$2,$3,$4,TRUE) RETURNING *",
    [username, hash, role, role === "employee" ? empId || null : null]
  );
  await logAudit(req.user.username, `Created login "${username}" (${role})`);
  res.json(pub(r.rows[0]));
});

router.put("/users/:id", auth, staffOnly, async (req, res) => {
  const { role, empId, active } = req.body;
  const r = await pool.query(
    "UPDATE users SET role=COALESCE($2,role), emp_id=$3, active=COALESCE($4,active) WHERE id=$1 RETURNING *",
    [req.params.id, role, role === "employee" ? empId || null : null, active]
  );
  await logAudit(req.user.username, `Updated login ${r.rows[0]?.username}`);
  res.json(pub(r.rows[0]));
});

router.post("/users/:id/password", auth, staffOnly, async (req, res) => {
  const hash = await bcrypt.hash(req.body.password, 10);
  const r = await pool.query("UPDATE users SET password=$2 WHERE id=$1 RETURNING username", [req.params.id, hash]);
  await logAudit(req.user.username, `Reset password for ${r.rows[0]?.username}`);
  res.json({ ok: true });
});

router.post("/users/:id/active", auth, staffOnly, async (req, res) => {
  const r = await pool.query("UPDATE users SET active=$2 WHERE id=$1 RETURNING *", [req.params.id, !!req.body.active]);
  await logAudit(req.user.username, `${req.body.active ? "Enabled" : "Disabled"} ${r.rows[0]?.username}`);
  res.json(pub(r.rows[0]));
});

router.delete("/users/:id", auth, staffOnly, async (req, res) => {
  const r = await pool.query("SELECT username FROM users WHERE id=$1", [req.params.id]);
  await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
  await logAudit(req.user.username, `Deleted login ${r.rows[0]?.username}`);
  res.json({ ok: true });
});

// ===== Permissions (founder only) =====
router.put("/users/:id/perms", auth, adminOnly, async (req, res) => {
  const r = await pool.query("UPDATE users SET perms=$2 WHERE id=$1 RETURNING *", [
    req.params.id,
    JSON.stringify(req.body.perms || {}),
  ]);
  await logAudit(req.user.username, `Updated permissions for ${r.rows[0]?.username}`);
  res.json(pub(r.rows[0]));
});


// Lightweight identity for chat/websocket: the app manages its own logins,
// this just issues a token tying a username+role to socket/chat calls.
router.post("/identify", async (req, res) => {
  const { username, role } = req.body || {};
  if (!username) return res.status(400).json({ error: "username required" });
  // upsert a shadow user row so chat has a stable id + directory
  const existing = await pool.query("SELECT * FROM users WHERE lower(username)=lower($1)", [username]);
  let u = existing.rows[0];
  if (!u) {
    const r = await pool.query(
      "INSERT INTO users (username, password, role, active) VALUES (lower($1),'-',$2,TRUE) RETURNING *",
      [username, ["admin","hr","employee"].includes(role) ? role : "employee"]
    );
    u = r.rows[0];
  }
  res.json({ token: sign(u), user: pub(u) });
});

module.exports = router;
