// ===== Announcement email blast =====
// When HR posts an announcement in the portal it can also go out by email to every
// registered address — minus anyone HR chose to exclude. Recipients go in BCC so
// nobody sees the rest of the list (or who was left off it).
const express = require("express");
const { pool } = require("../db");
const { auth, staffOnly } = require("../middleware/auth");

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
    await tx.sendMail({
      from: fromHeader(cfg, brand),
      to: fromHeader(cfg, brand),                       // the visible To: is the sender itself
      bcc: to.map((r) => r.email),                      // real recipients stay private
      subject: `📢 ${String(title).trim()} — ${company}`,
      text: `${String(title).trim()}\n\n${String(body || "").trim()}\n\n—\nThis announcement was posted on the ${company} portal.`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
        <div style="background:${esc(brand.accent || "#0284c7")};color:#fff;border-radius:10px 10px 0 0;padding:14px 20px;font-size:12px;font-weight:700;letter-spacing:2px">${esc(company).toUpperCase()} · ANNOUNCEMENT</div>
        <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:20px">
          <div style="font-size:18px;font-weight:700;margin-bottom:8px">${esc(title)}</div>
          <div style="font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(body)}</div>
          <div style="margin-top:18px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8">Posted on the ${esc(company)} portal · you can also see it on your dashboard.</div>
        </div></div>`,
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
