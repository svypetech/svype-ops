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
const { crud } = require("./routes/crud");

const app = express();
app.use(cors());
app.use(express.json({ limit: "12mb" })); // images are base64

// health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// auth + special + chat
app.use("/api/auth", auth);
app.use("/api", special);
app.use("/api/chat", chat);
app.use("/api/state", state);

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
app.use(express.static(clientDist));
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(clientDist, "index.html")));

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
  .then(() => server.listen(PORT, () => console.log("Svype OS API on :" + PORT)))
  .catch((e) => { console.error("DB init failed:", e); process.exit(1); });
