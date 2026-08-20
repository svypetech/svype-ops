// ===== Announcement email blast =====
// When HR posts an announcement in the portal it can also go out by email to every
// registered address — minus anyone HR chose to exclude. Recipients go in BCC so
// nobody sees the rest of the list (or who was left off it).
const express = require("express");
const { pool } = require("../db");
const { auth, staffOnly } = require("../middleware/auth");
const { emailHTML, emailText, PORTAL_URL } = require("../lib/emailTemplate");

const router = express.Router();
const cleanPass = (p) => String(p || "").replace(/\s+/g, "");
function fromHeader(cfg, brand) {
  if (cfg.from && cfg.from.includes("@")) return cfg.from;
  return `${(brand && brand.company) || "Svype OS"} <${cfg.user}>`;
}
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Who actually gets the email. Exported so it can be unit-tested.
// exclude: array of employee names (matches how everything else in the doc keys people).
function pickRecipients(doc, exclude) {
  const ex = new Set((exclude || []).map((n) => String(n).trim().toLowerCase()));
  const active = (doc.employees || []).filter((e) => e.status === "Active");
  const excluded = [], noEmail = [], to = [];
  for (const e of active) {
    if (ex.has(String(e.name || "").trim().toLowerCase())) { excluded.push(e.name); continue; }
    const addr = String(e.email || "").trim();
    if (!addr || !addr.includes("@")) { noEmail.push(e.name); continue; }
    to.push({ name: e.name, email: addr });
  }
  // Same person listed twice (or two people sharing an inbox) — send once per address.
  const seen = new Set();
  const unique = to.filter((r) => { const k = r.email.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  return { to: unique, excluded, noEmail };
}

router.post("/send", auth, staffOnly, async (req, res) => {
  const { title, body, exclude } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: "The announcement needs a title." });

  let doc = {};
  try { const r = await pool.query("SELECT doc FROM app_state WHERE id=1"); doc = r.rows[0]?.doc || {}; }
  catch { return res.status(500).json({ error: "Could not read the workspace data." }); }

  const cfg = doc.emailConfig || null;
  if (!cfg || !cfg.user || !cfg.pass)
    return res.status(412).json({ error: "Email sending isn't set up yet. Open Settings → Email and add the sending mailbox — the announcement is still posted in the portal." });

  const brand = doc.brand || {};
  const { to, excluded, noEmail } = pickRecipients(doc, exclude);
  if (to.length === 0)
    return res.json({ ok: true, sent: 0, excluded: excluded.length, noEmail, note: "No one left to email after exclusions." });

  let nodemailer;
  try { nodemailer = require("nodemailer"); }
  catch { return res.status(501).json({ error: "The mail library isn't installed on the server yet. Redeploy and try again." }); }

  try {
    const port = +cfg.port || 465;
    const tx = nodemailer.createTransport({
      host: cfg.host || "smtp.gmail.com", port, secure: port === 465,
      auth: { user: cfg.user, pass: cleanPass(cfg.pass) },
    });
    const company = brand.company || "Svype OS";
    const opts = {
      brand, badge: "Announcement", tone: "info",
      heading: String(title).trim(),
      intro: String(body || "").trim(),
      cta: { label: "Open the portal", url: PORTAL_URL },
      note: "This announcement is also on your portal dashboard.",
    };
    await tx.sendMail({
      from: fromHeader(cfg, brand),
      to: fromHeader(cfg, brand),                       // the visible To: is the sender itself
      bcc: to.map((r) => r.email),                      // real recipients stay private
      subject: `\u{1F4E2} ${String(title).trim()} — ${company}`,
      text: emailText(opts),
      html: emailHTML(opts),
    });
    try { await pool.query("INSERT INTO audit (who, action) VALUES ($1,$2)", [req.user?.username || "system", `Emailed announcement "${String(title).trim()}" to ${to.length} recipient(s)${excluded.length ? `, excluded ${excluded.join(", ")}` : ""}`]); } catch {}
    res.json({ ok: true, sent: to.length, excluded: excluded.length, noEmail });
  } catch (e) {
    const m = String((e && e.message) || "");
    if (/invalid login|username and password not accepted|535/i.test(m))
      return res.status(400).json({ error: "The mailbox rejected the login. For Gmail use a 16-character App Password, not the normal password." });
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(m))
      return res.status(400).json({ error: "Couldn't reach the mail server. Check the SMTP host and port in Settings → Email." });
    res.status(500).json({ error: "The email couldn't be sent. " + m });
  }
});

module.exports = router;
module.exports.pickRecipients = pickRecipients;
