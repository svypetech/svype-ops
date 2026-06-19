const jwt = require("jsonwebtoken");
const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

function sign(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, empId: user.emp_id, perms: user.perms || {} },
    SECRET,
    { expiresIn: "30d" }
  );
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
}

// founder only
function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Founder access only" });
  next();
}

// admin or hr (staff, not employee portal)
function staffOnly(req, res, next) {
  if (!["admin", "hr"].includes(req.user?.role)) return res.status(403).json({ error: "Not allowed" });
  next();
}

// permission gate for a given section id
function canAccess(section) {
  return (req, res, next) => {
    const u = req.user;
    if (u.role === "admin") return next();
    const perms = u.perms || {};
    if (perms[section] === false) return res.status(403).json({ error: "No access to " + section });
    next();
  };
}

module.exports = { sign, auth, adminOnly, staffOnly, canAccess, SECRET };
