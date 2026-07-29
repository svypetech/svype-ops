const { pool } = require("../db");

// Watches office hours and tells HR who hasn't checked in (or out). Runs on the server,
// so it works whether or not anyone has the portal open.

const DEFAULTS = {
  enabled: false,
  startTime: "09:30",     // office start
  graceMin: 30,           // how long after start before HR is told
  endTime: "18:00",       // office end
  outGraceMin: 60,        // how long after end before HR is told about missing check-outs
  tzOffsetMin: 300,       // Pakistan (UTC+5)
  hrEmail: "",            // blank = the sending mailbox
  remindEmployee: true,   // nudge the employee before HR is told
  weekendDays: [0, 6],    // Sunday=0 .. Saturday=6. Without this the alert fires
                          // every weekend telling HR the whole team is "missing".
};
const isWeekendFor = (offsetMin, weekendDays) => weekendDays.includes(localNow(offsetMin).getUTCDay());

const pad = (n) => String(n).padStart(2, "0");
const localNow = (off) => new Date(Date.now() + (off || 0) * 60000);
const localDate = (off) => localNow(off).toISOString().slice(0, 10);
const localHM = (off) => { const d = localNow(off); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const addMin = (hm, mins) => {
  const [h, m] = String(hm || "09:00").split(":").map(Number);
  const t = (h * 60 + m + mins + 1440) % 1440;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
};

async function readState() {
  const r = await pool.query("SELECT doc, brand FROM app_state WHERE id=1");
  return r.rowCount ? { doc: r.rows[0].doc || {}, brand: r.rows[0].brand || null } : { doc: {}, brand: null };
}
const cfgOf = (doc) => ({ ...DEFAULTS, ...((doc && doc.attendanceWatch) || {}) });

async function stamp(key, value) {
  await pool.query(
    `UPDATE app_state SET doc = COALESCE(doc,'{}'::jsonb) || jsonb_build_object(
       'attendanceWatch', COALESCE(doc->'attendanceWatch','{}'::jsonb) || jsonb_build_object($1::text, $2::text)
     ), rev = rev + 1, updated_at = now() WHERE id=1`, [key, value]);
}

async function mailer(doc, brand) {
  const email = (doc && doc.emailConfig) || null;
  if (!email || !email.user || !email.pass) throw new Error("email not configured");
  const nodemailer = require("nodemailer");
  const port = +email.port || 465;
  return {
    from: email.from && email.from.includes("@") ? email.from : `${(brand && brand.company) || "Svype OS"} <${email.user}>`,
    fallbackTo: email.user,
    tx: nodemailer.createTransport({
      host: email.host || "smtp.gmail.com", port, secure: port === 465,
      auth: { user: email.user, pass: String(email.pass || "").replace(/\s+/g, "") },
    }),
  };
}

// Who is expected in the office today and hasn't acted.
function pending(doc, date, kind) {
  const active = (doc.employees || []).filter(e => e.status === "Active" && e.payType !== "Freelance");
  const att = (doc.attendance || []).filter(a => a.date === date);
  const onLeave = new Set((doc.leaves || [])
    .filter(l => l.status === "Approved" && (l.from || "") <= date && (l.to || "") >= date)
    .map(l => l.employee));
  const wfh = new Set((doc.wfhRequests || []).filter(w => w.date === date && w.status !== "Rejected").map(w => w.employee));
  return active.filter(e => {
    if (onLeave.has(e.name)) return false;
    const rec = att.find(a => a.employee === e.name);
    if (kind === "in") {
      if (rec && (rec.checkIn || rec.status === "Leave" || rec.status === "Absent")) return false;
      return true;
    }
    // check-out: only people who actually checked in and never checked out
    return !!(rec && rec.checkIn && !rec.checkOut);
  }).map(e => ({ name: e.name, email: e.email, wfh: wfh.has(e.name) }));
}

async function notify(kind) {
  const { doc, brand } = await readState();
  const cfg = cfgOf(doc);
  const date = localDate(cfg.tzOffsetMin);
  const list = pending(doc, date, kind);
  const m = await mailer(doc, brand);
  const to = (cfg.hrEmail || "").trim() || m.fallbackTo;
  const label = kind === "in" ? "not checked in" : "not checked out";

  if (list.length) {
    const lines = [
      `${list.length} team member(s) ${label} — ${date}`, "",
      ...list.map(p => `  • ${p.name}${p.wfh ? " (working from home)" : ""}`),
      "", kind === "in"
        ? `Office start is ${cfg.startTime}. This was sent ${cfg.graceMin} minutes after that.`
        : `Office end is ${cfg.endTime}. This was sent ${cfg.outGraceMin} minutes after that.`,
      "", "Open the portal → Attendance & Leave to mark them or review corrections.",
    ];
    await m.tx.sendMail({ from: m.from, to, subject: `Attendance: ${list.length} ${label} (${date})`, text: lines.join("\n") });

    // optional nudge to the people themselves
    if (cfg.remindEmployee) {
      for (const p of list) {
        if (!p.email) continue;
        try {
          await m.tx.sendMail({
            from: m.from, to: p.email,
            subject: kind === "in" ? "Reminder: you haven't checked in" : "Reminder: you haven't checked out",
            text: kind === "in"
              ? `Hi ${p.name},\n\nYou aren't checked in yet today. Please open the portal and check in.\nIf you started earlier, use "Forgot to check in or out? Send a correction".`
              : `Hi ${p.name},\n\nYou're still checked in. Please check out.\nIf you left earlier, send a correction with the time you actually left.`,
          });
        } catch {}
      }
    }
  }
  await stamp(kind === "in" ? "lastInAlert" : "lastOutAlert", date);
  return list.length;
}

let timer = null, guard = {};
function startAttendanceWatch() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const { doc } = await readState();
      const cfg = cfgOf(doc);
      if (!cfg.enabled) return;
      if (isWeekendFor(cfg.tzOffsetMin, cfg.weekendDays || DEFAULTS.weekendDays)) return;   // no point telling HR the office is empty on a day off
      const hm = localHM(cfg.tzOffsetMin), date = localDate(cfg.tzOffsetMin);
      const saved = doc.attendanceWatch || {};
      if (hm === addMin(cfg.startTime, +cfg.graceMin || 0) && saved.lastInAlert !== date && guard.in !== date) {
        guard.in = date;
        const n = await notify("in");
        console.log(`[attendance] check-in alert sent (${n} pending)`);
      }
      if (hm === addMin(cfg.endTime, +cfg.outGraceMin || 0) && saved.lastOutAlert !== date && guard.out !== date) {
        guard.out = date;
        const n = await notify("out");
        console.log(`[attendance] check-out alert sent (${n} pending)`);
      }
    } catch (e) {
      // Previously this only went to the server log, which nobody sees — so a
      // misconfigured mailbox meant the alert silently never arrived, forever.
      // Recording it here makes it visible right where the toggle lives.
      console.error("[attendance] watch failed:", e.message);
      try { await stamp("lastError", `${localDate(300)}: ${e.message}`); } catch {}
    }
  }, 30000);
  console.log("[attendance] office-hours watch active");
}

module.exports = { startAttendanceWatch, notify, cfgOf, readState, pending, addMin, DEFAULTS };
