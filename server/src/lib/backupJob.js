const zlib = require("zlib");
const { pool } = require("../db");

// Nightly off-site backup. The attached file is exactly the format the portal's
// "Restore from backup" button expects, so a bad day can be undone from an email.

const DEFAULTS = { enabled: true, time: "23:59", tzOffsetMin: 300, to: "" }; // 300 = Pakistan (UTC+5)

const pad = (n) => String(n).padStart(2, "0");
// "Now" in the configured timezone, read through the UTC getters.
const localNow = (offsetMin) => new Date(Date.now() + (offsetMin || 0) * 60000);
const localDate = (offsetMin) => localNow(offsetMin).toISOString().slice(0, 10);
const localHM = (offsetMin) => {
  const d = localNow(offsetMin);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

async function readState() {
  const r = await pool.query("SELECT doc, brand FROM app_state WHERE id=1");
  if (!r.rowCount) return { doc: {}, brand: null };
  return { doc: r.rows[0].doc || {}, brand: r.rows[0].brand || null };
}

const cfgOf = (doc) => ({ ...DEFAULTS, ...((doc && doc.backupConfig) || {}) });

// Record the run without loading the document into memory.
async function stampRun(dateStr, note) {
  await pool.query(
    `UPDATE app_state SET doc = COALESCE(doc,'{}'::jsonb) || jsonb_build_object(
       'backupConfig', COALESCE(doc->'backupConfig','{}'::jsonb) || jsonb_build_object('lastSentOn', $1::text, 'lastResult', $2::text)
     ), rev = rev + 1, updated_at = now() WHERE id=1`,
    [dateStr, String(note || "").slice(0, 300)]
  );
}

async function fileStats() {
  try {
    const r = await pool.query("SELECT count(*)::int AS n, COALESCE(sum(size),0)::bigint AS total FROM files");
    return { count: r.rows[0].n, mb: +(r.rows[0].total / 1048576).toFixed(2) };
  } catch { return { count: 0, mb: 0 }; }
}

const countOf = (doc, k) => (Array.isArray(doc && doc[k]) ? doc[k].length : 0);

async function runBackup({ manual = false } = {}) {
  const { doc, brand } = await readState();
  const cfg = cfgOf(doc);
  const email = (doc && doc.emailConfig) || null;
  if (!email || !email.user || !email.pass) throw new Error("Email sending isn't set up (Settings → Email), so the backup can't be sent.");
  const to = (cfg.to || "").trim() || email.user;

  let nodemailer;
  try { nodemailer = require("nodemailer"); }
  catch { throw new Error("The mail library isn't installed on the server."); }

  const dateStr = localDate(cfg.tzOffsetMin);
  const payload = JSON.stringify({ db: doc, brand });          // same shape as the manual export
  const rawMb = +(Buffer.byteLength(payload) / 1048576).toFixed(2);

  // Gzip anything sizeable so the mailbox isn't hammered every night.
  let filename = `svype-os-backup-${dateStr}.json`;
  let content = Buffer.from(payload, "utf8");
  let contentType = "application/json";
  if (content.length > 2 * 1048576) {
    content = zlib.gzipSync(content);
    filename += ".gz";
    contentType = "application/gzip";
  }
  const files = await fileStats();
  const sentMb = +(content.length / 1048576).toFixed(2);

  const lines = [
    `Svype OS backup — ${dateStr}`,
    "",
    `Attached: ${filename} (${sentMb} MB${filename.endsWith(".gz") ? `, ${rawMb} MB uncompressed` : ""})`,
    "",
    "What's inside:",
    `  Employees        ${countOf(doc, "employees")}`,
    `  Clients          ${countOf(doc, "clients")}`,
    `  Retainers        ${countOf(doc, "retainers")}`,
    `  Invoices         ${countOf(doc, "retainerInvoices") + countOf(doc, "invoices")}`,
    `  Payroll records  ${countOf(doc, "payroll")}`,
    `  Attendance rows  ${countOf(doc, "attendance")}`,
    "",
    "To restore: open the portal → Settings → Backup → Restore from backup,",
    `and choose this file${filename.endsWith(".gz") ? " (unzip it first)" : ""}.`,
    "",
    `Note: uploaded documents (${files.count} files, ${files.mb} MB) live in the database`,
    "separately and are not inside this file. This backup restores every record.",
    "",
    manual ? "Sent manually from Settings." : "Sent automatically by the nightly backup.",
  ];

  const port = +email.port || 465;
  const transporter = nodemailer.createTransport({
    host: email.host || "smtp.gmail.com", port, secure: port === 465,
    auth: { user: email.user, pass: String(email.pass || "").replace(/\s+/g, "") },
  });
  await transporter.sendMail({
    from: email.from && email.from.includes("@") ? email.from : `${(brand && brand.company) || "Svype OS"} <${email.user}>`,
    to,
    subject: `Svype OS backup — ${dateStr}`,
    text: lines.join("\n"),
    attachments: [{ filename, content, contentType }],
  });

  await stampRun(dateStr, `Sent to ${to} (${sentMb} MB)`);
  return { ok: true, to, filename, sizeMb: sentMb, date: dateStr };
}

// ---- schedule ----
let timer = null;
let lastAttempt = "";   // guards against re-running inside the same minute

function startBackupSchedule() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const { doc } = await readState();
      const cfg = cfgOf(doc);
      if (cfg.enabled === false) return;
      const today = localDate(cfg.tzOffsetMin);
      const hm = localHM(cfg.tzOffsetMin);
      const target = /^\d{2}:\d{2}$/.test(cfg.time) ? cfg.time : DEFAULTS.time;
      if (hm !== target) return;
      const already = (doc.backupConfig || {}).lastSentOn === today;
      if (already || lastAttempt === today) return;
      lastAttempt = today;
      const r = await runBackup({ manual: false });
      console.log(`[backup] nightly backup emailed to ${r.to} (${r.sizeMb} MB)`);
    } catch (e) {
      console.error("[backup] nightly backup failed:", e.message);
      try { await stampRun(localDate(300), "FAILED: " + e.message); } catch {}
    }
  }, 30000);
  console.log("[backup] nightly backup schedule active");
}

module.exports = { runBackup, startBackupSchedule, cfgOf, readState, DEFAULTS };
