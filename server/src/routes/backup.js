const express = require("express");
const { auth } = require("../middleware/auth");
const { runBackup, cfgOf, readState } = require("../lib/backupJob");
const router = express.Router();

router.get("/status", auth, async (req, res) => {
  try {
    const { doc } = await readState();
    const cfg = cfgOf(doc);
    const emailReady = !!(doc.emailConfig && doc.emailConfig.user && doc.emailConfig.pass);
    res.json({ ...cfg, emailReady, mailbox: (doc.emailConfig && doc.emailConfig.user) || null });
  } catch (e) { res.status(500).json({ error: e.message || "Could not read the backup settings." }); }
});

router.post("/run-now", auth, async (req, res) => {
  try { res.json(await runBackup({ manual: true })); }
  catch (e) { res.status(400).json({ error: e.message || "The backup could not be sent." }); }
});

module.exports = router;
