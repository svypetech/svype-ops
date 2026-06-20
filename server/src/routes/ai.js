const express = require("express");
const { auth, staffOnly } = require("../middleware/auth");
const router = express.Router();

// Server-side Claude API call. Key stays on the server (never sent to browser).
router.post("/draft", auth, staffOnly, async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: "AI is not configured yet. Add ANTHROPIC_API_KEY in Render → Environment to enable AI drafting." });
  const { kind, fields, template } = req.body || {};
  const prompt = buildPrompt(kind, fields, template);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error?.message || "AI request failed" });
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: "Could not reach the AI service: " + e.message });
  }
});

function buildPrompt(kind, f = {}, template) {
  const base = template && template.trim()
    ? `Use this saved template/style as a guide:\n"""${template}"""\n\n`
    : "";
  if (kind === "proposal") {
    return base + `Write a professional, persuasive client project proposal in plain prose (no markdown headers, ready to paste into a document).
Client: ${f.client || "the client"}
Title: ${f.title || ""}
Overview notes: ${f.overview || ""}
Scope notes: ${f.scope || ""}
Timeline notes: ${f.timeline || ""}
Investment notes: ${f.investment || ""}
Keep it warm, confident, and concise. Return only the proposal body text.`;
  }
  if (kind === "quotation") {
    return base + `Write a short, professional description/cover note for a price quotation to ${f.client || "the client"}.
Items: ${f.items || ""}.
Keep it to 2-3 sentences, friendly and clear. Return only the text.`;
  }
  return base + (f.brief || "Write professional business text.");
}

module.exports = router;
