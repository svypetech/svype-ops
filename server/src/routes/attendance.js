const express = require("express");
const { auth } = require("../middleware/auth");
const { notify, cfgOf, readState, pending, addMin } = require("../lib/attendanceWatch");
const router = express.Router();

router.get("/watch-status", auth, async (req, res) => {
  try {
    const { doc } = await readState();
    const cfg = cfgOf(doc);
    const d = new Date(Date.now() + cfg.tzOffsetMin * 60000).toISOString().slice(0, 10);
    res.json({ ...cfg, today: d, missingIn: pending(doc, d, "in").length, missingOut: pending(doc, d, "out").length,
      alertsAt: { in: addMin(cfg.startTime, +cfg.graceMin || 0), out: addMin(cfg.endTime, +cfg.outGraceMin || 0) },
      emailReady: !!(doc.emailConfig && doc.emailConfig.user && doc.emailConfig.pass) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/watch-test", auth, async (req, res) => {
  try { res.json({ ok: true, pending: await notify(req.body && req.body.kind === "out" ? "out" : "in") }); }
  catch (e) { res.status(400).json({ error: e.message || "Could not send the alert." }); }
});

module.exports = router;
