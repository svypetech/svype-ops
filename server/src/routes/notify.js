// ===== "You have received a request" — HR inbox notifications =====
// Every request an employee sends through the portal (leave, work-from-home,
// check-in/check-out time corrections, expense claims and appeals, document
// requests) also lands in HR's email inbox the moment it's submitted, so nothing
// waits unseen until someone happens to open the portal.
const express = require("express");
const { pool } = require("../db");
const { auth } = require("../middleware/auth");
const { emailHTML, emailText, PORTAL_URL } = require("../lib/emailTemplate");

const router = express.Router();
const DEFAULT_HR_EMAIL = "info@svype.net";
const cleanPass = (p) => String(p || "").replace(/\s+/g, "");

// What each request kind looks like in the email. Whitelist — anything else is refused.
const KINDS = {
  leave:        { badge: "Leave request",        title: (e) => `${e} has requested leave` },
  wfh:          { badge: "Work-from-home",       title: (e) => `${e} has requested to work from home` },
  "time-in":    { badge: "Check-in correction",  title: (e) => `${e} sent a check-in time correction` },
  "time-out":   { badge: "Check-out correction", title: (e) => `${e} sent a check-out time correction` },
  "time-both":  { badge: "Time correction",      title: (e) => `${e} sent a check-in & check-out correction` },
  expense:      { badge: "Expense claim",        title: (e) => `${e} submitted an expense claim` },
  appeal:       { badge: "Claim appeal",         title: (e) => `${e} appealed a rejected claim` },
  document:     { badge: "Document request",     title: (e) => `${e} requested a document` },
  other:        { badge: "New request",          title: (e) => `${e} sent a request` },
};

router.post("/hr-request", auth, async (req, res) => {
  const { kind, employee, details } = req.body || {};
  const k = KINDS[kind] || KINDS.other;
  const who = String(employee || req.user?.username || "An employee").slice(0, 120);

  let doc = {}, brand = {};
  try {
    const r = await pool.query("SELECT doc, brand FROM app_state WHERE id=1");
    doc = r.rows[0]?.doc || {}; brand = r.rows[0]?.brand || {};
  } catch { return res.status(500).json({ error: "Could not read workspace data." }); }

  const cfg = doc.emailConfig || null;
  if (!cfg || !cfg.user || !cfg.pass)
    // The request itself is already saved in the portal — this endpoint is only the
    // email echo, so a missing mailbox is reported softly, not as a failure.
    return res.json({ ok: false, note: "Email isn't configured; the request is in the portal only." });

  const to = String((doc.attendanceWatch || {}).hrEmail || "").trim() || DEFAULT_HR_EMAIL;

  let nodemailer;
  try { nodemailer = require("nodemailer"); }
  catch { return res.json({ ok: false, note: "Mail library missing on server." }); }

  // Detail rows come from the client but are rendered fully escaped; cap size defensively.
  const rows = Array.isArray(details)
    ? details.slice(0, 12).map((r) => [String(r?.[0] ?? "").slice(0, 60), String(r?.[1] ?? "").slice(0, 500)])
    : [];

  const opts = {
    brand, badge: k.badge, tone: "info",
    heading: k.title(who),
    intro: "A new request is waiting for HR on the portal. Review and approve or decline it there — the employee is notified of the decision automatically.",
    rows,
    cta: { label: "Review this request", url: PORTAL_URL },
    note: "You're receiving this because this address is set as HR's inbox for the portal.",
  };

  try {
    const port = +cfg.port || 465;
    const tx = nodemailer.createTransport({
      host: cfg.host || "smtp.gmail.com", port, secure: port === 465,
      auth: { user: cfg.user, pass: cleanPass(cfg.pass) },
    });
    const from = cfg.from && cfg.from.includes("@") ? cfg.from : `${brand.company || "Svype OS"} <${cfg.user}>`;
    await tx.sendMail({ from, to, subject: `📥 ${k.badge}: ${who}`, text: emailText(opts), html: emailHTML(opts) });
    res.json({ ok: true, to });
  } catch (e) {
    // Never fail the employee's submission over the email echo.
    res.json({ ok: false, note: String((e && e.message) || "send failed") });
  }
});

module.exports = router;
