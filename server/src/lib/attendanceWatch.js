const { pool } = require("../db");
const { emailHTML, emailText, PORTAL_URL } = require("./emailTemplate");

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
  worklogTime: "21:00",   // evening reminder to fill the daily work log (PKT)
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
    if (kind === "worklog") {
      // Skip days HR already marked leave/absent; everyone else who worked is
      // expected to write what they worked on.
      if (rec && (rec.status === "Leave" || rec.status === "Absent")) return false;
      return !(doc.timesheets || []).some(t => t.employee === e.name && t.date === date);
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
  const send = (rcpt, subject, opts) => m.tx.sendMail({ from: m.from, to: rcpt, subject, text: emailText(opts), html: emailHTML(opts) });

  if (kind === "worklog") {
    // Evening reminder straight to the people who haven't written today's work log.
    // HR isn't copied — this one is a personal nudge, and HR sees the same names on
    // their dashboard "Team watch" card anyway.
    for (const p of list) {
      if (!p.email) continue;
      try {
        await send(p.email, "⏰ Your daily work log is still empty", {
          brand, badge: "Daily work log", tone: "warn",
          heading: `${(p.name || "").split(" ")[0]}, today's work log is still empty`,
          intro: `Before you wrap up for the day, take two minutes to note what you worked on today (${date}). It keeps your record complete and is what HR and the founders read to see everyone's day.`,
          rows: [["Date", date], ["Status", "No work update logged yet"]],
          cta: { label: "Write today's update", url: PORTAL_URL },
          note: "If you were on approved leave today, you can ignore this — leave days don't need a log.",
        });
      } catch {}
    }
    await stamp("lastWorklogAlert", date);
    return list.length;
  }

  const label = kind === "in" ? "not checked in" : "not checked out";
  if (list.length) {
    // --- HR summary: who's missing, as a designed digest ---
    await send(to, `Attendance: ${list.length} ${label} (${date})`, {
      brand, badge: "Attendance alert", tone: "warn",
      heading: kind === "in"
        ? `${list.length} team member${list.length === 1 ? " hasn't" : "s haven't"} checked in`
        : `${list.length} team member${list.length === 1 ? " is" : "s are"} still checked in`,
      intro: kind === "in"
        ? `Office start is ${cfg.startTime}. As of ${cfg.graceMin} minutes past that, these people haven't checked in:`
        : `Office end is ${cfg.endTime}. As of ${cfg.outGraceMin} minutes past that, these people haven't checked out:`,
      list: list.map(p => `${p.name}${p.wfh ? "  (working from home)" : ""}`),
      cta: { label: "Review in Attendance & Leave", url: PORTAL_URL },
      note: "People on approved leave are skipped automatically. Anyone who sent a time correction will appear there for approval.",
    });

    // --- personal nudges ---
    if (cfg.remindEmployee) {
      for (const p of list) {
        if (!p.email) continue;
        try {
          await send(p.email,
            kind === "in" ? "⏰ Reminder: you haven't checked in" : "⏰ Reminder: you haven't checked out",
            kind === "in" ? {
              brand, badge: "Check-in reminder", tone: "warn",
              heading: `${(p.name || "").split(" ")[0]}, you haven't checked in yet`,
              intro: `Office hours started at ${cfg.startTime} and your check-in for today (${date}) is still empty. Please check in now so your attendance is recorded${p.wfh ? " — your work-from-home day still needs a check-in" : ""}.`,
              rows: [["Date", date], ["Office start", cfg.startTime], ["Your check-in", "— not recorded —"]],
              cta: { label: "Check in now", url: PORTAL_URL },
              note: "Already started earlier? Open the portal and use “Forgot to check in or out? Send a correction” — HR will approve the real time.",
            } : {
              brand, badge: "Check-out reminder", tone: "warn",
              heading: `${(p.name || "").split(" ")[0]}, you're still checked in`,
              intro: `The workday ended at ${cfg.endTime} and you haven't checked out for today (${date}). Please check out so your hours are recorded correctly.`,
              rows: [["Date", date], ["Office end", cfg.endTime], ["Your check-out", "— not recorded —"]],
              cta: { label: "Check out now", url: PORTAL_URL },
              note: "Left earlier and forgot? Send a correction with the time you actually left and HR will fix it.",
            });
        } catch {}
      }
    }
  }
  await stamp(kind === "in" ? "lastInAlert" : "lastOutAlert", date);
  return list.length;
}

