// ===== Shared designed email template =====
// One visual language for every email the portal sends: branded header band, big
// heading, optional detail rows, a button into the portal, quiet footer. Built as
// table-based inline-styled HTML so it renders properly in Gmail/Outlook/phones,
// with a plain-text fallback for clients that want it.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const PORTAL_URL = process.env.PORTAL_URL || "https://portal.svype.net";

// opts: { brand, badge, heading, intro, rows:[[label,value]], list:[strings],
//         cta:{label,url}, note, tone:"info"|"warn" }
function emailHTML(opts = {}) {
  const brand = opts.brand || {};
  const accent = /^#[0-9a-fA-F]{6}$/.test(brand.accent || "") ? brand.accent : "#0284c7";
  const company = brand.company || "Svype OS";
  const tone = opts.tone === "warn"
    ? { bg: "#fffbeb", border: "#fde68a", text: "#92400e" }
    : { bg: "#f0f9ff", border: "#bae6fd", text: "#075985" };
  const cta = opts.cta || { label: "Open the portal", url: PORTAL_URL };

  const rowsHtml = (opts.rows || []).filter(r => r && r[1] != null && String(r[1]).trim() !== "").map(([k, v], i) => `
    <tr style="background:${i % 2 ? "#f8fafc" : "#ffffff"}">
      <td style="padding:9px 14px;font-size:12px;color:#64748b;font-weight:600;white-space:nowrap;vertical-align:top">${esc(k)}</td>
      <td style="padding:9px 14px;font-size:13px;color:#0f172a;white-space:pre-wrap">${esc(v)}</td>
    </tr>`).join("");

  const listHtml = (opts.list || []).map(item => `
    <tr><td style="padding:7px 14px;font-size:13px;color:#0f172a;border-bottom:1px solid #f1f5f9">•&nbsp;&nbsp;${esc(item)}</td></tr>`).join("");

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 12px"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
      <tr><td style="background:${accent};border-radius:12px 12px 0 0;padding:16px 24px">
        <span style="color:#ffffff;font-size:12px;font-weight:700;letter-spacing:2px">${esc(company).toUpperCase()}</span>
        ${opts.badge ? `<span style="float:right;background:rgba(255,255,255,.18);color:#ffffff;font-size:10px;font-weight:700;letter-spacing:1px;padding:3px 10px;border-radius:999px">${esc(opts.badge).toUpperCase()}</span>` : ""}
      </td></tr>
      <tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-top:none;padding:26px 24px 8px">
        <div style="font-size:20px;font-weight:800;color:#0f172a;line-height:1.3">${esc(opts.heading || "")}</div>
        ${opts.intro ? `<div style="font-size:14px;color:#334155;line-height:1.6;margin-top:10px;white-space:pre-wrap">${esc(opts.intro)}</div>` : ""}
      </td></tr>
      ${rowsHtml ? `<tr><td style="background:#ffffff;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;padding:14px 24px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">${rowsHtml}</table>
      </td></tr>` : ""}
      ${listHtml ? `<tr><td style="background:#ffffff;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;padding:14px 24px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">${listHtml}</table>
      </td></tr>` : ""}
      ${opts.note ? `<tr><td style="background:#ffffff;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;padding:14px 24px 0">
        <div style="background:${tone.bg};border:1px solid ${tone.border};color:${tone.text};font-size:12.5px;line-height:1.55;border-radius:10px;padding:11px 14px">${esc(opts.note)}</div>
      </td></tr>` : ""}
      <tr><td align="center" style="background:#ffffff;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;padding:22px 24px 24px">
        <a href="${esc(cta.url)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:11px 28px;border-radius:10px">${esc(cta.label)}</a>
      </td></tr>
      <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-top:1px solid #eef2f7;border-radius:0 0 12px 12px;padding:14px 24px;text-align:center">
        <div style="font-size:11px;color:#94a3b8;line-height:1.6">Sent automatically by the ${esc(company)} portal · <a href="${esc(PORTAL_URL)}" style="color:#94a3b8">${esc(PORTAL_URL.replace(/^https?:\/\//, ""))}</a></div>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

// Matching plain-text version, for clients that prefer it.
function emailText(opts = {}) {
  const lines = [opts.heading || ""];
  if (opts.intro) lines.push("", opts.intro);
  const rows = (opts.rows || []).filter(r => r && r[1] != null && String(r[1]).trim() !== "");
  if (rows.length) { lines.push(""); rows.forEach(([k, v]) => lines.push(`${k}: ${v}`)); }
  if ((opts.list || []).length) { lines.push(""); opts.list.forEach(i => lines.push(`  • ${i}`)); }
  if (opts.note) lines.push("", opts.note);
  const cta = opts.cta || { label: "Open the portal", url: PORTAL_URL };
  lines.push("", `${cta.label}: ${cta.url}`);
  return lines.join("\n");
}

module.exports = { emailHTML, emailText, PORTAL_URL };
