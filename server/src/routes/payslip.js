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

const fileNameFor = (slip) =>
  `Payslip-${String(slip.employee || "employee").replace(/[^a-z0-9]+/gi, "-")}-${String(slip.month || "").replace(/[^a-z0-9]+/gi, "-")}.pdf`;

// Email the payslip with the PDF attached, using the company's own mailbox.
// Credentials live in the shared settings document (Settings -> Email).
router.post("/email", auth, async (req, res) => {
  const { slip, brand, employee, to, subject, body } = req.body || {};
  if (!slip || !to) return res.status(400).json({ error: "Missing the payslip or the employee's email address." });

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
      auth: { user: cfg.user, pass: cfg.pass },
    });
    const pdf = buildPayslipPdf(slip, brand || {}, employee || {});
    await transporter.sendMail({
      from: cfg.from || `${(brand && brand.company) || "Payroll"} <${cfg.user}>`,
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

module.exports = router;