// ===== Offboarding =====
// Runs once a day (first tick after 08:00 PKT), independent of the attendance-alert
// toggle — leaving must work even if reminders are switched off.
//   • Someone on notice whose LAST WORKING DAY is today → a farewell email: today is
//     your last day, the portal deactivates after today, download what you need.
//   • Someone on notice whose last working day has PASSED → automatically marked
//     Inactive (they move to the Previous employees section), their login is switched
//     off in the users table, and the change is written to the activity log. From that
//     moment no reminder, announcement, payslip or any other email can reach them —
//     every sender in this codebase filters on status === "Active".
async function offboardSweep() {
  const { doc, brand } = await readState();
  const date = localDate(cfgOf(doc).tzOffsetMin);
  const emps = doc.employees || [];

  // --- farewell emails for people finishing TODAY ---
  const leavingToday = emps.filter(e => e.status === "Active" && e.onNotice && e.lastWorkingDay === date && e.email);
  if (leavingToday.length) {
    try {
      const m = await mailer(doc, brand);
      for (const e of leavingToday) {
        try {
          const opts = {
            brand, badge: "Last working day", tone: "info",
            heading: `${(e.name || "").split(" ")[0]}, today is your last working day`,
            intro: `Thank you for everything you've done at ${(brand && brand.company) || "the company"}. We wish you the very best for what comes next.`,
            rows: [["Last working day", date], ["Joined", e.joined || "—"], ["Portal access", "Deactivates after today"]],
            cta: { label: "Open the portal", url: PORTAL_URL },
            note: "Your portal login will be switched off after today, so please download any payslips or documents you want to keep before the end of the day. HR will be in touch about your final settlement.",
          };
          await m.tx.sendMail({ from: m.from, to: e.email, subject: `Today is your last working day — ${(brand && brand.company) || "Svype OS"}`, text: emailText(opts), html: emailHTML(opts) });
          console.log(`[offboard] farewell sent to ${e.name}`);
        } catch (err) { console.error(`[offboard] farewell to ${e.name} failed:`, err.message); }
      }
    } catch (err) { console.error("[offboard] mailer unavailable, farewells skipped:", err.message); }
  }

  // --- deactivate people whose last working day has passed ---
  const dueOut = emps.filter(e => e.status === "Active" && e.onNotice && e.lastWorkingDay && e.lastWorkingDay < date);
  if (dueOut.length) {
    const ids = dueOut.map(e => String(e.id));
    // Read-modify-write with rev CAS so a simultaneous portal save can't be trampled.
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await pool.query("SELECT doc, rev FROM app_state WHERE id=1");
      const cur = r.rows[0]?.doc || {}, rev = r.rows[0]?.rev || 0;
      const next = {
        ...cur,
        employees: (cur.employees || []).map(e => ids.includes(String(e.id)) && e.status === "Active"
          ? { ...e, status: "Inactive", offboardedOn: date }
          : e),
        audit: [
          ...dueOut.map(e => ({ id: `offb-${e.id}-${date}`, date: new Date().toISOString(), who: "system", action: `Offboarded ${e.name} — last working day was ${e.lastWorkingDay}; portal access deactivated, moved to Previous employees` })),
          ...(cur.audit || []),
        ].slice(0, 500),
      };
      const w = await pool.query("UPDATE app_state SET doc=$1, rev=rev+1, updated_at=now() WHERE id=1 AND rev=$2", [next, rev]);
      if (w.rowCount) break;
    }
    try { await pool.query("UPDATE users SET active=FALSE WHERE emp_id::text = ANY($1)", [ids]); } catch (e) { console.error("[offboard] user disable failed:", e.message); }
    console.log(`[offboard] deactivated: ${dueOut.map(e => e.name).join(", ")}`);
  }

  await stamp("lastOffboardSweep", date);
  return { farewells: leavingToday.length, deactivated: dueOut.length };
}

let timer = null, guard = {};
function startAttendanceWatch() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      const { doc } = await readState();
      const cfg = cfgOf(doc);
      // Offboarding runs regardless of the reminder toggle or weekends — a last
      // working day can fall on any date and must never be missed.
      const hmAll = localHM(cfg.tzOffsetMin), dateAll = localDate(cfg.tzOffsetMin);
      const savedAll = doc.attendanceWatch || {};
      if (hmAll >= "08:00" && savedAll.lastOffboardSweep !== dateAll && guard.offb !== dateAll) {
        guard.offb = dateAll;
        try { await offboardSweep(); } catch (e) { console.error("[offboard] sweep failed:", e.message); }
      }
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
      // Evening work-log reminder ("did you write what you worked on today?").
      // Fires once per day at cfg.worklogTime, Pakistan time.
      if (hm === (cfg.worklogTime || "21:00") && saved.lastWorklogAlert !== date && guard.work !== date) {
        guard.work = date;
        const n = await notify("worklog");
        console.log(`[attendance] work-log reminder sent (${n} pending)`);
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

module.exports = { startAttendanceWatch, notify, offboardSweep, cfgOf, readState, pending, addMin, DEFAULTS };
