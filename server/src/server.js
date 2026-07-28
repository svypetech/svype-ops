require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");

const { pool, init } = require("./db");
const { SECRET } = require("./middleware/auth");
const auth = require("./routes/auth");
const special = require("./routes/special");
const chat = require("./routes/chat");
const state = require("./routes/state");
const payslip = require("./routes/payslip");
const files = require("./routes/files");
const backup = require("./routes/backup");
const attendanceRt = require("./routes/attendance");
const { startAttendanceWatch } = require("./lib/attendanceWatch");
const { startBackupSchedule } = require("./lib/backupJob");
const ai = require("./routes/ai");
const { crud } = require("./routes/crud");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" })); // images are base64; large HR document sets need headroom

// health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// auth + special + chat
app.use("/api/auth", auth);
app.use("/api", special);
app.use("/api/chat", chat);
app.use("/api/state", state);
app.use("/api/payslip", payslip);
app.use("/api/files", files);
app.use("/api/backup", backup);
app.use("/api/attendance", attendanceRt);
app.use("/api/ai", ai);

// generic CRUD modules
app.use("/api/employees", crud("employees", ["name","role","dept","email","phone","cnic","salary","pf","joined","status","bankName","account","docs"], { jsonCols:["docs"] }));
app.use("/api/clients", crud("clients", ["name","email","whatsapp","currency","notes"]));
app.use("/api/attendance", crud("attendance", ["employee","date","status","checkIn","checkOut","location"], { jsonCols:["location"] }));
app.use("/api/leaves", crud("leaves", ["employee","type","fromDate","toDate","reason","status"]));
app.use("/api/advances", crud("advances", ["employee","total","installment","remaining","date","status"]));
app.use("/api/timesheets", crud("timesheets", ["employee","client","date","work","status","hours","edited"]));
app.use("/api/candidates", crud("candidates", ["name","role","email","phone","stage","notes","cv","cvName","date"]));
app.use("/api/invoices", crud("invoices", ["client","number","amount","currency","date","status","type"]));
app.use("/api/payables", crud("payables", ["vendor","descr","amount","due","status","kind","billId","settled","receipt"]));
app.use("/api/receivables", crud("receivables", ["client","descr","amount","due","status"]));
app.use("/api/letters", crud("letters", ["docType","type","name","date","body","signed"], { jsonCols:["signed"] }));
app.use("/api/proposals", crud("proposals", ["client","title","date","body","signed"], { jsonCols:["signed"] }));
app.use("/api/quotations", crud("quotations", ["number","client","currency","amount","date","body","signed"], { jsonCols:["signed"] }));
app.use("/api/offers", crud("offers", ["docType","name","email","role","date","body","signed"], { jsonCols:["signed"] }));
app.use("/api/retainers", crud("retainers", ["client","whatsapp","amount","currency","billingDay","status","carry"]));
app.use("/api/bank-accounts", crud("bank_accounts", ["type","label","title","number","iban","bank","notes"]));
app.use("/api/meeting-notes", crud("meeting_notes", ["employee","client","title","body","date","edited"]));
app.use("/api/announcements", crud("announcements", ["title","body","date"]));
app.use("/api/requests", crud("requests", ["employee","type","note","status","date"]));

// serve built frontend
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
// Hashed assets (js/css) may be cached forever; the app shell (index.html) must NEVER be
// cached, so every visit picks up the newest build. Stale cached builds on employee phones
// were overwriting fresh data with old lists.
app.use(express.static(clientDist, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store, must-revalidate");
    else res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  },
}));
app.get(/^(?!\/api).*/, (req, res) => { res.setHeader("Cache-Control", "no-store, must-revalidate"); res.sendFile(path.join(clientDist, "index.html")); });

// ---- HTTP + WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clientsByChannel = new Map(); // channelId -> Set<ws>

wss.on("connection", (ws, req) => {
  // authenticate via token in query string
  try {
    const url = new URL(req.url, "http://x");
    const token = url.searchParams.get("token");
    ws.user = jwt.verify(token, SECRET);
  } catch {
    ws.close();
    return;
  }
  ws.channels = new Set();
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "join" && m.channelId) {
      ws.channels.add(+m.channelId);
      if (!clientsByChannel.has(+m.channelId)) clientsByChannel.set(+m.channelId, new Set());
      clientsByChannel.get(+m.channelId).add(ws);
    }
    // Typing is ephemeral — never stored, just relayed live to whoever else is in
    // the channel right now.
    if (m.type === "typing" && m.channelId) {
      const set = clientsByChannel.get(+m.channelId);
      if (set) {
        const payload = JSON.stringify({ type: "typing", channelId: +m.channelId, userId: ws.user.id, username: ws.user.username, at: m.at !== false });
        set.forEach((peer) => { if (peer !== ws) { try { peer.send(payload); } catch {} } });
      }
    }
    // Read receipts: persisted (so "seen" survives a reload) and relayed live.
    if (m.type === "read" && m.channelId) {
      const cid = +m.channelId;
      pool.query(
        "UPDATE messages SET read_by = (SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements(COALESCE(read_by,'[]'::jsonb) || to_jsonb($1::int)) v) WHERE channel_id=$2 AND user_id != $1 AND created_at <= now()",
        [ws.user.id, cid]
      ).catch(() => {});
      const set = clientsByChannel.get(cid);
      if (set) {
        const payload = JSON.stringify({ type: "read", channelId: cid, userId: ws.user.id, at: new Date().toISOString() });
        set.forEach((peer) => { if (peer !== ws) { try { peer.send(payload); } catch {} } });
      }
    }
  });
  ws.on("close", () => {
    ws.channels.forEach((cid) => clientsByChannel.get(cid)?.delete(ws));
  });
});

function broadcast(channelId, msg) {
  const set = clientsByChannel.get(+channelId);
  if (!set) return;
  const payload = JSON.stringify({ type: "message", channelId: +channelId, message: msg });
  set.forEach((ws) => { try { ws.send(payload); } catch {} });
}
app.set("broadcast", broadcast);

const PORT = process.env.PORT || 4000;
init()
  .then(() => server.listen(PORT, () => {
    console.log("Svype OS API on :" + PORT);
    // Heal an oversized data record automatically, just after the port is open so a
    // slow cleanup can never delay or block start-up.
    setTimeout(() => { try { files.autoTidyOnBoot(); } catch (e) { console.error("auto-tidy skipped:", e.message); } }, 3000);
    try { startBackupSchedule(); } catch (e) { console.error("backup schedule skipped:", e.message); }
    try { startAttendanceWatch(); } catch (e) { console.error("attendance watch skipped:", e.message); }
  }))
  .catch((e) => { console.error("DB init failed:", e); process.exit(1); });
