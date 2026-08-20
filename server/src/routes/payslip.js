const express = require("express");
const { pool } = require("../db");
const { auth } = require("../middleware/auth");
const { buildPayslipPdf } = require("../lib/payslipPdf");
const router = express.Router();

// Real PDF bytes for a salary slip (used for download and as an email attachment).
router.post("/pdf", auth, async (req, res) => {
  try {
    const { slip, brand, employee } = req.body || {};
    if (!slip) return res.status(400).json({ error: "No payslip provided." });
    const pdf = buildPayslipPdf(slip, brand || {}, employee || {});
    res.json({ ok: true, filename: fileNameFor(slip), pdf: pdf.toString("base64") });
  } catch (e) {
    res.status(500).json({ error: "Could not build the payslip PDF." });
  }
});


// The sender header must always be a real address. People naturally type just a name
// in the "sender name" box, so accept that and build a valid header around the mailbox.
function fromHeader(cfg, brand) {
  const mailbox = String(cfg.user || "").trim();
  const raw = String(cfg.from || "").trim();
  if (!raw) return `${(brand && brand.company) || "Payroll"} <${mailbox}>`;
  if (raw.includes("<") && raw.includes(">")) return raw;      // already "Name <a@b.com>"
  if (raw.includes("@")) return raw;                            // a bare address
  return `${raw.replace(/[<>"]/g, "")} <${mailbox}>`;           // a display name only
}

// Gmail app passwords are shown in four groups and get pasted with spaces.
const cleanPass = (p) => String(p || "").replace(/\s+/g, "");

const fileNameFor = (slip) =>
  `Payslip-${String(slip.employee || "employee").replace(/[^a-z0-9]+/gi, "-")}-${String(slip.month || "").replace(/[^a-z0-9]+/gi, "-")}.pdf`;

// Email the payslip with the PDF attached, using the company's own mailbox.
// Credentials live in the shared settings document (Settings -> Email).
router.post("/email", auth, async (req, res) => {
  const { slip, brand, employee, to, subject, body } = req.body || {};
  if (!slip || !to) return res.status(400).json({ error: "Missing the payslip or the employee's email address." });
  // Former employees receive nothing from the portal — including payslips. If a final
  // settlement genuinely needs emailing, HR can reactivate the person for a moment.
  try {
    const a = await pool.query("SELECT doc FROM app_state WHERE id=1");
    const emp = ((a.rows[0]?.doc || {}).employees || []).find(e => e.name === slip.employee);
    if (emp && emp.status !== "Active")
      return res.status(403).json({ error: `${slip.employee} is no longer an active employee — the portal doesn't send anything to former staff. Download the PDF instead, or reactivate them briefly if it truly must be emailed.` });
  } catch {}

  let cfg = null;
  try {
    const r = await pool.query("SELECT doc FROM app_state WHERE id=1");
    cfg = (r.rows[0]?.doc || {}).emailConfig || null;
  } catch {
    return res.status(500).json({ error: "Could not read the email settings." });
  }
  if (!cfg || !cfg.user || !cfg.pass) {
    return res.status(412).json({ error: "Email sending isn't set up yet. Open Settings → Email and add the sending mailbox." });
  }

  let nodemailer;
  try { nodemailer = require("nodemailer"); }
  catch { return res.status(501).json({ error: "The mail library isn't installed on the server yet. Redeploy after this update and try again." }); }

  try {
    const port = +cfg.port || 465;
    const transporter = nodemailer.createTransport({
      host: cfg.host || "smtp.gmail.com",
      port,
      secure: port === 465,
      auth: { user: cfg.user, pass: cleanPass(cfg.pass) },
    });
    const pdf = buildPayslipPdf(slip, brand || {}, employee || {});
    await transporter.sendMail({
      from: fromHeader(cfg, brand),
      to,
      subject: subject || `Salary slip — ${slip.month || ""}`,
      text: body || "Please find your salary slip attached.",
      attachments: [{ filename: fileNameFor(slip), content: pdf, contentType: "application/pdf" }],
    });
    res.json({ ok: true });
  } catch (e) {
    const m = String(e && e.message || "");
    // Turn the usual SMTP failures into something a non-technical user can act on.
    if (/invalid login|username and password not accepted|535/i.test(m))
      return res.status(400).json({ error: "The mailbox rejected the login. For Gmail you must use a 16-character App Password, not the normal password." });
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(m))
      return res.status(400).json({ error: "Couldn't reach the mail server. Check the SMTP host and port in Settings → Email." });
    res.status(500).json({ error: "The email couldn't be sent. " + m });
  }
});

// Verify the mailbox settings end to end: real SMTP login, real PDF attachment.
router.post("/test", auth, async (req, res) => {
  const { to, brand } = req.body || {};
  let cfg = null;
  try {
    const r = await pool.query("SELECT doc FROM app_state WHERE id=1");
    cfg = (r.rows[0]?.doc || {}).emailConfig || null;
  } catch { return res.status(500).json({ error: "Could not read the email settings." }); }
  if (!cfg || !cfg.user || !cfg.pass) return res.status(412).json({ error: "Fill in the mailbox and app password first, then Save." });

  let nodemailer;
  try { nodemailer = require("nodemailer"); }
  catch { return res.status(501).json({ error: "The mail library isn't installed on the server yet. Redeploy after this update and try again." }); }

  const target = String(to || cfg.user).trim();
  try {
    const port = +cfg.port || 465;
    const transporter = nodemailer.createTransport({
      host: cfg.host || "smtp.gmail.com", port, secure: port === 465,
      auth: { user: cfg.user, pass: cleanPass(cfg.pass) },
    });
    await transporter.verify();   // fails fast on a bad host/port/password
    const sample = buildPayslipPdf(
      { employee: "Test Employee", month: "Sample month", basic: 100000, deductions: 0, currency: "PKR", adjustments: [] },
      brand || {}, {});
    await transporter.sendMail({
      from: fromHeader(cfg, brand),
      to: target,
      subject: "Test — payslip email is working",
      text: "This is a test from your Svype OS portal.\n\nIf you can read this and the attached sample PDF opens, salary slips will send correctly.",
      attachments: [{ filename: "Sample-payslip.pdf", content: sample, contentType: "application/pdf" }],
    });
    res.json({ ok: true, to: target, from: fromHeader(cfg, brand) });
  } catch (e) {
    const m = String(e && e.message || "");
    if (/invalid login|username and password not accepted|535/i.test(m))
      return res.status(400).json({ error: "The mailbox rejected the login. Check that 2-Step Verification is on and that you pasted the 16-character App Password (not the account password)." });
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAUTH/i.test(m))
      return res.status(400).json({ error: "Couldn't reach the mail server. Check the SMTP host and port." });
    res.status(500).json({ error: m || "The test email couldn't be sent." });
  }
});

module.exports = router;
