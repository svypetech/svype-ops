import React, { useState, useEffect, useRef } from "react";
import {
  LayoutDashboard, Users, CalendarCheck, Wallet, UserPlus, FolderOpen,
  FileText, ArrowDownCircle, ArrowUpCircle, ScrollText, Plus, Trash2,
  Edit3, X, Check, LogOut, Search, Download, Building2, Loader2, Settings,
  Upload, PenTool, Stamp, ChevronLeft, FileSignature, Receipt, Briefcase, Paperclip,
  Repeat, Send, Landmark, Menu, Megaphone, Inbox, UserCircle, Clock, MapPin, CalendarClock, Lock, Eye, EyeOff, Copy,
  Contact, History, Database, HandCoins, Bell, Mail, MessageSquare, Hash
} from "lucide-react";

/* ---------------- storage (server-backed) ---------------- */
const TOKEN_KEY = "svype_chat_token";
const getChatToken = () => localStorage.getItem(TOKEN_KEY);
const setChatToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));
async function apiReq(method, url, body) {
  const res = await fetch("/api" + url, {
    method,
    headers: { "Content-Type": "application/json", ...(getChatToken() ? { Authorization: "Bearer " + getChatToken() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
// Whole-app shared state persisted as one document on the server.
let _stateCache = { doc: null, brand: null, rev: 0 };
const DB = {
  async get(key, fb) {
    try {
      const st = await apiReq("GET", "/state");
      _stateCache = { doc: st?.doc ?? null, brand: st?.brand ?? null, rev: +st?.rev || 0 };
      if (key === "svype_db") return _stateCache.doc ?? fb;
      if (key === "svype_brand") return _stateCache.brand ?? fb;
      return fb;
    } catch { return fb; }
  },
  async set(key, v) {
    // NOTE: failures are RE-THROWN so the caller can warn the user.
    if (key === "svype_db") { _stateCache.doc = v; await apiReq("PUT", "/state", { doc: v }); }
    else if (key === "svype_brand") { _stateCache.brand = v; await apiReq("PUT", "/state", { brand: v }); }
  },
};


// 3-way merge for list saves. A module hands us the list as ITS tab last saw it (before)
// and the list it wants (next). We derive exactly what was added / edited / deleted and
// apply ONLY those changes to the freshest list (current). Rows added meanwhile by anyone
// else always survive — a slightly-stale tab can no longer wipe other people's entries.
function mergeRows(current, before, next) {
  if (!Array.isArray(current) || !Array.isArray(before) || !Array.isArray(next)) return next;
  if (next.some(r=>!r || r.id==null) || before.some(r=>!r || r.id==null) || current.some(r=>!r || r.id==null)) return next;
  const beforeIds = new Map(before.map(r=>[r.id, r]));
  const nextIds = new Map(next.map(r=>[r.id, r]));
  // deletions this tab explicitly made: present before, absent in next
  let out = current.filter(r=> !(beforeIds.has(r.id) && !nextIds.has(r.id)) );
  // edits: rows this tab still lists — take its version
  const outIds = new Set(out.map(r=>r.id));
  out = out.map(r=> nextIds.has(r.id) ? nextIds.get(r.id) : r);
  // additions: rows this tab has that the fresh list doesn't
  const additions = next.filter(r=>!outIds.has(r.id));
  if (additions.length) {
    const firstIsNew = next.length && !outIds.has(next[0].id);
    out = firstIsNew ? [...additions, ...out] : [...out, ...additions];
  }
  return out;
}

// ===== Conflict-safe save queue =====
// Every save states which server revision it was based on. If another tab/user saved
// in the meantime, the server rejects (409) and returns the latest doc; we re-apply
// our change ON TOP of that and retry. This stops one person's save from wiping
// another person's recent changes (the cause of "my data disappeared on refresh").
// Visible build tag so we can always verify which version is actually deployed.
const APP_BUILD = "Build 28 Jul 2026 · invoices-v1";
// Save-status indicator: "saving" | "saved" | "error" — shown in the top bar.
let _statusCb = null;
function onSaveStatus(cb) { _statusCb = cb; }
function _setSaveStatus(s) { try { _statusCb && _statusCb(s); } catch {} }

let _rev = 0;            // last server revision we know
let _serverDoc = null;   // the doc as the server has it after our last confirmed write
let _saveQueue = [];
let _saving = false;
function initSaveState(doc, rev) { _serverDoc = doc; _rev = rev || 0; }
async function _gzipBody(str) {
  try {
    if (typeof CompressionStream === "undefined") return null;
    const stream = new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).blob();
  } catch { return null; }
}
async function _putState(doc, baseRev, base) {
  // Send ONLY the top-level keys that actually changed (our mutations keep unchanged
  // keys referentially identical), so ticking a task uploads kilobytes, not the whole
  // database with every photo in it. Falls back to the full document when needed.
  let payload;
  if (base && typeof base === "object") {
    const patchDoc = {};
    for (const k of Object.keys(doc)) if (doc[k] !== base[k]) patchDoc[k] = doc[k];
    if (Object.keys(patchDoc).length === 0) return { conflict: false, rev: baseRev }; // nothing changed
    payload = { patchDoc, baseRev };
  } else {
    payload = { doc, baseRev };
  }
  const json = JSON.stringify(payload);
  if (json.length > 18 * 1024 * 1024) {
    // Sending this would time the server out. Say exactly how to fix it instead.
    const mb = (json.length / 1048576).toFixed(1);
    throw new Error(`TOO_LARGE:${mb}`);
  }
  const headers = { "Content-Type": "application/json", ...(getChatToken() ? { Authorization: "Bearer " + getChatToken() } : {}) };
  let body = json;
  const gz = await _gzipBody(json);          // typically 2–4× smaller → 2–4× faster upload
  if (gz) { headers["Content-Encoding"] = "gzip"; body = gz; }
  const res = await fetch("/api/state", { method: "PUT", headers, body });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) return { conflict: true, doc: data.doc, rev: +data.rev || 0 };
  if (!res.ok) throw new Error(data.error || "Save failed");
  return { conflict: false, rev: +data.rev || 0 };
}
function enqueueSave(mutate, onMerged) {
  // Returns a promise that resolves only when the SERVER has confirmed this save —
  // so buttons can show "Processing…" until the change is truly persisted.
  return new Promise((resolve, reject) => {
    _saveQueue.push({ mutate, onMerged, resolve, reject });
    _setSaveStatus("saving");
    _drainSaves();
  });
}
async function _drainSaves() {
  if (_saving) return; _saving = true;
  try {
    while (_saveQueue.length) {
      // Coalesce everything queued right now into ONE server write — ticking ten
      // checkboxes quickly becomes one or two PUTs instead of ten (much faster).
      const batch = _saveQueue.splice(0, _saveQueue.length);
      try {
        let attempts = 0, done = false, hadConflict = false;
        while (!done && attempts < 6) {
          attempts++;
          const base = _serverDoc;
          let next = base || undefined;
          for (const b of batch) next = b.mutate(next);
          const r = await _putState(next, _rev, base);
          if (r.conflict) { hadConflict = true; _serverDoc = r.doc; _rev = r.rev; continue; }
          _serverDoc = next; _rev = r.rev; _stateCache.doc = next; done = true;
          if (hadConflict) { const om = batch.find(b=>b.onMerged); om && om.onMerged(next); } // re-sync UI with merged result
        }
        if (!done) throw new Error("could not save after several retries");
        batch.forEach(b=>b.resolve && b.resolve(true));
      } catch (e) {
        batch.forEach(b=>b.reject && b.reject(e));
        _saveQueue.forEach(q=>q.reject && q.reject(e)); _saveQueue = [];
        _setSaveStatus("error");
        const raw = e?.message || "save failed";
        if (String(raw).startsWith("TOO_LARGE:")) {
          alert("⚠️ Your change could not be saved because the data record has grown too large (" + String(raw).split(":")[1] + " MB).\n\nThis happens when uploaded files (CNICs, contracts, receipts) are stored inside the main record.\n\nFIX — open Settings → Backup → Storage health and press “Move uploaded files to storage”. It takes a moment and only needs doing once, then saving will work normally again.");
        } else {
          alert("⚠️ Your last change could NOT be saved to the server, so it will be lost on refresh.\n\nFirst try: reload the page and do it again.\nIf it keeps happening, open Settings → Backup → Storage health and run “Move uploaded files to storage”.\n\n(Technical detail: " + raw + ")");
        }
        return;
      }
    }
    _setSaveStatus("saved");
  } finally { _saving = false; }
}
const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);
const monthLabel = () => new Date().toLocaleString("default", { month: "long", year: "numeric" });
const fmt = (n, cur) => `${cur || "PKR"} ${Number(n || 0).toLocaleString()}`;
const timeOf = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
// A corrected check-in time only counts once HR has approved it. Until then (and if
// declined) the time that stands is the moment the person actually checked in.
const effIn = (a) => (a && a.timeReq && a.timeReq.status === "Approved") ? a.timeReq.requested : (a ? a.checkIn : null);
// Same rule for check-out: a corrected time only counts once HR has approved it.
const effOut = (a) => (a && a.outReq && a.outReq.status === "Approved") ? a.outReq.requested : (a ? a.checkOut : null);
// A work-from-home day that has been asked for (or already approved) lifts the geofence.
const wfhFor = (data, name, date) => (data.wfhRequests || []).find(r => r.employee === name && r.date === date && r.status !== "Rejected");
const dtOf = (iso) => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const dayCount = (from, to) => { const a = new Date(from), b = new Date(to); return Math.max(1, Math.round((b - a) / 86400000) + 1); };
const daysUntil = (d) => Math.round((new Date(d) - new Date()) / 86400000);
// Svype Leave Policy (see Leave Policy doc). 2026 figures are the prorated Aug-Dec entitlement;
// from 2027 onward the full annual entitlement applies. Bereavement is per qualifying event.
const LEAVE_POLICY = {
  Casual:      { full: 6,  y2026: 3 },
  Sick:        { full: 8,  y2026: 3 },
  Annual:      { full: 12, y2026: 5 },
  Bereavement: { full: 3,  y2026: 3, perEvent: true },
};
const LEAVE_TYPES = ["Casual","Sick","Annual","Bereavement","Unpaid"];
const entitlementFor = (type, year = new Date().getFullYear()) => {
  const p = LEAVE_POLICY[type]; if (!p) return null;
  return year === 2026 ? p.y2026 : p.full;
};
const CURRENCIES = ["PKR", "SAR", "AED", "GBP", "USD", "CAD"];

/* Pakistan salaried income-tax slabs (FY 2025–26, annual) — estimate */
function annualTax(a) {
  if (a <= 600000) return 0;
  if (a <= 1200000) return (a - 600000) * 0.01;
  if (a <= 2200000) return 6000 + (a - 1200000) * 0.11;
  if (a <= 3200000) return 116000 + (a - 2200000) * 0.23;
  if (a <= 4100000) return 346000 + (a - 3200000) * 0.30;
  return 616000 + (a - 4100000) * 0.35;
}
const EOBI = 250; // employee monthly contribution

function readImage(file, maxW = 700, asJpeg = false, quality = 0.82) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => { const img = new Image(); img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas"); c.width = img.width * scale; c.height = img.height * scale;
      const ctx = c.getContext("2d");
      if (asJpeg) { ctx.fillStyle = "#fff"; ctx.fillRect(0,0,c.width,c.height); } // white bg for jpeg
      ctx.drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL(asJpeg ? "image/jpeg" : "image/png", asJpeg ? quality : undefined));
    }; img.src = r.result; };
    r.readAsDataURL(file);
  });
}
function download(name, text) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name; a.click(); }
// Read ANY file (PDF, doc, image) as a base64 data URL so it can be stored and re-opened.
function readFile(file) {
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
}


// Works with both shapes: a legacy inline data URL, or a stored file reference.
const fileRef = (o, k) => {
  const raw = o && typeof o[k] === "string" ? o[k] : null;
  return {
    fileId: o && o[k + "FileId"],
    mime: (o && o[k + "Mime"]) || (raw ? (/^data:([^;,]+)/.exec(raw) || [])[1] : null),
    img: raw && raw.startsWith("data:image") ? raw : null,
    file: raw && !raw.startsWith("data:image") ? raw : null,
  };
};
// ===== File storage =====
// Uploaded files are kept in their own server table, not inside the shared data
// document. The document only holds a small id, so saving a record never re-uploads
// every file in the company (that is what was timing the server out).
async function uploadFile(dataUrl, name) {
  const m = /^data:([^;,]+)?(;base64)?,/i.exec(dataUrl || "");
  if (!m) return null;
  const r = await apiReq("POST", "/files", {
    name: name || "file",
    mime: m[1] || "application/octet-stream",
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
  });
  return { fileId: r.id, mime: m[1] || "application/octet-stream", size: r.size };
}
const fileUrl = (id) => `/api/files/${id}`;
async function fetchStoredBlob(fileId) {
  const res = await fetch(fileUrl(fileId), { headers: getChatToken() ? { Authorization: "Bearer " + getChatToken() } : {} });
  if (!res.ok) throw new Error("File not found on the server.");
  return await res.blob();
}
// Opens either a stored file (by id) or a legacy inline data URL.
async function openStored(ref, name) {
  try {
    if (ref && ref.fileId) {
      const blob = await fetchStoredBlob(ref.fileId);
      const url = URL.createObjectURL(blob);
      const w = window.open(url, "_blank");
      if (!w) { const a = document.createElement("a"); a.href = url; a.download = name || "file"; document.body.appendChild(a); a.click(); a.remove(); }
      setTimeout(()=>URL.revokeObjectURL(url), 60000);
      return;
    }
    openDataUrl((ref && (ref.file || ref.img || ref.data)) || null, name);
  } catch (e) {
    alert(e.message || "Couldn't open this file.");
  }
}
// A small preview for images, whether stored or inline.
function StoredImg({ d, className }) {
  const [src, setSrc] = useState(d?.img || null);
  useEffect(() => {
    let url = null, dead = false;
    if (!d?.img && d?.fileId && String(d.mime || "").startsWith("image/")) {
      fetchStoredBlob(d.fileId).then(b => { if (dead) return; url = URL.createObjectURL(b); setSrc(url); }).catch(()=>{});
    }
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [d?.fileId, d?.img]);
  if (!src) return null;
  return <img src={src} className={className}/>;
}

// Open a stored data URL (PDF/image/etc.) in a new tab.
function openDataUrl(dataUrl, name) {
  if (!dataUrl) { alert("This document has no stored file — it was uploaded before an earlier fix and only its name was saved. Please ask HR to re-upload it."); return; }
  try {
    const [meta, b64] = dataUrl.split(",");
    const mime = (meta.match(/data:(.*?);/) || [])[1] || "application/octet-stream";
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: mime }));
    // window.open must happen synchronously inside the tap for phones; download is the fallback.
    const w = window.open(url, "_blank");
    if (!w) { const a = document.createElement("a"); a.href = url; if (name) a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(()=>URL.revokeObjectURL(url), 60000);
  } catch {
    try { window.open(dataUrl, "_blank"); } catch { alert("Couldn't open this document on this device."); }
  }
}


async function identifyForChat(u){
  try{
    const role = u.role;
    const username = u.username || (u.name) || "user";
    const r = await apiReq("POST","/auth/identify",{ username, role });
    setChatToken(r.token);
    localStorage.setItem("svype_chat_uid", String(r.user.id));
  }catch(e){ console.error("chat identify failed", e); }
}
function chatSocket(onMessage){  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${getChatToken()}`);
  ws.onmessage = (e)=>{ try{ onMessage(JSON.parse(e.data)); }catch{} };
  return ws;
}
async function aiDraft(kind, fields, template){
  return apiReq("POST","/ai/draft",{ kind, fields, template });
}

/* ---------------- seed ---------------- */
const SEED = {
  employees: [],
  clients: [],
  attendance: [], leaves: [], payroll: [], advances: [], timesheets: [], vendorBills: [], bankAccounts: [], meetingNotes: [],
  candidates: [],
  invoices: [],
  payables: [],
  receivables: [],
  letters: [], proposals: [], quotations: [], offers: [],
  retainers: [],
  retainerInvoices: [],
  receipts: [],
  accounts: [],
  announcements: [],
  requests: [], audit: [],
  users: [],
  vault: [],
  vaultMeta: null,
  todos: [],
  wfhRequests: [],
  gigs: [],
};
const OFFICE_ADDRESSES = [
  { city: "Islamabad", address: "Floor 1, Nova, Business Square, Gulberg Greens, Islamabad." },
  { city: "Lahore", address: "71 C3, Facing Qarshi Park, Gulberg III, Lahore" },
];
const COMPANY_PHONE = "0327-7777201";
const COMPANY_EMAIL = "info@svype.net";
const COMPANY_WEB = "www.svype.com";
// Bumping BRAND_V pushes the company details below into an existing saved brand once.
const BRAND_V = 2;
const BRAND_DETAILS = {
  offices: OFFICE_ADDRESSES, phone: COMPANY_PHONE, email: COMPANY_EMAIL, website: COMPANY_WEB,
  address: OFFICE_ADDRESSES.map(o=>`${o.city}: ${o.address}`).join("  ·  "),
  contact: `${COMPANY_PHONE} · ${COMPANY_EMAIL} · ${COMPANY_WEB}`,
  brandV: BRAND_V,
};
const SEED_BRAND = { company: "Svype Tech Limited", tagline: "Digital Marketing & Creative Agency", accent: "#0284c7", logo: null, signatories: [], stamps: [], payslipSigId: "", payslipStampId: "", ...BRAND_DETAILS };

// Office geofence: check-in/out only allowed within RADIUS metres of an office.
const OFFICES = [
  { name: "Islamabad office", lat: 33.65028635688238, lng: 73.15295963866075 },
  { name: "Lahore office", lat: 31.505179320998522, lng: 74.34525968090706 },
];
const GEOFENCE_RADIUS_M = 300;
// Haversine distance in metres.
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// Returns the nearest office within radius, or null. { office, distance }
function nearestOffice(lat, lng) {
  let best = null;
  for (const o of OFFICES) {
    const d = distanceMeters(lat, lng, o.lat, o.lng);
    if (best === null || d < best.distance) best = { office: o.name, distance: d };
  }
  return best;
}

// Helpers for the billing schedule.
function pad2(n){ return String(n).padStart(2,"0"); }
function nextMonthInfo(from){
  // Given a date, return info about the NEXT month (the period being billed).
  const d = from ? new Date(from) : new Date();
  const y = d.getFullYear(), m = d.getMonth(); // 0-11
  const nm = m === 11 ? 0 : m+1;
  const ny = m === 11 ? y+1 : y;
  const key = `${ny}-${pad2(nm+1)}`;                       // e.g. 2026-07
  const label = new Date(ny, nm, 1).toLocaleString("default",{month:"long",year:"numeric"});
  const issue = `${ny}-${pad2(nm+1)}-01`;                   // 1st of next month
  const due = `${ny}-${pad2(nm+1)}-05`;                     // 5th of next month
  return { key, label, issue, due };
}

function currentMonthInfo(from){
  // The month just worked (postpaid billing): period = this month, due 5th of next month.
  const d = from ? new Date(from) : new Date();
  const y = d.getFullYear(), m = d.getMonth();
  const key = `${y}-${pad2(m+1)}`;
  const label = new Date(y, m, 1).toLocaleString("default",{month:"long",year:"numeric"});
  const nm = m === 11 ? 0 : m+1, ny = m === 11 ? y+1 : y;
  const due = `${ny}-${pad2(nm+1)}-05`;
  return { key, label, issue: today(), due };
}

// Build invoices for the upcoming billing cycle.
// HARD RULE: invoices are created ONLY when explicitly instructed (the "Generate now"
// button passes force=true). Any call without force is a no-op — there is no automatic
// path, on any date, ever.
function generateRetainerInvoices(db, force){
  if (!force) return db;
  const now = new Date();
  const pre = nextMonthInfo(now);      // Prepaid: pays for the UPCOMING month
  const post = currentMonthInfo(now);  // Postpaid: pays for the month just worked
  const inv = [...(db.retainerInvoices || [])];
  let changed = false;
  const rets = (db.retainers || []).map((r) => {
    if (r.status !== "Active") return r;
    const cyc = r.billing === "Postpaid" ? post : pre;
    const { key, label, issue, due } = cyc;
    // The only duplicate guard is whether an invoice for this client + cycle actually
    // EXISTS. (The old `lastGenCycle` marker also blocked generation, which silently
    // skipped clients whose invoices had been deleted — prepaid clients kept getting
    // skipped because their upcoming-month cycle was still stamped as "generated".)
    if (inv.some(i => i.retainerId === r.id && i.monthKey === key)) return r;
    const base = +r.amount || 0, carry = +r.carry || 0;
    inv.push({ id: uid(), retainerId: r.id, client: r.client, number: `RET-${key.replace("-", "")}-${inv.length + 1}`, monthKey: key, month: label, billing: r.billing||"Prepaid", base, carry, total: base + carry, currency: r.currency || "PKR", status: "Unpaid", paidAmount: 0, account: "", date: issue, due, paidDate: "" });
    changed = true; return { ...r, carry: 0, lastGenCycle: key };
  });
  return changed ? { ...db, retainerInvoices: inv, retainers: rets } : db;
}

/* ---------------- notifications + search ---------------- */
function adminNotes(data) {
  const out = [];
  data.retainerInvoices.filter(i=>i.status!=="Paid").forEach(i=>out.push({ text:`${i.client}: retainer ${fmt(i.total,i.currency)} unpaid`, tab:"retainers" }));
  data.receivables.filter(r=>r.status==="Overdue").forEach(r=>out.push({ text:`${r.client}: receivable overdue`, tab:"receivables" }));
  data.payables.filter(p=>p.kind==="reimbursement" && p.status==="Pending").forEach(p=>out.push({ text:`${p.vendor}: reimbursement to approve`, tab:"payables" }));
  data.leaves.filter(l=>l.status==="Pending").forEach(l=>out.push({ text:`${l.employee}: ${l.type||""} leave ${l.from} → ${l.to} (${dayCount(l.from,l.to)}d) awaiting approval`, tab:"requests" }));
  (data.attendance||[]).filter(a=>a.timeReq && a.timeReq.status==="Pending").forEach(a=>out.push({ text:`${a.employee}: check-in time correction for ${a.date} awaiting approval`, tab:"requests" }));
  (data.attendance||[]).filter(a=>a.outReq && a.outReq.status==="Pending").forEach(a=>out.push({ text:`${a.employee}: check-out time correction for ${a.date} awaiting approval`, tab:"requests" }));
  (data.wfhRequests||[]).filter(w=>w.status==="Pending").forEach(w=>out.push({ text:`${w.employee}: work from home on ${w.date} awaiting approval`, tab:"requests" }));
  (data.payables||[]).filter(p=>p.kind==="reimbursement" && p.status==="Pending" && (p.appeals||[]).length>0).forEach(p=>out.push({ text:`${p.vendor} appealed a rejected claim: ${p.desc.replace("Reimbursement: ","")}`, tab:"payables" }));
  data.requests.filter(r=>r.status!=="Done").forEach(r=>out.push({ text:`${r.employee}: ${r.type}`, tab:"requests" }));
  data.employees.forEach(e=>(e.docs||[]).forEach(d=>{ if(d.expiry){ const dd=daysUntil(d.expiry); if(dd<=30) out.push({ text:`${e.name}: ${d.name} ${dd<0?"expired":"expires in "+dd+"d"}`, tab:"employees" }); }}));
  return out;
}
function empNotes(data, me) {
  const out = [];
  (data.requests||[]).filter(r=>r.employee===me.name && r.status==="Done").slice(0,3).forEach(r=>out.push({ text:`Your ${r.type} is ready — collect it from HR`, tab:"payslips" }));
  (data.attendance||[]).filter(a=>a.employee===me.name && a.timeReq && a.timeReq.status!=="Pending").slice(-3).forEach(a=>out.push({ text:`Your check-in correction for ${a.date} was ${a.timeReq.status==="Approved"?"approved ✓":"declined — the recorded time stands"}`, tab:"attendance" }));
  (data.attendance||[]).filter(a=>a.employee===me.name && a.outReq && a.outReq.status!=="Pending").slice(-3).forEach(a=>out.push({ text:`Your check-out correction for ${a.date} was ${a.outReq.status==="Approved"?"approved ✓":"declined — the recorded time stands"}`, tab:"attendance" }));
  (data.wfhRequests||[]).filter(w=>w.employee===me.name && w.status!=="Pending").slice(-3).forEach(w=>out.push({ text:`Your work-from-home request for ${w.date} was ${w.status==="Approved"?"approved ✓":"declined"}`, tab:"attendance" }));
  (data.payables||[]).filter(p=>p.kind==="reimbursement" && p.vendor===me.name && p.status==="Rejected").slice(-3).forEach(p=>out.push({ text:`Your claim "${p.desc.replace("Reimbursement: ","")}" was rejected${p.finalRejected?" (final)":" — you can appeal"}`, tab:"expenses" }));
  [...data.leaves].filter(l=>l.employee===me.name && l.status!=="Pending").sort((a,b)=>(b.decidedOn||"").localeCompare(a.decidedOn||"")).slice(0,5).forEach(l=>out.push({ text:`Your ${l.type||""} leave (${l.from} → ${l.to}) was ${l.status==="Approved"?"approved ✓":"declined"}`, tab:"attendance" }));
  data.payables.filter(p=>p.kind==="reimbursement" && p.vendor===me.name && p.status!=="Pending").slice(0,5).forEach(p=>out.push({ text:`Expense claim: ${p.status}`, tab:"expenses" }));
  return out;
}
function searchAll(data, q) {
  q = q.toLowerCase().trim(); if (!q) return [];
  const r = [];
  data.employees.filter(e=>e.name.toLowerCase().includes(q)).forEach(e=>r.push({ label:e.name, sub:"Employee", tab:"employees" }));
  data.clients.filter(c=>c.name.toLowerCase().includes(q)).forEach(c=>r.push({ label:c.name, sub:"Client", tab:"clients" }));
  data.invoices.filter(i=>(i.number+" "+i.client).toLowerCase().includes(q)).forEach(i=>r.push({ label:`${i.number} · ${i.client}`, sub:"Invoice", tab:"invoices" }));
  data.quotations.filter(i=>((i.number||"")+" "+(i.client||"")).toLowerCase().includes(q)).forEach(i=>r.push({ label:`${i.number} · ${i.client}`, sub:"Quotation", tab:"quotations" }));
  data.proposals.filter(p=>((p.client||"")+" "+(p.title||"")).toLowerCase().includes(q)).forEach(p=>r.push({ label:p.title||p.client, sub:"Proposal", tab:"proposals" }));
  data.retainers.filter(c=>c.client.toLowerCase().includes(q)).forEach(c=>r.push({ label:c.client, sub:"Retainer", tab:"retainers" }));
  return r.slice(0, 8);
}

const ROLES = { admin: "Founder (Admin)", hr: "HR / PM", employee: "Employee" };
const NAV = [
  { id:"dash", label:"Dashboard", icon:LayoutDashboard },
  { id:"employees", label:"Employees", icon:Users },
  { id:"users", label:"Users & Access", icon:UserCircle },
  { id:"permissions", label:"Permissions", icon:Settings, adminOnly:true },
  { id:"clients", label:"Clients", icon:Contact },
  { id:"attendance", label:"Attendance & Leave", icon:CalendarCheck },
  { id:"todos", label:"Team To-dos", icon:CalendarCheck },
  { id:"gigs", label:"Freelance Projects", icon:Briefcase },
  { id:"payroll", label:"Payroll & Slips", icon:Wallet },
  { id:"advances", label:"Advances & Loans", icon:HandCoins },
  { id:"vendorbills", label:"Vendor Bills", icon:Receipt },
  { id:"timesheets", label:"Work & Timesheets", icon:Clock },
  { id:"meetings", label:"Meeting Notes", icon:FileText },
  { id:"recruit", label:"Recruitment", icon:UserPlus },
  { id:"cvbank", label:"CV Bank", icon:FolderOpen },
  { id:"offers", label:"Offer Letters", icon:FileSignature },
  { id:"letters", label:"Letters & Certificates", icon:ScrollText },
  { id:"requests", label:"HR Requests", icon:Inbox },
  { id:"announce", label:"Announcements", icon:Megaphone },
  { id:"proposals", label:"Proposals", icon:FileText },
  { id:"quotations", label:"Quotations", icon:Receipt },
  { id:"retainers", label:"Retainers", icon:Repeat },
  { id:"invoices", label:"Invoices & Receipts", icon:FolderOpen },
  { id:"receipts", label:"Receipts", icon:Receipt },
  { id:"payables", label:"Payables", icon:ArrowUpCircle },
  { id:"receivables", label:"Receivables", icon:ArrowDownCircle },
  { id:"accounts", label:"Bank Accounts", icon:Landmark },
  { id:"brand", label:"Brand & Signatures", icon:Settings },
  { id:"vault", label:"Vault", icon:Settings },
  { id:"audit", label:"Activity Log", icon:History },
  { id:"backup", label:"Backup & Data", icon:Database },
];

// Grouped navigation: each top-level section opens to a page with sub-tabs.
const NAV_GROUPS = [
  { id:"dash", label:"Dashboard", icon:LayoutDashboard, tabs:["dash"] },
  { id:"people", label:"People", icon:Users, tabs:["employees","attendance","todos","payroll","gigs","advances","recruit","cvbank"] },
  { id:"sales", label:"Clients & Sales", icon:Contact, tabs:["clients","proposals","quotations","retainers","invoices","receipts"] },
  { id:"finance", label:"Finance", icon:Wallet, tabs:["payables","receivables","vendorbills","accounts"] },
  { id:"documents", label:"Documents", icon:FileSignature, tabs:["offers","letters","meetings"] },
  { id:"workspace", label:"Workspace", icon:Inbox, tabs:["requests","announce","timesheets"] },
  { id:"settings", label:"Settings", icon:Settings, adminOnly:true, bottom:true, tabs:["users","permissions","vault","brand","email","audit","backup"] },
];
// Friendly labels for sub-tabs (override the long sidebar labels inside a section)
const TAB_LABELS = {
  dash:"Dashboard", chat:"Team Chat", email:"Email (sending)",
  employees:"Employees", attendance:"Attendance & Leave", todos:"Team To-dos", gigs:"Freelance Projects", payroll:"Payroll & Slips", advances:"Advances & Loans", recruit:"Recruitment", cvbank:"CV Bank",
  clients:"Clients", proposals:"Proposals", quotations:"Quotations", retainers:"Retainers", invoices:"Invoices", receipts:"Receipts",
  payables:"Payables", receivables:"Receivables", vendorbills:"Vendor Bills", accounts:"Bank Accounts",
  offers:"Offer Letters", letters:"Letters & Certificates", meetings:"Meeting Notes",
  requests:"HR Requests", announce:"Announcements", timesheets:"Work & Timesheets",
  users:"Users & Access", permissions:"Permissions", vault:"Vault", brand:"Brand & Signatures", audit:"Activity Log", backup:"Backup & Data",
};
const groupOfTab = (tabId) => NAV_GROUPS.find(g => g.tabs.includes(tabId)) || NAV_GROUPS[0];
const EMP_NAV = [
  { id:"dash", label:"Home", icon:LayoutDashboard },
  { id:"profile", label:"My Profile", icon:UserCircle },
  { id:"attendance", label:"Attendance & Leave", icon:CalendarCheck },
  { id:"todos", label:"My To-dos", icon:CalendarCheck },
  { id:"gigs", label:"My Projects", icon:Briefcase },
  { id:"payslips", label:"Payslips", icon:Wallet },
  { id:"timesheet", label:"Daily Work Log", icon:Clock },
  { id:"meetings", label:"Meeting Notes", icon:FileText },
  { id:"expenses", label:"Expense Claims", icon:Receipt },
];

export default function App() {
  const [loading, setLoading] = useState(true);
  const [session, setSessionRaw] = useState(() => {
    try { const s = localStorage.getItem("svype_session"); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const setSession = (s) => {
    setSessionRaw(s);
    try { s ? localStorage.setItem("svype_session", JSON.stringify(s)) : localStorage.removeItem("svype_session"); } catch {}
  };
  const [tab, setTab] = useState("dash");
  const [navOpen, setNavOpen] = useState(false);
  const [data, setData] = useState(SEED);
  const dataRef = useRef(SEED); dataRef.current = data;
  const [brand, setBrand] = useState(SEED_BRAND);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [serverHasFounders, setServerHasFounders] = useState(null); // null = unknown yet

  useEffect(() => { (async () => {
    // Ask the SERVER (the database) whether any founder/staff account exists.
    // This is the single source of truth and is shared across every domain.
    let serverFounders = null;
    try {
      const st = await apiReq("GET", "/auth/state");
      serverFounders = !!st.hasFounders;
    } catch { serverFounders = null; }
    setServerHasFounders(serverFounders);

    const d = await DB.get("svype_db", null);
    let merged = d ? { ...SEED, ...d } : SEED;
    initSaveState(d || null, _stateCache.rev); // conflict-safe saves start from the fetched revision
    setData(merged);
    if (!d && serverFounders === false) DB.set("svype_db", merged); // only seed empty doc on a genuine fresh install
    const b = await DB.get("svype_brand", null);
    if (b) {
      // Fill in the company addresses/contact once, without touching anything else.
      if ((b.brandV || 0) < BRAND_V) {
        const upgraded = { ...b, ...BRAND_DETAILS };
        setBrand(upgraded);
        try { await DB.set("svype_brand", upgraded); } catch {}
      } else setBrand(b);
    }
    else {
      // No token on this device yet (brand-new browser): fetch just the public brand
      // so the login screen still shows the company logo and colours.
      let pubBrand = null;
      try { const bs = await apiReq("GET", "/auth/bootstrap"); pubBrand = bs?.brand || null; } catch {}
      if (pubBrand) setBrand(pubBrand);
      else if (serverFounders === false) { await DB.set("svype_brand", SEED_BRAND); setNeedsSetup(true); }
    }
    try {
      const s = localStorage.getItem("svype_session");
      if (s && !getChatToken()) await identifyForChat(JSON.parse(s));
    } catch {}
    setLoading(false);
  })(); }, []);


  // A focused number field changes value when the mouse wheel rolls over it — that is
  // how a typed 100,000 silently became 99,998. Block it everywhere.
  useEffect(() => {
    const onWheel = (e) => {
      const el = document.activeElement;
      if (el && el.tagName === "INPUT" && el.type === "number" && (el === e.target || el.contains(e.target))) {
        e.preventDefault();
        el.blur();
      }
    };
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => document.removeEventListener("wheel", onWheel);
  }, []);

  // Anti-staleness: quietly re-fetch the latest data every 60s and whenever the tab regains
  // focus, so a tab left open all day never saves on top of hours-old data.
  useEffect(() => {
    const tick = async () => {
      if (_saving || _saveQueue.length) return; // never interrupt our own pending saves
      try {
        const st = await apiReq("GET", "/state?knownRev=" + _rev);
        if (st && st.unchanged) {
          if (st.build && st.build !== APP_BUILD) { const k = "svype_reload_" + st.build; if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k, "1"); _setSaveStatus("updating"); setTimeout(()=>window.location.reload(), 1200); } }
          return;
        }
        if (st && st.build && st.build !== APP_BUILD) {
          // A newer version is deployed. Reload once so this device can't keep running
          // old code (stale builds were overwriting fresh data with old lists).
          const k = "svype_reload_" + st.build;
          if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k, "1"); _setSaveStatus("updating"); setTimeout(()=>window.location.reload(), 1200); return; }
        }
        if (st && st.doc && +st.rev > _rev) { initSaveState(st.doc, +st.rev); setData({ ...SEED, ...st.doc }); }
      } catch {}
    };
    const iv = setInterval(tick, 60000);
    const onVis = () => { if (document.visibilityState === "visible") tick(); };
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVis); // phones fire this when you return to the app
    return () => { clearInterval(iv); window.removeEventListener("focus", tick); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  const role = session?.role || null;
  const meId = session?.empId || null;
  const who = () => role === "employee" ? (data.employees.find(e=>e.id===meId)?.name || session?.username || "Employee") : (ROLES[role] || "System");
  const auditEntry = (msg) => ({ id:uid(), who:who(), action:msg, date:new Date().toISOString() });
  // Always merge against the freshest state (functional updater) so two quick saves never clobber each other.
  const commit = (mutate, msg) => {
    const fullMutate = (curIn) => {
      const cur = curIn || SEED;
      let next = mutate(cur);
      if (msg) next = { ...next, audit: [auditEntry(msg), ...(cur.audit||[])].slice(0,500) };
      return next;
    };
    setData((cur) => fullMutate(cur));                       // instant UI update
    return enqueueSave(fullMutate, (merged) => setData({ ...SEED, ...merged })); // resolves when server confirms
  };
  const persist = (n) => commit(() => n);
  const update = (k, rows, audit) => {
    // Capture what this tab believed the list was at the moment of saving, so mergeRows can
    // compute the tab's actual adds/edits/deletes and apply only those to the freshest data.
    const before = (dataRef.current && dataRef.current[k]) || [];
    return commit((cur) => ({ ...cur, [k]: mergeRows(cur[k] || [], before, rows) }), audit);
  };
  const patch = (obj, audit) => { return commit((cur) => ({ ...cur, ...obj }), audit); };
  const saveBrand = (b) => { setBrand(b); DB.set("svype_brand", b); };
  const restore = (db, br) => { if (db) commit(() => ({ ...SEED, ...db })); if (br) saveBrand(br); };
  const wipe = () => { const fresh = JSON.parse(JSON.stringify(SEED)); DB.set("svype_db", fresh); DB.set("svype_brand", SEED_BRAND); setData(fresh); setBrand(SEED_BRAND); setSession(null); setTab("dash"); };
  const reset = () => { setSession(null); setTab("dash"); };

  if (loading) return <div className="min-h-screen grid place-items-center bg-slate-50 text-sky-600"><Loader2 className="animate-spin"/></div>;
  const localHasFounders = (data.users||[]).some(u=>u.role==="admin" || u.role==="hr");
  // First-run setup is shown ONLY when the database itself confirms there are no founder/staff
  // accounts yet (a genuinely fresh install). If the server says founders exist, or we cannot
  // reach the server, we NEVER show setup — we show Login. This prevents anyone from hitting the
  // setup screen and creating an account on an already-initialised system.
  const showSetup = serverHasFounders === false && !localHasFounders;
  if (showSetup) return <FirstRunSetup data={data} brand={brand} onCreate={(u)=>{ update("users", [...(data.users||[]), u], `Created first ${u.role} account "${u.username}"`); }}/>;
  if (session && session.mustChange) return <SetPassword session={session} data={data} brand={brand} update={update}
    onDone={(u)=>setSession(u)}
    onSignOut={()=>{ setSession(null); try { setChatToken(null); localStorage.removeItem("svype_session"); } catch {} }}/>;
  if (!session) return <Login data={data} brand={brand}
    onHydrate={(d)=>{ if (d.token) setChatToken(d.token); if (d.doc) { initSaveState(d.doc, +d.rev||0); setData({ ...SEED, ...d.doc }); } if (d.brand) setBrand(d.brand); }}
    onLogin={(u)=>{ identifyForChat(u); setSession(u); setTab("dash"); }}/>;
  if (needsSetup && role !== "employee") return <BrandSetup brand={brand} saveBrand={saveBrand} done={()=>setNeedsSetup(false)} />;

  const isEmp = role === "employee";
  const me = isEmp ? data.employees.find(e=>e.id===meId) : null;
  const perms = session?.perms || null; // null/undefined = full access
  const canSeeTab = (id) => {
    // HR has the same reach as the founder by default. Per-user permissions still
    // apply, so the founder can still narrow a specific HR login if they choose.
    if (id === "permissions" && role !== "admin" && role !== "hr") return false;
    if (role === "admin") return true;
    if (id === "dash") return true;
    if (!perms) return true;
    return perms[id] !== false;
  };
  // Employee uses the flat nav; admin uses grouped nav.
  const canSeeEmp = (n) => n.id !== "gigs" || (me && me.payType === "Freelance");
  const empVisible = EMP_NAV.filter(canSeeEmp);
  // For admins, filter groups to those with at least one visible tab.
  const groups = NAV_GROUPS
    .filter(g => !(g.adminOnly && role !== "admin" && role !== "hr"))
    .map(g => ({ ...g, tabs: g.tabs.filter(canSeeTab) }))
    .filter(g => g.tabs.length > 0);
  const allTabs = isEmp ? empVisible.map(n=>n.id) : groups.flatMap(g=>g.tabs);
  const active = allTabs.includes(tab) ? tab : "dash";
  const activeGroup = isEmp ? null : groupOfTab(active);
  const notes = isEmp && me ? empNotes(data, me) : adminNotes(data);
  const props = { data, update, patch, mutateData: commit, role, brand, saveBrand, me, restore, wipe, session, go:setTab };

  return (
    <div className="h-screen overflow-hidden flex bg-slate-50 text-slate-800 font-sans">
      {navOpen && <div className="fixed inset-0 z-40 lg:hidden" style={{background:"rgba(15,23,42,.5)"}} onClick={()=>setNavOpen(false)}/>}
      <aside className={`fixed lg:static z-50 inset-y-0 left-0 w-60 shrink-0 h-screen bg-slate-900 text-slate-300 flex flex-col transition-transform duration-200 ${navOpen?"translate-x-0":"-translate-x-full"} lg:translate-x-0`}>
        <div className="px-5 py-5 flex items-center gap-2 border-b border-slate-700">
          {brand.logo ? <img src={brand.logo} className="w-8 h-8 rounded-lg object-contain bg-slate-800"/> : <div className="w-8 h-8 rounded-lg bg-sky-600 grid place-items-center text-white font-black">S</div>}
          <div className="flex-1 min-w-0"><div className="font-bold tracking-tight leading-none text-sm text-white truncate">{brand.company}</div><div className="text-xs text-slate-400 uppercase tracking-widest">{isEmp?"Team Portal":"HR & Ops"}</div></div>
          <button onClick={()=>setNavOpen(false)} className="lg:hidden text-slate-400 hover:text-white"><X size={18}/></button>
        </div>
        <nav className="flex-1 py-3 overflow-y-auto">
          {isEmp
            ? empVisible.map(n=>{ const I=n.icon; return (
                <button key={n.id} onClick={()=>{setTab(n.id);setNavOpen(false);}} className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm transition ${active===n.id?"bg-slate-800 text-white border-r-2 border-sky-500":"text-slate-400 hover:text-white hover:bg-slate-800"}`}>
                  <I size={17}/> {n.label}</button>); })
            : groups.filter(g=>!g.bottom).map(g=>{ const I=g.icon; const on=activeGroup?.id===g.id; return (
                <button key={g.id} onClick={()=>{ setTab(g.tabs[0]); setNavOpen(false); }} className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm transition ${on?"bg-slate-800 text-white border-r-2 border-sky-500":"text-slate-400 hover:text-white hover:bg-slate-800"}`}>
                  <I size={17}/> {g.label}</button>); })}
        </nav>
        <div className="border-t border-slate-700">
          {!isEmp && groups.filter(g=>g.bottom).map(g=>{ const I=g.icon; const on=activeGroup?.id===g.id; return (
            <button key={g.id} onClick={()=>{ setTab(g.tabs[0]); setNavOpen(false); }} className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm transition ${on?"bg-slate-800 text-white border-r-2 border-sky-500":"text-slate-400 hover:text-white hover:bg-slate-800"}`}>
              <I size={17}/> {g.label}</button>); })}
        </div>
        <div className="p-4 border-t border-slate-700">
          <div className="text-xs text-slate-400 mb-2">{isEmp && me ? me.name : ROLES[role]}</div>
          <button onClick={reset} className="flex items-center gap-2 text-sm text-slate-300 hover:text-white"><LogOut size={15}/>Sign out</button>
          <div className="text-[10px] text-slate-500 mt-2">{APP_BUILD}</div>
        </div>
      </aside>

      <SaveStatus/>
      <main className="flex-1 min-w-0 overflow-y-auto">
        <ErrorBoundary key={active}>
        <div className="sticky top-0 z-30 flex items-center gap-3 px-4 py-2.5 bg-white border-b border-slate-200">
          <button onClick={()=>setNavOpen(true)} className="lg:hidden text-slate-600"><Menu size={22}/></button>
          {!isEmp ? <GlobalSearch data={data} go={setTab}/> : <div className="font-semibold text-sm text-slate-700">Team Portal</div>}
          <div className="flex-1"/>
          <NotifBell items={notes} go={setTab}/>
        </div>
        {/* sub-tab bar for grouped admin sections with more than one tab */}
        {!isEmp && activeGroup && activeGroup.tabs.length > 1 && (
          <div className="sticky top-[49px] z-20 bg-white border-b border-slate-200 px-4 sm:px-8">
            <div className="max-w-6xl mx-auto flex gap-1 overflow-x-auto">
              {activeGroup.tabs.map(t=>(
                <button key={t} onClick={()=>setTab(t)} className={`px-3 py-2.5 text-sm whitespace-nowrap border-b-2 transition ${active===t?"border-sky-500 text-sky-700 font-medium":"border-transparent text-slate-500 hover:text-slate-800"}`}>{TAB_LABELS[t]||t}</button>
              ))}
            </div>
          </div>
        )}
        <div className="max-w-6xl mx-auto px-4 sm:px-8 py-6 sm:py-8">
          {isEmp ? (
            (!me && active!=="chat") ? (
              <div className="max-w-md mx-auto mt-10 bg-white border border-slate-200 rounded-xl p-6 text-center">
                <div className="font-semibold text-slate-900 mb-1">Your login isn't linked to an employee profile yet</div>
                <p className="text-sm text-slate-500">Ask HR to open <b>Users &amp; Access</b>, edit your login, and set <b>“Which staff member is this login for?”</b> to your name. Once linked, your profile, payslips, attendance and claims will appear here. You can still use Team Chat in the meantime.</p>
              </div>
            ) : (<>
            {active==="dash" && <EmpDashboard {...props}/>}
            {active==="chat" && <TeamChat session={session}/>}
            {active==="profile" && <EmpProfile {...props}/>}
            {active==="attendance" && <EmpAttendance {...props}/>}
            {active==="todos" && <MyTodos {...props}/>}
            {active==="gigs" && <MyProjects {...props}/>}
            {active==="payslips" && <EmpPayslips {...props}/>}
            {active==="timesheet" && <EmpTimesheet {...props}/>}
            {active==="meetings" && <EmpMeetings {...props}/>}
            {active==="expenses" && <EmpExpenses {...props}/>}
          </>)) : (<>
            {active==="dash" && <Dashboard {...props}/>}
            {active==="todos" && <TeamTodos {...props}/>}
            {active==="gigs" && <Gigs {...props}/>}
            {active==="chat" && <TeamChat session={session}/>}
            {active==="employees" && <Employees {...props}/>}
            {active==="users" && <UsersAccess {...props}/>}
            {active==="permissions" && <Permissions {...props}/>}
            {active==="email" && <EmailSettings {...props}/>}
            {active==="clients" && <Clients {...props}/>}
            {active==="attendance" && <Attendance {...props}/>}
            {active==="payroll" && <Payroll {...props}/>}
            {active==="advances" && <Advances {...props}/>}
            {active==="vendorbills" && <VendorBills {...props}/>}
            {active==="timesheets" && <Timesheets {...props}/>}
            {active==="meetings" && <MeetingNotes {...props}/>}
            {active==="recruit" && <Recruit {...props}/>}
            {active==="cvbank" && <CVBank {...props}/>}
            {active==="offers" && <Offers {...props}/>}
            {active==="letters" && <Letters {...props}/>}
            {active==="requests" && <Requests {...props}/>}
            {active==="announce" && <Announcements {...props}/>}
            {active==="proposals" && <Proposals {...props}/>}
            {active==="quotations" && <Quotations {...props}/>}
            {active==="retainers" && <Retainers {...props}/>}
            {active==="invoices" && <Invoices {...props}/>}
            {active==="receipts" && <Receipts {...props}/>}
            {active==="payables" && <Payables {...props}/>}
            {active==="receivables" && <Receivables {...props}/>}
            {active==="accounts" && <BankAccounts {...props}/>}
            {active==="brand" && <BrandSettings {...props}/>}
            {active==="audit" && <Audit {...props}/>}
            {active==="backup" && <Backup {...props}/>}
            {active==="vault" && <Vault {...props}/>}
          </>)}
        </div>
        </ErrorBoundary>
      </main>
    </div>
  );
}

/* ---------------- header widgets ---------------- */
function GlobalSearch({ data, go }) {
  const [q, setQ] = useState(""); const [open, setOpen] = useState(false);
  const results = searchAll(data, q);
  return (
    <div className="relative w-full max-w-xs">
      <Search size={15} className="absolute left-3 top-2.5 text-slate-400"/>
      <input value={q} onChange={e=>{setQ(e.target.value);setOpen(true);}} onFocus={()=>setOpen(true)} placeholder="Search anything…" className="w-full bg-slate-100 border border-transparent rounded-lg pl-9 pr-3 py-1.5 text-sm outline-none focus:bg-white focus:border-sky-500"/>
      {open && q && <>
        <div className="fixed inset-0 z-20" onClick={()=>setOpen(false)}/>
        <div className="absolute z-30 mt-1 w-72 max-w-[calc(100vw-4.5rem)] bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
          {results.length===0?<div className="px-4 py-3 text-sm text-slate-400">No matches</div>:results.map((r,i)=>(
            <button key={i} onClick={()=>{go(r.tab);setOpen(false);setQ("");}} className="w-full text-left px-4 py-2.5 hover:bg-slate-50 flex items-center justify-between">
              <span className="text-sm">{r.label}</span><span className="text-xs text-slate-400">{r.sub}</span></button>))}
        </div></>}
    </div>
  );
}
function NotifBell({ items, go }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={()=>setOpen(o=>!o)} className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100"><Bell size={19}/>
        {items.length>0 && <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-rose-500 text-white text-xs grid place-items-center">{items.length}</span>}</button>
      {open && <>
        <div className="fixed inset-0 z-20" onClick={()=>setOpen(false)}/>
        <div className="absolute right-0 z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-200 font-semibold text-sm">Notifications</div>
          {items.length===0?<div className="px-4 py-6 text-sm text-slate-400 text-center">You're all caught up</div>:
            <div className="max-h-80 overflow-y-auto">{items.map((n,i)=>(
              <button key={i} onClick={()=>{go(n.tab);setOpen(false);}} className="w-full text-left px-4 py-2.5 hover:bg-slate-50 text-sm border-b border-slate-100 last:border-0">{n.text}</button>))}</div>}
        </div></>}
    </div>
  );
}

/* ---------------- first-run: create founding accounts ---------------- */
function FirstRunSetup({ data, brand, onCreate }) {
  const made = data.users || [];
  const hasAdmin = made.some(u=>u.role==="admin");
  const hasHr = made.some(u=>u.role==="hr");
  const [role, setRole] = useState(hasAdmin ? "hr" : "admin");
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [err, setErr] = useState("");
  const create = () => {
    if (!u.trim() || !p) { setErr("Enter a username and password."); return; }
    if (made.some(x=>x.username.toLowerCase()===u.trim().toLowerCase())) { setErr("That username is taken."); return; }
    onCreate({ id:uid(), username:u.trim().toLowerCase(), password:p, role, empId:null, active:true });
    setU(""); setP(""); setErr("");
  };
  return (<div className="min-h-screen grid place-items-center bg-slate-900 text-white p-4"><div className="max-w-sm w-full">
    <div className="text-center mb-7">
      {brand.logo ? <img src={brand.logo} className="w-16 h-16 rounded-2xl object-contain bg-slate-800 mx-auto mb-5"/> : <div className="w-14 h-14 rounded-2xl bg-sky-600 grid place-items-center text-white font-black text-2xl mx-auto mb-5">S</div>}
      <h1 className="text-2xl font-bold tracking-tight">Welcome to {brand.company}</h1>
      <p className="text-slate-400 text-sm mt-1">First-time setup — create your founding accounts. Whatever you enter becomes that role's first login.</p>
    </div>
    <div className="bg-slate-800 border border-slate-700 rounded-2xl p-5 space-y-4">
      <div className="flex gap-2">
        <button disabled={hasAdmin} onClick={()=>setRole("admin")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${role==="admin"?"bg-sky-600 text-white":"bg-slate-700 text-slate-300"} ${hasAdmin?"opacity-50":""}`}>Super Admin {hasAdmin?"✓":""}</button>
        <button disabled={hasHr} onClick={()=>setRole("hr")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${role==="hr"?"bg-sky-600 text-white":"bg-slate-700 text-slate-300"} ${hasHr?"opacity-50":""}`}>HR {hasHr?"✓":""}</button>
      </div>
      <div><span className="text-xs text-slate-400 mb-1 block">Username for {role==="admin"?"Super Admin":"HR"}</span><input value={u} onChange={e=>{setU(e.target.value);setErr("");}} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-sky-500" placeholder="choose a username"/></div>
      <div><span className="text-xs text-slate-400 mb-1 block">Password</span><input type="password" value={p} onChange={e=>{setP(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&create()} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-sky-500" placeholder="choose a password"/></div>
      {err && <div className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div>}
      <button onClick={create} className="w-full py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-medium">Create {role==="admin"?"Super Admin":"HR"} account</button>
      {(hasAdmin||hasHr) && <div className="text-xs text-slate-400 text-center">Created: {made.map(m=>`${m.username} (${ROLES[m.role]})`).join(", ")}</div>}
      {hasAdmin && hasHr && <div className="text-sm text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2 text-center">Both accounts created — reload or it will continue to the login screen automatically.</div>}
    </div>
    <p className="text-xs text-slate-500 mt-4 text-center">You can create one or both now. Employee logins are added later from Users &amp; Access.</p>
  </div></div>);
}

/* ---------------- login (username + password) ---------------- */

// A render error used to blank the whole screen with no clue what happened. This shows
// what broke and lets the person carry on working elsewhere.
class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { try { console.error("Svype OS error:", err, info); } catch {} }
  render() {
    if (!this.state.err) return this.props.children;
    return (<div className="p-6">
      <div className="max-w-lg mx-auto bg-white border border-rose-200 rounded-2xl p-6 text-center">
        <div className="w-11 h-11 rounded-full bg-rose-100 text-rose-600 grid place-items-center text-xl font-bold mx-auto">!</div>
        <div className="font-semibold text-slate-900 mt-3">This screen hit a problem</div>
        <p className="text-sm text-slate-500 mt-1">Nothing has been lost — your saved data is safe. Please screenshot the detail below and send it over.</p>
        <pre className="text-xs text-left bg-slate-50 border border-slate-200 rounded-lg p-3 mt-3 overflow-auto max-h-40 whitespace-pre-wrap">{String(this.state.err && (this.state.err.stack || this.state.err.message || this.state.err))}</pre>
        <div className="flex gap-2 justify-center mt-4">
          <Btn onClick={()=>this.setState({ err:null })}><ChevronLeft size={15}/>Go back</Btn>
          <Btn variant="ghost" onClick={()=>window.location.reload()}>Reload the portal</Btn>
        </div>
      </div>
    </div>);
  }
}
function SaveStatus() {
  // BLOCKING save dialog: while a save is in flight the whole screen is locked —
  // nothing else can be done until the server confirms. Brief green tick on success.
  const [st, setSt] = useState(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    let hideT;
    onSaveStatus((v) => {
      setSt(v); setShow(true);
      clearTimeout(hideT);
      if (v === "saved") hideT = setTimeout(()=>setShow(false), 700);
    });
    return () => onSaveStatus(null);
  }, []);
  if (!show || !st) return null;
  const wrap = "fixed inset-0 z-[200] grid place-items-center";
  const card = "bg-white rounded-2xl shadow-2xl px-8 py-6 flex flex-col items-center gap-3 min-w-[260px] text-center";
  if (st === "saving") return (<div className={wrap} style={{background:"rgba(15,23,42,.45)"}}>
    <div className={card}><Loader2 size={30} className="animate-spin text-sky-600"/><div className="font-semibold text-slate-900">Saving…</div><div className="text-xs text-slate-500">Please wait — don't close this tab.</div></div></div>);
  if (st === "updating") return (<div className={wrap} style={{background:"rgba(15,23,42,.45)"}}>
    <div className={card}><Loader2 size={30} className="animate-spin text-sky-600"/><div className="font-semibold text-slate-900">Updating to the latest version…</div><div className="text-xs text-slate-500">The app will reload in a moment.</div></div></div>);
  if (st === "error") return (<div className={wrap} style={{background:"rgba(15,23,42,.45)"}}>
    <div className={card}><div className="w-10 h-10 rounded-full bg-rose-100 text-rose-600 grid place-items-center text-xl font-bold">!</div><div className="font-semibold text-rose-600">Could not save</div><div className="text-xs text-slate-500 max-w-[240px]">Your last change didn't reach the server. Check your connection, then try again.</div><Btn onClick={()=>setShow(false)}>Close</Btn></div></div>);
  return (<div className={wrap} style={{background:"rgba(15,23,42,.25)"}}>
    <div className={card}><div className="w-10 h-10 rounded-full bg-emerald-500 text-white grid place-items-center"><Check size={22}/></div><div className="font-semibold text-emerald-600">Saved</div></div></div>);
}
function SetPassword({ session, data, brand, update, onDone, onSignOut }) {
  const [p1, setP1] = useState(""); const [p2, setP2] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const save = async () => {
    if (p1.length < 6) { setErr("Please use at least 6 characters."); return; }
    if (p1 !== p2) { setErr("The two passwords don't match."); return; }
    setBusy(true); setErr("");
    try {
      const uname = String(session.username || "").toLowerCase();
      const users = (data.users || []).map(u => String(u.username||"").toLowerCase() === uname ? { ...u, password: p1, mustChange: false } : u);
      await update("users", users, `${session.username} set their own password`);
      onDone({ ...session, password: p1, mustChange: false });
    } catch { setErr("Couldn't save your new password — check your connection and try again."); setBusy(false); }
  };
  return (<div className="min-h-screen grid place-items-center bg-slate-100 px-4">
    <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-7">
      <div className="text-lg font-bold tracking-tight">Set your own password</div>
      <p className="text-sm text-slate-500 mt-1 mb-5">Welcome, {session.username}. The password you were given is temporary — choose one only you know.</p>
      <div className="space-y-3">
        <div><span className="text-xs font-medium text-slate-500 mb-1 block">New password</span>
          <input type="password" value={p1} autoFocus autoComplete="new-password" onChange={e=>{setP1(e.target.value);setErr("");}} className={inputCls} placeholder="at least 6 characters"/></div>
        <div><span className="text-xs font-medium text-slate-500 mb-1 block">Confirm new password</span>
          <input type="password" value={p2} autoComplete="new-password" onChange={e=>{setP2(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&save()} className={inputCls} placeholder="type it again"/></div>
        {err && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{err}</div>}
        <Btn onClick={save} disabled={busy}>{busy?<Loader2 size={15} className="animate-spin"/>:<Check size={15}/>}{busy?"Saving…":"Save and continue"}</Btn>
        <button onClick={onSignOut} className="text-xs text-slate-400 hover:text-slate-600 w-full text-center pt-1">Sign out instead</button>
      </div>
    </div>
  </div>);
}
function Login({ data, brand, onLogin, onHydrate }) {
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(new Date());
  useEffect(() => { const iv = setInterval(()=>setNow(new Date()), 1000); return ()=>clearInterval(iv); }, []);
  const submit = async () => {
    setBusy(true); setErr("");
    const uname = u.trim();
    // 1) If this device already holds the account list, check locally (instant).
    const user = (data.users||[]).find(x=>x.username.toLowerCase()===uname.toLowerCase() && x.password===p);
    if (user) {
      if (!user.active) { setErr("This account has been deactivated. Contact HR."); setBusy(false); return; }
      if (user.role === "employee" && user.empId) {
        const emp = data.employees.find(e=>e.id===user.empId);
        if (emp && emp.status !== "Active") { setErr("Your employee profile is inactive. Contact HR."); setBusy(false); return; }
      }
      onLogin(user); return;
    }
    // 2) Otherwise ask the server. A brand-new browser has no account list yet — this
    //    is what used to make correct passwords look wrong on a new phone or PC.
    try {
      const res = await fetch("/api/auth/portal-login", {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ username: uname, password: p }),
      });
      const d = await res.json().catch(()=>({}));
      if (!res.ok) { setErr(d.error || "Incorrect username or password."); setBusy(false); return; }
      onHydrate && onHydrate(d);      // store the token + load the shared data
      onLogin(d.user);
    } catch {
      setErr("Couldn't reach the server. Check your internet connection and try again.");
      setBusy(false);
    }
  };
  const accent = brand.accent || "#0284c7";
  const readouts = [
    { icon:MapPin, label:"Geofenced attendance", sub:"Check-in at the Islamabad & Lahore offices" },
    { icon:Wallet, label:"Payroll & salary slips", sub:"Adjustments, deductions, slips by email" },
    { icon:Repeat, label:"Clients & retainers", sub:"Invoices, receipts and onboarding in one place" },
  ];
  return (<div className="min-h-screen flex flex-col lg:flex-row bg-slate-950 text-white">
    <style>{`
      @keyframes svy-rise { from { opacity:0; transform:translateY(10px);} to { opacity:1; transform:none;} }
      @keyframes svy-pulse { 0%,100% { opacity:.45; transform:scale(1);} 50% { opacity:1; transform:scale(1.25);} }
      .svy-rise { animation: svy-rise .5s ease both; }
      .svy-rise-2 { animation: svy-rise .5s .12s ease both; }
      .svy-dot { animation: svy-pulse 2.4s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) { .svy-rise,.svy-rise-2 { animation:none; } .svy-dot { animation:none; opacity:1; } }
    `}</style>

    {/* Brand panel */}
    <div className="relative lg:w-[54%] flex flex-col justify-between px-8 py-10 sm:px-14 sm:py-12 overflow-hidden">
      <div aria-hidden className="absolute -top-32 -left-32 w-[480px] h-[480px] rounded-full pointer-events-none" style={{background:`radial-gradient(closest-side, ${accent}33, transparent)`}}/>
      <div aria-hidden className="absolute bottom-0 right-0 w-[360px] h-[360px] rounded-full pointer-events-none" style={{background:`radial-gradient(closest-side, ${accent}1f, transparent)`}}/>
      <div className="relative svy-rise">
        <div className="flex items-center gap-3">
          {brand.logo ? <img src={brand.logo} className="w-11 h-11 rounded-xl object-contain bg-slate-900 border border-slate-800"/> : <div className="w-11 h-11 rounded-xl grid place-items-center text-white font-black text-xl" style={{background:accent}}>S</div>}
          <div>
            <div className="text-lg font-bold tracking-tight leading-none">{brand.company}</div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-slate-400 mt-1">HR & Operations Portal</div>
          </div>
        </div>
        <h1 className="mt-10 lg:mt-16 text-3xl sm:text-4xl font-bold tracking-tight leading-tight max-w-md">The day runs<br/>through here.</h1>
        <p className="mt-3 text-sm text-slate-400 max-w-sm">{brand.tagline || "Attendance, payroll, clients and requests — one portal for the whole team."}</p>
        <div className="mt-8 lg:mt-10 space-y-4 max-w-sm hidden sm:block">
          {readouts.map(r=>{const I=r.icon; return (
            <div key={r.label} className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 grid place-items-center shrink-0"><I size={15} style={{color:accent}}/></div>
              <div><div className="text-sm font-medium text-slate-200">{r.label}</div><div className="text-xs text-slate-500">{r.sub}</div></div>
            </div>);})}
        </div>
      </div>
      <div className="relative mt-10 flex items-center gap-2.5 text-xs text-slate-500 svy-rise-2">
        <span className="w-2 h-2 rounded-full svy-dot" style={{background:accent}}/>
        <span className="tabular-nums text-slate-300">{now.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}</span>
        <span>· {now.toLocaleDateString("en-GB",{weekday:"long", day:"numeric", month:"long"})}</span>
        <span className="hidden sm:inline">· Islamabad & Lahore offices</span>
      </div>
    </div>

    {/* Sign-in card */}
    <div className="flex-1 grid place-items-center px-4 py-10 sm:px-8 lg:bg-slate-900/40">
      <div className="w-full max-w-sm bg-white text-slate-900 rounded-2xl shadow-2xl p-7 sm:p-8 svy-rise-2">
        <div className="text-xl font-bold tracking-tight">Welcome back</div>
        <div className="text-sm text-slate-500 mb-6">Sign in to continue.</div>
        <div className="space-y-3.5">
          <div><span className="text-xs font-medium text-slate-500 mb-1 block">Username</span>
            <input value={u} onChange={e=>{setU(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&submit()} autoFocus autoCapitalize="none" autoComplete="username"
              className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" placeholder="your.username"/></div>
          <div><span className="text-xs font-medium text-slate-500 mb-1 block">Password</span>
            <input type="password" value={p} onChange={e=>{setP(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&submit()} autoComplete="current-password"
              className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" placeholder="••••••••"/></div>
          {err && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{err}</div>}
          <button onClick={submit} disabled={busy} className="w-full py-2.5 rounded-lg text-white font-medium transition hover:opacity-90 disabled:opacity-60 flex items-center justify-center gap-2" style={{background:accent}}>
            {busy?<Loader2 size={15} className="animate-spin"/>:null}Sign in</button>
        </div>
        <p className="text-xs text-slate-400 mt-6">Access is created by HR — ask your manager if you don't have a login.</p>
        <p className="text-[10px] text-slate-300 mt-3">{APP_BUILD}</p>
      </div>
    </div>
  </div>);
}
function BrandSetup({ brand, saveBrand, done }) {
  const [b, setB] = useState(brand);
  const onLogo = async (f) => { if (f) setB({ ...b, logo: await readImage(f, 400) }); };
  return (<div className="min-h-screen grid place-items-center bg-slate-50 text-slate-800 p-4"><div className="w-full max-w-lg bg-white border border-slate-200 rounded-2xl p-7 shadow-sm">
    <h1 className="text-xl font-bold tracking-tight mb-1 text-slate-900">Set up your letterhead</h1>
    <p className="text-sm text-slate-500 mb-6">Upload your logo once. Fine-tune anytime under Brand & Signatures.</p>
    <div className="flex items-center gap-4 mb-5">
      <label className="w-24 h-24 rounded-xl border-2 border-dashed border-slate-300 grid place-items-center cursor-pointer hover:border-sky-500 overflow-hidden">{b.logo ? <img src={b.logo} className="w-full h-full object-contain p-2"/> : <Upload className="text-slate-400"/>}<input type="file" accept="image/png,image/jpeg" className="hidden" onChange={e=>onLogo(e.target.files[0])}/></label>
      <div className="text-xs text-slate-500">PNG with transparent background works best.</div>
    </div>
    <div className="space-y-3"><Field label="Company name" value={b.company} onChange={e=>setB({...b,company:e.target.value})}/><Field label="Tagline" value={b.tagline} onChange={e=>setB({...b,tagline:e.target.value})}/><div className="grid sm:grid-cols-2 gap-3">
          <Field label="Islamabad office address" value={(b.offices?.[0]?.address)||""} onChange={e=>{const o=[...(b.offices||OFFICE_ADDRESSES)]; o[0]={...o[0],city:"Islamabad",address:e.target.value}; setB({...b,offices:o});}}/>
          <Field label="Lahore office address" value={(b.offices?.[1]?.address)||""} onChange={e=>{const o=[...(b.offices||OFFICE_ADDRESSES)]; o[1]={...o[1],city:"Lahore",address:e.target.value}; setB({...b,offices:o});}}/>
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Phone" value={b.phone||""} onChange={e=>setB({...b,phone:e.target.value})}/>
          <Field label="Email" value={b.email||""} onChange={e=>setB({...b,email:e.target.value})}/>
          <Field label="Website" value={b.website||""} onChange={e=>setB({...b,website:e.target.value})}/>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Select label="Payslip signature" options={["", ...(b.signatories||[]).map(x=>x.name)]} value={(b.signatories||[]).find(x=>x.id===b.payslipSigId)?.name || ""} onChange={e=>setB({...b, payslipSigId:(b.signatories||[]).find(x=>x.name===e.target.value)?.id || ""})}/>
          <Select label="Payslip stamp" options={["", ...(b.stamps||[]).map(x=>x.label)]} value={(b.stamps||[]).find(x=>x.id===b.payslipStampId)?.label || ""} onChange={e=>setB({...b, payslipStampId:(b.stamps||[]).find(x=>x.label===e.target.value)?.id || ""})}/>
        </div>
        <p className="text-xs text-slate-400 -mt-1">The chosen signature and stamp are printed on every salary slip PDF. Add them in the panels on the right first.</p></div>
    <div className="mt-6 flex justify-end gap-2"><Btn variant="ghost" onClick={()=>{saveBrand(b);done();}}>Skip for now</Btn><Btn onClick={()=>{saveBrand(b);done();}}><Check size={15}/>Save letterhead</Btn></div>
  </div></div>);
}

/* ---------------- shared UI ---------------- */
const Head = ({ title, sub, action }) => (<div className="flex flex-wrap items-end justify-between gap-3 mb-6"><div><h2 className="text-xl font-bold tracking-tight text-slate-900">{title}</h2>{sub && <p className="text-sm text-slate-500 mt-0.5">{sub}</p>}</div>{action}</div>);
const Btn = ({ children, onClick, variant="primary", disabled=false }) => { const s={primary:"bg-sky-600 text-white hover:bg-sky-700",ghost:"bg-white border border-slate-300 text-slate-700 hover:bg-slate-100",danger:"bg-white border border-rose-300 text-rose-600 hover:bg-rose-50",ok:"bg-emerald-600 text-white hover:bg-emerald-700"}; return <button onClick={onClick} disabled={disabled} className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition ${s[variant]} ${disabled?"opacity-60 cursor-not-allowed":""}`}>{children}</button>; };
const Card = ({ children }) => <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">{children}</div>;
const Pill = ({ s }) => { const m={Active:"bg-emerald-100 text-emerald-700",Paid:"bg-emerald-100 text-emerald-700",Sent:"bg-sky-100 text-sky-700",Accepted:"bg-emerald-100 text-emerald-700",Done:"bg-emerald-100 text-emerald-700",Cleared:"bg-emerald-100 text-emerald-700",Pending:"bg-amber-100 text-amber-700",Unpaid:"bg-amber-100 text-amber-700",Open:"bg-amber-100 text-amber-700",Requested:"bg-amber-100 text-amber-700","Pending HR":"bg-amber-100 text-amber-700","Pending Founder":"bg-sky-100 text-sky-700",Partial:"bg-orange-100 text-orange-700",Outstanding:"bg-amber-100 text-amber-700",Overdue:"bg-rose-100 text-rose-700",Approved:"bg-emerald-100 text-emerald-700",Rejected:"bg-rose-100 text-rose-700",Draft:"bg-slate-100 text-slate-600",Inactive:"bg-slate-100 text-slate-600",Paused:"bg-slate-100 text-slate-600"}; return <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${m[s]||"bg-slate-100 text-slate-600"}`}>{s}</span>; };
function Modal({ title, onClose, children, wide }) {
  return <div className="fixed inset-0 grid place-items-center z-50 p-4" style={{background:"rgba(15,23,42,.5)"}} onClick={onClose}>
    <div className={`bg-white border border-slate-200 rounded-2xl w-full ${wide?"max-w-2xl":"max-w-md"} overflow-y-auto shadow-xl`} style={{maxHeight:"90vh", paddingBottom:"env(safe-area-inset-bottom)"}} onClick={e=>e.stopPropagation()}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200"><h3 className="font-semibold text-slate-900">{title}</h3><button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18}/></button></div>
      <div className="p-5 space-y-3">{children}</div></div></div>;
}
const inputCls = "w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:ring-1 focus:ring-sky-200 outline-none";
const Field = ({ label, ...p }) => (<label className="block"><span className="text-xs text-slate-500 mb-1 block">{label}</span><input {...p} className={inputCls}/></label>);
const Area = ({ label, ...p }) => (<label className="block"><span className="text-xs text-slate-500 mb-1 block">{label}</span><textarea {...p} rows={3} className={inputCls+" resize-y"}/></label>);
const Select = ({ label, options, ...p }) => (<label className="block"><span className="text-xs text-slate-500 mb-1 block">{label}</span><select {...p} className={inputCls}>{options.map(o=><option key={o} value={o}>{o||"—"}</option>)}</select></label>);
const Table = ({ cols, children }) => (<div className="overflow-x-auto"><table className="w-full text-sm" style={{minWidth: Math.max(480, cols.length*110)}}><thead><tr className="text-left text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200 bg-slate-50">{cols.map((c,ci)=><th key={ci} className="px-4 py-3 font-medium">{c}</th>)}</tr></thead><tbody>{children}</tbody></table></div>);
const Row = ({ children, onClick }) => <tr onClick={onClick} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 ${onClick?"cursor-pointer":""}`}>{children}</tr>;
const Td = ({ children, className="" }) => <td className={`px-4 py-3 ${className}`}>{children}</td>;
const RowActions = ({ onEdit, onDelete, children }) => {
  const [confirming, setConfirming] = useState(false);
  return (<div className="flex gap-1 justify-end items-center" onClick={e=>e.stopPropagation()}>
    {children}
    {onEdit&&<button onClick={onEdit} className="p-1.5 rounded text-slate-400 hover:text-sky-600 hover:bg-slate-100"><Edit3 size={14}/></button>}
    {onDelete&&!confirming&&<button onClick={()=>setConfirming(true)} title="Delete" className="p-1.5 rounded text-slate-400 hover:text-rose-500 hover:bg-slate-100"><Trash2 size={14}/></button>}
    {onDelete&&confirming&&<span className="flex items-center gap-1 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1"><span className="text-xs text-rose-600">Delete?</span><button onClick={()=>{ setConfirming(false); onDelete(); }} className="text-xs font-medium text-white bg-rose-600 hover:bg-rose-700 rounded px-2 py-0.5">Yes</button><button onClick={()=>setConfirming(false)} className="text-xs text-slate-500 hover:text-slate-700 px-1">No</button></span>}
  </div>);
};

// ===== Batch selection =====
// Shared multi-select for list screens: a checkbox column plus an action bar that
// appears only when something is selected. Deletes always ask for confirmation.
function useBatch(rows) {
  const [sel, setSel] = useState(() => new Set());
  const ids = (rows || []).map(r => r.id);
  const idKey = ids.join(",");
  useEffect(() => {
    // drop selections for rows that no longer exist (deleted, filtered away)
    setSel(s => { const keep = new Set([...s].filter(id => ids.includes(id))); return keep.size === s.size ? s : keep; });
  }, [idKey]);
  const toggle = (id) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selected = ids.filter(i => sel.has(i));
  const allOn = ids.length > 0 && selected.length === ids.length;
  const toggleAll = () => setSel(allOn ? new Set() : new Set(ids));
  const clear = () => setSel(new Set());
  return { has: (id) => sel.has(id), toggle, toggleAll, allOn, clear, selected, count: selected.length };
}
const SelBox = ({ on, onChange, title }) => (
  <input type="checkbox" checked={!!on} onChange={onChange} onClick={e=>e.stopPropagation()} title={title}
    className="w-4 h-4 align-middle rounded border-slate-300 accent-sky-600 cursor-pointer"/>);
const SelTd = ({ on, onChange }) => <Td className="w-8"><SelBox on={on} onChange={onChange}/></Td>;
function BatchBar({ count, noun="item", onDelete, onClear, children }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!count) setConfirming(false); }, [count]);
  if (!count) return null;
  const many = count > 1 ? "s" : "";
  return (<div className="flex flex-wrap items-center gap-2 mb-3 bg-sky-50 border border-sky-200 rounded-xl px-4 py-2.5">
    <span className="text-sm font-medium text-sky-800">{count} {noun}{many} selected</span>
    <div className="flex-1"/>
    {children}
    {onDelete && !confirming && <Btn variant="ghost" onClick={()=>setConfirming(true)}><Trash2 size={15}/>Delete selected</Btn>}
    {onDelete && confirming && <span className="flex items-center gap-2 bg-white border border-rose-200 rounded-lg px-2.5 py-1.5">
      <span className="text-xs text-rose-600">Delete {count} {noun}{many}?</span>
      <button onClick={()=>{ setConfirming(false); onDelete(); }} className="text-xs font-medium text-white bg-rose-600 hover:bg-rose-700 rounded px-2 py-1">Yes, delete</button>
      <button onClick={()=>setConfirming(false)} className="text-xs text-slate-500 hover:text-slate-700 px-1">Cancel</button></span>}
    <Btn variant="ghost" onClick={onClear}><X size={15}/>Clear</Btn>
  </div>);
}
const Empty = ({ msg }) => <div className="px-4 py-12 text-center text-slate-400 text-sm">{msg}</div>;
function ClientInput({ label="Client", clients, value, onChange }) {
  return (<label className="block"><span className="text-xs text-slate-500 mb-1 block">{label}</span>
    <input list="client-list" value={value} onChange={onChange} className={inputCls} placeholder="Type or pick a client"/>
    <datalist id="client-list">{clients.map(c=><option key={c.id} value={c.name}/>)}</datalist></label>);
}

/* ---------------- leave helpers ---------------- */
function leaveUsed(data, name, year = new Date().getFullYear()) {
  const used={Casual:0,Sick:0,Annual:0,Bereavement:0};
  (data.leaves||[]).filter(l=>l.employee===name && l.status==="Approved" && (l.from||"").startsWith(String(year)))
    .forEach(l=>{ if(used[l.type]!=null) used[l.type]+=dayCount(l.from,l.to); });
  return used;
}
function leaveLeft(data, name, type, year = new Date().getFullYear()) {
  const ent = entitlementFor(type, year); if (ent===null) return null;
  return ent - leaveUsed(data, name, year)[type];
}
function LeaveBalances({ data, name }) {
  const yr = new Date().getFullYear();
  const used = leaveUsed(data, name, yr);
  return (<div>
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">{["Casual","Sick","Annual","Bereavement"].map(t=>{ const ent=entitlementFor(t,yr); const left=Math.max(0, ent-used[t]); const perEvent=LEAVE_POLICY[t].perEvent; return (
      <Card key={t}><div className="p-4 text-center"><div className="text-2xl font-bold text-slate-900">{left}</div><div className="text-xs text-slate-500 mt-0.5">{t} left</div><div className="text-xs text-slate-400">of {ent}{perEvent?" / event":""}{yr===2026?" (2026)":""}</div></div></Card>); })}</div>
    {yr===2026 && <div className="text-xs text-slate-400 mt-2">2026 entitlements are prorated for Aug–Dec per the leave policy; full entitlement (6 casual · 8 sick · 12 annual) applies from 2027. Public holidays follow the Government of Pakistan calendar.</div>}
  </div>);
}

/* ---------------- payroll calc ---------------- */
function computePayslip(e, data, month) {
  const basic = +e.salary || 0;
  const allowances = 0; // no automatic allowance — add increases manually with a reason
  const reimb = data.payables.filter(p=>p.kind==="reimbursement" && p.vendor===e.name && p.status==="Approved" && !p.settled && p.payVia==="salary" && (!p.payMonth || p.payMonth===month)).reduce((s,p)=>s+ +p.amount,0);
  const tax = 0;   // not auto-calculated — set manually per payslip if needed
  const eobi = 0;  // not auto-calculated
  const pf = Math.round(basic * (+e.pf||0) / 100);
  const advance = data.advances.filter(a=>a.employee===e.name && a.status==="Active" && a.remaining>0).reduce((s,a)=>s+Math.min(+a.installment, a.remaining),0);
  const deductions = tax + eobi + pf + advance;
  return { id:uid(), employee:e.name, month, basic, allowances, reimbursements:reimb, tax, eobi, pf, advance, deductions, adjustments:[], paid:false, date:today() };
}
// Sum of manual adjustments (+ increase / - deduction)
const adjTotal = (p) => (p.adjustments||[]).reduce((s,a)=>s + (+a.amount||0), 0);
const netPay = (p) => +p.basic + +p.allowances + (+p.reimbursements||0) + adjTotal(p) - (+p.deductions||0);

/* ---------------- document sheet ---------------- */
function Letterhead({ brand }) {
  return (<div className="flex items-start justify-between border-b-2 pb-3 mb-5" style={{ borderColor: brand.accent }}>
    <div className="flex items-center gap-3">{brand.logo ? <img src={brand.logo} className="h-12 object-contain"/> : <Building2 size={28}/>}<div><div className="font-bold text-base leading-tight">{brand.company}</div><div className="text-xs text-slate-500">{brand.tagline}</div></div></div>
    <div className="text-right text-xs text-slate-500 leading-tight max-w-[46%]">
      {(brand.offices||[]).map(o=>(<div key={o.city}>{o.city}: {o.address}</div>))}
      {!(brand.offices||[]).length && <div>{brand.address}</div>}
      <div className="mt-0.5">{[brand.phone, brand.email, brand.website].filter(Boolean).join(" · ") || brand.contact}</div>
    </div></div>);
}
function DocSheet({ brand, body, signed, setSigned }) {
  const sig = brand.signatories.find(s=>s.id===signed?.sigId);
  const stamp = brand.stamps.find(s=>s.id===signed?.stampId);
  return (<div>
    <div className="flex flex-wrap gap-2 mb-3">
      <select value={signed?.sigId||""} onChange={e=>setSigned({...signed,sigId:e.target.value})} className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs text-slate-700 outline-none focus:border-sky-500"><option value="">No signature</option>{brand.signatories.map(s=><option key={s.id} value={s.id}>✍ {s.name}</option>)}</select>
      <select value={signed?.stampId||""} onChange={e=>setSigned({...signed,stampId:e.target.value})} className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs text-slate-700 outline-none focus:border-sky-500"><option value="">No stamp</option>{brand.stamps.map(s=><option key={s.id} value={s.id}>● {s.label}</option>)}</select>
      {(!brand.signatories.length && !brand.stamps.length) && <span className="text-xs text-slate-400 self-center">Add signatures & stamps under Brand & Signatures</span>}
    </div>
    <div className="bg-white text-slate-900 rounded-lg p-7 text-sm leading-relaxed border border-slate-200 shadow-md"><Letterhead brand={brand}/>
      <div className="whitespace-pre-wrap" style={{minHeight:120}}>{body}</div>
      <div className="mt-8 relative" style={{ minHeight: 90 }}>
        {stamp && <img src={stamp.img} alt="" className="absolute h-20 opacity-80 pointer-events-none" style={{left:96,top:-8,transform:"rotate(-6deg)"}}/>}
        {sig && <img src={sig.sig} alt="" className="h-14 object-contain"/>}
        <div className="border-t border-slate-300 w-48 mt-1 pt-1"><div className="font-semibold text-sm">{sig ? sig.name : "______________________"}</div><div className="text-xs text-slate-500">{sig ? `${sig.role}, ${brand.company}` : ""}</div></div>
      </div></div></div>);
}

/* ================= EMPLOYEE PORTAL ================= */
function checkInOut(mutateData, name, which, onResult, remoteAllowed = false, wfhToday = null) {
  if (wfhToday) remoteAllowed = true;   // a work-from-home day is never geofenced
  const apply = (loc) => {
    const near = loc ? nearestOffice(loc.lat, loc.lng) : null;
    const atOffice = !!(near && near.distance <= GEOFENCE_RADIUS_M);
    if (!remoteAllowed) {
      // Office-only employees: the geofence stands.
      if (!loc) { onResult && onResult({ ok:false, msg:"Couldn't get your location. Please enable location access and try again — check-in requires being at a Svype office." }); return; }
      if (!atOffice) {
        onResult && onResult({ ok:false, msg:`You're not at a Svype office. You must be within ${GEOFENCE_RADIUS_M}m of the Lahore or Islamabad office to check ${which}. ${near?`(You're about ${Math.round(near.distance)}m from the ${near.office}.)`:""}` });
        return;
      }
    }
    // WFH employees are never blocked: tag the office if they happen to be at one,
    // otherwise tag "Remote". Location is still recorded when available.
    const officeName = atOffice ? near.office : (wfhToday ? "Work from home" : "Remote");
    const stampedLoc = loc ? { ...loc, office: officeName, ...(near ? { distance: Math.round(near.distance) } : {}) } : null;
    const now = new Date().toISOString();
    const stamp = which==="in"
      ? { checkIn:now, location:stampedLoc, office:officeName, ...(wfhToday ? { wfh:true, wfhReqId:wfhToday.id, status: wfhToday.status==="Approved" ? "Present" : "Requested" } : {}) }
      : { checkOut:now, checkOutLocation:stampedLoc, checkOutOffice:officeName };
    // FUNCTIONAL mutation: recomputed against the freshest data on every save retry, so
    // simultaneous check-ins from many employees merge instead of overwriting each other.
    mutateData((cur) => {
      const list = cur.attendance || [];
      const ex = list.find(a=>a.employee===name && a.date===today());
      const attendance = ex
        ? list.map(a=>a===ex ? { ...a, status:"Present", ...stamp } : a)
        : [...list, { id:uid(), employee:name, date:today(), status:"Present", checkIn:null, checkOut:null, location:null, office:null, checkOutLocation:null, checkOutOffice:null, ...stamp }];
      return { ...cur, attendance };
    }, `${name} checked ${which} · ${officeName}`);
    onResult && onResult({ ok:true, msg:`Checked ${which} · ${officeName}`, office:officeName });
  };
  if (navigator.geolocation) {
    const ok = (p)=>apply({ lat:p.coords.latitude, lng:p.coords.longitude });
    const fail = (err)=>{
      if (remoteAllowed) return apply(null);             // WFH is never blocked
      const code = err && err.code;
      let msg = "Couldn't get your location. Please try again.";
      if (code === 1) msg = "Location is blocked for this site. Tap the padlock / (i) icon next to the web address, allow Location, then try again. On iPhone also check Settings → Privacy → Location Services → Safari.";
      else if (code === 2) msg = "Your device couldn't work out where it is. On a laptop make sure Wi-Fi is on; on a phone turn on Location/GPS, then try again.";
      else if (code === 3) msg = "Getting your location took too long. Step near a window or switch on Wi-Fi, then try again.";
      onResult && onResult({ ok:false, msg });
    };
    // First a quick precise fix; if that fails, retry with a longer, lower-accuracy
    // attempt — laptops indoors routinely fail the strict one.
    navigator.geolocation.getCurrentPosition(ok, () => {
      navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy:false, timeout:20000, maximumAge:120000 });
    }, { enableHighAccuracy:true, timeout:10000, maximumAge:0 });
  } else if (remoteAllowed) {
    apply(null); // WFH: no location available — check in as Remote
  } else {
    onResult && onResult({ ok:false, msg:"This browser can't share location. Please use Safari or Chrome, or ask HR to mark you present." });
  }
}
function CheckInCard({ data, mutateData, me }) {
  const a = data.attendance.find(x=>x.employee===me.name && x.date===today());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [tf, setTf] = useState(null); const [terr, setTerr] = useState(""); const [tbusy, setTbusy] = useState(false); const [tsent, setTsent] = useState("");
  const minDate = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
  const sendCorrection = async () => {
    if (!tf.date) { setTerr("Pick the day."); return; }
    if (!tf.inTime && !tf.outTime) { setTerr("Enter the time you started, the time you left, or both."); return; }
    const iso = (t) => t ? new Date(`${tf.date}T${t}`).toISOString() : null;
    const inIso = iso(tf.inTime), outIso = iso(tf.outTime);
    if ((tf.inTime && isNaN(new Date(inIso).getTime())) || (tf.outTime && isNaN(new Date(outIso).getTime()))) { setTerr("That time doesn't look right."); return; }
    if (inIso && outIso && new Date(outIso) <= new Date(inIso)) { setTerr("The leaving time has to be after the starting time."); return; }
    setTbusy(true); setTerr("");
    try {
      await mutateData((cur)=>{
        const list = cur.attendance || [];
        const meta = { reason:(tf.reason||"").trim(), status:"Pending", submittedAt:new Date().toISOString() };
        const patchRec = (rec) => ({
          ...rec,
          ...(inIso ? { timeReq: { ...meta, requested: inIso } } : {}),
          ...(outIso ? { outReq: { ...meta, requested: outIso } } : {}),
        });
        const existing = list.find(x=>x.employee===me.name && x.date===tf.date);
        if (existing) return { ...cur, attendance: list.map(x=>x===existing ? patchRec(x) : x) };
        // No attendance for that day at all — a placeholder that does NOT count as
        // present until HR approves it.
        return { ...cur, attendance: [...list, patchRec({ id:uid(), employee:me.name, date:tf.date, status:"Requested", checkIn:null, checkOut:null, viaRequest:true })] };
      }, `${me.name} requested an attendance time correction for ${tf.date}`);
      setTf(null);
      setTsent("Sent to HR. Your attendance stays as recorded until they approve it.");
      setTimeout(()=>setTsent(""), 8000);
    } catch { setTerr("Couldn't reach the server — please try again."); }
    setTbusy(false);
  };
  // ---- work from home for a specific day ----
  const [wf, setWf] = useState(null); const [werr, setWerr] = useState(""); const [wbusy, setWbusy] = useState(false);
  const myWfh = wfhFor(data, me.name, today());
  const sendWfh = async () => {
    if (!wf.date) { setWerr("Pick the day."); return; }
    if (!(wf.reason||"").trim()) { setWerr("Please tell HR why you're working from home."); return; }
    setWbusy(true); setWerr("");
    try {
      await mutateData((cur)=>({ ...cur, wfhRequests: [...(cur.wfhRequests||[]), {
        id: uid(), employee: me.name, date: wf.date, reason: wf.reason.trim(),
        status: "Pending", requestedOn: today(),
      }] }), `${me.name} requested to work from home on ${wf.date}`);
      setWf(null);
      setTsent("Work-from-home request sent to HR. You can check in and out from anywhere on that day — it reaches the attendance sheet once HR approves.");
      setTimeout(()=>setTsent(""), 10000);
    } catch { setWerr("Couldn't reach the server — please try again."); }
    setWbusy(false);
  };
  const doAction = (which) => {
    setBusy(true); setMsg(null);
    checkInOut(mutateData, me.name, which, (res)=>{ setBusy(false); setMsg(res); }, !!me.remoteAllowed, myWfh || null);
  };
  return (<Card><div className="p-5">
    <div className="flex items-center gap-2 text-sm font-semibold mb-3"><Clock size={16} className="text-sky-600"/>Today · {new Date().toLocaleDateString()}</div>
    <div className="flex flex-wrap items-center gap-3">
      <Btn variant={a?.checkIn?"ghost":"primary"} disabled={busy} onClick={()=>doAction("in")}>{busy?<Loader2 size={14} className="animate-spin"/>:null}Check in{a?.checkIn?` · ${timeOf(a.checkIn)}`:""}</Btn>
      <Btn variant={a?.checkOut?"ghost":"ok"} disabled={busy} onClick={()=>doAction("out")}>{busy?<Loader2 size={14} className="animate-spin"/>:null}Check out{a?.checkOut?` · ${timeOf(a.checkOut)}`:""}</Btn>
      {a?.office && <span className="text-xs text-slate-500 flex items-center gap-1"><MapPin size={12}/>{a.office}</span>}
    </div>
    {msg && <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${msg.ok?"bg-emerald-50 border border-emerald-200 text-emerald-700":"bg-rose-50 border border-rose-200 text-rose-700"}`}>{msg.msg}</div>}
    {a?.timeReq?.status==="Pending" && <div className="mt-3 text-xs rounded-lg px-3 py-2 bg-amber-50 border border-amber-200 text-amber-700">Correction to {timeOf(a.timeReq.requested)} sent — waiting for HR approval.</div>}
    {a?.timeReq?.status==="Approved" && <div className="mt-3 text-xs rounded-lg px-3 py-2 bg-emerald-50 border border-emerald-200 text-emerald-700">HR approved your check-in time of {timeOf(a.timeReq.requested)}.</div>}
    {a?.timeReq?.status==="Rejected" && <div className="mt-3 text-xs rounded-lg px-3 py-2 bg-rose-50 border border-rose-200 text-rose-700">HR declined the correction — the recorded time stands.</div>}
    {tsent && <div className="mt-3 text-xs rounded-lg px-3 py-2 bg-emerald-50 border border-emerald-200 text-emerald-700">{tsent}</div>}
    {a?.outReq?.status==="Pending" && <div className="mt-3 text-xs rounded-lg px-3 py-2 bg-amber-50 border border-amber-200 text-amber-700">Check-out correction to {timeOf(a.outReq.requested)} sent — waiting for HR approval.</div>}
    {a?.outReq?.status==="Approved" && <div className="mt-3 text-xs rounded-lg px-3 py-2 bg-emerald-50 border border-emerald-200 text-emerald-700">HR approved your check-out time of {timeOf(a.outReq.requested)}.</div>}
    {myWfh && <div className={`mt-3 text-xs rounded-lg px-3 py-2 ${myWfh.status==="Approved"?"bg-emerald-50 border border-emerald-200 text-emerald-700":"bg-sky-50 border border-sky-200 text-sky-700"}`}>
      {myWfh.status==="Approved" ? "Working from home today — approved by HR. Check in and out as normal." : "Work-from-home request sent for today. You can check in and out from anywhere; it reaches the attendance sheet once HR approves."}
    </div>}
    <div className="mt-3 flex flex-wrap gap-3">
      <button onClick={()=>{ setTf({ date: today(), inTime:"", outTime:"", reason:"" }); setTerr(""); }} className="text-xs text-sky-600 hover:underline">Forgot to check in or out? Send a correction →</button>
      {!myWfh && !me.remoteAllowed && <button onClick={()=>{ setWf({ date: today(), reason:"" }); setWerr(""); }} className="text-xs text-sky-600 hover:underline">Working from home? Request it →</button>}
    </div>
    {wf && <Modal title="Work from home request" onClose={()=>{setWf(null);setWerr("");}}>
      <p className="text-xs text-slate-500">HR has to approve working from home. You can check in and out from anywhere on that day straight away — the day only lands on the attendance sheet once HR approves it.</p>
      <Field label="Day" type="date" value={wf.date} min={today()} onChange={e=>{setWf({...wf,date:e.target.value});setWerr("");}}/>
      <Area label="Reason" value={wf.reason} onChange={e=>{setWf({...wf,reason:e.target.value});setWerr("");}}/>
      {werr && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{werr}</div>}
      <Btn onClick={sendWfh} disabled={wbusy}>{wbusy?<Loader2 size={15} className="animate-spin"/>:<Check size={15}/>}{wbusy?"Sending…":"Send to HR for approval"}</Btn>
    </Modal>}
    {tf && <Modal title="Correct my attendance times" onClose={()=>{setTf(null);setTerr("");}}>
      <p className="text-xs text-slate-500">Tell HR the times you actually started and/or finished — for example if you left the office but only checked out once you got home. This is a request: your attendance stays exactly as recorded until HR approves it.</p>
      <Field label="Day" type="date" value={tf.date} min={minDate} max={today()} onChange={e=>{setTf({...tf,date:e.target.value});setTerr("");}}/>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Time I actually started" type="time" value={tf.inTime} onChange={e=>{setTf({...tf,inTime:e.target.value});setTerr("");}}/>
        <Field label="Time I actually left" type="time" value={tf.outTime} onChange={e=>{setTf({...tf,outTime:e.target.value});setTerr("");}}/>
      </div>
      <p className="text-xs text-slate-400 -mt-1">Fill in whichever one is wrong — you can send both together.</p>
      <Area label="Why the time was late or missed" value={tf.reason} onChange={e=>setTf({...tf,reason:e.target.value})}/>
      {terr && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{terr}</div>}
      <Btn onClick={sendCorrection} disabled={tbusy}>{tbusy?<Loader2 size={15} className="animate-spin"/>:<Check size={15}/>}{tbusy?"Sending…":"Send to HR for approval"}</Btn>
    </Modal>}
    <div className="mt-3 text-xs text-slate-400">{me.remoteAllowed ? "You\u2019re approved for work from home — you can check in from anywhere. Your location is recorded when available." : `Check-in and check-out require being within ${GEOFENCE_RADIUS_M}m of a Svype office.`}</div>
  </div></Card>);
}
function EmpDashboard({ data, update, mutateData, session, me }) {
  const myClaims = data.payables.filter(p=>p.kind==="reimbursement" && p.vendor===me.name && p.status!=="Paid").length;
  return (<>
    <Head title={`Hi, ${me.name.split(" ")[0]}`} sub={`${me.role} · ${me.dept}`}/>
    <div className="space-y-5">
      <CheckInCard data={data} mutateData={mutateData} me={me}/>
      <TodoCard data={data} mutateData={mutateData} session={session} me={me}/>
      <div><div className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium">Leave balance</div><LeaveBalances data={data} name={me.name}/></div>
      <Card><div className="px-5 py-4 border-b border-slate-200 font-semibold text-sm flex items-center gap-2"><Megaphone size={15} className="text-sky-600"/>Announcements</div>
        {data.announcements.length===0?<Empty msg="No announcements"/>:<div className="divide-y divide-slate-100">{data.announcements.map(an=>(<div key={an.id} className="px-5 py-3"><div className="font-medium text-sm">{an.title}</div><div className="text-sm text-slate-600 mt-0.5">{an.body}</div><div className="text-xs text-slate-400 mt-1">{an.date}</div></div>))}</div>}
      </Card>
      {myClaims>0 && <div className="text-sm text-slate-500">You have {myClaims} expense claim(s) awaiting approval.</div>}
    </div></>);
}
function EmpProfile({ data, update, me }) {
  const [req, setReq] = useState(null);
  const [cert, setCert] = useState(null);
  const submit = () => { update("requests", [{ id:uid(), employee:me.name, type:"Profile update", note:req, status:"Open", date:today() }, ...data.requests], `${me.name} requested a profile change`); setReq(null); };
  const submitCert = () => { update("requests", [{ id:uid(), employee:me.name, type:cert.type, note:cert.note, status:"Requested", date:today() }, ...data.requests], `${me.name} requested ${cert.type}`); setCert(null); };
  return (<>
    <Head title="My Profile" sub="Your records on file" action={<div className="flex gap-2"><Btn variant="ghost" onClick={()=>setCert({ type:"Salary Certificate", note:"" })}><FileSignature size={15}/>Request certificate</Btn><Btn variant="ghost" onClick={()=>setReq("")}><Edit3 size={15}/>Request edit</Btn></div>}/>
    <div className="flex items-center gap-4 mb-6"><div className="w-14 h-14 rounded-2xl bg-sky-100 text-sky-700 grid place-items-center font-bold text-xl">{me.name[0]}</div><div><div className="text-lg font-bold text-slate-900">{me.name}</div><div className="text-sm text-slate-500">{me.role} · {me.dept}</div></div></div>
    <div className="grid sm:grid-cols-2 gap-4 mb-6">{[["Email",me.email],["Phone",me.phone],["CNIC",me.cnic],["Salary",fmt(me.salary)],["Joined",me.joined],["Status",me.status],["Check-in policy", me.remoteAllowed?"Anywhere (WFH)":"Office only"], ...(me.onNotice?[["Employment","On notice period"],["Notice given",me.noticeGivenOn||"—"],["Last working day",me.lastWorkingDay||"—"]]:[])].map(([k,v])=>(<Card key={k}><div className="p-4"><div className="text-xs text-slate-500">{k}</div><div className="font-medium mt-0.5">{v||"—"}</div></div></Card>))}</div>
    <div className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium">My documents</div>
    <Card><div className="p-4">{(!me.docs||me.docs.length===0)?<Empty msg="No documents on file"/>:<div className="grid sm:grid-cols-3 gap-3">{me.docs.map(d=>(<button key={d.id} onClick={()=>openStored(d, d.name)} className="text-left bg-slate-50 border border-slate-200 rounded-lg overflow-hidden hover:border-sky-400 hover:shadow-sm transition">{(d.img||(d.fileId&&String(d.mime||"").startsWith("image/")))?<StoredImg d={d} className="w-full h-32 object-cover"/>:<div className="h-32 grid place-items-center text-slate-400"><FileText/></div>}<div className="p-2 text-xs truncate flex items-center gap-1"><span className="text-sky-600">↗</span>{d.name}{d.expiry&&<span className="block text-slate-400">exp {d.expiry}</span>}</div></button>))}</div>}</div></Card>
    {req!==null && <Modal title="Request a profile change" onClose={()=>setReq(null)}><Area label="What needs updating?" value={req} onChange={e=>setReq(e.target.value)} placeholder="e.g. New phone number, updated CNIC scan"/><Btn onClick={submit}><Check size={15}/>Send to HR</Btn></Modal>}
    {cert && <Modal title="Request a certificate / letter" onClose={()=>setCert(null)}>
      <Select label="What do you need?" options={["Salary Certificate","Experience Certificate","Employment Verification","Appointment Letter","Other"]} value={cert.type} onChange={e=>setCert({...cert,type:e.target.value})}/>
      <Area label="Any details for HR (optional)" value={cert.note} onChange={e=>setCert({...cert,note:e.target.value})} placeholder="e.g. addressed to the bank, needed by Friday"/>
      <Btn onClick={submitCert}><Check size={15}/>Send request to HR</Btn>
    </Modal>}
  </>);
}
function EmpAttendance({ data, update, mutateData, me }) {
  const [lf, setLf] = useState(null);
  const blank = { employee:me.name, type:"Casual", from:today(), to:today(), reason:"", status:"Pending" };
  const myLeaves = data.leaves.filter(l=>l.employee===me.name);
  const myAtt = data.attendance.filter(a=>a.employee===me.name).slice().reverse().slice(0,10);
  const [lerr, setLerr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sentMsg, setSentMsg] = useState("");
  const [tf, setTf] = useState(null); const [terr, setTerr] = useState(""); const [tbusy, setTbusy] = useState(false);
  const submitTime = async () => {
    if (!tf.time) { setTerr("Enter the time you actually started."); return; }
    const iso = new Date(`${tf.date}T${tf.time}`).toISOString();
    if (isNaN(new Date(iso))) { setTerr("That time doesn't look right."); return; }
    setTbusy(true); setTerr("");
    try {
      await mutateData((cur)=>({ ...cur, attendance:(cur.attendance||[]).map(a=>a.id===tf.id
        ? { ...a, timeReq:{ requested:iso, reason:(tf.reason||"").trim(), status:"Pending", submittedAt:new Date().toISOString() } } : a) }),
        `${me.name} requested a check-in time correction for ${tf.date}`);
      setTf(null);
      setSentMsg("Correction sent to HR. Your check-in stays as recorded until they approve it.");
      setTimeout(()=>setSentMsg(""), 7000);
    } catch { setTerr("Couldn't reach the server — please try again."); }
    setTbusy(false);
  };
  const save = async (l)=>{
    const days = dayCount(l.from, l.to);
    if (!days || days < 1) { setLerr("Pick a valid date range."); return; }
    if (l.type==="Bereavement" && days > 3) { setLerr("Bereavement leave is 3 days per qualifying event. For more time, please speak to HR."); return; }
    if (["Casual","Sick","Annual"].includes(l.type)) {
      const left = leaveLeft(data, me.name, l.type);
      if (days > left) { setLerr(`You have ${Math.max(0,left)} ${l.type.toLowerCase()} day(s) left this year — this request is ${days} day(s).`); return; }
    }
    setSubmitting(true);
    try {
      await mutateData((cur)=>({ ...cur, leaves: [...(cur.leaves||[]), { ...l, days, id:uid(), requestedOn: today() }] }), `${me.name} requested ${l.type} leave (${l.from} → ${l.to})`);
      setLf(null); setLerr(""); setSentMsg("Leave request sent to HR — you'll be notified once it's approved or declined.");
      setTimeout(()=>setSentMsg(""), 7000);
    } catch { setLerr("Couldn't reach the server — please try again."); }
    setSubmitting(false);
  };
  return (<>
    <Head title="Attendance & Leave" sub="Check in, track your days, request leave"/>
    <div className="space-y-5">
      <CheckInCard data={data} mutateData={mutateData} me={me}/>
      {sentMsg && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center gap-2"><Check size={15}/>{sentMsg}</div>}
      <LeaveBalances data={data} name={me.name}/>
      <div className="flex justify-between items-center"><div className="text-xs uppercase tracking-wider text-slate-500 font-medium">My leave requests</div><Btn onClick={()=>setLf(blank)}><Plus size={15}/>Request leave</Btn></div>
      <Card><Table cols={["Type","From","To","Days","Status"]}>{myLeaves.length===0?<tr><td colSpan={5}><Empty msg="No leave requests yet"/></td></tr>:myLeaves.map(l=>(<Row key={l.id}><Td>{l.type}{l.reason&&<div className="text-xs text-slate-400 max-w-[180px] truncate">{l.reason}</div>}</Td><Td className="text-slate-500">{l.from}</Td><Td className="text-slate-500">{l.to}</Td><Td>{dayCount(l.from,l.to)}</Td><Td><Pill s={l.status}/>{l.decidedOn&&l.status!=="Pending"&&<div className="text-xs text-slate-400 mt-0.5">{l.status.toLowerCase()} {l.decidedOn}</div>}</Td></Row>))}</Table></Card>
      <div className="text-xs uppercase tracking-wider text-slate-500 font-medium">Recent attendance</div>
      <Card><Table cols={["Date","Office","In","Out",""]}>{myAtt.length===0?<tr><td colSpan={5}><Empty msg="No attendance recorded"/></td></tr>:myAtt.map(a=>(<Row key={a.id}><Td>{a.date}</Td><Td className="text-xs text-slate-600">{a.office||a.checkOutOffice||"—"}</Td>
        <Td className="text-slate-500">{timeOf(effIn(a))||"—"}
          {a.timeReq && a.timeReq.status==="Pending" && <div className="text-xs text-amber-600">correction to {timeOf(a.timeReq.requested)} — awaiting HR</div>}
          {a.timeReq && a.timeReq.status==="Approved" && <div className="text-xs text-emerald-600">corrected ✓ (checked in {timeOf(a.checkIn)})</div>}
          {a.timeReq && a.timeReq.status==="Rejected" && <div className="text-xs text-rose-500">correction declined</div>}
        </Td>
        <Td className="text-slate-500">{timeOf(effOut(a))||"—"}{a.outReq?.status==="Pending"&&<div className="text-xs text-amber-600">correction pending</div>}</Td>
        <Td>{(!a.timeReq || a.timeReq.status==="Rejected")
          ? <button onClick={()=>{setTf({ id:a.id, date:a.date, time:"", reason:"" });setTerr("");}} className="text-xs text-sky-600 hover:underline whitespace-nowrap">Correct time</button>
          : <span className="text-xs text-slate-300">—</span>}</Td></Row>))}</Table></Card>
    </div>
    {tf && <Modal title="Correct my check-in time" onClose={()=>{setTf(null);setTerr("");}}>
      <p className="text-xs text-slate-500">For {tf.date}. Tell HR the time you actually started — this is sent for approval. Until HR approves it, the recorded check-in time stands.</p>
      <Field label="Time I actually started" type="time" value={tf.time} onChange={e=>{setTf({...tf,time:e.target.value});setTerr("");}}/>
      <Area label="Why the check-in was late/missed" value={tf.reason} onChange={e=>setTf({...tf,reason:e.target.value})}/>
      {terr && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{terr}</div>}
      <Btn onClick={submitTime} disabled={tbusy}>{tbusy?<Loader2 size={15} className="animate-spin"/>:<Check size={15}/>}{tbusy?"Sending…":"Send to HR for approval"}</Btn>
    </Modal>}
    {lf && <Modal title="Request leave" onClose={()=>{setLf(null);setLerr("");}}>
      <Select label="Type" options={LEAVE_TYPES} value={lf.type} onChange={e=>{setLf({...lf,type:e.target.value});setLerr("");}}/>
      <div className="grid grid-cols-2 gap-3"><Field label="From" type="date" value={lf.from} onChange={e=>{setLf({...lf,from:e.target.value});setLerr("");}}/><Field label="To" type="date" value={lf.to} onChange={e=>{setLf({...lf,to:e.target.value});setLerr("");}}/></div>
      <div className="text-xs text-slate-500">{dayCount(lf.from,lf.to)||0} day(s){["Casual","Sick","Annual"].includes(lf.type)?` · ${Math.max(0,leaveLeft(data,me.name,lf.type))} ${lf.type.toLowerCase()} left this year`:""}</div>
      {lf.type==="Sick" && dayCount(lf.from,lf.to)>2 && <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Per policy: more than 2 consecutive sick days requires a medical report to HR.</div>}
      <Area label="Reason" value={lf.reason} onChange={e=>setLf({...lf,reason:e.target.value})}/>
      {lerr && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{lerr}</div>}
      <Btn onClick={()=>save(lf)} disabled={submitting}>{submitting?<Loader2 size={15} className="animate-spin"/>:<Check size={15}/>}{submitting?"Submitting…":"Submit request"}</Btn>
      <p className="text-xs text-slate-400">Your request goes to HR. You'll be notified here (bell icon) once it's approved or declined.</p>
    </Modal>}
  </>);
}
function EmpPayslips({ data, update, mutateData, brand, me }) {
  const [slip, setSlip] = useState(null);
  const slips = data.payroll.filter(p=>p.employee===me.name);
  const [sent, setSent] = useState("");
  const myReqs = (data.requests||[]).filter(r=>r.employee===me.name);
  const [sending, setSending] = useState(false);
  const requestCert = async (type) => {
    setSending(true);
    try {
      await mutateData((cur)=>({ ...cur, requests:[{ id:uid(), employee:me.name, type, status:"Requested", date:today() }, ...(cur.requests||[])] }), `${me.name} requested ${type}`);
      setSent(`${type} request sent to HR — you'll be notified when it's ready.`);
      setTimeout(()=>setSent(""), 6000);
    } catch { setSent(""); alert("Couldn't reach the server — please try again."); }
    setSending(false);
  };
  return (<>
    <Head title="Payslips" sub="Download your slips or request a certificate"/>
    <div className="flex flex-wrap gap-2 mb-2"><Btn variant="ghost" disabled={sending} onClick={()=>requestCert("Salary Certificate")}>{sending?<Loader2 size={15} className="animate-spin"/>:<FileSignature size={15}/>}Request salary certificate</Btn><Btn variant="ghost" disabled={sending} onClick={()=>requestCert("Experience Certificate")}>{sending?<Loader2 size={15} className="animate-spin"/>:<ScrollText size={15}/>}Request experience certificate</Btn></div>
    {sent && <div className="mb-3 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center gap-2"><Check size={15}/>{sent}</div>}
    {myReqs.length>0 && <div className="mb-4"><div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-2">My certificate requests</div>
      <Card><Table cols={["Request","Sent","Status"]}>{myReqs.map(r=>(<Row key={r.id}><Td className="font-medium">{r.type}</Td><Td className="text-slate-500">{r.date}</Td><Td><Pill s={r.status}/>{r.decidedOn&&r.status==="Done"&&<div className="text-xs text-slate-400 mt-0.5">done {r.decidedOn}</div>}</Td></Row>))}</Table></Card></div>}
    <Card><Table cols={["Month","Net pay","Status",""]}>{slips.length===0?<tr><td colSpan={4}><Empty msg="No payslips yet"/></td></tr>:slips.map(p=>(<Row key={p.id}><Td className="font-medium">{p.month}</Td><Td>{fmt(netPay(p))}</Td><Td><Pill s={p.paid?"Paid":"Pending"}/></Td><Td><button onClick={()=>setSlip(p)} className="text-sky-600 text-xs font-medium hover:underline">View / download</button></Td></Row>))}</Table></Card>
    {slip && <SlipModal slip={slip} brand={brand} data={data} onClose={()=>setSlip(null)}/>}
  </>);
}
function EmpTimesheet({ data, update, me }) {
  const blank = { client:"", date:today(), work:"", status:"Completed", hours:"" };
  const [f, setF] = useState(blank); const [editId, setEditId] = useState(null);
  const mine = data.timesheets.filter(t=>t.employee===me.name).slice().sort((a,b)=>b.date.localeCompare(a.date));
  const submit = () => {
    if(!f.client || !f.work) return;
    if (editId) { update("timesheets", data.timesheets.map(t=>t.id===editId?{...t,...f,hours:+f.hours||0,edited:true}:t), `${me.name} edited a work log (${f.client})`); }
    else { update("timesheets", [{ id:uid(), employee:me.name, ...f, hours:+f.hours||0 }, ...data.timesheets], `${me.name} logged daily work (${f.client})`); }
    setF(blank); setEditId(null);
  };
  const editRow = (t) => { setEditId(t.id); setF({ client:t.client, date:t.date, work:t.work||t.note||"", status:t.status||"Completed", hours:t.hours||"" }); };
  return (<>
    <Head title="Daily Work Log" sub="Log what you worked on each day and for which client — your founder & HR can see this"/>
    <div className="grid lg:grid-cols-2 gap-5">
      <Card><div className="p-5 space-y-3">
        <ClientInput clients={data.clients} value={f.client} onChange={e=>setF({...f,client:e.target.value})}/>
        <Area label="What did you work on?" value={f.work} onChange={e=>setF({...f,work:e.target.value})} placeholder="e.g. Designed 5 Instagram posts, edited reel, sent for review"/>
        <div className="grid grid-cols-3 gap-3"><Field label="Date" type="date" value={f.date} onChange={e=>setF({...f,date:e.target.value})}/><Select label="Status" options={["Completed","In progress","Blocked"]} value={f.status} onChange={e=>setF({...f,status:e.target.value})}/><Field label="Hours (optional)" type="number" value={f.hours} onChange={e=>setF({...f,hours:e.target.value})}/></div>
        <div className="flex gap-2"><Btn onClick={submit}><Check size={15}/>{editId?"Save update":"Log work"}</Btn>{editId && <Btn variant="ghost" onClick={()=>{setF(blank);setEditId(null);}}>Cancel</Btn>}</div>
      </div></Card>
      <Card><Table cols={["Date","Client","Work","Status",""]}>{mine.length===0?<tr><td colSpan={5}><Empty msg="No work logged yet"/></td></tr>:mine.map(t=>(<Row key={t.id}><Td className="text-slate-500 whitespace-nowrap">{t.date}</Td><Td className="font-medium">{t.client}</Td><Td className="text-slate-600">{t.work||t.note}{t.hours?<span className="text-slate-400 text-xs"> · {t.hours}h</span>:null}</Td><Td><Pill s={t.status==="Completed"?"Done":t.status||"Done"}/></Td><Td><RowActions onEdit={()=>editRow(t)}/></Td></Row>))}</Table></Card>
    </div></>);
}
function EmpExpenses({ data, update, mutateData, me }) {
  const [f, setF] = useState({ desc:"", amount:"", receipt:null });
  const [ap, setAp] = useState(null); const [apErr, setApErr] = useState(""); const [apBusy, setApBusy] = useState(false);
  const sendAppeal = async () => {
    if (!ap.reason.trim()) { setApErr("Please explain why it should be reconsidered."); return; }
    setApBusy(true); setApErr("");
    try {
      await mutateData((cur)=>({ ...cur, payables:(cur.payables||[]).map(x=>x.id!==ap.id ? x : {
        ...x, status:"Pending",                       // back to HR for one more look
        appealCount:(+x.appealCount||0)+1,
        appeals:[...(x.appeals||[]), { reason:ap.reason.trim(), on:today() }],
      }) }), `${me.name} appealed a rejected claim: ${ap.desc}`);
      setAp(null);
    } catch { setApErr("Couldn't reach the server — please try again."); }
    setApBusy(false);
  };
  const [err, setErr] = useState("");
  const mine = data.payables.filter(p=>p.kind==="reimbursement" && p.vendor===me.name);
  const onReceipt = async (file) => {
    if (!file) return;
    if (file.size > 20*1024*1024) { setErr("That file is over 20 MB — please compress it first."); return; }
    const isImg = file.type.startsWith("image/");
    const dataUrl = isImg ? await readImage(file, 1600, true, 0.82) : await readFile(file);
    try {
      const stored = await uploadFile(dataUrl, file.name);        // stored outside the data record
      setF({ ...f, receipt:null, receiptFileId:stored.fileId, receiptMime:stored.mime, receiptName:file.name, receiptIsImg:isImg });
      setErr("");
    } catch { setErr("Couldn't upload the receipt — check your connection and try again."); }
  };
  const submit = () => {
    if (!f.desc || !f.amount) { setErr("Please add a description and amount."); return; }
    if (!f.receipt && !f.receiptFileId) { setErr("A photo of the bill/receipt is required to submit a claim."); return; }
    update("payables", [{ id:uid(), vendor:me.name, desc:"Reimbursement: "+f.desc, amount:+f.amount, due:today(), status:"Pending", kind:"reimbursement", settled:false, receipt:f.receipt, receiptFileId:f.receiptFileId, receiptMime:f.receiptMime, receiptName:f.receiptName }, ...data.payables], `${me.name} submitted an expense claim`);
    setF({ desc:"", amount:"", receipt:null, receiptFileId:null, receiptMime:null, receiptName:"", receiptIsImg:undefined }); setErr("");
  };
  return (<>
    <Head title="Expense Claims" sub="Submit a claim with a receipt — approved claims are added to your salary"/>
    <div className="grid lg:grid-cols-2 gap-5">
      <Card><div className="p-5 space-y-3">
        <Field label="What was it for?" value={f.desc} onChange={e=>setF({...f,desc:e.target.value})} placeholder="e.g. Client meeting fuel, props for shoot"/>
        <Field label="Amount (PKR)" type="number" value={f.amount} onChange={e=>setF({...f,amount:e.target.value})}/>
        <div><span className="text-xs text-slate-500 mb-1 block">Receipt / bill photo <span className="text-rose-500">*required</span></span>
          <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500"><Paperclip size={15}/>{f.receipt?"Receipt attached":"Attach receipt / bill"}<input type="file" accept="image/*,application/pdf" className="hidden" onChange={e=>onReceipt(e.target.files[0])}/></label>
          {(f.receipt||f.receiptFileId) && <button onClick={()=>openStored(fileRef(f,"receipt"), f.receiptName)} className="mt-2 flex items-center gap-2 text-sm text-sky-600 hover:underline"><FileText size={15}/>{f.receiptName||"Attached file"} ↗</button>}
        </div>
        {err && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{err}</div>}
        <Btn onClick={submit}><Check size={15}/>Submit claim</Btn>
      </div></Card>
      <Card><Table cols={["Description","Amount","Status",""]}>{mine.length===0?<tr><td colSpan={4}><Empty msg="No claims submitted"/></td></tr>:mine.map(p=>{
        const rejected = p.status==="Rejected";
        const canAppeal = rejected && !p.finalRejected && (+p.appealCount||0)===0;
        const lastRej = (p.rejections||[])[(p.rejections||[]).length-1];
        return (<Row key={p.id}>
          <Td className="font-medium"><div className="flex items-center gap-2">{(p.receipt||p.receiptFileId)&&<button onClick={()=>openStored(fileRef(p,"receipt"), p.receiptName||"receipt")} title="Open receipt" className="w-8 h-8 rounded border border-slate-200 grid place-items-center overflow-hidden hover:ring-2 hover:ring-sky-400"><StoredImg d={fileRef(p,"receipt")} className="w-8 h-8 object-cover"/></button>}{p.desc.replace("Reimbursement: ","")}</div>
            {lastRej && <div className="text-xs text-rose-600 mt-1">HR: {lastRej.reason}</div>}
            {(p.appeals||[]).length>0 && <div className="text-xs text-amber-600 mt-0.5">Your appeal: {p.appeals[p.appeals.length-1].reason}</div>}
          </Td>
          <Td>{fmt(p.amount)}</Td>
          <Td><Pill s={p.status}/>{p.finalRejected && <div className="text-xs text-slate-400 mt-0.5">final</div>}{(p.appeals||[]).length>0 && p.status==="Pending" && <div className="text-xs text-amber-600 mt-0.5">under review</div>}</Td>
          <Td>{canAppeal
            ? <button onClick={()=>{setAp({ id:p.id, desc:p.desc.replace("Reimbursement: ",""), amount:p.amount, reason:"" });setApErr("");}} className="text-xs text-sky-600 hover:underline whitespace-nowrap">Appeal</button>
            : p.finalRejected ? <span className="text-xs text-slate-400 whitespace-nowrap">closed</span> : <span className="text-xs text-slate-300">—</span>}</Td>
        </Row>);})}</Table></Card>
      {ap && <Modal title="Appeal this decision" onClose={()=>{setAp(null);setApErr("");}}>
        <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm flex justify-between"><span className="text-slate-500">{ap.desc}</span><b>{fmt(ap.amount)}</b></div>
        <p className="text-xs text-slate-500">Explain why you think this claim should be reimbursed. HR will look at it once more — if it is rejected again, the decision is final.</p>
        <Area label="Your explanation" value={ap.reason} onChange={e=>{setAp({...ap,reason:e.target.value});setApErr("");}}/>
        {apErr && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{apErr}</div>}
        <Btn onClick={sendAppeal} disabled={apBusy}>{apBusy?<Loader2 size={15} className="animate-spin"/>:<Check size={15}/>}{apBusy?"Sending…":"Send appeal to HR"}</Btn>
      </Modal>}
    </div></>);
}


// ===== Payslip delivery =====
// The PDF is built on the server so it exists as a real file — that is what makes it
// attachable to an email (a Gmail compose link can never carry an attachment).
function payslipBreakdown(slip) {
  const cur = slip.currency || "PKR";
  const plus = [["Basic salary", +slip.basic || 0]];
  if (+slip.allowances) plus.push(["Allowances", +slip.allowances]);
  if (+slip.reimbursements) plus.push(["Reimbursements", +slip.reimbursements]);
  (slip.adjustments||[]).filter(a=>+a.amount>0).forEach(a=>plus.push([a.reason||"Addition", +a.amount]));
  const minus = [];
  [["Income tax",slip.tax],["EOBI",slip.eobi],["Provident fund",slip.pf],["Advance / loan",slip.advance]]
    .forEach(([k,v])=>{ if (+v) minus.push([k, +v]); });
  (slip.adjustments||[]).filter(a=>+a.amount<0).forEach(a=>minus.push([a.reason||"Deduction", Math.abs(+a.amount)]));
  const gross = plus.reduce((t,[,v])=>t+v,0), ded = minus.reduce((t,[,v])=>t+v,0);
  return { cur, plus, minus, gross, ded, net: gross - ded };
}
function payslipMessage(slip, brand, { whatsapp = false } = {}) {
  const b = payslipBreakdown(slip);
  const B = (t) => whatsapp ? `*${t}*` : t;
  const money = (n) => fmt(n, b.cur);
  const L = [];
  L.push(B(brand?.company || "Salary slip"));
  L.push(`Salary slip — ${slip.month || ""}`, "");
  L.push(`Employee: ${slip.employee}`, "");
  L.push(B("Earnings"));
  b.plus.forEach(([k,v])=>L.push(`${k}: ${money(v)}`));
  L.push(`Total earnings: ${money(b.gross)}`, "");
  L.push(B("Deductions"));
  if (b.minus.length) b.minus.forEach(([k,v])=>L.push(`${k}: ${money(v)}`)); else L.push("None");
  L.push(`Total deductions: ${money(b.ded)}`, "");
  L.push(B(`Net pay: ${money(b.net)}`));
  if (slip.paid) L.push("", `Paid on ${slip.paidOn || "—"}${slip.payMethod ? ` via ${slip.payMethod}` : ""}.`);
  L.push("", whatsapp ? "Your detailed slip is attached as a PDF." : "Your detailed salary slip is attached to this email as a PDF.");
  L.push("", `${brand?.company || ""}`);
  return L.join("\n");
}
// The PDF builder wants the actual images, not ids.
function pdfBrand(brand) {
  const sig = (brand?.signatories || []).find(x => x.id === brand.payslipSigId) || (brand?.signatories || [])[0] || null;
  const stamp = (brand?.stamps || []).find(x => x.id === brand.payslipStampId) || (brand?.stamps || [])[0] || null;
  return {
    ...brand,
    signatories: undefined, stamps: undefined,      // don't ship every image to the server
    payslipSignature: sig ? { img: sig.sig, name: sig.name, role: sig.role } : null,
    payslipStamp: stamp ? stamp.img : null,
  };
}
async function downloadPayslipPdf(slip, brand, employee) {
  const r = await apiReq("POST", "/payslip/pdf", { slip, brand: pdfBrand(brand), employee });
  const bin = atob(r.pdf); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: "application/pdf" }));
  const a = document.createElement("a"); a.href = url; a.download = r.filename || "payslip.pdf";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 60000);
}

/* shared slip modal */
function SlipModal({ slip, brand, data, sendable = false, onClose }) {
  const emp = (data?.employees || []).find(e => e.name === slip.employee) || {};
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const doPdf = async () => {
    setBusy("pdf"); setMsg(null);
    try { await downloadPayslipPdf(slip, brand, emp); }
    catch (e) { setMsg({ ok:false, text: e.message || "Couldn't build the PDF." }); }
    setBusy("");
  };
  const doEmail = async () => {
    if (!emp.email) { setMsg({ ok:false, text:"There's no email address on this employee's profile — add one first." }); return; }
    setBusy("mail"); setMsg(null);
    try {
      await apiReq("POST", "/payslip/email", {
        slip, brand: pdfBrand(brand), employee: emp, to: emp.email,
        subject: `Salary slip — ${slip.month || ""}`,
        body: payslipMessage(slip, brand),
      });
      setMsg({ ok:true, text:`Emailed to ${emp.email} with the PDF attached.` });
    } catch (e) { setMsg({ ok:false, text: e.message || "The email couldn't be sent." }); }
    setBusy("");
  };
  const doWA = () => {
    const num = String(emp.phone || "").replace(/\D/g, "");
    if (!num) { setMsg({ ok:false, text:"No phone number on this employee's profile." }); return; }
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(payslipMessage(slip, brand, { whatsapp:true }))}`, "_blank");
  };
  return (<Modal title="Salary slip" onClose={onClose}>
    <div className="bg-white text-slate-900 rounded-lg p-5 text-sm border border-slate-200"><Letterhead brand={brand}/>
      <div className="flex justify-between mb-1"><span className="text-slate-500">Employee</span><b>{slip.employee}</b></div>
      <div className="flex justify-between mb-3"><span className="text-slate-500">Period</span><b>{slip.month}</b></div>
      <div className="space-y-1 border-t pt-3">
        <div className="flex justify-between"><span>Basic</span><span>{fmt(slip.basic)}</span></div>
        {+slip.allowances>0 && <div className="flex justify-between"><span>Allowances</span><span>{fmt(slip.allowances)}</span></div>}
        {+slip.reimbursements>0 && <div className="flex justify-between"><span>Reimbursements</span><span>{fmt(slip.reimbursements)}</span></div>}
        {(slip.adjustments||[]).map(a=>(<div key={a.id} className={`flex justify-between ${a.amount<0?"text-rose-600":"text-emerald-700"}`}><span>{a.reason}</span><span>{a.amount<0?"-":"+"}{fmt(Math.abs(a.amount))}</span></div>))}
        {+slip.tax>0 && <div className="flex justify-between text-slate-500 pt-2"><span>Income tax</span><span>-{fmt(slip.tax)}</span></div>}
        {+slip.eobi>0 && <div className="flex justify-between text-slate-500"><span>EOBI</span><span>-{fmt(slip.eobi)}</span></div>}
        {+slip.pf>0 && <div className="flex justify-between text-slate-500"><span>Provident fund</span><span>-{fmt(slip.pf)}</span></div>}
        {+slip.advance>0 && <div className="flex justify-between text-slate-500"><span>Advance / loan</span><span>-{fmt(slip.advance)}</span></div>}
        <div className="flex justify-between border-t pt-2 mt-2 font-bold"><span>Net pay</span><span>{fmt(netPay(slip))}</span></div>
      </div></div>
    {(()=>{ const pb=pdfBrand(brand); if(!pb.payslipSignature && !pb.payslipStamp) return null; return (
      <div className="flex items-end justify-between gap-4 pt-2">
        <div>{pb.payslipSignature?.img && <img src={pb.payslipSignature.img} className="h-12 object-contain"/>}
          <div className="border-t border-slate-400 w-40 mt-1 pt-1"><div className="text-xs font-semibold text-slate-700">{pb.payslipSignature?.name||"Authorised signatory"}</div><div className="text-xs text-slate-400">{pb.payslipSignature?.role||"Human Resources"}</div></div>
        </div>
        {pb.payslipStamp && <img src={pb.payslipStamp} className="h-20 object-contain opacity-90"/>}
      </div>); })()}
    <div className="flex flex-wrap gap-2">
      <Btn variant="ghost" onClick={doPdf} disabled={busy==="pdf"}>{busy==="pdf"?<Loader2 size={15} className="animate-spin"/>:<Download size={15}/>}Download PDF</Btn>
      {sendable && <Btn onClick={doEmail} disabled={busy==="mail"}>{busy==="mail"?<Loader2 size={15} className="animate-spin"/>:<Send size={15}/>}{busy==="mail"?"Sending…":"Email with PDF attached"}</Btn>}
      {sendable && <Btn variant="ghost" onClick={doWA}><Send size={15}/>WhatsApp message</Btn>}
    </div>
    {msg && <div className={`text-xs rounded-lg px-3 py-2 ${msg.ok?"bg-emerald-50 border border-emerald-200 text-emerald-700":"bg-rose-50 border border-rose-200 text-rose-700"}`}>{msg.text}</div>}
    {sendable && <p className="text-xs text-slate-400">WhatsApp carries the written breakdown; attach the downloaded PDF there if you want the document too.</p>}
  </Modal>);
}

/* ================= ADMIN / HR ================= */

// ===== Daily To-Do list =====
// Each person plans their day; unfinished tasks carry to the next day automatically,
// but a reason must be given for every missed task. HR & CEO track it in Team To-dos.
function todoOwner(session, me) { return (me && me.name) || session?.name || session?.username || "User"; }
function TodoCard({ data, mutateData, session, me }) {
  const owner = todoOwner(session, me);
  const t = today();
  const mine = (data.todos||[]).filter(x=>x.owner===owner);
  const overdue = mine.filter(x=>!x.done && x.date < t);
  const open = mine.filter(x=>!x.done && x.date === t);
  const doneToday = mine.filter(x=>x.completedOn === t);
  const [text, setText] = useState("");
  const [reasons, setReasons] = useState({});
  const [rErr, setRErr] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    const v = text.trim(); if (!v) return;
    setText("");
    await mutateData((cur)=>({ ...cur, todos:[...(cur.todos||[]), { id:uid(), owner, text:v, date:t, createdOn:t, done:false, carry:0, reasons:[] }] }), null);
  };
  const toggle = (task) => mutateData((cur)=>({ ...cur, todos:(cur.todos||[]).map(x=>x.id===task.id ? (x.done ? { ...x, done:false, completedOn:null, date:t } : { ...x, done:true, completedOn:t }) : x) }), task.done?null:`${owner} completed: ${task.text}`);
  const del = (task) => mutateData((cur)=>({ ...cur, todos:(cur.todos||[]).filter(x=>x.id!==task.id) }), null);
  const carryAll = async () => {
    if (overdue.some(x=>!(reasons[x.id]||"").trim())) { setRErr("Please give a reason for every task that wasn't completed."); return; }
    setBusy(true); setRErr("");
    await mutateData((cur)=>({ ...cur, todos:(cur.todos||[]).map(x=>{
      if (x.done || x.date >= t || x.owner!==owner) return x;
      return { ...x, date:t, carry:(x.carry||0)+1, reasons:[...(x.reasons||[]), { missedOn:x.date, reason:(reasons[x.id]||"").trim(), givenOn:t }] };
    }) }), `${owner} carried ${overdue.length} unfinished task(s) to today`);
    setReasons({}); setBusy(false);
  };
  return (<Card><div className="p-5">
    <div className="flex items-center justify-between mb-3"><div className="font-semibold text-sm flex items-center gap-2"><CalendarCheck size={16} className="text-sky-600"/>My tasks · today</div><div className="text-xs text-slate-400">{doneToday.length} done · {open.length} open</div></div>
    <div className="flex gap-2 mb-3">
      <input value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>e.key==="Enter"&&add()} placeholder="Write today's task and press Enter…" className={inputCls+" flex-1"}/>
      <Btn onClick={add}><Plus size={15}/>Add</Btn>
    </div>
    {open.length===0 && doneToday.length===0 && <div className="text-sm text-slate-400 py-2">No tasks yet — plan your day above.</div>}
    <div className="space-y-1">{open.map(x=>(
      <div key={x.id} className="flex items-start gap-2 py-1.5 group">
        <button onClick={()=>toggle(x)} className="mt-0.5 w-4 h-4 rounded border border-slate-300 hover:border-sky-500 shrink-0" title="Mark completed"/>
        <div className="flex-1 text-sm text-slate-700">{x.text}
          {x.carry>0 && <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">carried {x.carry}d</span>}
          {(x.reasons||[]).length>0 && <div className="text-xs text-slate-400 mt-0.5">last reason: {x.reasons[x.reasons.length-1].reason}</div>}
        </div>
        <button onClick={()=>del(x)} className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-rose-500"><X size={14}/></button>
      </div>))}
    </div>
    {doneToday.length>0 && <div className="mt-3 pt-3 border-t border-slate-100">
      <div className="text-xs uppercase tracking-wider text-slate-400 mb-1">Completed today</div>
      {doneToday.map(x=>(<div key={x.id} className="flex items-start gap-2 py-1"><button onClick={()=>toggle(x)} className="mt-0.5 w-4 h-4 rounded bg-emerald-500 text-white grid place-items-center shrink-0" title="Undo"><Check size={11}/></button><div className="flex-1 text-sm text-slate-400 line-through">{x.text}</div></div>))}
    </div>}
    {overdue.length>0 && <Modal title={`${overdue.length} task(s) from earlier days not completed`} onClose={()=>{}}>
      <p className="text-xs text-slate-500">These will be moved to today's list. Per policy, please give a reason each one wasn't completed — HR and management can see these reasons.</p>
      <div className="space-y-3">{overdue.map(x=>(<div key={x.id} className="bg-slate-50 border border-slate-200 rounded-lg p-3">
        <div className="text-sm font-medium text-slate-800">{x.text}</div>
        <div className="text-xs text-slate-400 mb-2">planned for {x.date}{x.carry>0?` · already carried ${x.carry}d`:""}</div>
        <input value={reasons[x.id]||""} onChange={e=>{setReasons({...reasons,[x.id]:e.target.value});setRErr("");}} placeholder="Why wasn't this completed?" className={inputCls}/>
      </div>))}</div>
      {rErr && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{rErr}</div>}
      <Btn onClick={carryAll} disabled={busy}>{busy?<Loader2 size={15} className="animate-spin"/>:<Check size={15}/>}Save reasons & move to today</Btn>
    </Modal>}
  </div></Card>);
}
function MyTodos({ data, mutateData, session, me }) {
  const owner = todoOwner(session, me);
  const mine = (data.todos||[]).filter(x=>x.owner===owner);
  const [day, setDay] = useState("");
  const pending = mine.filter(x=>!x.done).slice().sort((a,b)=>(a.createdOn||"").localeCompare(b.createdOn||""));
  const completed = mine.filter(x=>x.done && (!day || x.completedOn===day)).slice().sort((a,b)=>(b.completedOn||"").localeCompare(a.completedOn||""));
  return (<>
    <Head title="My To-dos" sub={`${pending.length} still to do · ${mine.filter(x=>x.done).length} completed so far`}/>
    <div className="space-y-5">
      <TodoCard data={data} mutateData={mutateData} session={session} me={me}/>
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-2">Everything still pending</div>
        <Card>{pending.length===0?<Empty msg="Nothing pending — you're all clear"/>:<div className="divide-y divide-slate-100">{pending.map(x=>(
          <div key={x.id} className="px-5 py-3">
            <div className="flex items-center justify-between gap-2"><div className="text-sm font-medium text-slate-800">{x.text}</div>
              <div className="text-xs text-slate-400 whitespace-nowrap">since {x.createdOn}{x.carry>0?` · carried ${x.carry}d`:""}</div></div>
            {(x.reasons||[]).length>0 && <div className="mt-1.5 space-y-0.5">{x.reasons.map((r,i)=>(<div key={i} className="text-xs text-slate-500">• {r.missedOn}: <span className="text-slate-600">{r.reason}</span></div>))}</div>}
          </div>))}</div>}</Card>
      </div>
      <div>
        <div className="flex flex-wrap items-end justify-between gap-3 mb-2">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-medium">Completed {day?`on ${day}`:""}</div>
          <div className="flex items-end gap-2"><div className="min-w-40"><Field label="Check a specific day" type="date" value={day} onChange={e=>setDay(e.target.value)}/></div>{day&&<Btn variant="ghost" onClick={()=>setDay("")}><X size={14}/>Clear</Btn>}</div>
        </div>
        <Card>{completed.length===0?<Empty msg={day?`Nothing completed on ${day}`:"Nothing completed yet"}/>:<Table cols={["Task","Planned on","Completed","On time"]}>{completed.map(x=>(
          <Row key={x.id}><Td className="text-slate-700">{x.text}</Td><Td className="text-slate-500">{x.createdOn}</Td><Td className="text-slate-500">{x.completedOn}</Td>
          <Td>{x.carry>0?<span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">{x.carry}d late</span>:<span className="text-xs text-emerald-600">on time</span>}</Td></Row>))}</Table>}</Card>
      </div>
    </div>
  </>);
}
function TeamTodos({ data, go }) {
  const [openP, setOpenP] = useState(null);
  const [day, setDay] = useState("");
  const t = today();
  const todos = data.todos||[];
  const owners = [...new Set([...data.employees.filter(e=>e.status==="Active").map(e=>e.name), ...todos.map(x=>x.owner)])];
  const of = (n)=>todos.filter(x=>x.owner===n);
  if (openP) {
    const mine = of(openP);
    const pending = mine.filter(x=>!x.done).sort((a,b)=>(b.date||"").localeCompare(a.date||""));
    const completed = mine.filter(x=>x.done && (!day || x.completedOn===day)).sort((a,b)=>(b.completedOn||"").localeCompare(a.completedOn||""));
    const plannedThatDay = day ? mine.filter(x=>x.createdOn<=day && (!x.done || (x.completedOn||"")>=day)) : [];
    return (<>
      <button onClick={()=>{setOpenP(null);setDay("");}} className="flex items-center gap-1 text-sm text-slate-500 hover:text-sky-600 mb-4"><ChevronLeft size={16}/>All team members</button>
      <Head title={`${openP} · to-dos`} sub={`${pending.length} pending · ${mine.filter(x=>x.done).length} completed all-time`}/>
      <div className="flex flex-wrap gap-3 mb-4 items-end"><div className="min-w-40"><Field label="Check a specific day" type="date" value={day} onChange={e=>setDay(e.target.value)}/></div>{day&&<Btn variant="ghost" onClick={()=>setDay("")}><X size={14}/>Clear</Btn>}</div>
      {day && <Card><div className="p-4 text-sm text-slate-600">{plannedThatDay.length} task(s) on their list on {day} · {mine.filter(x=>x.completedOn===day).length} completed that day</div></Card>}
      <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mt-4 mb-2">Pending (carrying forward)</div>
      <Card>{pending.length===0?<Empty msg="Nothing pending — all clear"/>:<div className="divide-y divide-slate-100">{pending.map(x=>(
        <div key={x.id} className="px-5 py-3"><div className="flex items-center justify-between"><div className="text-sm font-medium text-slate-800">{x.text}</div><div className="text-xs text-slate-400">since {x.createdOn}{x.carry>0?` · carried ${x.carry}d`:""}</div></div>
        {(x.reasons||[]).length>0 && <div className="mt-1.5 space-y-0.5">{x.reasons.map((r,i)=>(<div key={i} className="text-xs text-slate-500">• {r.missedOn}: <span className="text-slate-600">{r.reason}</span></div>))}</div>}
        </div>))}</div>}</Card>
      <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mt-5 mb-2">Completed {day?`on ${day}`:""}</div>
      <Card>{completed.length===0?<Empty msg={day?`Nothing completed on ${day}`:"Nothing completed yet"}/>:<Table cols={["Task","Planned on","Completed","Carried"]}>{completed.map(x=>(
        <Row key={x.id}><Td className="text-slate-700">{x.text}{(x.reasons||[]).length>0&&<div className="text-xs text-slate-400 mt-0.5">{x.reasons.length} delay reason(s) on record</div>}</Td><Td className="text-slate-500">{x.createdOn}</Td><Td className="text-slate-500">{x.completedOn}</Td><Td>{x.carry>0?<span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">{x.carry}d late</span>:<span className="text-xs text-emerald-600">on time</span>}</Td></Row>))}</Table>}</Card>
    </>);
  }
  return (<>
    <Head title="Team To-dos" sub="Everyone's daily task lists · tap a person to see their plan, what's done, and reasons for delays"/>
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{owners.length===0?<Card><Empty msg="No team members yet"/></Card>:owners.map(n=>{
      const mine=of(n); const openN=mine.filter(x=>!x.done&&x.date===t).length; const doneN=mine.filter(x=>x.completedOn===t).length;
      const carrying=mine.filter(x=>!x.done&&(x.carry>0||x.date<t)).length; const planned=mine.some(x=>x.createdOn===t||x.date===t);
      return (<Card key={n}><button onClick={()=>setOpenP(n)} className="p-5 text-left w-full hover:bg-slate-50 rounded-xl transition">
        <div className="flex items-center justify-between"><div className="font-semibold">{n}</div>{planned?<span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">planned today</span>:<span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">no plan yet</span>}</div>
        <div className="text-xs text-slate-500 mt-2">{doneN} done · {openN} open today</div>
        <div className={`text-xs mt-0.5 ${carrying?"text-amber-600":"text-slate-400"}`}>{carrying?`${carrying} task(s) carrying forward`:"nothing carrying over"}</div>
      </button></Card>);
    })}</div>
  </>);
}

function Dashboard({ data, role, go, mutateData, session, me }) {
  const t = today(); const mk = monthKey(); const ml = monthLabel();
  const activeEmp = data.employees.filter(e=>e.status==="Active");
  // --- attendance today ---
  const att = data.attendance.filter(a=>a.date===t);
  const present = att.filter(a=>a.status==="Present").length;
  const onLeave = att.filter(a=>a.status==="Leave").length;
  const absent = att.filter(a=>a.status==="Absent").length;
  const marked = att.filter(a=>a.status!=="Requested");   // pending claims are not attendance yet
  const notMarked = Math.max(0, activeEmp.length - marked.length);
  // --- requests: left vs handled ---
  const pendLeaves = data.leaves.filter(l=>l.status==="Pending").length;
  const decidedMonth = data.leaves.filter(l=>l.status!=="Pending" && (l.decidedOn||"").startsWith(mk)).length;
  const pendCerts = (data.requests||[]).filter(r=>r.status!=="Done"&&r.status!=="Declined").length;
  const certsDoneMonth = (data.requests||[]).filter(r=>r.status==="Done" && (r.decidedOn||"").startsWith(mk)).length;
  const pendClaims = data.payables.filter(p=>p.kind==="reimbursement"&&p.status==="Pending").length;
  const claimsSettledMonth = data.payables.filter(p=>p.kind==="reimbursement"&&p.settled&&(p.due||"").startsWith(mk)).length;
  const pendReqs = pendLeaves + pendCerts + pendClaims;
  // --- work today / this week ---
  const weekAgo = new Date(Date.now()-6*86400000).toISOString().slice(0,10);
  const workToday = (data.timesheets||[]).filter(w=>w.date===t);
  const loggedTodayPeople = new Set(workToday.map(w=>w.employee)).size;
  const hoursToday = workToday.reduce((s2,w)=>s2+(+w.hours||0),0);
  const hoursWeek = (data.timesheets||[]).filter(w=>w.date>=weekAgo).reduce((s2,w)=>s2+(+w.hours||0),0);
  const openWork = (data.timesheets||[]).filter(w=>w.status&&w.status!=="Completed").length;
  // --- payroll this month ---
  const slips = data.payroll.filter(p=>p.month===ml);
  const slipsPaid = slips.filter(p=>p.paid).length;
  // --- money ---
  const unpaidRet = data.retainerInvoices.filter(i=>i.status!=="Paid").length;
  const unpaidInv = data.invoices.filter(i=>i.status!=="Paid"&&i.status!=="Draft").length;
  const unpaidAll = unpaidRet + unpaidInv;
  const paidThisMonth = (data.receipts||[]).filter(r=>(r.date||"").startsWith(mk)).length;
  const recvOverdue = data.receivables.filter(r=>r.status==="Overdue").length;
  const openPayables = data.payables.filter(p=>p.status!=="Paid");
  const vbPending = (data.vendorBills||[]).filter(b=>b.status!=="Approved"&&b.status!=="Paid").length;
  // --- compliance ---
  const expiring = data.employees.reduce((n,e)=>n+(e.docs||[]).filter(d=>d.expiry&&daysUntil(d.expiry)<=30).length,0);
  const onNotice = data.employees.filter(e=>e.onNotice && e.status==="Active").length;
  const pastLastDay = data.employees.filter(e=>e.onNotice && e.status==="Active" && e.lastWorkingDay && e.lastWorkingDay < t).length;
  const isAdmin = role === "admin";
  const mrr = data.retainers.filter(r=>r.status==="Active").reduce((s2,r)=>s2+ +r.amount,0);
  const stats = [
    { label:"Team (active)", value:activeEmp.length, sub:`${present} present · ${onLeave} on leave · ${notMarked} not marked`, icon:Users, tab:"attendance" },
    { label:"Requests awaiting HR", value:pendReqs, sub:`${pendLeaves} leave · ${pendCerts} certificates · ${pendClaims} claims`, icon:Inbox, tab:"requests" },
    { label:"Unpaid invoices", value:unpaidAll, sub:`${paidThisMonth} paid so far in ${ml.split(" ")[0]}`, icon:FolderOpen, tab:"retainers" },
    isAdmin
      ? { label:"Retainer MRR (PKR)", value:fmt(mrr), sub:`${data.retainers.filter(r=>r.status==="Active").length} active retainers`, icon:Repeat, tab:"retainers" }
      : { label:"Work logged today", value:`${loggedTodayPeople}/${activeEmp.length}`, sub:`${hoursToday}h today · ${hoursWeek}h this week`, icon:Clock, tab:"timesheets" },
  ];
  const ok = (v) => v===0;
  const Line = ({label, value, good, tab}) => (
    <button onClick={()=>tab&&go(tab)} className="w-full flex items-center justify-between py-1.5 text-sm hover:bg-slate-50 rounded px-1 text-left">
      <span className="text-slate-600">{label}</span>
      <span className={`font-semibold ${good?"text-emerald-600":"text-slate-900"}`}>{good?"✓ clear":value}</span>
    </button>);
  const Panel = ({title, tab, children}) => (
    <Card><div className="p-5">
      <div className="flex items-center justify-between mb-2"><div className="font-semibold text-sm">{title}</div><button onClick={()=>go(tab)} className="text-xs text-sky-600 hover:underline">open →</button></div>
      <div className="divide-y divide-slate-100">{children}</div>
    </div></Card>);
  return (<>
    <Head title="Dashboard" sub={`Welcome back · ${ROLES[role]} · ${new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"})}`}/>
    <div className="mb-6"><TodoCard data={data} mutateData={mutateData} session={session} me={me}/></div>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">{stats.map(s2=>{const I=s2.icon;return(<Card key={s2.label}><button onClick={()=>go(s2.tab)} className="p-5 text-left w-full hover:bg-slate-50 rounded-xl transition"><I className="text-sky-600 mb-3" size={20}/><div className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 break-words">{s2.value}</div><div className="text-xs text-slate-500 mt-1">{s2.label}</div><div className="text-xs text-slate-400 mt-0.5">{s2.sub}</div></button></Card>);})}</div>
    <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
      <Panel title="Attendance · today" tab="attendance">
        <Line label="Present" value={present} tab="attendance"/>
        <Line label="On leave" value={onLeave} good={ok(onLeave)} tab="attendance"/>
        <Line label="Absent" value={absent} good={ok(absent)} tab="attendance"/>
        <Line label="Not marked yet" value={notMarked} good={ok(notMarked)} tab="attendance"/>
      </Panel>
      <Panel title="HR requests · pending vs handled" tab="requests">
        <Line label="Leave awaiting approval" value={pendLeaves} good={ok(pendLeaves)} tab="requests"/>
        <Line label="Certificates open" value={pendCerts} good={ok(pendCerts)} tab="requests"/>
        <Line label="Expense claims to review" value={pendClaims} good={ok(pendClaims)} tab="payables"/>
        <Line label={`Handled in ${ml.split(" ")[0]}`} value={decidedMonth+certsDoneMonth+claimsSettledMonth} tab="requests"/>
      </Panel>
      <Panel title="Work & timesheets" tab="timesheets">
        <Line label="Logged work today" value={`${loggedTodayPeople} of ${activeEmp.length}`} tab="timesheets"/>
        <Line label="Hours today" value={`${hoursToday}h`} tab="timesheets"/>
        <Line label="Hours this week" value={`${hoursWeek}h`} tab="timesheets"/>
        <Line label="Work items in progress" value={openWork} good={ok(openWork)} tab="timesheets"/>
      </Panel>
      <Panel title={`Payroll · ${ml}`} tab="payroll">
        <Line label="Salary slips prepared" value={`${slips.length} of ${activeEmp.length}`} tab="payroll"/>
        <Line label="Paid" value={slipsPaid} tab="payroll"/>
        <Line label="Awaiting payment" value={slips.length-slipsPaid} good={slips.length>0&&slips.length-slipsPaid===0} tab="payroll"/>
      </Panel>
      <Panel title="Billing & money" tab="retainers">
        <Line label="Invoices unpaid (retainer + one-off)" value={unpaidAll} good={ok(unpaidAll)} tab="retainers"/>
        <Line label={`Payments received in ${ml.split(" ")[0]}`} value={paidThisMonth} tab="receipts"/>
        <Line label="Receivables overdue" value={recvOverdue} good={ok(recvOverdue)} tab="receivables"/>
        <Line label="Payables open" value={`${openPayables.length}${openPayables.length?` · ${fmt(openPayables.reduce((s2,p)=>s2+ +p.amount,0))}`:""}`} good={ok(openPayables.length)} tab="payables"/>
        <Line label="Vendor bills awaiting approval" value={vbPending} good={ok(vbPending)} tab="vendorbills"/>
      </Panel>
      <Panel title="Compliance & documents" tab="employees">
        <Line label="Employee documents expiring ≤30 days" value={expiring} good={ok(expiring)} tab="employees"/>
        <Line label="On notice period" value={onNotice} good={ok(onNotice)} tab="employees"/>
        {pastLastDay>0 && <Line label="Past their last working day" value={pastLastDay} tab="employees"/>}
        <Line label="Announcements posted" value={(data.announcements||[]).length} tab="announce"/>
        <Line label="Clients on record" value={data.clients.length} tab="clients"/>
      </Panel>
    </div>
  </>);
}


// ===== Client Onboarding (Svype Client Intake Ledger v1.0) =====
// Field types: t=text n=number a=textarea s=select m=multi-select d=date b=checkbox
const OB_STEPS = [
  { id:"entity", title:"Client & Company", fields:[
    {k:"legalName", l:"Full legal business name", t:"t", req:1},
    {k:"tradeName", l:"Trading / brand name (if different)", t:"t"},
    {k:"licence", l:"Trade licence / registration no. (UAE licence, NTN…)", t:"t"},
    {k:"industry", l:"Industry / sector", t:"s", o:["Real Estate & Hospitality","F&B / Restaurant","Retail & E-commerce","Professional Services","Healthcare","Technology / SaaS","Other"]},
    {k:"yearEst", l:"Year established", t:"t"},
    {k:"size", l:"Company size", t:"s", o:["Solo / 1–10","11–50","51–200","200+"]},
    {k:"regAddress", l:"Registered address", t:"a"},
    {k:"locationsServed", l:"Physical location(s) served (for local SEO / GBP)", t:"a", ph:"list every branch"},
    {k:"languages", l:"Languages audience is served in", t:"m", o:["English","Arabic","Urdu","Other"]},
    {k:"markets", l:"Primary markets / regions targeted", t:"t", ph:"e.g. UAE only, GCC-wide, UK, Pakistan"},
    {k:"contactName", l:"Primary contact — name & title", t:"t", req:1},
    {k:"contactEmail", l:"Primary contact — email", t:"t", req:1},
    {k:"contactPhone", l:"Primary contact — phone / WhatsApp", t:"t", ph:"9230… / 9715…"},
    {k:"decisionMaker", l:"Final decision-maker (if different)", t:"t"},
    {k:"escalation", l:"Escalation contact for urgent issues", t:"t"},
  ]},
  { id:"comms", title:"Communication & Workflow", fields:[
    {k:"contactMethod", l:"Preferred contact method", t:"s", o:["Email","WhatsApp","Phone","Slack"]},
    {k:"cadence", l:"Preferred meeting cadence", t:"s", o:["Weekly","Biweekly","Monthly","As-needed only"]},
    {k:"timezone", l:"Time zone & working hours", t:"t"},
    {k:"reporting", l:"Preferred reporting format", t:"s", o:["Live dashboard","PDF report","Walkthrough call","Slack summary"]},
    {k:"approver", l:"Who approves content before publishing?", t:"t"},
    {k:"turnaround", l:"Expected approval turnaround", t:"s", o:["Same day","Within 48 hours","Within a week","Flexible"]},
    {k:"revisions", l:"Revision rounds per deliverable", t:"s", o:["1","2","3","Unlimited (specify in contract)"]},
  ]},
  { id:"digital", title:"Current Digital Presence", fields:[
    {k:"website", l:"Website URL", t:"t"},
    {k:"cms", l:"CMS / platform", t:"s", o:["WordPress","Shopify","Webflow","Custom-built","No website yet"]},
    {k:"registrar", l:"Domain registrar", t:"t"},
    {k:"domainExpiry", l:"Domain expiry date", t:"d"},
    {k:"hosting", l:"Hosting provider", t:"t"},
    {k:"adminAccess", l:"Who holds admin access to hosting / DNS?", t:"t", ph:"credentials go in the Vault, never here"},
    {k:"ga4", l:"Google Analytics (GA4) access?", t:"s", o:["Yes — will share","No / not set up","Not sure"]},
    {k:"gsc", l:"Search Console verified?", t:"s", o:["Yes","No","Not sure"]},
    {k:"gbp", l:"Google Business Profile status", t:"s", o:["Claimed & verified","Claimed, not verified","Not claimed","Not applicable"]},
    {k:"seoTools", l:"Existing Ahrefs / SEMrush / other SEO tools", t:"t"},
    {k:"crm", l:"CRM or email marketing platform in use", t:"t"},
    {k:"socials", l:"Social handles (IG, LinkedIn, FB, TikTok)", t:"a"},
    {k:"contentVolume", l:"Approx. existing blog / content volume", t:"t"},
    {k:"brandGuide", l:"Brand guideline / style guide (link)", t:"t"},
  ]},
  { id:"history", title:"Service History & Current Needs", fields:[
    {k:"prevAgency", l:"Worked with an SEO / marketing agency before?", t:"s", o:["Yes","No"]},
    {k:"prevAgencyDetail", l:"If yes — agency, duration, why it ended", t:"a"},
    {k:"penalties", l:"Known Google penalties / manual actions?", t:"s", o:["Yes","No","Not sure"]},
    {k:"notWorking", l:"What's not working right now?", t:"a", req:1},
    {k:"techIssues", l:"Known technical issues", t:"m", o:["Slow site speed","Broken links","No rankings","No leads/conversions","Thin or outdated content","Other"]},
    {k:"keywords", l:"Priority keywords already tracked", t:"a"},
    {k:"urgency", l:"Urgency", t:"s", o:["Immediate","Within a month","Flexible timeline"]},
  ]},
  { id:"goals", title:"Expectations & Goals", fields:[
    {k:"objective", l:"Primary business objective", t:"s", o:["More leads","More bookings/sales","Brand awareness","Rank in AI search (AEO/GEO)","Fix technical SEO foundation"]},
    {k:"success90", l:"What does success look like in 90 days?", t:"a", req:1},
    {k:"audience", l:"Ideal customer / target audience", t:"a"},
    {k:"competitors", l:"Top 3 competitors to benchmark", t:"a"},
    {k:"seasonality", l:"Seasonal / timing considerations", t:"a", ph:"launches, peak seasons, events"},
    {k:"priorities", l:"Priority ranking (Traffic, Rankings, Leads, Conversions, Revenue)", t:"a", ph:"numbered, most important first"},
  ]},
  { id:"budget", title:"Budget & Payment", fields:[
    {k:"budget", l:"Monthly budget range", t:"s", o:["Under $1,000","$1,000–$3,000","$3,000–$7,000","$7,000+"]},
    {k:"currency", l:"Currency", t:"s", o:["AED","USD","GBP","PKR"]},
    {k:"engagement", l:"Engagement type", t:"s", o:["Monthly retainer","Project-based","Milestone-based"]},
    {k:"term", l:"Contract term", t:"s", o:["Month-to-month","3 months","6 months","12 months"]},
    {k:"notice", l:"Notice period to cancel", t:"s", o:["None","14 days","30 days","60 days"]},
    {k:"exclusivity", l:"Working with another agency concurrently?", t:"s", o:["Yes","No"]},
    {k:"payMethod", l:"Preferred payment method", t:"s", o:["Bank transfer","Payoneer","Card"]},
    {k:"billingContact", l:"Billing contact (if different)", t:"t"},
    {k:"invoiceReqs", l:"Anything specific required on invoices?", t:"a"},
  ]},
  { id:"legal", title:"Legal & Consent", fields:[
    {k:"tos", l:"Client accepts the Service Agreement / Terms", t:"b", req:1},
    {k:"privacy", l:"Consent to data processing (UAE PDPL / GDPR)", t:"b", req:1},
    {k:"nda", l:"NDA / confidentiality required?", t:"s", o:["Yes","No"]},
    {k:"ipTransfer", l:"IP of deliverables transfers on final payment", t:"b"},
    {k:"portfolio", l:"Permission to feature in Svype portfolio", t:"s", o:["Yes, freely","Yes, with approval each time","No"]},
    {k:"signatory", l:"Authorised signatory name & date", t:"t", req:1},
  ]},
  { id:"notes", title:"Additional Notes", fields:[
    {k:"tone", l:"Tone of voice notes", t:"a"},
    {k:"avoid", l:"Topics or competitors to avoid", t:"a"},
    {k:"compliance", l:"Industry compliance requirements", t:"a", ph:"e.g. real-estate disclaimers, health claims"},
    {k:"anythingElse", l:"Anything else we should know", t:"a"},
  ]},
  { id:"referral", title:"Referral & Marketing", fields:[
    {k:"source", l:"How did you hear about Svype?", t:"s", o:["Referral","Google search","Social media","Existing client","Other"]},
    {k:"referredBy", l:"Referred by (optional)", t:"t"},
    {k:"testimonial", l:"Consent to be featured as testimonial", t:"s", o:["Yes","No"]},
    {k:"newsletter", l:"Opt in to Svype updates", t:"s", o:["Yes","No"]},
  ]},
  { id:"internal", title:"Internal Use Only", internal:1, fields:[
    {k:"strategist", l:"Account strategist assigned", t:"t"},
    {k:"callDate", l:"Onboarding call date", t:"d"},
    {k:"contractDate", l:"Contract signed date", t:"d"},
    {k:"tags", l:"CRM tags (service, industry, priority tier)", t:"t"},
    {k:"capacity", l:"Content production capacity confirmed?", t:"s", o:["Yes","No — flag capacity conflict"]},
    {k:"riskFlags", l:"Internal risk flags", t:"a", ph:"unclear scope, budget mismatch, difficult stakeholder…"},
    {k:"reviewDate", l:"Next internal review date", t:"d"},
    {k:"retainerAmount", l:"Monthly retainer amount (auto-creates the retainer)", t:"n", ph:"leave blank if not a retainer"},
  ]},
];
function ObField({ f, v, set }) {
  const lbl = f.l + (f.req ? " *" : "");
  if (f.t==="a") return <Area label={lbl} value={v||""} onChange={e=>set(e.target.value)} placeholder={f.ph}/>;
  if (f.t==="s") return <Select label={lbl} options={["— select —",...f.o]} value={v||"— select —"} onChange={e=>set(e.target.value==="— select —"?"":e.target.value)}/>;
  if (f.t==="m") return (<div><span className="text-xs text-slate-500 mb-1 block">{lbl}</span><div className="flex flex-wrap gap-2">{f.o.map(o=>{const on=(v||[]).includes(o);return <button key={o} type="button" onClick={()=>set(on?(v||[]).filter(x=>x!==o):[...(v||[]),o])} className={`px-2.5 py-1.5 rounded-full text-xs border transition ${on?"bg-sky-600 border-sky-600 text-white":"bg-white border-slate-300 text-slate-600 hover:border-sky-400"}`}>{o}</button>;})}</div></div>);
  if (f.t==="b") return (<label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer"><input type="checkbox" checked={!!v} onChange={e=>set(e.target.checked)} className="mt-0.5"/><span>{lbl}</span></label>);
  return <Field label={lbl} type={f.t==="n"?"number":f.t==="d"?"date":"text"} value={v||""} onChange={e=>set(e.target.value)} placeholder={f.ph}/>;
}
function obMissing(ob) {
  const miss=[];
  OB_STEPS.forEach((st,si)=>st.fields.forEach(f=>{ if(f.req && !(f.t==="b" ? ob[f.k] : (ob[f.k]||"").toString().trim())) miss.push({ step:si, label:f.l }); }));
  return miss;
}
function ClientOnboarding({ data, patch, onDone, onCancel }) {
  const [step, setStep] = useState(0);
  const [ob, setOb] = useState({});
  const [err, setErr] = useState("");
  const st = OB_STEPS[step];
  const setF = (k) => (val) => { setOb(o=>({ ...o, [k]:val })); setErr(""); };
  const finish = () => {
    const miss = obMissing(ob);
    if (miss.length) { setStep(miss[0].step); setErr("Required: " + miss.map(m=>m.label).join(" · ")); return; }
    const name = (ob.tradeName||"").trim() || ob.legalName.trim();
    const currency = ob.currency || "PKR";
    const existing = data.clients.find(c=>c.name.toLowerCase()===name.toLowerCase());
    const base = { name, legalName: ob.legalName, email: ob.contactEmail||"", whatsapp: (ob.contactPhone||"").trim(), currency, status:"Active", onboarding: ob, onboardedOn: today() };
    const rec = existing ? { ...existing, ...base, id: existing.id, notes: existing.notes } : { id:uid(), notes:"", ...base };
    const nextClients = existing ? data.clients.map(c=>c.id===existing.id?rec:c) : [...data.clients, rec];
    let nextRetainers = data.retainers;
    const amt = +ob.retainerAmount || 0;
    if (amt > 0) {
      const r = data.retainers.find(x=>x.client===name);
      nextRetainers = r
        ? data.retainers.map(x=>x.id===r.id?{...x,amount:amt,currency,whatsapp:rec.whatsapp||x.whatsapp,status:"Active"}:x)
        : [...data.retainers, { id:uid(), client:name, whatsapp:rec.whatsapp, amount:amt, currency, billingDay:1, status:"Active", carry:0 }];
    }
    patch({ clients: nextClients, retainers: nextRetainers }, `Onboarded client ${name}`);
    onDone(rec);
  };
  return (<>
    <button onClick={onCancel} className="flex items-center gap-1 text-sm text-slate-500 hover:text-sky-600 mb-4"><ChevronLeft size={16}/>Back to clients</button>
    <Head title="Onboard new client" sub="Svype Client Intake Ledger · fields marked * are required · everything is stored on the client record"/>
    <div className="flex gap-1.5 flex-wrap mb-5">{OB_STEPS.map((x,i)=>(<button key={x.id} onClick={()=>setStep(i)} className={`px-2.5 py-1.5 rounded-full text-xs border transition ${i===step?"bg-sky-600 border-sky-600 text-white":obStepDone(x,ob)?"bg-emerald-50 border-emerald-300 text-emerald-700":"bg-white border-slate-300 text-slate-500 hover:border-sky-400"}`}>{i+1}. {x.title}</button>))}</div>
    <Card><div className="p-6 space-y-4 max-w-2xl">
      {st.internal ? <div className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Internal — not client-facing. Completed by the Svype team.</div> : null}
      {st.fields.map(f=>(<ObField key={f.k} f={f} v={ob[f.k]} set={setF(f.k)}/>))}
      {err && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{err}</div>}
      <div className="flex gap-2 pt-2">
        {step>0 && <Btn variant="ghost" onClick={()=>setStep(step-1)}><ChevronLeft size={15}/>Previous</Btn>}
        {step<OB_STEPS.length-1 && <Btn onClick={()=>setStep(step+1)}>Next section</Btn>}
        {step===OB_STEPS.length-1 && <Btn variant="ok" onClick={finish}><Check size={15}/>Complete onboarding</Btn>}
      </div>
    </div></Card>
  </>);
}
function obStepDone(st, ob) { return st.fields.some(f=> f.t==="b" ? ob[f.k] : ((ob[f.k]||"").toString().trim() || (Array.isArray(ob[f.k]) && ob[f.k].length))); }

function Clients({ data, update, patch }) {
  const rows = data.clients;
  const [edit, setEdit] = useState(null); const [open, setOpen] = useState(null);
  const [show, setShow] = useState("active"); const [onboard, setOnboard] = useState(false);
  const blank = { name:"", email:"", whatsapp:"", currency:"PKR", notes:"", retainer:"", status:"Active" };
  const openEdit = (c) => { const r = data.retainers.find(x=>x.client===c.name && x.status==="Active"); setEdit({ ...c, status:c.status||"Active", retainer: r ? r.amount : "" }); };
  const save = (c)=>{
    if (!c.name) return;
    const isNew = !c.id;
    const status = c.status || "Active";
    const rec = isNew ? { id:uid(), name:c.name, email:c.email, whatsapp:c.whatsapp, currency:c.currency, notes:c.notes, status } : { id:c.id, name:c.name, email:c.email, whatsapp:c.whatsapp, currency:c.currency, notes:c.notes, status };
    const nextClients = isNew ? [...rows, rec] : rows.map(r=>r.id===rec.id?rec:r);
    // sync retainer
    let nextRetainers = data.retainers;
    const amt = +c.retainer || 0;
    const existing = data.retainers.find(r=>r.client===c.name);
    if (status==="Inactive") {
      // inactive client -> pause any retainer so it stops generating invoices
      if (existing) nextRetainers = data.retainers.map(r=>r.id===existing.id?{...r,status:"Paused"}:r);
    } else if (amt > 0) {
      if (existing) nextRetainers = data.retainers.map(r=>r.id===existing.id?{...r,amount:amt,currency:c.currency,whatsapp:c.whatsapp||r.whatsapp,status:"Active"}:r);
      else nextRetainers = [...data.retainers, { id:uid(), client:c.name, whatsapp:c.whatsapp||"", amount:amt, currency:c.currency||"PKR", billingDay:1, status:"Active", carry:0 }];
    } else if (existing) {
      nextRetainers = data.retainers.map(r=>r.id===existing.id?{...r,status:"Paused"}:r);
    }
    patch({ clients: nextClients, retainers: nextRetainers }, isNew ? `Added client ${c.name}` : `Updated client ${c.name}`);
    setEdit(null);
  };
  const setStatus = (c, status) => {
    const nextClients = rows.map(r=>r.id===c.id?{...r,status}:r);
    const existing = data.retainers.find(r=>r.client===c.name);
    let nextRetainers = data.retainers;
    if (status==="Inactive" && existing) nextRetainers = data.retainers.map(r=>r.id===existing.id?{...r,status:"Paused"}:r);
    patch({ clients: nextClients, retainers: nextRetainers }, `${status==="Inactive"?"Deactivated":"Reactivated"} client ${c.name}`);
  };
  if (onboard) return <ClientOnboarding data={data} patch={patch} onCancel={()=>setOnboard(false)} onDone={(rec)=>{ setOnboard(false); setOpen(rec.id); }}/>;
  if (open) { const c = rows.find(r=>r.id===open); if (c) return <ClientProfile c={c} data={data} patch={patch} onBack={()=>setOpen(null)} onEdit={()=>openEdit(c)}/>; }
  const isActive = (c)=> (c.status||"Active")==="Active";
  const filtered = rows.filter(c=> show==="all" ? true : show==="active" ? isActive(c) : !isActive(c));
  const bcl = useBatch(filtered);
  const activeCount = rows.filter(isActive).length;
  return (<>
    <Head title="Clients" sub={`${activeCount} active · ${rows.length} total · used across retainers, invoices, proposals, quotations`} action={<div className="flex gap-2"><Btn variant="ghost" onClick={()=>setEdit(blank)}><Plus size={15}/>Quick add</Btn><Btn onClick={()=>setOnboard(true)}><UserPlus size={15}/>Onboard client</Btn></div>}/>
    <div className="flex flex-wrap gap-2 mb-4"><Btn variant={show==="active"?"primary":"ghost"} onClick={()=>setShow("active")}>Active</Btn><Btn variant={show==="inactive"?"primary":"ghost"} onClick={()=>setShow("inactive")}>Inactive</Btn><Btn variant={show==="all"?"primary":"ghost"} onClick={()=>setShow("all")}>All</Btn></div>
    <BatchBar count={bcl.count} noun="client" onClear={bcl.clear} onDelete={()=>{ const ids=new Set(bcl.selected); update("clients", (data.clients||[]).filter(x=>!ids.has(x.id)), `Deleted ${ids.size} client(s)`); bcl.clear(); }}/>
    <Card><Table cols={[<SelBox key="a" on={bcl.allOn} onChange={bcl.toggleAll} title="Select all"/>,"Client","Status","Currency","Retainer","WhatsApp","Email",""]}>{filtered.length===0?<tr><td colSpan={8}><Empty msg={show==="inactive"?"No inactive clients":"No clients yet"}/></td></tr>:filtered.map(c=>{ const r=data.retainers.find(x=>x.client===c.name && x.status==="Active"); const act=isActive(c); return (
      <Row key={c.id} onClick={()=>setOpen(c.id)}><SelTd on={bcl.has(c.id)} onChange={()=>bcl.toggle(c.id)}/><Td className="font-medium">{c.name}{c.notes&&<div className="text-xs text-slate-400">{c.notes}</div>}</Td><Td><Pill s={act?"Active":"Inactive"}/></Td><Td>{c.currency}</Td><Td className="text-slate-500">{r?fmt(r.amount,r.currency):"—"}</Td><Td className="text-slate-500">{c.whatsapp||"—"}</Td><Td className="text-slate-500">{c.email||"—"}</Td>
      <Td><RowActions onEdit={()=>openEdit(c)} onDelete={()=>update("clients",rows.filter(x=>x.id!==c.id), `Removed client ${c.name}`)}>
        {act
          ? <button onClick={()=>setStatus(c,"Inactive")} title="Make inactive" className="px-2 py-1 rounded text-xs bg-slate-100 text-slate-600 hover:bg-slate-200">Deactivate</button>
          : <button onClick={()=>setStatus(c,"Active")} title="Reactivate" className="px-2 py-1 rounded text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-200">Reactivate</button>}
      </RowActions></Td></Row>); })}</Table></Card>
    {edit && <Modal title={edit.id?"Edit client":"Add client"} onClose={()=>setEdit(null)}>
      <Field label="Client name" value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})}/>
      <div className="grid grid-cols-2 gap-3"><Field label="Email" value={edit.email} onChange={e=>setEdit({...edit,email:e.target.value})}/><Field label="WhatsApp" value={edit.whatsapp} onChange={e=>setEdit({...edit,whatsapp:e.target.value})} placeholder="9230..."/></div>
      <div className="grid grid-cols-2 gap-3"><Select label="Default currency" options={CURRENCIES} value={edit.currency} onChange={e=>setEdit({...edit,currency:e.target.value})}/><Field label="Monthly retainer (optional)" type="number" value={edit.retainer} onChange={e=>setEdit({...edit,retainer:e.target.value})} placeholder="leave blank if none"/></div>
      <Select label="Status" options={["Active","Inactive"]} value={edit.status||"Active"} onChange={e=>setEdit({...edit,status:e.target.value})}/>
      <Select label="Pay type" options={["Salaried (monthly)","Freelance (paid per project)"]} value={edit.payType==="Freelance"?"Freelance (paid per project)":"Salaried (monthly)"} onChange={e=>setEdit({...edit,payType:e.target.value.startsWith("Freelance")?"Freelance":"Salaried"})}/>
      {edit.payType==="Freelance" && <p className="text-xs text-slate-500 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 -mt-1">Freelancers are left out of monthly payroll. They are paid per project under People → Freelance Projects, and the salary field above is ignored.</p>}
      <Select label="Employment" options={["Working normally","On notice period"]} value={edit.onNotice?"On notice period":"Working normally"} onChange={e=>setEdit({...edit,onNotice:e.target.value==="On notice period"})}/>
      {edit.onNotice && <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Notice given on" type="date" value={edit.noticeGivenOn||""} onChange={e=>setEdit({...edit,noticeGivenOn:e.target.value})}/>
          <Field label="Last working day" type="date" value={edit.lastWorkingDay||""} onChange={e=>setEdit({...edit,lastWorkingDay:e.target.value})}/>
        </div>
        <Field label="Note (reason, handover, replacement…)" value={edit.noticeNote||""} onChange={e=>setEdit({...edit,noticeNote:e.target.value})}/>
        <p className="text-xs text-amber-700">They stay fully active — attendance, payroll and to-dos keep working until you set the status to Inactive.</p>
      </div>}
      <p className="text-xs text-slate-400">Set a monthly retainer to add this client to the Retainers section automatically. Marking a client inactive pauses their retainer.</p>
      <Area label="Notes" value={edit.notes} onChange={e=>setEdit({...edit,notes:e.target.value})}/>
      <Btn onClick={()=>save(edit)}><Check size={15}/>Save</Btn>
    </Modal>}
  </>);
}
function ClientRetainerCard({ c, data, patch }) {
  const rets = (data.retainers||[]).filter(r=>r.client===c.name);
  const [edit, setEdit] = useState(null);
  const blank = () => ({ client:c.name, whatsapp:c.whatsapp||"", amount:"", currency:c.currency||"PKR", billing:"Prepaid", billingDay:1, status:"Active", carry:0 });
  const save = () => {
    const e = edit;
    if (!e.amount) { alert("Enter the monthly retainer amount."); return; }
    const list = data.retainers || [];
    const next = e.id ? list.map(r=>r.id===e.id?e:r) : [...list, { ...e, id:uid(), carry:+e.carry||0 }];
    patch({ retainers: next }, e.id ? `Updated retainer for ${c.name}` : `Added retainer for ${c.name}`);
    setEdit(null);
  };
  return (<Card><div className="p-5">
    <div className="flex items-center justify-between mb-3">
      <div className="font-semibold text-sm">Retainer</div>
      {rets.length===0 && <Btn variant="ghost" onClick={()=>setEdit(blank())}><Plus size={15}/>Add retainer</Btn>}
    </div>
    {rets.length===0 ? <div className="text-sm text-slate-400">No retainer for this client yet.</div> :
      <div className="space-y-2">{rets.map(r=>{
        const cyc = r.billing==="Postpaid" ? currentMonthInfo() : nextMonthInfo();
        return (<div key={r.id} className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5">
          <div><div className="text-sm font-medium">{fmt(r.amount, r.currency)}<span className="text-slate-400 font-normal">/month</span></div>
            <div className="text-xs text-slate-500 mt-0.5">{r.billing==="Postpaid"?"Postpaid":"Prepaid"} · next invoice covers {cyc.label} · {r.status}{+r.carry?` · ${fmt(r.carry,r.currency)} carried forward`:""}</div></div>
          <Btn variant="ghost" onClick={()=>setEdit(r)}><Edit3 size={15}/>Edit retainer</Btn>
        </div>);})}
      </div>}
    {edit && <Modal title={edit.id?`Edit retainer · ${c.name}`:`Add retainer · ${c.name}`} onClose={()=>setEdit(null)}>
      <div className="grid grid-cols-2 gap-3"><Field label="Monthly amount" type="number" value={edit.amount} onChange={e=>setEdit({...edit,amount:e.target.value})}/><Select label="Currency" options={CURRENCIES} value={edit.currency} onChange={e=>setEdit({...edit,currency:e.target.value})}/></div>
      <Select label="Billing type" options={["Prepaid — pays for the upcoming month","Postpaid — pays after the month ends"]} value={edit.billing==="Postpaid"?"Postpaid — pays after the month ends":"Prepaid — pays for the upcoming month"} onChange={e=>setEdit({...edit,billing:e.target.value.startsWith("Postpaid")?"Postpaid":"Prepaid"})}/>
      <Field label="WhatsApp (for sending invoices)" value={edit.whatsapp} onChange={e=>setEdit({...edit,whatsapp:e.target.value})}/>
      <div className="grid grid-cols-2 gap-3"><Field label="Carried forward" type="number" value={edit.carry} onChange={e=>setEdit({...edit,carry:e.target.value})}/><Select label="Status" options={["Active","Paused"]} value={edit.status} onChange={e=>setEdit({...edit,status:e.target.value})}/></div>
      <Btn onClick={save}><Check size={15}/>Save retainer</Btn>
      <p className="text-xs text-slate-400">Invoices are never created automatically — press “Generate now” in Retainers when you want them.</p>
    </Modal>}
  </div></Card>);
}
function ClientProfile({ c, data, patch, onBack, onEdit }) {
  const inv = data.invoices.filter(i=>i.client===c.name);
  const ret = data.retainers.filter(r=>r.client===c.name);
  const prop = data.proposals.filter(p=>p.client===c.name);
  const quo = data.quotations.filter(q=>q.client===c.name);
  const notes = (data.meetingNotes||[]).filter(n=>n.client===c.name).sort((a,b)=>b.date.localeCompare(a.date));
  const hrs = data.timesheets.filter(t=>t.client===c.name).reduce((s,t)=>s+ +t.hours,0);
  return (<>
    <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-sky-600 mb-4"><ChevronLeft size={16}/>Back to clients</button>
    <div className="flex flex-wrap items-start justify-between gap-3 mb-6"><div><h2 className="text-xl font-bold tracking-tight text-slate-900">{c.name}</h2><p className="text-sm text-slate-500">{c.currency} · {c.whatsapp||"no WhatsApp"} · {c.email||"no email"}</p></div><Btn variant="ghost" onClick={onEdit}><Edit3 size={15}/>Edit</Btn></div>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {[["Invoices",inv.length],["Retainers",ret.length],["Proposals",prop.length],["Hours logged",hrs]].map(([k,v])=>(<Card key={k}><div className="p-4"><div className="text-2xl font-bold text-slate-900">{v}</div><div className="text-xs text-slate-500 mt-0.5">{k}</div></div></Card>))}
    </div>
    <div className="mb-6"><ClientRetainerCard c={c} data={data} patch={patch}/></div>
    {c.onboarding && <Card><div className="p-5">
      <div className="flex items-center justify-between mb-3"><div className="font-semibold text-sm">Onboarding record</div><span className="text-xs text-slate-400">completed {c.onboardedOn}</span></div>
      <div className="grid md:grid-cols-2 gap-x-8 gap-y-4">{OB_STEPS.map(st=>{
        const filled = st.fields.filter(f=>{ const v=c.onboarding[f.k]; return f.t==="b" ? v : Array.isArray(v) ? v.length : (v||"").toString().trim(); });
        if (!filled.length) return null;
        return (<div key={st.id}><div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">{st.title}</div>
          {filled.map(f=>{ const v=c.onboarding[f.k]; return <div key={f.k} className="text-sm mb-1"><span className="text-slate-500">{f.l}: </span><span className="text-slate-800">{f.t==="b"?"Yes":Array.isArray(v)?v.join(", "):String(v)}</span></div>; })}
        </div>);
      })}</div>
    </div></Card>}
    <div className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium">Invoices</div>
    <Card><Table cols={["Number","Amount","Date","Status"]}>{inv.length===0?<tr><td colSpan={4}><Empty msg="No invoices"/></td></tr>:inv.map(i=>(<Row key={i.id}><Td className="font-medium">{i.number}</Td><Td>{fmt(i.amount,i.currency)}</Td><Td className="text-slate-500">{i.date}</Td><Td><Pill s={i.status}/></Td></Row>))}</Table></Card>
    {quo.length>0 && <><div className="text-xs uppercase tracking-wider text-slate-500 mb-2 mt-5 font-medium">Quotations</div><Card><Table cols={["Number","Amount","Date"]}>{quo.map(q=>(<Row key={q.id}><Td className="font-medium">{q.number}</Td><Td>{fmt(q.amount,q.currency)}</Td><Td className="text-slate-500">{q.date}</Td></Row>))}</Table></Card></>}
    <div className="text-xs uppercase tracking-wider text-slate-500 mb-2 mt-5 font-medium">Meeting notes</div>
    {notes.length===0?<Card><Empty msg="No meeting notes for this client"/></Card>:<div className="space-y-2">{notes.map(n=>(<Card key={n.id}><div className="p-4"><div className="flex items-center justify-between"><div className="font-medium text-sm">{n.title||"Meeting"}</div><span className="text-xs text-slate-400">{n.date} · {n.employee}</span></div><div className="text-sm text-slate-600 mt-1 whitespace-pre-wrap">{n.body}</div></div></Card>))}</div>}
  </>);
}

function UsersAccess({ data, update }) {
  const users = data.users || [];
  const setUsers = (u, msg) => update("users", u, msg);
  const [edit, setEdit] = useState(null);
  const [reset, setReset] = useState(null);
  const linkedName = (u) => u.role!=="employee" ? ROLES[u.role] : (data.employees.find(e=>e.id===u.empId)?.name || "— unlinked —");
  const blank = { username:"", password:"", role:"employee", empId:"", active:true, mustChange:true };
  const save = (u) => {
    const uname = u.username.trim().toLowerCase();
    if (!uname || !u.password) return;
    if (users.some(x=>x.username.toLowerCase()===uname && x.id!==u.id)) { alert("That username is already taken."); return; }
    if (u.id) setUsers(users.map(x=>x.id===u.id?{...u,username:uname}:x), `Updated login for ${uname}`);
    else setUsers([...users, { ...u, username:uname, id:uid() }], `Created login "${uname}" (${u.role})`);
    setEdit(null);
  };
  const doReset = () => { setUsers(users.map(x=>x.id===reset.id?{...x,password:reset.password,mustChange:true}:x), `Reset password for ${reset.username}`); setReset(null); };
  const toggle = (u) => setUsers(users.map(x=>x.id===u.id?{...x,active:!x.active}:x), `${u.active?"Deactivated":"Reactivated"} ${u.username}`);
  const unlinkedEmps = data.employees.filter(e=>e.status==="Active" && !users.some(u=>u.empId===e.id));
  return (<>
    <Head title="Users & Access" sub="Create a login for each person — they sign in with the username & password you set" action={<Btn onClick={()=>setEdit(blank)}><Plus size={15}/>Create user</Btn>}/>
    <Card><Table cols={["Username","Role","Linked to","Status",""]}>
      {users.length===0?<tr><td colSpan={5}><Empty msg="No users yet"/></td></tr>:users.map(u=>(
        <Row key={u.id}>
          <Td className="font-medium">{u.username}</Td>
          <Td className="text-slate-500">{ROLES[u.role]}</Td>
          <Td className="text-slate-500">{linkedName(u)}</Td>
          <Td><Pill s={u.active?"Active":"Inactive"}/></Td>
          <Td><RowActions onEdit={()=>setEdit(u)} onDelete={u.username==="admin"?undefined:()=>setUsers(users.filter(x=>x.id!==u.id), `Deleted login ${u.username}`)}>
            <button onClick={()=>setReset({ id:u.id, username:u.username, password:"" })} title="Reset password" className="px-2 py-1 rounded text-xs bg-slate-100 text-slate-600 hover:bg-slate-200">Reset</button>
            <button onClick={()=>toggle(u)} title={u.active?"Deactivate":"Reactivate"} className={`px-2 py-1 rounded text-xs ${u.active?"bg-amber-100 text-amber-700 hover:bg-amber-200":"bg-emerald-100 text-emerald-700 hover:bg-emerald-200"}`}>{u.active?"Disable":"Enable"}</button>
          </RowActions></Td>
        </Row>))}
    </Table></Card>

    {edit && <Modal title={edit.id?"Edit user":"Create user"} onClose={()=>setEdit(null)}>
      <Field label="Username" value={edit.username} onChange={e=>setEdit({...edit,username:e.target.value})} placeholder="e.g. qasim"/>
      <Field label="Password" value={edit.password} onChange={e=>setEdit({...edit,password:e.target.value})} placeholder="set a starting password"/>
      <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer"><input type="checkbox" checked={edit.mustChange!==false} onChange={e=>setEdit({...edit,mustChange:e.target.checked})} className="mt-0.5"/>
        <span>Ask them to set their own password at first sign-in<div className="text-xs text-slate-400">Recommended — what you type above becomes a one-time code, and only they know their real password afterwards.</div></span></label>
      <Select label="Role" options={["employee","hr","admin"]} value={edit.role} onChange={e=>setEdit({...edit,role:e.target.value, empId: e.target.value==="employee"?edit.empId:""})}/>
      {edit.role==="employee" && <label className="block"><span className="text-xs text-slate-500 mb-1 block">Which staff member is this login for?</span>
        <select value={edit.empId} onChange={e=>setEdit({...edit,empId:e.target.value})} className={inputCls}>
          <option value="">— select employee —</option>
          {edit.id && data.employees.find(e=>e.id===edit.empId) && !unlinkedEmps.find(e=>e.id===edit.empId) && <option value={edit.empId}>{data.employees.find(e=>e.id===edit.empId).name}</option>}
          {unlinkedEmps.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <span className="text-xs text-slate-400 mt-1 block">Each employee login shows only that person's profile, payslips, attendance and claims.</span>
      </label>}
      <Btn onClick={()=>save(edit)}><Check size={15}/>{edit.id?"Save":"Create user"}</Btn>
    </Modal>}

    {reset && <Modal title={`Reset password · ${reset.username}`} onClose={()=>setReset(null)}>
      <p className="text-xs text-slate-500">This becomes a one-time code — they will be asked to set their own password the next time they sign in.</p>
      <Field label="New password" value={reset.password} onChange={e=>setReset({...reset,password:e.target.value})} placeholder="enter new password"/>
      <Btn onClick={()=>reset.password&&doReset()}><Check size={15}/>Set new password</Btn>
    </Modal>}
  </>);
}

function EmailSettings({ data, patch, brand }) {
  const cur = data.emailConfig || { host:"smtp.gmail.com", port:465, user:"", pass:"", from:"" };
  const [f, setF] = useState(cur);
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const save = () => {
    // App passwords are displayed in four groups, so they arrive with spaces in them.
    patch({ emailConfig: { ...f, pass:(f.pass||"").replace(/\s+/g,""), port:+f.port || 465 } }, "Updated email sending settings");
    setSaved(true); setResult(null); setTimeout(()=>setSaved(false), 3000);
  };
  const sendTest = async () => {
    setTesting(true); setResult(null);
    try {
      const r = await apiReq("POST", "/payslip/test", { to: testTo || f.user, brand: pdfBrand(brand) });
      setResult({ ok:true, text:`Sent to ${r.to} from “${r.from}”. Check the inbox — the sample PDF should be attached.` });
    } catch (e) { setResult({ ok:false, text: e.message || "The test email couldn't be sent." }); }
    setTesting(false);
  };
  return (<>
    <Head title="Email (sending)" sub="The mailbox the portal sends salary slips from — with the PDF attached"/>
    <div className="grid lg:grid-cols-2 gap-5">
      <Card><div className="p-5 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="SMTP host" value={f.host} onChange={e=>setF({...f,host:e.target.value})} placeholder="smtp.gmail.com"/>
          <Field label="Port" type="number" value={f.port} onChange={e=>setF({...f,port:e.target.value})} placeholder="465"/>
        </div>
        <Field label="Mailbox address" value={f.user} onChange={e=>setF({...f,user:e.target.value})} placeholder="accounts@svype.com"/>
        <Field label="App password" type="password" value={f.pass} onChange={e=>setF({...f,pass:e.target.value})} placeholder="16-character app password"/>
        <Field label="Sender name (optional)" value={f.from} onChange={e=>setF({...f,from:e.target.value})} placeholder="Svype Tech Limited"/>
        <p className="text-xs text-slate-400 -mt-1">Just the name is fine — emails always go out from the mailbox above.</p>
        <Btn onClick={save}><Check size={15}/>Save email settings</Btn>
        {saved && <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">Saved. Send yourself a test below before using it on the team.</div>}
        <div className="border-t border-slate-200 pt-3 mt-1 space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-medium">Test it</div>
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-48"><Field label="Send a test to" value={testTo} onChange={e=>setTestTo(e.target.value)} placeholder={f.user || "your@email.com"}/></div>
            <Btn onClick={sendTest} disabled={testing}>{testing?<Loader2 size={15} className="animate-spin"/>:<Send size={15}/>}{testing?"Sending…":"Send test email"}</Btn>
          </div>
          {result && <div className={`text-xs rounded-lg px-3 py-2 ${result.ok?"bg-emerald-50 border border-emerald-200 text-emerald-700":"bg-rose-50 border border-rose-200 text-rose-700"}`}>{result.text}</div>}
          <p className="text-xs text-slate-400">The test signs in for real and attaches a sample payslip PDF — if it arrives, salary slips will send correctly.</p>
        </div>
      </div></Card>
      <Card><div className="p-5 text-sm text-slate-600 space-y-2">
        <div className="font-semibold text-slate-900">Setting this up with Gmail</div>
        <p>Gmail will not accept your normal password here. You need an <b>App Password</b>:</p>
        <ol className="list-decimal ml-5 space-y-1 text-slate-600">
          <li>Turn on 2-step verification on the Google account.</li>
          <li>Go to Google Account → Security → App passwords.</li>
          <li>Create one named “Svype OS” and copy the 16-character code.</li>
          <li>Paste it above with the mailbox address, host <b>smtp.gmail.com</b>, port <b>465</b>.</li>
        </ol>
        <p className="text-xs text-slate-400 pt-2">This password is stored in your portal database so the server can send on your behalf. Use a dedicated mailbox (for example accounts@) rather than a personal one, and revoke the app password from Google if you ever stop using it.</p>
      </div></Card>
    </div>
  </>);
}
function Permissions({ data, update }) {
  const users = (data.users||[]).filter(u=>u.role!=="admin"); // founder always full access
  const [sel, setSel] = useState(users[0]?.id || "");
  const user = users.find(u=>u.id===sel);
  const empName = (u) => u.role==="employee" ? (data.employees.find(e=>e.id===u.empId)?.name || u.username) : u.username;
  // sections a user could be granted/denied, by their role
  const adminSections = NAV.filter(n=>n.id!=="dash" && n.id!=="permissions" && !n.adminOnly);
  const empSections = EMP_NAV.filter(n=>n.id!=="dash");
  const sections = user?.role==="employee" ? empSections : adminSections;
  const isOn = (id) => !user?.perms || user.perms[id] !== false;
  const toggle = (id) => {
    const perms = { ...(user.perms||{}) };
    if (perms[id] === false) delete perms[id]; else perms[id] = false;
    update("users", (data.users||[]).map(u=>u.id===user.id?{...u,perms}:u), `Updated permissions for ${user.username}`);
  };
  const allOn = () => update("users", (data.users||[]).map(u=>u.id===user.id?{...u,perms:{}}:u), `Granted full access to ${user.username}`);
  return (<>
    <Head title="Permissions" sub="Founder-only · grant or revoke what each user can access"/>
    {users.length===0 ? <Card><Empty msg="No HR or employee users yet — create them in Users & Access"/></Card> : (
    <div className="grid lg:grid-cols-3 gap-5">
      <Card><div className="p-3">
        <div className="text-xs uppercase tracking-wider text-slate-500 mb-2 px-2 font-medium">Users</div>
        {users.map(u=>(<button key={u.id} onClick={()=>setSel(u.id)} className={`w-full text-left px-3 py-2.5 rounded-lg text-sm ${sel===u.id?"bg-sky-50 text-sky-700 font-medium":"hover:bg-slate-50"}`}><div>{empName(u)}</div><div className="text-xs text-slate-400">{u.username} · {ROLES[u.role]}</div></button>))}
      </div></Card>
      <div className="lg:col-span-2">{user ? (
        <Card><div className="p-5">
          <div className="flex items-center justify-between mb-4"><div><div className="font-semibold">{empName(user)}</div><div className="text-xs text-slate-500">{ROLES[user.role]} · sign-in: {user.username}</div></div><Btn variant="ghost" onClick={allOn}><Check size={14}/>Grant all</Btn></div>
          <div className="text-xs text-slate-500 mb-3">Toggle the sections this user can open. The Dashboard is always available.</div>
          <div className="grid sm:grid-cols-2 gap-2">{sections.map(s=>{ const on=isOn(s.id); const I=s.icon; return (
            <button key={s.id} onClick={()=>toggle(s.id)} className={`flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg border text-sm ${on?"border-sky-200 bg-sky-50 text-slate-700":"border-slate-200 bg-white text-slate-400"}`}>
              <span className="flex items-center gap-2"><I size={15}/>{s.label}</span>
              <span className={`text-xs font-medium ${on?"text-emerald-600":"text-slate-400"}`}>{on?"On":"Off"}</span>
            </button>); })}</div>
          <p className="text-xs text-slate-400 mt-4">Changes apply the next time this user signs in.</p>
        </div></Card>
      ) : <Card><Empty msg="Select a user"/></Card>}</div>
    </div>)}
  </>);
}

function Employees({ data, update, mutateData }) {
  const rows = data.employees, setRows = (r)=>update("employees",r);
  const [edit, setEdit] = useState(null); const [open, setOpen] = useState(null); const [q, setQ] = useState("");
  const [lookup, setLookup] = useState("");
  const blank = { name:"",role:"",dept:"",email:"",phone:"",cnic:"",salary:"",pf:0,joined:today(),status:"Active",remoteAllowed:false,bankName:"",account:"",docs:[] };
  const save = (e)=>{
    const isNew = !e.id;
    const rec = isNew ? { ...e, id: uid() } : e;
    // Functional per-record write: only THIS employee is replaced/added against the freshest
    // data on every retry, so a long-open stale tab can never wipe other people's changes.
    mutateData((cur)=>{
      const list = cur.employees || [];
      const employees = isNew ? [...list, rec] : list.some(r=>r.id===rec.id) ? list.map(r=>r.id===rec.id?rec:r) : [...list, rec];
      return { ...cur, employees };
    }, isNew ? `Added employee ${rec.name}` : `Updated employee ${rec.name}`);
    setEdit(null);
  };
  const filtered = rows.filter(r=>r.name.toLowerCase().includes(q.toLowerCase()));
  const be = useBatch(filtered);
  const noEmail = (data.employees||[]).filter(e=>e.status==="Active" && !e.email).length;
  const found = lookup ? rows.find(r=>r.name.toLowerCase().includes(lookup.toLowerCase())) : null;
  if (open) { const emp = rows.find(r=>r.id===open); if (emp) return <EmployeeProfile emp={emp} data={data} onBack={()=>setOpen(null)} onEdit={()=>{ setEdit(emp); setOpen(null); }} />; }
  return (<>
    <Head title="Employees" sub={`${rows.length} on record · tap a name to open their file`} action={<Btn onClick={()=>setEdit(blank)}><Plus size={15}/>Add employee</Btn>}/>
    <Card><div className="p-4">
      <div className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium flex items-center gap-1.5"><Landmark size={13}/>Quick account lookup</div>
      <div className="relative max-w-sm"><Search size={15} className="absolute left-3 top-2.5 text-slate-400"/><input list="emp-names" value={lookup} onChange={e=>setLookup(e.target.value)} placeholder="Type an employee name…" className={inputCls+" pl-9"}/><datalist id="emp-names">{rows.map(e=><option key={e.id} value={e.name}/>)}</datalist></div>
      {lookup && (found ? <div className="mt-3 bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm flex flex-wrap gap-x-6 gap-y-1"><span><span className="text-slate-500">Name:</span> <b>{found.name}</b></span><span><span className="text-slate-500">Bank:</span> {found.bankName||"—"}</span><span><span className="text-slate-500">Account / IBAN:</span> <b>{found.account||"— not on file —"}</b></span></div> : <div className="mt-3 text-sm text-slate-400">No employee matches that name.</div>)}
    </div></Card>
    <div className="relative my-4 max-w-xs"><Search size={15} className="absolute left-3 top-2.5 text-slate-400"/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search name" className={inputCls+" pl-9"}/></div>
    {noEmail>0 && <div className="mb-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{noEmail} active employee(s) have no email address — their salary slips can't be emailed until you add one.</div>}
    <BatchBar count={be.count} noun="employee" onClear={be.clear} onDelete={()=>{ const ids=new Set(be.selected); mutateData((cur)=>({ ...cur, employees:(cur.employees||[]).filter(x=>!ids.has(x.id)) }), `Removed ${ids.size} employee(s)`); be.clear(); }}/>
    <Card><Table cols={[<SelBox key="a" on={be.allOn} onChange={be.toggleAll} title="Select all"/>,"Name","Role","Email","Account / IBAN","Salary","Status",""]}>{filtered.length===0?<tr><td colSpan={8}><Empty msg="No employees"/></td></tr>:filtered.map(e=>(
      <Row key={e.id} onClick={()=>setOpen(e.id)}><SelTd on={be.has(e.id)} onChange={()=>be.toggle(e.id)}/><Td><div className="font-medium">{e.name}</div>{e.payType==="Freelance"&&<span className="text-xs px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 mr-1">Freelance</span>}{e.onNotice&&<span className="text-xs text-amber-600 mt-0.5">On notice{e.lastWorkingDay?` · last day ${e.lastWorkingDay}`:""}</span>}</Td><Td className="text-slate-500">{e.role}</Td><Td className="text-xs">{e.email?<span className="text-slate-600">{e.email}</span>:<button onClick={(ev)=>{ev.stopPropagation();setEdit(e);}} className="text-amber-600 hover:underline">add email</button>}</Td><Td className="text-slate-500">{e.account||"—"}</Td><Td className="text-slate-500">{fmt(e.salary)}</Td><Td><Pill s={e.status}/></Td><Td><RowActions onEdit={()=>setEdit(e)} onDelete={()=>mutateData((cur)=>({ ...cur, employees:(cur.employees||[]).filter(r=>r.id!==e.id) }), `Removed employee ${e.name}`)}/></Td></Row>))}</Table></Card>
    {edit && <EmployeeForm edit={edit} setEdit={setEdit} save={save}/>}
  </>);
}
function EmployeeForm({ edit, setEdit, save }) {
  const [upErr, setUpErr] = useState("");
  const [uploading, setUploading] = useState(false);
  const addDocs = async (files) => {
    setUpErr(""); setUploading(true);
    const arr = [...(edit.docs||[])];
    try {
      for (const f of files) {
        if (f.size > 20 * 1024 * 1024) { setUpErr(`${f.name} is over 20 MB — please compress it first.`); continue; }
        const isImg = f.type.startsWith("image/");
        const dataUrl = isImg ? await readImage(f, 1600, true, 0.82) : await readFile(f);
        const stored = await uploadFile(dataUrl, f.name);          // straight to file storage
        if (!stored) { setUpErr(`Couldn't read ${f.name}.`); continue; }
        arr.push({ id:uid(), name:f.name, type:isImg?"image":"file", fileId:stored.fileId, mime:stored.mime, size:stored.size, expiry:"", date:today() });
      }
      setEdit({ ...edit, docs: arr });
    } catch (e) {
      setUpErr(e.message || "Upload failed — check your connection and try again.");
    }
    setUploading(false);
  };
  const setDocExpiry = (id, v) => setEdit({ ...edit, docs: edit.docs.map(d=>d.id===id?{...d,expiry:v}:d) });
  return <Modal title={edit.id?"Edit employee":"Add employee"} onClose={()=>setEdit(null)}>
    <Field label="Full name" value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})}/>
    <div className="grid grid-cols-2 gap-3"><Field label="Role" value={edit.role} onChange={e=>setEdit({...edit,role:e.target.value})}/><Field label="Department" value={edit.dept} onChange={e=>setEdit({...edit,dept:e.target.value})}/></div>
    <div className="grid grid-cols-2 gap-3"><Field label="Email" value={edit.email} onChange={e=>setEdit({...edit,email:e.target.value})}/><Field label="Phone" value={edit.phone} onChange={e=>setEdit({...edit,phone:e.target.value})}/></div>
    <div className="grid grid-cols-2 gap-3"><Field label="CNIC number" value={edit.cnic} onChange={e=>setEdit({...edit,cnic:e.target.value})} placeholder="00000-0000000-0"/><Field label="Monthly salary (PKR)" type="number" value={edit.salary} onChange={e=>setEdit({...edit,salary:e.target.value})}/></div>
    <div className="grid grid-cols-2 gap-3"><Field label="Provident fund (% of basic)" type="number" value={edit.pf} onChange={e=>setEdit({...edit,pf:e.target.value})}/><Field label="Joined" type="date" value={edit.joined} onChange={e=>setEdit({...edit,joined:e.target.value})}/></div>
    <Select label="Check-in policy" options={["Office only (geofenced)","Anywhere (work from home)"]} value={edit.remoteAllowed?"Anywhere (work from home)":"Office only (geofenced)"} onChange={e=>setEdit({...edit,remoteAllowed:e.target.value.startsWith("Anywhere")})}/>
    <Select label="Status" options={["Active","Inactive"]} value={edit.status} onChange={e=>setEdit({...edit,status:e.target.value})}/>
    <div className="grid grid-cols-2 gap-3"><Field label="Bank name" value={edit.bankName||""} onChange={e=>setEdit({...edit,bankName:e.target.value})} placeholder="e.g. Meezan Bank"/><Field label="Account number / IBAN" value={edit.account||""} onChange={e=>setEdit({...edit,account:e.target.value})}/></div>
    <div><span className="text-xs text-slate-500 mb-1 block">Documents (set an expiry to get reminders)</span>
      <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500">{uploading?<Loader2 size={15} className="animate-spin"/>:<Paperclip size={15}/>}{uploading?"Uploading…":"Upload files"}<input type="file" multiple accept="image/*,.pdf" className="hidden" disabled={uploading} onChange={e=>addDocs([...e.target.files])}/></label>
      {upErr && <div className="mt-2 text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{upErr}</div>}
      {(edit.docs||[]).length>0 && <div className="mt-2 space-y-2">{edit.docs.map(d=>(<div key={d.id} className="bg-slate-50 border border-slate-200 rounded px-2 py-2"><div className="flex items-center justify-between text-xs"><button onClick={()=>openStored(d, d.name)} className="truncate text-sky-600 hover:underline flex items-center gap-1"><span>↗</span>{d.name}</button><button onClick={()=>setEdit({...edit,docs:edit.docs.filter(x=>x.id!==d.id)})} className="text-slate-400 hover:text-rose-500"><X size={13}/></button></div><div className="flex items-center gap-2 mt-1"><span className="text-xs text-slate-400">Expiry</span><input type="date" value={d.expiry||""} onChange={e=>setDocExpiry(d.id,e.target.value)} className="bg-white border border-slate-300 rounded px-2 py-1 text-xs outline-none focus:border-sky-500"/></div></div>))}</div>}
    </div>
    <Btn onClick={()=>save(edit)}><Check size={15}/>Save</Btn>
  </Modal>;
}
function EmployeeProfile({ emp, data, onBack, onEdit }) {
  const [t, setT] = useState("overview");
  const slips = data.payroll.filter(p=>p.employee===emp.name);
  const empLetters = [...data.letters, ...data.offers].filter(l=>l.name===emp.name);
  const advs = data.advances.filter(a=>a.employee===emp.name);
  const tabs = [["overview","Overview"],["docs","Documents"],["payroll","Payroll"],["advances","Advances"],["letters","Letters"]];
  return (<>
    <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-sky-600 mb-4"><ChevronLeft size={16}/>Back to employees</button>
    <div className="flex flex-wrap items-start justify-between gap-3 mb-6"><div className="flex items-center gap-4"><div className="w-14 h-14 rounded-2xl bg-sky-100 text-sky-700 grid place-items-center font-bold text-xl shrink-0">{emp.name[0]}</div><div><h2 className="text-xl font-bold tracking-tight text-slate-900">{emp.name}</h2><p className="text-sm text-slate-500">{emp.role} · {emp.dept}</p></div></div><Btn variant="ghost" onClick={onEdit}><Edit3 size={15}/>Edit</Btn></div>
    <div className="flex gap-1 mb-5 border-b border-slate-200 overflow-x-auto">{tabs.map(([k,l])=>(<button key={k} onClick={()=>setT(k)} className={`px-4 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${t===k?"border-sky-600 text-sky-700 font-medium":"border-transparent text-slate-500 hover:text-slate-800"}`}>{l}</button>))}</div>
    {t==="overview" && <div className="grid sm:grid-cols-2 gap-4">{[["Email",emp.email],["Phone",emp.phone],["CNIC",emp.cnic],["Salary",fmt(emp.salary)],["Provident fund",(emp.pf||0)+"%"],["Joined",emp.joined],["Bank",emp.bankName],["Account / IBAN",emp.account]].map(([k,v])=>(<Card key={k}><div className="p-4"><div className="text-xs text-slate-500">{k}</div><div className="font-medium mt-0.5">{v||"—"}</div></div></Card>))}</div>}
    {t==="docs" && <Card><div className="p-4">{(!emp.docs||emp.docs.length===0)?<Empty msg="No documents on file."/>:<div className="grid sm:grid-cols-3 gap-3">{emp.docs.map(d=>{const dd=d.expiry?daysUntil(d.expiry):null;return(<button key={d.id} onClick={()=>openStored(d, d.name)} className="text-left bg-slate-50 border border-slate-200 rounded-lg overflow-hidden hover:border-sky-400 hover:shadow-sm transition">{(d.img||(d.fileId&&String(d.mime||"").startsWith("image/")))?<StoredImg d={d} className="w-full h-32 object-cover"/>:<div className="h-32 grid place-items-center text-slate-400"><FileText/></div>}<div className="p-2 text-xs"><div className="truncate flex items-center gap-1"><span className="text-sky-600">↗</span>{d.name}</div>{d.expiry&&<div className={dd<=30?"text-rose-600":"text-slate-400"}>exp {d.expiry}{dd<=30?` · ${dd<0?"expired":dd+"d"}`:""}</div>}</div></button>);})}</div>}</div></Card>}
    {t==="payroll" && <Card><Table cols={["Month","Basic","Net","Status"]}>{slips.length===0?<tr><td colSpan={4}><Empty msg="No payroll history"/></td></tr>:slips.map(p=>(<Row key={p.id}><Td>{p.month}</Td><Td>{fmt(p.basic)}</Td><Td className="font-semibold">{fmt(netPay(p))}</Td><Td><Pill s={p.paid?"Paid":"Pending"}/></Td></Row>))}</Table></Card>}
    {t==="advances" && <Card><Table cols={["Date","Total","Installment","Remaining","Status"]}>{advs.length===0?<tr><td colSpan={5}><Empty msg="No advances"/></td></tr>:advs.map(a=>(<Row key={a.id}><Td className="text-slate-500">{a.date}</Td><Td>{fmt(a.total)}</Td><Td>{fmt(a.installment)}</Td><Td>{fmt(a.remaining)}</Td><Td><Pill s={a.status}/></Td></Row>))}</Table></Card>}
    {t==="letters" && <Card><Table cols={["Type","Date"]}>{empLetters.length===0?<tr><td colSpan={2}><Empty msg="No letters issued"/></td></tr>:empLetters.map(l=>(<Row key={l.id}><Td>{l.docType||l.type}</Td><Td className="text-slate-500">{l.date}</Td></Row>))}</Table></Card>}
  </>);
}

// Literal class strings — Tailwind only ships classes it can see written out in full.
const MARK_STYLES = [
  { st:"Present", on:"bg-emerald-600 border-emerald-600 text-white", off:"bg-emerald-100 border-emerald-100 text-emerald-700 hover:bg-emerald-200" },
  { st:"Absent",  on:"bg-rose-600 border-rose-600 text-white",       off:"bg-rose-100 border-rose-100 text-rose-700 hover:bg-rose-200" },
  { st:"Leave",   on:"bg-amber-500 border-amber-500 text-white",     off:"bg-amber-100 border-amber-100 text-amber-700 hover:bg-amber-200" },
];
function Attendance({ data, update, mutateData }) {
  const [view, setView] = useState("attendance");
  // HR always overrides: whatever the employee did, HR's mark wins and is stamped as theirs.
  const mark = (emp,status)=>{ mutateData((cur)=>{ const list=cur.attendance||[]; const ex=list.find(a=>a.employee===emp&&a.date===today()); return { ...cur, attendance: ex?list.map(a=>a===ex?{...a,status,markedBy:"HR",markedOn:new Date().toISOString()}:a):[...list,{id:uid(),employee:emp,date:today(),status,markedBy:"HR",markedOn:new Date().toISOString()}] }; }, `Marked ${emp} ${status}`); };
  const bh = useBatch(data.attendance||[]);
  const [busyTime,setBusyTime]=useState(null);
  const decideTime = async (id,sv,field="timeReq")=>{
    const rec=(data.attendance||[]).find(x=>x.id===id); setBusyTime(id);
    try { await mutateData((cur)=>({ ...cur, attendance:(cur.attendance||[]).flatMap(x=>{
        if (x.id!==id) return [x];
        if (sv==="Rejected" && x.viaRequest && !x.checkIn && !x.checkOut) return [];
        const upd={ ...x, [field]:{ ...x[field], status:sv, decidedOn:today() } };
        if (sv==="Approved" && x.viaRequest) return [{ ...upd, status:"Present", office:x.office||"Added by HR approval" }];
        return [upd];
      }) }), `Check-in correction ${sv.toLowerCase()} for ${rec?.employee} (${rec?.date}) — they have been notified`); }
    finally { setBusyTime(null); }
  };
  const TimeReqActions = ({ a, field="timeReq", label="check-in" }) => {
    if (!a || !a[field]) return null;
    const rq = a[field];
    if (busyTime===a.id) return <div className="text-xs text-slate-500 flex items-center gap-1"><Loader2 size={11} className="animate-spin"/>Processing…</div>;
    if (rq.status==="Pending") return (<div className="text-xs text-amber-600">
      {label} → {timeOf(rq.requested)}{rq.reason?` · ${rq.reason}`:""}
      <div className="flex gap-1 mt-1"><button onClick={()=>decideTime(a.id,"Approved",field)} className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200">Approve</button><button onClick={()=>decideTime(a.id,"Rejected",field)} className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 hover:bg-rose-200">Decline</button></div>
    </div>);
    if (rq.status==="Approved") return <div className="text-xs text-emerald-600">{label} corrected</div>;
    return <div className="text-xs text-slate-400">correction declined</div>;
  };
  const [busyLeave,setBusyLeave]=useState(null);
  const setStatus=async (id,s)=>{ const l=data.leaves.find(x=>x.id===id); setBusyLeave(id); try { await mutateData((cur)=>({ ...cur, leaves:(cur.leaves||[]).map(x=>x.id===id?{...x,status:s,decidedOn:today()}:x) }), `Leave ${s.toLowerCase()} for ${l?.employee} — they have been notified`); } finally { setBusyLeave(null); } };
  const locLink = (loc) => loc && loc.lat ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : null;
  const history = [...data.attendance].sort((a,b)=> (b.date||"").localeCompare(a.date||"") || (b.checkIn||"").localeCompare(a.checkIn||""));
  return (<>
    <Head title="Attendance & Leave" sub="Team marking, check-in/out log, and leave approvals"/>
    <div className="flex flex-wrap gap-2 mb-4"><Btn variant={view==="attendance"?"primary":"ghost"} onClick={()=>setView("attendance")}>Today's attendance</Btn><Btn variant={view==="history"?"primary":"ghost"} onClick={()=>setView("history")}>Check-in/out log</Btn><Btn variant={view==="leave"?"primary":"ghost"} onClick={()=>setView("leave")}>Leave requests</Btn></div>
    {view==="attendance"?(
      <Card><Table cols={["Employee","Today","In / Out","Office","Location",""]}>{data.employees.filter(e=>e.status==="Active").map(e=>{const a=data.attendance.find(x=>x.employee===e.name&&x.date===today());const ll=locLink(a?.location);const lo=locLink(a?.checkOutLocation);return(
        <Row key={e.id}><Td className="font-medium">{e.name}</Td><Td>{a?<span className="text-xs text-slate-600">{a.status}<div className="text-xs text-slate-400">{a.markedBy?"set by HR":a.checkIn?"checked in":""}</div></span>:<span className="text-slate-400 text-xs">Not marked</span>}</Td><Td className="text-xs text-slate-500">{effIn(a)?timeOf(effIn(a)):"—"} / {effOut(a)?timeOf(effOut(a)):"—"}<TimeReqActions a={a}/><TimeReqActions a={a} field="outReq" label="check-out"/>{a?.wfh&&<div className="text-xs text-indigo-600">work from home{a.status==="Requested"?" · awaiting approval":""}</div>}</Td><Td className="text-xs text-slate-600">{a?.office||a?.checkOutOffice||"—"}</Td><Td className="text-xs"><div className="flex flex-col gap-0.5">{ll?<a href={ll} target="_blank" rel="noopener" className="text-sky-600 hover:underline flex items-center gap-1"><MapPin size={11}/>in</a>:null}{lo?<a href={lo} target="_blank" rel="noopener" className="text-emerald-600 hover:underline flex items-center gap-1"><MapPin size={11}/>out</a>:null}{!ll&&!lo&&<span className="text-slate-400">—</span>}</div></Td>
        <Td><div className="flex gap-1 justify-end">{MARK_STYLES.map(({ st, on:onCls, off:offCls })=>{
          const on = a?.status===st;
          return <button key={st} onClick={()=>mark(e.name,st)} title={on?`Already marked ${st.toLowerCase()} — click to re-confirm`:`Set ${st.toLowerCase()} — this overrides whatever the employee did`}
            className={`px-2 py-1 rounded text-xs border ${on?onCls:offCls}`}>{st}</button>; })}</div></Td></Row>);})}</Table></Card>
    ):view==="history"?(
      <><BatchBar count={bh.count} noun="record" onClear={bh.clear} onDelete={()=>{ const ids=new Set(bh.selected); update("attendance", (data.attendance||[]).filter(x=>!ids.has(x.id)), `Deleted ${ids.size} attendance record(s)`); bh.clear(); }}/>
      <Card><Table cols={[<SelBox key="a" on={bh.allOn} onChange={bh.toggleAll} title="Select all"/>,"Date","Employee","Office","Check-in","Check-out","In loc","Out loc"]}>{history.length===0?<tr><td colSpan={8}><Empty msg="No attendance recorded yet"/></td></tr>:history.map(a=>{const ll=locLink(a.location);const lo=locLink(a.checkOutLocation);return(
        <Row key={a.id}><SelTd on={bh.has(a.id)} onChange={()=>bh.toggle(a.id)}/><Td className="text-slate-500 whitespace-nowrap">{a.date}</Td><Td className="font-medium">{a.employee}</Td><Td className="text-xs text-slate-600">{a.office||a.checkOutOffice||"—"}</Td><Td className="text-slate-500">{effIn(a)?timeOf(effIn(a)):"—"}<TimeReqActions a={a}/><TimeReqActions a={a} field="outReq" label="check-out"/>{a?.wfh&&<div className="text-xs text-indigo-600">work from home{a.status==="Requested"?" · awaiting approval":""}</div>}</Td><Td className="text-slate-500">{effOut(a)?timeOf(effOut(a)):"—"}{a.outReq?.status==="Pending"&&<div className="text-xs text-amber-600">check-out correction pending</div>}{a.outReq?.status==="Approved"&&<div className="text-xs text-emerald-600">corrected · was {a.checkOut?timeOf(a.checkOut):"—"}</div>}</Td><Td className="text-xs">{ll?<a href={ll} target="_blank" rel="noopener" className="text-sky-600 hover:underline flex items-center gap-1"><MapPin size={11}/>view</a>:<span className="text-slate-400">—</span>}</Td><Td className="text-xs">{lo?<a href={lo} target="_blank" rel="noopener" className="text-emerald-600 hover:underline flex items-center gap-1"><MapPin size={11}/>view</a>:<span className="text-slate-400">—</span>}</Td></Row>);})}</Table></Card></>
    ):(
      <Card><Table cols={["Employee","Type & reason","From","To","Days","Balance left","Status",""]}>{data.leaves.length===0?<tr><td colSpan={8}><Empty msg="No leave requests"/></td></tr>:data.leaves.map(l=>(
        <Row key={l.id}><Td className="font-medium">{l.employee}</Td><Td className="text-slate-500">{l.type}{l.reason&&<div className="text-xs text-slate-400 max-w-[200px] truncate">{l.reason}</div>}</Td><Td className="text-slate-500">{l.from}</Td><Td className="text-slate-500">{l.to}</Td><Td>{dayCount(l.from,l.to)}</Td><Td className="text-xs text-slate-500">{LEAVE_POLICY[l.type]?`${Math.max(0,leaveLeft(data,l.employee,l.type))} left`:"—"}</Td><Td><Pill s={l.status}/></Td>
        <Td>{busyLeave===l.id?<span className="flex items-center gap-1.5 justify-end text-xs text-slate-500"><Loader2 size={13} className="animate-spin"/>Processing…</span>:l.status==="Pending"?<div className="flex gap-1 justify-end"><button disabled={!!busyLeave} onClick={()=>setStatus(l.id,"Approved")} className="p-1.5 rounded text-emerald-600 hover:bg-slate-100 disabled:opacity-40"><Check size={14}/></button><button disabled={!!busyLeave} onClick={()=>setStatus(l.id,"Rejected")} className="p-1.5 rounded text-rose-500 hover:bg-slate-100 disabled:opacity-40"><X size={14}/></button></div>:<span className="text-xs text-slate-400">—</span>}</Td></Row>))}</Table></Card>
    )}
  </>);
}

// ===== Freelance projects =====
// Freelancers earn per delivered project, never a monthly salary. A project moves
// In progress -> Delivered -> Approved -> Paid, and only approved work is money owed.
const GIG_FLOW = ["In progress", "Delivered", "Approved", "Paid"];
function Gigs({ data, update, brand }) {
  const rows = data.gigs || [];
  const freelancers = (data.employees||[]).filter(e=>e.payType==="Freelance" && e.status==="Active");
  const [edit, setEdit] = useState(null);
  const [pay, setPay] = useState(null);
  const [who, setWho] = useState("");
  const [st, setSt] = useState("open");
  const blank = () => ({ employee: freelancers[0]?.name || "", client:"", title:"", amount:"", currency:"PKR", startedOn:today(), dueOn:"", status:"In progress", note:"" });
  const save = (g) => {
    if (!g.employee) { alert("Choose which freelancer this project is for."); return; }
    if (!g.title.trim()) { alert("Give the project a title."); return; }
    if (!+g.amount) { alert("Enter the agreed amount."); return; }
    update("gigs", g.id ? rows.map(x=>x.id===g.id?g:x) : [{ ...g, id:uid() }, ...rows],
      g.id ? `Updated project: ${g.title}` : `Added project for ${g.employee}: ${g.title}`);
    setEdit(null);
  };
  const setStatus = (g, status) => update("gigs", rows.map(x=>x.id===g.id?{ ...x, status, ...(status==="Approved"?{approvedOn:today()}:{}) }:x), `${g.title} → ${status}`);
  const confirmPay = () => {
    update("gigs", rows.map(x=>x.id===pay.id?{ ...x, status:"Paid", paidOn:pay.date, payMethod:pay.method, proof:pay.proof||null }:x), `Paid ${pay.employee} for ${pay.title}`);
    setPay(null);
  };
  const filtered = rows.filter(g=>(!who||g.employee===who) && (st==="all" ? true : st==="open" ? g.status!=="Paid" : g.status==="Paid"));
  const owed = rows.filter(g=>g.status==="Approved").reduce((t,g)=>t + (+g.amount||0), 0);
  const inFlight = rows.filter(g=>g.status==="In progress"||g.status==="Delivered").reduce((t,g)=>t + (+g.amount||0), 0);
  const paidThisMonth = rows.filter(g=>g.status==="Paid" && (g.paidOn||"").startsWith(monthKey())).reduce((t,g)=>t + (+g.amount||0), 0);
  const pill = (s2)=> s2==="Paid"?"bg-emerald-100 text-emerald-700":s2==="Approved"?"bg-sky-100 text-sky-700":s2==="Delivered"?"bg-amber-100 text-amber-700":"bg-slate-100 text-slate-600";
  return (<>
    <Head title="Freelance Projects" sub="Per-project work — freelancers are paid for approved projects, not a monthly salary"
      action={<Btn onClick={()=>setEdit(blank())} disabled={!freelancers.length}><Plus size={15}/>Add project</Btn>}/>
    {!freelancers.length && <div className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">No freelancers yet. Open People → Employees, add the person, and set their <b>Pay type</b> to “Freelance (paid per project)”.</div>}
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-5">
      {[["Approved, awaiting payment", fmt(owed), "text-sky-700"],["Work in progress", fmt(inFlight), "text-slate-700"],[`Paid in ${monthLabel().split(" ")[0]}`, fmt(paidThisMonth), "text-emerald-700"]].map(([k,v,c])=>(
        <Card key={k}><div className="p-4"><div className={`text-xl font-bold ${c}`}>{v}</div><div className="text-xs text-slate-500 mt-0.5">{k}</div></div></Card>))}
    </div>
    <div className="flex flex-wrap gap-2 mb-4 items-end">
      <div className="min-w-44"><Select label="Freelancer" options={["", ...freelancers.map(f=>f.name)]} value={who} onChange={e=>setWho(e.target.value)}/></div>
      {[["open","Open"],["paid","Paid"],["all","All"]].map(([k,l])=><Btn key={k} variant={st===k?"primary":"ghost"} onClick={()=>setSt(k)}>{l}</Btn>)}
    </div>
    <Card><Table cols={["Freelancer","Project","Client","Agreed","Dates","Status",""]}>{filtered.length===0?<tr><td colSpan={7}><Empty msg="No projects here yet"/></td></tr>:filtered.map(g=>(
      <Row key={g.id}>
        <Td className="font-medium">{g.employee}</Td>
        <Td>{g.title}{g.note&&<div className="text-xs text-slate-400 max-w-[220px] truncate">{g.note}</div>}</Td>
        <Td className="text-slate-500">{g.client||"—"}</Td>
        <Td className="font-medium">{fmt(g.amount, g.currency)}</Td>
        <Td className="text-xs text-slate-500 whitespace-nowrap">{g.startedOn||"—"}{g.dueOn?` → ${g.dueOn}`:""}{g.paidOn&&<div className="text-emerald-600">paid {g.paidOn}</div>}</Td>
        <Td><span className={`text-xs px-2 py-0.5 rounded-full ${pill(g.status)}`}>{g.status}</span></Td>
        <Td><div className="flex items-center gap-1 justify-end">
          {g.status==="In progress" && <button onClick={()=>setStatus(g,"Delivered")} className="text-xs text-sky-600 hover:underline whitespace-nowrap">Mark delivered</button>}
          {g.status==="Delivered" && <button onClick={()=>setStatus(g,"Approved")} className="text-xs text-emerald-600 hover:underline whitespace-nowrap">Approve</button>}
          {g.status==="Approved" && <button onClick={()=>setPay({ id:g.id, employee:g.employee, title:g.title, amount:g.amount, currency:g.currency, method:"Bank transfer", date:today(), proof:null })} className="text-xs font-medium text-emerald-700 hover:underline whitespace-nowrap">Mark paid</button>}
          <RowActions onEdit={()=>setEdit(g)} onDelete={()=>update("gigs", rows.filter(x=>x.id!==g.id), `Deleted project ${g.title}`)}/>
        </div></Td>
      </Row>))}</Table></Card>
    {edit && <Modal title={edit.id?"Edit project":"Add project"} onClose={()=>setEdit(null)}>
      <Select label="Freelancer" options={freelancers.map(f=>f.name)} value={edit.employee} onChange={e=>setEdit({...edit,employee:e.target.value})}/>
      <Field label="Project title" value={edit.title} onChange={e=>setEdit({...edit,title:e.target.value})}/>
      <ClientInput data={data} value={edit.client} onChange={v=>setEdit({...edit,client:v})}/>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Agreed amount" type="number" value={edit.amount} onChange={e=>setEdit({...edit,amount:e.target.value})}/>
        <Select label="Currency" options={CURRENCIES} value={edit.currency} onChange={e=>setEdit({...edit,currency:e.target.value})}/>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Started" type="date" value={edit.startedOn} onChange={e=>setEdit({...edit,startedOn:e.target.value})}/>
        <Field label="Due" type="date" value={edit.dueOn} onChange={e=>setEdit({...edit,dueOn:e.target.value})}/>
      </div>
      <Area label="Scope / notes" value={edit.note} onChange={e=>setEdit({...edit,note:e.target.value})}/>
      {edit.id && <Select label="Status" options={GIG_FLOW} value={edit.status} onChange={e=>setEdit({...edit,status:e.target.value})}/>}
      <Btn onClick={()=>save(edit)}><Check size={15}/>Save project</Btn>
    </Modal>}
    {pay && <Modal title={`Pay ${pay.employee}`} onClose={()=>setPay(null)}>
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm flex justify-between"><span className="text-slate-500">{pay.title}</span><b>{fmt(pay.amount, pay.currency)}</b></div>
      <Select label="Payment method" options={["Bank transfer","Cheque","Cash","Wise / online"]} value={pay.method} onChange={e=>setPay({...pay,method:e.target.value})}/>
      <Field label="Payment date" type="date" value={pay.date} onChange={e=>setPay({...pay,date:e.target.value})}/>
      <div><span className="text-xs text-slate-500 mb-1 block">Payment proof (optional)</span>
        <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500"><Paperclip size={15}/>{pay.proof?"Change screenshot":"Attach screenshot"}
          <input type="file" accept="image/*" className="hidden" onChange={async e=>{ const f=e.target.files[0]; if(f){ const img=await readImage(f,1400,true,0.82); try { const stt=await uploadFile(img,"gig-payment.jpg"); setPay(c=>({...c, proof:{fileId:stt.fileId, mime:stt.mime}})); } catch { setPay(c=>({...c, proof:img})); } } }}/></label>
        {pay.proof && <StoredImg d={typeof pay.proof==="string"?{img:pay.proof}:{...pay.proof}} className="mt-2 h-24 rounded-lg border border-slate-200 object-cover"/>}
      </div>
      <Btn onClick={confirmPay}><Check size={15}/>Record payment</Btn>
    </Modal>}
  </>);
}
function MyProjects({ data, me }) {
  const mine = (data.gigs||[]).filter(g=>g.employee===me.name);
  const earned = mine.filter(g=>g.status==="Paid").reduce((t,g)=>t + (+g.amount||0), 0);
  const due = mine.filter(g=>g.status==="Approved").reduce((t,g)=>t + (+g.amount||0), 0);
  const working = mine.filter(g=>g.status==="In progress"||g.status==="Delivered").reduce((t,g)=>t + (+g.amount||0), 0);
  const pill = (s2)=> s2==="Paid"?"bg-emerald-100 text-emerald-700":s2==="Approved"?"bg-sky-100 text-sky-700":s2==="Delivered"?"bg-amber-100 text-amber-700":"bg-slate-100 text-slate-600";
  return (<>
    <Head title="My Projects" sub="You are paid per project — here is where each one stands"/>
    <div className="grid grid-cols-3 gap-4 mb-5">
      {[["Paid to me", fmt(earned), "text-emerald-700"],["Approved, awaiting payment", fmt(due), "text-sky-700"],["In progress", fmt(working), "text-slate-700"]].map(([k,v,c])=>(
        <Card key={k}><div className="p-4"><div className={`text-lg sm:text-xl font-bold ${c}`}>{v}</div><div className="text-xs text-slate-500 mt-0.5">{k}</div></div></Card>))}
    </div>
    <Card><Table cols={["Project","Client","Amount","Dates","Status"]}>{mine.length===0?<tr><td colSpan={5}><Empty msg="No projects assigned yet"/></td></tr>:mine.map(g=>(
      <Row key={g.id}>
        <Td className="font-medium">{g.title}{g.note&&<div className="text-xs text-slate-400 max-w-[240px] truncate">{g.note}</div>}</Td>
        <Td className="text-slate-500">{g.client||"—"}</Td>
        <Td className="font-medium">{fmt(g.amount, g.currency)}</Td>
        <Td className="text-xs text-slate-500 whitespace-nowrap">{g.startedOn||"—"}{g.dueOn?` → ${g.dueOn}`:""}{g.paidOn&&<div className="text-emerald-600">paid {g.paidOn}{g.payMethod?` · ${g.payMethod}`:""}</div>}</Td>
        <Td><span className={`text-xs px-2 py-0.5 rounded-full ${pill(g.status)}`}>{g.status}</span></Td>
      </Row>))}</Table></Card>
    <p className="text-xs text-slate-400 mt-3">Payment is released once HR approves a delivered project.</p>
  </>);
}
function Payroll({ data, patch, update, brand }) {
  const [slip, setSlip] = useState(null);
  const [payProof, setPayProof] = useState(null);
  const [editDed, setEditDed] = useState(null);
  const [adj, setAdj] = useState(null);
  const month = monthLabel();
  // Payroll is guarded: it shows exactly who will be processed and can never produce a
  // second slip (or a second advance deduction) for someone already run this month.
  const bp = useBatch(data.payroll);
  const [bulkPay, setBulkPay] = useState(null);
  const doBulkPay = () => {
    const ids = new Set(bp.selected);
    update("payroll", data.payroll.map(x=>ids.has(x.id) && !x.paid
      ? { ...x, paid:true, payMethod:bulkPay.method, proof:bulkPay.proof||x.proof, paidOn:today() } : x),
      `Marked ${ids.size} salary slip(s) paid`);
    bp.clear(); setBulkPay(null);
  };
  const withAllowance = data.payroll.filter(p => +p.allowances > 0);
  const clearAllowances = () => {
    const total = withAllowance.reduce((t,p)=>t + (+p.allowances||0), 0);
    if (!confirm(`Remove the automatic allowance from ${withAllowance.length} salary slip(s)?\n\nThese were created by an older version that added 10% automatically. Removing it lowers those slips by ${fmt(total)} in total. Nothing else changes — you can still add increases manually with a reason.`)) return;
    update("payroll", data.payroll.map(p => +p.allowances > 0 ? { ...p, allowances: 0 } : p), `Removed automatic allowance from ${withAllowance.length} slip(s)`);
  };
  const [runAsk, setRunAsk] = useState(null);
  const askRun = () => {
    const already = data.payroll.filter(p=>p.month===month).map(p=>p.employee);
    const doneSet = new Set(already);
    const targets = data.employees.filter(e=>e.status==="Active" && e.payType!=="Freelance" && !doneSet.has(e.name));   // freelancers are paid per project
    setRunAsk({ already, targets });
  };
  const doRun = ()=>{
    const names = new Set(runAsk.targets.map(e=>e.name));
    if (!names.size) { setRunAsk(null); return; }
    // Only the people actually being processed have reimbursements settled and an
    // advance installment taken — that's what made a repeat run dangerous before.
    const ids=[]; data.payables.forEach(p=>{ if(p.kind==="reimbursement"&&p.status==="Approved"&&!p.settled&&p.payVia==="salary"&&(!p.payMonth||p.payMonth===month)&&names.has(p.vendor)) ids.push(p.id); });
    const runs=runAsk.targets.map(e=>computePayslip(e,data,month));
    const newPayables=data.payables.map(p=>ids.includes(p.id)?{...p,settled:true,status:"Paid"}:p);
    const newAdvances=data.advances.map(a=>{ if(a.status==="Active"&&a.remaining>0&&names.has(a.employee)){ const d=Math.min(+a.installment,a.remaining); const rem=a.remaining-d; return {...a,remaining:rem,status:rem<=0?"Cleared":"Active"};} return a; });
    patch({ payroll:[...runs,...data.payroll], payables:newPayables, advances:newAdvances }, `Ran payroll for ${month} · ${runs.length} employee(s)`);
    setRunAsk(null);
  };
  const saveDed = () => {
    const tax=+editDed.tax||0, eobi=+editDed.eobi||0, pf=+editDed.pf||0, advance=+editDed.advance||0;
    const deductions = tax+eobi+pf+advance;
    update("payroll", data.payroll.map(x=>x.id===editDed.id?{...x,tax,eobi,pf,advance,deductions}:x), `Adjusted deductions for ${editDed.employee} (${editDed.month})`);
    setEditDed(null);
  };
  // adjustments (increase or deduction with a reason)
  const addAdjLine = (sign) => setAdj(a=>({ ...a, list:[...a.list, { id:uid(), reason:"", amount:"", sign }] }));
  const setAdjLine = (id,k,v) => setAdj(a=>({ ...a, list:a.list.map(l=>l.id===id?{...l,[k]:v}:l) }));
  const rmAdjLine = (id) => setAdj(a=>({ ...a, list:a.list.filter(l=>l.id!==id) }));
  const saveAdj = () => {
    const adjustments = adj.list.filter(l=>l.reason && l.amount).map(l=>({ id:l.id, reason:l.reason, amount: (l.sign==="-"?-1:1)*Math.abs(+l.amount||0) }));
    update("payroll", data.payroll.map(x=>x.id===adj.id?{...x,adjustments}:x), `Adjusted pay for ${adj.employee} (${adj.month})`);
    setAdj(null);
  };
  const openAdj = (p) => setAdj({ id:p.id, employee:p.employee, month:p.month, list: (p.adjustments||[]).map(a=>({ id:a.id||uid(), reason:a.reason, amount:Math.abs(a.amount), sign: a.amount<0?"-":"+" })) });
  const pendingReimb = data.payables.filter(p=>p.kind==="reimbursement"&&p.status==="Approved"&&!p.settled).reduce((s,p)=>s+ +p.amount,0);
  const empEmail = (name) => data.employees.find(e=>e.name===name)?.email || "";
  const empAcct = (name) => data.employees.find(e=>e.name===name)?.account || "";
  return (<>
    <Head title="Payroll & Salary Slips" sub={`${month} · base salary + your adjustments − deductions (no automatic allowance)${pendingReimb?` · ${fmt(pendingReimb)} reimbursements queued`:""}`} action={<Btn onClick={askRun}><Wallet size={15}/>Run payroll · {month}</Btn>}/>
    {withAllowance.length>0 && <div className="mb-3 flex flex-wrap items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
      <div className="text-sm text-amber-800 flex-1">{withAllowance.length} salary slip(s) still carry an automatic 10% allowance added by an older version. New payroll runs no longer add it.</div>
      <Btn variant="ghost" onClick={clearAllowances}><X size={15}/>Remove automatic allowance</Btn>
    </div>}
    <BatchBar count={bp.count} noun="salary slip" onClear={bp.clear}
      onDelete={()=>{ const ids=new Set(bp.selected); update("payroll", data.payroll.filter(x=>!ids.has(x.id)), `Deleted ${ids.size} salary slip(s)`); bp.clear(); }}>
      <Btn variant="ghost" onClick={()=>setBulkPay({ method:"Bank transfer", proof:null })}><Check size={15}/>Mark paid</Btn>
    </BatchBar>
    <Card><Table cols={[<SelBox key="a" on={bp.allOn} onChange={bp.toggleAll} title="Select all"/>,"Employee","Month","Net","Account / IBAN","Payment","",""]}>{data.payroll.length===0?<tr><td colSpan={8}><Empty msg="No payroll runs yet"/></td></tr>:data.payroll.map(p=>(
      <Row key={p.id}>
        <SelTd on={bp.has(p.id)} onChange={()=>bp.toggle(p.id)}/>
        <Td className="font-medium">{p.employee}</Td><Td className="text-slate-500">{p.month}</Td><Td className="font-semibold">{fmt(netPay(p))}{(p.adjustments||[]).length>0&&<div className="text-xs text-slate-400 font-normal">{adjTotal(p)>=0?"+":""}{fmt(adjTotal(p))} adj.</div>}</Td>
        <Td className="text-slate-500 text-xs">{empAcct(p.employee)||"— not on file —"}</Td>
        <Td>{p.paid?<span className="flex items-center gap-2"><Pill s="Paid"/>{p.proof&&<button onClick={(e)=>{e.stopPropagation();openStored(typeof p.proof==="string"?{img:p.proof}:{...p.proof},"payment-proof");}} title="Open payment proof" className="w-7 h-7 rounded border border-slate-200 overflow-hidden grid place-items-center hover:ring-2 hover:ring-sky-400"><StoredImg d={typeof p.proof==="string"?{img:p.proof}:{...p.proof}} className="w-7 h-7 object-cover"/></button>}</span>:<Pill s="Pending"/>}</Td>
        <Td><button onClick={()=>setSlip(p)} className="text-sky-600 text-xs font-medium hover:underline">View slip</button></Td>
        <Td><RowActions>{!p.paid && <button onClick={()=>openAdj(p)} title="Add increase / deduction with reason" className="px-2 py-1 rounded text-xs bg-sky-100 text-sky-700 hover:bg-sky-200">Adjust</button>}{!p.paid && <button onClick={()=>setEditDed({...p})} title="Tax / EOBI / PF / advance" className="px-2 py-1 rounded text-xs bg-slate-100 text-slate-600 hover:bg-slate-200">Deductions</button>}{!p.paid && <button onClick={()=>setPayProof({ ...p, proof:null })} className="px-2 py-1 rounded text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-200">Mark paid</button>}{p.paid && <button onClick={()=>setPayProof({ ...p })} title="Update payment" className="p-1.5 rounded text-slate-400 hover:text-sky-600 hover:bg-slate-100"><Edit3 size={14}/></button>}</RowActions></Td>
      </Row>))}</Table></Card>
    {bulkPay && (()=>{ const chosen=data.payroll.filter(x=>bp.selected.includes(x.id)); const unpaid=chosen.filter(x=>!x.paid); return (
      <Modal title={`Mark ${unpaid.length} salary slip(s) paid`} onClose={()=>setBulkPay(null)}>
        {unpaid.length===0 ? <div className="text-sm text-slate-600">Everything selected is already marked paid.</div> : <>
          <div className="text-sm text-slate-600">Total being paid: <b>{fmt(unpaid.reduce((t,x)=>t+netPay(x),0))}</b> across {unpaid.length} employee(s).</div>
          <Select label="Payment method" options={["Bank transfer","Cheque","Cash","Wise / online"]} value={bulkPay.method} onChange={e=>setBulkPay({...bulkPay,method:e.target.value})}/>
          <div><span className="text-xs text-slate-500 mb-1 block">Payment proof (optional — applied to all)</span>
            <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500"><Paperclip size={15}/>{bulkPay.proof?"Change screenshot":"Attach screenshot"}
              <input type="file" accept="image/*" className="hidden" onChange={async e=>{ const f=e.target.files[0]; if(f){ const img=await readImage(f,1400,true,0.82); try { const st=await uploadFile(img,"payment-proof.jpg"); setBulkPay(b=>({...b, proof:{fileId:st.fileId, mime:st.mime}})); } catch { setBulkPay(b=>({...b, proof:img})); } } }}/></label>
            {bulkPay.proof && <StoredImg d={typeof bulkPay.proof==="string"?{img:bulkPay.proof}:{...bulkPay.proof}} className="mt-2 h-24 rounded-lg border border-slate-200 object-cover"/>}
          </div>
          {chosen.length!==unpaid.length && <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{chosen.length-unpaid.length} already-paid slip(s) in your selection will be left untouched.</div>}
          <Btn onClick={doBulkPay}><Check size={15}/>Mark {unpaid.length} paid</Btn>
        </>}
      </Modal>); })()}
    {runAsk && <Modal title={`Run payroll · ${month}`} onClose={()=>setRunAsk(null)}>
      {runAsk.targets.length===0
        ? <div className="text-sm text-slate-600">Every active employee already has a salary slip for {month}. Nothing to run — this is what stops a second run from creating duplicate slips or deducting advances twice.</div>
        : <>
          <div className="text-sm text-slate-600">This will create <b>{runAsk.targets.length}</b> salary slip{runAsk.targets.length>1?"s":""} for {month}:</div>
          <div className="max-h-40 overflow-y-auto bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm space-y-0.5">
            {runAsk.targets.map(e=>(<div key={e.id} className="flex justify-between"><span>{e.name}</span><span className="text-slate-500">{fmt(e.salary)}</span></div>))}
          </div>
          {runAsk.already.length>0 && <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Skipping {runAsk.already.length} employee(s) who already have a slip for {month}: {runAsk.already.slice(0,6).join(", ")}{runAsk.already.length>6?"…":""}</div>}
          <p className="text-xs text-slate-400">Approved reimbursements and one advance installment are applied only to the people listed above. Freelancers are never included — they are paid per project.</p>
        </>}
      {runAsk.targets.length>0 && <Btn onClick={doRun}><Check size={15}/>Run payroll for {runAsk.targets.length} employee{runAsk.targets.length>1?"s":""}</Btn>}
    </Modal>}
    {slip && <SlipModal slip={slip} brand={brand} data={data} sendable onClose={()=>setSlip(null)}/>}
    {adj && <Modal title={`Adjust pay · ${adj.employee}`} onClose={()=>setAdj(null)}>
      <p className="text-xs text-slate-500">Add an increase (bonus, arrears) or a deduction (fine, leave-without-pay) with a reason. Each line appears on the payslip.</p>
      <div className="space-y-2">{adj.list.length===0 && <div className="text-xs text-slate-400">No adjustments yet.</div>}
        {adj.list.map(l=>(<div key={l.id} className="flex items-center gap-2">
          <select value={l.sign} onChange={e=>setAdjLine(l.id,"sign",e.target.value)} className="bg-white border border-slate-300 rounded-lg px-2 py-2 text-sm"><option value="+">+ Add</option><option value="-">− Deduct</option></select>
          <input value={l.reason} onChange={e=>setAdjLine(l.id,"reason",e.target.value)} placeholder="Reason (e.g. Eid bonus, 2 days unpaid leave)" className="flex-1 bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-sky-500"/>
          <input type="number" value={l.amount} onChange={e=>setAdjLine(l.id,"amount",e.target.value)} placeholder="amount" className="w-28 bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-sky-500"/>
          <button onClick={()=>rmAdjLine(l.id)} className="text-slate-400 hover:text-rose-500"><X size={15}/></button>
        </div>))}
      </div>
      <div className="flex gap-2"><Btn variant="ghost" onClick={()=>addAdjLine("+")}><Plus size={14}/>Add increase</Btn><Btn variant="ghost" onClick={()=>addAdjLine("-")}><Plus size={14}/>Add deduction</Btn></div>
      <Btn onClick={saveAdj}><Check size={15}/>Save adjustments</Btn>
    </Modal>}
    {editDed && <Modal title={`Deductions · ${editDed.employee}`} onClose={()=>setEditDed(null)}>
      <p className="text-xs text-slate-500">These are blank (0) by default. Enter any amounts that apply for {editDed.month}.</p>
      <div className="grid grid-cols-2 gap-3"><Field label="Income tax" type="number" value={editDed.tax} onChange={e=>setEditDed({...editDed,tax:e.target.value})}/><Field label="EOBI" type="number" value={editDed.eobi} onChange={e=>setEditDed({...editDed,eobi:e.target.value})}/></div>
      <div className="grid grid-cols-2 gap-3"><Field label="Provident fund" type="number" value={editDed.pf} onChange={e=>setEditDed({...editDed,pf:e.target.value})}/><Field label="Advance / loan" type="number" value={editDed.advance} onChange={e=>setEditDed({...editDed,advance:e.target.value})}/></div>
      <Btn onClick={saveDed}><Check size={15}/>Save deductions</Btn>
    </Modal>}
    {payProof && <PayrollPaidModal rec={payProof} brand={brand} email={empEmail(payProof.employee)} employee={data.employees.find(e=>e.name===payProof.employee)||{}} onClose={()=>setPayProof(null)}
      onSave={(proof, method)=>{ update("payroll", data.payroll.map(x=>x.id===payProof.id?{...x,paid:true,proof,payMethod:method,paidOn:today()}:x), `Marked salary paid: ${payProof.employee} (${payProof.month})`); setPayProof(null); }}/>}
  </>);
}
function PayrollPaidModal({ rec, brand, email, employee, onClose, onSave }) {
  const [proof, setProof] = useState(rec.proof || null);
  const [method, setMethod] = useState(rec.payMethod || "Bank transfer");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState(null);
  // Send the real payslip PDF from the company mailbox, then record the payment.
  const saveAndEmail = async () => {
    if (!email) { setNote({ ok:false, text:"This employee has no email on file — add one under Employees, or use “Save as paid” and send it later." }); return; }
    setSending(true); setNote(null);
    const paidRec = { ...rec, paid:true, paidOn:today(), payMethod:method };   // so the PDF shows as paid
    try {
      await apiReq("POST", "/payslip/email", {
        slip: paidRec, brand: pdfBrand(brand), employee: employee || {}, to: email,
        subject: `Salary slip — ${rec.month}`,
        body: payslipMessage(paidRec, brand),
      });
      onSave(proof, method);          // records the payment and closes
    } catch (e) {
      setNote({ ok:false, text:(e.message || "The email couldn't be sent.") + " Nothing was recorded — you can still use “Save as paid”." });
      setSending(false);
    }
  };
  const onImg = async (f) => { if (!f) return; const d = await readImage(f, 1400, true, 0.82); try { const st = await uploadFile(d, "payment-proof.jpg"); setProof({ fileId: st.fileId, mime: st.mime }); } catch { setProof(d); } };
  const slipLines = () => {
    const L = [];
    L.push(`Basic: ${fmt(rec.basic)}`);
    if (+rec.allowances>0) L.push(`Allowances: ${fmt(rec.allowances)}`);
    if (+rec.reimbursements>0) L.push(`Reimbursements: ${fmt(rec.reimbursements)}`);
    (rec.adjustments||[]).forEach(a=>L.push(`${a.reason}: ${a.amount<0?"-":"+"}${fmt(Math.abs(a.amount))}`));
    if (+rec.tax>0) L.push(`Income tax: -${fmt(rec.tax)}`);
    if (+rec.eobi>0) L.push(`EOBI: -${fmt(rec.eobi)}`);
    if (+rec.pf>0) L.push(`Provident fund: -${fmt(rec.pf)}`);
    if (+rec.advance>0) L.push(`Advance / loan: -${fmt(rec.advance)}`);
    return L.join("\n");
  };
  const subject = `Salary Slip — ${rec.month} — ${brand.company}`;
  const bodyText = `Dear ${rec.employee},\n\nYour salary for ${rec.month} has been disbursed. Here is your payslip summary:\n\n${slipLines()}\n----------------------------\nNet pay: ${fmt(netPay(rec))}\nMethod: ${method}\nDate: ${today()}\n\nIf you have any questions about your payslip, please reach out to HR.\n\nWarm regards,\n${brand.company}\n${brand.contact || ""}`;
  const sendGmail = () => {
    if (!email) { alert("This employee has no email on file. Add one under Employees."); return; }
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`;
    window.open(url, "_blank");
  };
  const sendMailto = () => {
    if (!email) { alert("This employee has no email on file. Add one under Employees."); return; }
    window.open(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`, "_blank");
  };
  return (<Modal title={`Record salary payment · ${rec.employee}`} onClose={onClose}>
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm flex justify-between"><span className="text-slate-500">Net pay · {rec.month}</span><b>{fmt(netPay(rec))}</b></div>
    <Select label="Payment method" options={["Bank transfer","Cheque","Cash","Wise / online"]} value={method} onChange={e=>setMethod(e.target.value)}/>
    <div><span className="text-xs text-slate-500 mb-1 block">Payment proof (transfer screenshot or cheque photo)</span>
      <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500"><Paperclip size={15}/>{proof?"Proof attached":"Attach screenshot / cheque"}<input type="file" accept="image/*" className="hidden" onChange={e=>onImg(e.target.files[0])}/></label>
      {proof && <StoredImg d={typeof proof==="string"?{img:proof}:{...proof}} className="mt-2 h-32 rounded-lg border border-slate-200 object-cover"/>}
    </div>
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
      <div className="text-xs font-medium text-slate-600 mb-1 flex items-center gap-1.5"><Mail size={13}/>Email {email?`→ ${email}`:"(no email on file)"}</div>
      <div className="text-xs text-slate-500 whitespace-pre-wrap" style={{maxHeight:140, overflow:"auto"}}>{bodyText}</div>
    </div>
    {note && <div className={`text-xs rounded-lg px-3 py-2 ${note.ok?"bg-emerald-50 border border-emerald-200 text-emerald-700":"bg-rose-50 border border-rose-200 text-rose-700"}`}>{note.text}</div>}
    <div className="flex flex-wrap gap-2">
      <Btn onClick={saveAndEmail} disabled={sending}>{sending?<Loader2 size={15} className="animate-spin"/>:<Send size={15}/>}{sending?"Sending payslip…":"Save as paid & email payslip"}</Btn>
      <Btn variant="ok" onClick={()=>onSave(proof, method)} disabled={sending}><Check size={15}/>Save as paid only</Btn>
      <Btn variant="ghost" onClick={sendGmail} disabled={sending}><Mail size={15}/>Open in Gmail instead</Btn>
    </div>
    <p className="text-xs text-slate-400">“Save as paid &amp; email payslip” sends the slip straight from {brand.email || "your company mailbox"} with the PDF attached — no Gmail window. The Gmail option is only a fallback (it can't carry an attachment).</p>
  </Modal>);
}

function VendorBills({ data, update, patch, role, brand }) {
  const bv = useBatch(data.vendorBills||[]);
  const rows = data.vendorBills || [];
  const [edit, setEdit] = useState(null);
  const [viewBill, setViewBill] = useState(null);
  const blank = { vendor:"", whatsapp:"", desc:"", category:"Contractor / outsourced", amount:"", currency:"PKR", due:today(), file:null, fileName:"", hrApproved:null, founderApproved:null, status:"Pending HR", paid:false };
  const statusOf = (b) => b.paid ? "Paid" : (b.hrApproved && b.founderApproved) ? "Approved" : b.hrApproved ? "Pending Founder" : "Pending HR";
  // Note: "Approved" means fully signed off and sitting in Payables, awaiting actual payment.
  const save = (b) => {
    const rec = { ...b, status: statusOf(b) };
    if (b.id) update("vendorBills", rows.map(x=>x.id===b.id?rec:x));
    else update("vendorBills", [{ ...rec, id:uid() }, ...rows], `Uploaded vendor bill: ${b.vendor} ${fmt(b.amount,b.currency)}`);
    setEdit(null);
  };
  const approve = (b, kind) => {
    // Strict separation: only the founder (admin) can give the founder approval; only HR/founder can give HR approval.
    if (kind === "founder" && role !== "admin") return;
    if (kind === "hr" && role === "employee") return;
    const stamp = { by: kind === "founder" ? "Founder" : "HR", on: today() };
    const next = { ...b, [kind==="hr"?"hrApproved":"founderApproved"]: stamp };
    const bothApproved = next.hrApproved && next.founderApproved;
    if (bothApproved && !next.paid) {
      // Fully approved -> route to Payables as UNPAID. The bill is NOT paid yet.
      next.status = "Approved"; next.sentToPayables = true;
      const exists = (data.payables||[]).some(p=>p.kind==="vendorbill" && p.billId===b.id);
      const payable = { id:uid(), vendor:next.vendor, whatsapp:next.whatsapp||"", desc:`Vendor bill: ${next.desc||next.category}`, amount:+next.amount, due:next.due, status:"Pending", kind:"vendorbill", billId:next.id, receipt:next.file, fileType:next.fileType };
      patch({ vendorBills: rows.map(x=>x.id===b.id?next:x), payables: exists ? data.payables : [payable, ...(data.payables||[])] }, `${stamp.by} gave final approval — ${next.vendor} sent to Payables (awaiting payment)`);
    } else {
      next.status = statusOf(next);
      update("vendorBills", rows.map(x=>x.id===b.id?next:x), `${stamp.by} approved vendor bill: ${b.vendor} ${fmt(b.amount,b.currency)}`);
    }
  };
  const sendToPayables = (b) => {
    const payable = { id:uid(), vendor:b.vendor, desc:`Vendor bill: ${b.desc||b.category}`, amount:+b.amount, due:b.due, status:"Pending", kind:"vendorbill", billId:b.id, receipt:b.file };
    patch({ payables:[payable, ...data.payables], vendorBills: rows.map(x=>x.id===b.id?{...x,paid:true,status:"Paid"}:x) }, `Vendor bill sent to Payables: ${b.vendor}`);
  };
  const onFile = async (f, setFn, cur) => {
    if(!f) return;
    const isImg = f.type.startsWith("image/");
    const data = isImg ? await readImage(f, 1600, true, 0.82) : await readFile(f);
    try {
      const st = await uploadFile(data, f.name);          // kept out of the main record
      setFn({ ...cur, fileName:f.name, fileType: isImg ? "image" : "file", file:null, fileId:st.fileId, fileMime:st.mime });
    } catch {
      setFn({ ...cur, fileName:f.name, fileType: isImg ? "image" : "file", file: data });
    }
  };
  return (<>
    <Head title="Vendor Bills" sub="Upload vendor invoices → HR approves → Founder approves → moves to Payables (unpaid) → mark paid from Payables" action={<Btn onClick={()=>setEdit(blank)}><Plus size={15}/>Upload bill</Btn>}/>
    <BatchBar count={bv.count} noun="vendor bill" onClear={bv.clear} onDelete={()=>{ const ids=new Set(bv.selected); update("vendorBills", rows.filter(x=>!ids.has(x.id)), `Deleted ${ids.size} vendor bill(s)`); bv.clear(); }}/>
    <Card><Table cols={[<SelBox key="a" on={bv.allOn} onChange={bv.toggleAll} title="Select all"/>,"Vendor","For","Amount","Due","HR","Founder","Status",""]}>
      {rows.length===0?<tr><td colSpan={9}><Empty msg="No vendor bills uploaded yet"/></td></tr>:rows.map(b=>(
        <Row key={b.id}><SelTd on={bv.has(b.id)} onChange={()=>bv.toggle(b.id)}/>
          <Td className="font-medium">{b.vendor}</Td>
          <Td className="text-slate-500">{b.desc||b.category}</Td>
          <Td>{fmt(b.amount,b.currency)}</Td>
          <Td className="text-slate-500">{b.due}</Td>
          <Td>{b.hrApproved?<span className="text-emerald-600 text-xs">✓ {b.hrApproved.on}</span>:<span className="text-slate-400 text-xs">—</span>}</Td>
          <Td>{b.founderApproved?<span className="text-emerald-600 text-xs">✓ {b.founderApproved.on}</span>:<span className="text-slate-400 text-xs">—</span>}</Td>
          <Td><Pill s={statusOf(b)}/></Td>
          <Td><RowActions onEdit={b.paid?undefined:()=>setEdit(b)} onDelete={()=>update("vendorBills", rows.filter(x=>x.id!==b.id))}>
            {b.file && <button onClick={()=>setViewBill(b)} title="View bill" className="p-1.5 rounded text-slate-400 hover:text-sky-600 hover:bg-slate-100"><FileText size={14}/></button>}
            {!b.hrApproved && role!=="employee" && <button onClick={()=>approve(b,"hr")} title="HR approve" className="px-2 py-1 rounded text-xs bg-amber-100 text-amber-700 hover:bg-amber-200">HR ✓</button>}
            {b.hrApproved && !b.founderApproved && role==="admin" && <button onClick={()=>approve(b,"founder")} title="Founder approve" className="px-2 py-1 rounded text-xs bg-sky-100 text-sky-700 hover:bg-sky-200">Founder ✓</button>}
            {b.hrApproved && b.founderApproved && !b.paid && <span className="text-xs text-amber-600">in Payables · unpaid</span>}
            {b.paid && <span className="text-xs text-emerald-600">paid</span>}
          </RowActions></Td>
        </Row>))}
    </Table></Card>
    <p className="text-xs text-slate-400 mt-3">Flow: anyone (HR) uploads & gives HR approval → only the Founder can give the final approval → the bill then moves to <b>Payables as unpaid</b>. It is marked <b>Paid</b> only when you settle it in Payables. HR cannot give the Founder approval. All steps are stamped in the Activity Log.</p>

    {edit && <Modal title={edit.id?"Edit vendor bill":"Upload vendor bill"} onClose={()=>setEdit(null)}>
      <Field label="Vendor / contractor name" value={edit.vendor} onChange={e=>setEdit({...edit,vendor:e.target.value})}/>
      <Field label="Vendor WhatsApp number (required, with country code)" value={edit.whatsapp} onChange={e=>setEdit({...edit,whatsapp:e.target.value})} placeholder="923001234567"/>
      <Field label="What is it for?" value={edit.desc} onChange={e=>setEdit({...edit,desc:e.target.value})} placeholder="e.g. Video editing — March, Freelance designer"/>
      <Select label="Category" options={["Contractor / outsourced","Vendor / supplier","Software / tools","Other"]} value={edit.category} onChange={e=>setEdit({...edit,category:e.target.value})}/>
      <div className="grid grid-cols-2 gap-3"><Field label="Amount" type="number" value={edit.amount} onChange={e=>setEdit({...edit,amount:e.target.value})}/><Select label="Currency" options={CURRENCIES} value={edit.currency} onChange={e=>setEdit({...edit,currency:e.target.value})}/></div>
      <Field label="Due date" type="date" value={edit.due} onChange={e=>setEdit({...edit,due:e.target.value})}/>
      <div><span className="text-xs text-slate-500 mb-1 block">Bill / invoice file</span>
        <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500"><Paperclip size={15}/>{edit.fileName||"Attach invoice (image or PDF)"}<input type="file" accept="image/*,.pdf" className="hidden" onChange={e=>onFile(e.target.files[0], setEdit, edit)}/></label>
        {(edit.file || edit.fileId) && <div className="mt-2">{edit.fileType==="image" ? <StoredImg d={{ fileId:edit.fileId, mime:edit.fileMime, img:edit.file }} className="h-32 rounded-lg border border-slate-200 object-cover"/> : null}<button onClick={()=>openStored({ fileId:edit.fileId, mime:edit.fileMime, file:edit.file, img:edit.fileType==="image"?edit.file:null }, edit.fileName)} className="flex items-center gap-2 text-sm text-sky-600 hover:underline mt-1"><FileText size={15}/>{edit.fileName||"Attached file"} ↗</button></div>}
        {edit.file && !(edit.fileType==="image" || edit.file.startsWith("data:image")) && <button onClick={()=>openDataUrl(edit.file, edit.fileName)} className="mt-2 text-sky-600 text-xs hover:underline flex items-center gap-1"><FileText size={13}/>Open {edit.fileName||"file"}</button>}
      </div>
      {edit._err && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{edit._err}</div>}
      <Btn onClick={()=>{ if(!edit.vendor){ setEdit({...edit,_err:"Vendor name is required."}); return; } if(!edit.whatsapp){ setEdit({...edit,_err:"Vendor WhatsApp number is required."}); return; } if(!edit.amount){ setEdit({...edit,_err:"Amount is required."}); return; } save(edit); }}><Check size={15}/>{edit.id?"Save":"Upload bill"}</Btn>
    </Modal>}

    {viewBill && <Modal title={`Bill · ${viewBill.vendor}`} onClose={()=>setViewBill(null)}>
      {(viewBill.file || viewBill.fileId) ? (<>
        {viewBill.fileType==="image" && <StoredImg d={{ fileId:viewBill.fileId, mime:viewBill.fileMime, img:viewBill.file }} className="w-full rounded-lg border border-slate-200"/>}
        <Btn variant="ghost" onClick={()=>openStored({ fileId:viewBill.fileId, mime:viewBill.fileMime, file:viewBill.file, img:viewBill.fileType==="image"?viewBill.file:null }, viewBill.fileName)}><FileText size={15}/>Open {viewBill.fileName||"bill file"}</Btn>
      </>) : <div className="text-sm text-slate-500 text-center py-6">No file attached.</div>}
      <div className="text-sm space-y-1"><div className="flex justify-between"><span className="text-slate-500">Amount</span><b>{fmt(viewBill.amount,viewBill.currency)}</b></div><div className="flex justify-between"><span className="text-slate-500">Due</span><span>{viewBill.due}</span></div></div>
    </Modal>}
  </>);
}

function Advances({ data, update }) {
  const ba = useBatch(data.advances||[]);
  const rows = data.advances, setRows=r=>update("advances",r);
  const [edit, setEdit] = useState(null);
  const blank = { employee:data.employees[0]?.name||"", total:"", installment:"", date:today() };
  const save = (a)=>{ const rec={ ...a, id:uid(), total:+a.total, installment:+a.installment, remaining:+a.total, status:"Active" }; update("advances",[rec,...rows], `Advance ${fmt(rec.total)} to ${rec.employee}`); setEdit(null); };
  return (<>
    <Head title="Advances & Loans" sub="Installments auto-deduct from payslips until cleared" action={<Btn onClick={()=>setEdit(blank)}><Plus size={15}/>New advance</Btn>}/>
    <BatchBar count={ba.count} noun="advance" onClear={ba.clear} onDelete={()=>{ const ids=new Set(ba.selected); update("advances", rows.filter(x=>!ids.has(x.id)), `Deleted ${ids.size} advance(s)`); ba.clear(); }}/>
    <Card><Table cols={[<SelBox key="a" on={ba.allOn} onChange={ba.toggleAll} title="Select all"/>,"Employee","Date","Total","Installment","Remaining","Status",""]}>{rows.length===0?<tr><td colSpan={8}><Empty msg="No advances or loans"/></td></tr>:rows.map(a=>(
      <Row key={a.id}><SelTd on={ba.has(a.id)} onChange={()=>ba.toggle(a.id)}/><Td className="font-medium">{a.employee}</Td><Td className="text-slate-500">{a.date}</Td><Td>{fmt(a.total)}</Td><Td>{fmt(a.installment)}</Td><Td className={a.remaining>0?"text-amber-600 font-medium":"text-slate-400"}>{fmt(a.remaining)}</Td><Td><Pill s={a.status}/></Td><Td><RowActions onDelete={()=>setRows(rows.filter(x=>x.id!==a.id))}/></Td></Row>))}</Table></Card>
    {edit && <Modal title="New advance / loan" onClose={()=>setEdit(null)}>
      <Select label="Employee" options={data.employees.map(e=>e.name)} value={edit.employee} onChange={e=>setEdit({...edit,employee:e.target.value})}/>
      <div className="grid grid-cols-2 gap-3"><Field label="Total amount (PKR)" type="number" value={edit.total} onChange={e=>setEdit({...edit,total:e.target.value})}/><Field label="Monthly installment (PKR)" type="number" value={edit.installment} onChange={e=>setEdit({...edit,installment:e.target.value})}/></div>
      <Field label="Date" type="date" value={edit.date} onChange={e=>setEdit({...edit,date:e.target.value})}/>
      <Btn onClick={()=>{ if(edit.employee&&edit.total&&edit.installment) save(edit); }}><Check size={15}/>Save</Btn>
    </Modal>}
  </>);
}

function Timesheets({ data }) {
  const [openEmp, setOpenEmp] = useState(null);
  const [day, setDay] = useState(""); const [client, setClient] = useState("");
  const all = data.timesheets || [];
  const names = [...new Set([...data.employees.filter(e=>e.status==="Active").map(e=>e.name), ...all.map(t=>t.employee).filter(Boolean)])];
  const byEmp = (n) => all.filter(t=>t.employee===n);
  if (openEmp) {
    const mine = byEmp(openEmp).filter(t=>(!day||t.date===day)&&(!client||t.client===client)).slice().sort((a,b)=>(b.date||"").localeCompare(a.date||""));
    const myClients = [...new Set(byEmp(openEmp).map(t=>t.client).filter(Boolean))];
    const totalH = mine.reduce((s2,t)=>s2+ (+t.hours||0),0);
    return (<>
      <button onClick={()=>{setOpenEmp(null);setDay("");setClient("");}} className="flex items-center gap-1 text-sm text-slate-500 hover:text-sky-600 mb-4"><ChevronLeft size={16}/>All team members</button>
      <Head title={openEmp} sub={`Work log · ${mine.length} entr${mine.length===1?"y":"ies"} ${day?`on ${day}`:""} ${client?`· ${client}`:""} · ${totalH}h total`}/>
      <div className="flex flex-wrap gap-3 mb-4 items-end">
        <div className="min-w-40"><Field label="Filter by date" type="date" value={day} onChange={e=>setDay(e.target.value)}/></div>
        <div className="min-w-40"><Select label="Client" options={["",...myClients]} value={client} onChange={e=>setClient(e.target.value)}/></div>
        {(day||client) && <Btn variant="ghost" onClick={()=>{setDay("");setClient("");}}><X size={14}/>Clear filters</Btn>}
      </div>
      <Card><Table cols={["Date","Client","Work done","Hours","Status"]}>{mine.length===0?<tr><td colSpan={5}><Empty msg={day?`No work logged on ${day}`:"No work logged yet"}/></td></tr>:mine.map(t=>(
        <Row key={t.id}><Td className="text-slate-500 whitespace-nowrap">{t.date}</Td><Td className="font-medium">{t.client||"—"}</Td><Td className="text-slate-600 text-sm max-w-[340px]">{t.work||"—"}</Td><Td>{t.hours?`${t.hours}h`:"—"}</Td><Td><Pill s={t.status||"Logged"}/></Td></Row>))}</Table></Card>
    </>);
  }
  const todayCount = all.filter(t=>t.date===today()).length;
  return (<>
    <Head title="Work & Timesheets" sub={`Tap a team member to see their full work log · ${todayCount} update(s) today`}/>
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{names.length===0?<Card><Empty msg="No team members yet"/></Card>:names.map(n=>{
      const mine = byEmp(n); const hrs = mine.reduce((s2,t)=>s2+(+t.hours||0),0);
      const last = mine.length ? mine.slice().sort((a,b)=>(b.date||"").localeCompare(a.date||""))[0] : null;
      const loggedToday = mine.some(t=>t.date===today());
      return (<Card key={n}><button onClick={()=>setOpenEmp(n)} className="p-5 text-left w-full hover:bg-slate-50 rounded-xl transition">
        <div className="flex items-center justify-between"><div className="font-semibold">{n}</div>{loggedToday?<span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">logged today</span>:<span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">not yet today</span>}</div>
        <div className="text-xs text-slate-500 mt-2">{mine.length} entries · {hrs}h total</div>
        <div className="text-xs text-slate-400 mt-0.5">{last?`Last: ${last.date} · ${last.client||"—"}`:"No work logged yet"}</div>
      </button></Card>);
    })}</div>
  </>);
}

function Recruit({ data, update }) {
  const rows=data.candidates, setRows=r=>update("candidates",r);
  const [edit,setEdit]=useState(null); const [viewCv,setViewCv]=useState(null);
  const stages=["Applied","Screening","Interview","Offer","Hired","Rejected"];
  const blank={name:"",role:"",email:"",phone:"",stage:"Applied",notes:"",cv:null,cvName:"",date:today()};
  const save=c=>{setRows(c.id?rows.map(r=>r.id===c.id?c:r):[{...c,id:uid()},...rows]);setEdit(null);};
  const onCv=async(f,cur)=>{ if(!f) return; const isImg=f.type.startsWith("image/"); setEdit({...cur,cvName:f.name,cvType:isImg?"image":"file",cv:isImg?await readImage(f,1100):await readFile(f)}); };
  return (<>
    <Head title="Recruitment & Onboarding" sub="Candidate pipeline · every candidate is filed in the CV Bank" action={<Btn onClick={()=>setEdit(blank)}><Plus size={15}/>Add candidate</Btn>}/>
    <div className="grid md:grid-cols-3 gap-4">{stages.filter(s=>s!=="Rejected").map(stage=>(<div key={stage}><div className="text-xs uppercase tracking-wider text-slate-500 mb-2 px-1 font-medium">{stage} · {rows.filter(r=>r.stage===stage).length}</div><div className="space-y-2">{rows.filter(r=>r.stage===stage).map(c=>(<div key={c.id} className="bg-white border border-slate-200 rounded-lg p-3 shadow-sm"><div className="flex justify-between items-start"><div><div className="font-medium text-sm">{c.name}</div><div className="text-xs text-slate-500">{c.role}</div></div><button onClick={()=>setEdit(c)} className="text-slate-400 hover:text-sky-600"><Edit3 size={13}/></button></div>{c.notes&&<div className="text-xs text-slate-500 mt-2">{c.notes}</div>}{c.cv&&<button onClick={()=>setViewCv(c)} className="text-sky-600 text-xs mt-2 flex items-center gap-1 hover:underline"><FileText size={12}/>View CV</button>}</div>))}</div></div>))}</div>
    {edit && <Modal title={edit.id?"Edit candidate":"Add candidate"} onClose={()=>setEdit(null)}>
      <Field label="Name" value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})}/>
      <Field label="Position applied for" value={edit.role} onChange={e=>setEdit({...edit,role:e.target.value})} placeholder="e.g. Content Creator, Video Editor"/>
      <div className="grid grid-cols-2 gap-3"><Field label="Email" value={edit.email} onChange={e=>setEdit({...edit,email:e.target.value})}/><Field label="Phone" value={edit.phone} onChange={e=>setEdit({...edit,phone:e.target.value})}/></div>
      <Select label="Stage" options={stages} value={edit.stage} onChange={e=>setEdit({...edit,stage:e.target.value})}/>
      <Field label="Notes" value={edit.notes} onChange={e=>setEdit({...edit,notes:e.target.value})}/>
      <div><span className="text-xs text-slate-500 mb-1 block">CV / resume</span>
        <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500"><Paperclip size={15}/>{edit.cvName||"Attach CV (PDF or image)"}<input type="file" accept="image/*,.pdf,.doc,.docx" className="hidden" onChange={e=>onCv(e.target.files[0],edit)}/></label>
        {edit.cv && (edit.cvType==="image"||edit.cv.startsWith("data:image")) && <img src={edit.cv} className="mt-2 h-32 rounded-lg border border-slate-200 object-cover"/>}
        {edit.cv && !(edit.cvType==="image"||edit.cv.startsWith("data:image")) && <button onClick={()=>openDataUrl(edit.cv, edit.cvName)} className="mt-2 text-sky-600 text-xs hover:underline flex items-center gap-1"><FileText size={13}/>Open {edit.cvName||"CV"}</button>}
      </div>
      <div className="flex gap-2"><Btn onClick={()=>save(edit)}><Check size={15}/>Save</Btn>{edit.id&&<Btn variant="danger" onClick={()=>{ if(window.confirm(`Delete candidate "${edit.name}"? This cannot be undone.`)){ setRows(rows.filter(r=>r.id!==edit.id)); setEdit(null); } }}><Trash2 size={15}/>Remove</Btn>}</div>
    </Modal>}
    {viewCv && <CvModal c={viewCv} onClose={()=>setViewCv(null)}/>}
  </>);
}
function CvModal({ c, onClose }) {
  return (<Modal title={`CV · ${c.name}`} onClose={onClose}>
    {c.cv && (c.cvType==="image"||(c.cv||"").startsWith("data:image")) ? <img src={c.cv} className="w-full rounded-lg border border-slate-200"/> : c.cv ? <Btn variant="ghost" onClick={()=>openDataUrl(c.cv,c.cvName)}><FileText size={15}/>Open {c.cvName||"CV"}</Btn> : <div className="text-sm text-slate-500 text-center py-6">No CV attached.</div>}
    <div className="text-sm space-y-1"><div className="flex justify-between"><span className="text-slate-500">Position</span><b>{c.role||"—"}</b></div><div className="flex justify-between"><span className="text-slate-500">Email</span><span>{c.email||"—"}</span></div><div className="flex justify-between"><span className="text-slate-500">Phone</span><span>{c.phone||"—"}</span></div></div>
  </Modal>);
}

function CVBank({ data, update }) {
  const rows = data.candidates;
  const [pos, setPos] = useState(""); const [q, setQ] = useState("");
  const [viewCv, setViewCv] = useState(null); const [add, setAdd] = useState(null);
  const positions = [...new Set(rows.map(c=>c.role).filter(Boolean))].sort();
  const filtered = rows.filter(c=>(!pos || c.role===pos) && (!q || c.name.toLowerCase().includes(q.toLowerCase())));
  const onCv = async (f,cur)=>{ if(!f) return; const isImg=f.type.startsWith("image/"); setAdd({...cur,cvName:f.name,cvType:isImg?"image":"file",cv:isImg?await readImage(f,1100):await readFile(f)}); };
  const save = (c)=>{ if(!c.name) return; update("candidates", [{ ...c, id:uid(), stage:c.stage||"Applied", date:today() }, ...rows], `Added CV to bank: ${c.name} (${c.role||"unspecified"})`); setAdd(null); };
  return (<>
    <Head title="CV Bank" sub="Every CV ever received — filter by position to shortlist for a role" action={<Btn onClick={()=>setAdd({ name:"",role:"",email:"",phone:"",notes:"",cv:null,cvName:"" })}><Plus size={15}/>Add CV</Btn>}/>
    <div className="flex flex-wrap gap-3 mb-4">
      <div className="max-w-xs flex-1 min-w-44"><Select label="Filter by position" options={["",...positions]} value={pos} onChange={e=>setPos(e.target.value)}/></div>
      <div className="max-w-xs flex-1 min-w-44"><span className="text-xs text-slate-500 mb-1 block">Search name</span><div className="relative"><Search size={15} className="absolute left-3 top-2.5 text-slate-400"/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search candidate" className={inputCls+" pl-9"}/></div></div>
    </div>
    {positions.length>0 && <div className="flex flex-wrap gap-2 mb-4"><button onClick={()=>setPos("")} className={`px-3 py-1 rounded-full text-xs font-medium ${!pos?"bg-sky-600 text-white":"bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>All ({rows.length})</button>{positions.map(p=>(<button key={p} onClick={()=>setPos(p)} className={`px-3 py-1 rounded-full text-xs font-medium ${pos===p?"bg-sky-600 text-white":"bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>{p} ({rows.filter(c=>c.role===p).length})</button>))}</div>}
    <Card><Table cols={["Candidate","Position","Contact","Stage","CV",""]}>
      {filtered.length===0?<tr><td colSpan={6}><Empty msg={rows.length===0?"No CVs yet — add candidates in Recruitment or here":"No matches for this filter"}/></td></tr>:filtered.map(c=>(
        <Row key={c.id}>
          <Td className="font-medium">{c.name}</Td>
          <Td className="text-slate-500">{c.role||"—"}</Td>
          <Td className="text-slate-500 text-xs">{c.email||"—"}{c.phone?<div>{c.phone}</div>:null}</Td>
          <Td><Pill s={c.stage||"Applied"}/></Td>
          <Td>{c.cv?<button onClick={()=>setViewCv(c)} className="text-sky-600 text-xs font-medium hover:underline flex items-center gap-1"><FileText size={13}/>View</button>:<span className="text-slate-400 text-xs">none</span>}</Td>
          <Td><RowActions onDelete={()=>update("candidates", rows.filter(x=>x.id!==c.id))}/></Td>
        </Row>))}
    </Table></Card>
    {viewCv && <CvModal c={viewCv} onClose={()=>setViewCv(null)}/>}
    {add && <Modal title="Add CV to bank" onClose={()=>setAdd(null)}>
      <Field label="Name" value={add.name} onChange={e=>setAdd({...add,name:e.target.value})}/>
      <Field label="Position applied for" value={add.role} onChange={e=>setAdd({...add,role:e.target.value})} placeholder="e.g. Content Creator"/>
      <div className="grid grid-cols-2 gap-3"><Field label="Email" value={add.email} onChange={e=>setAdd({...add,email:e.target.value})}/><Field label="Phone" value={add.phone} onChange={e=>setAdd({...add,phone:e.target.value})}/></div>
      <div><span className="text-xs text-slate-500 mb-1 block">CV / resume</span>
        <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500"><Paperclip size={15}/>{add.cvName||"Attach CV (PDF or image)"}<input type="file" accept="image/*,.pdf,.doc,.docx" className="hidden" onChange={e=>onCv(e.target.files[0],add)}/></label>
        {add.cv && (add.cvType==="image"||add.cv.startsWith("data:image")) && <img src={add.cv} className="mt-2 h-32 rounded-lg border border-slate-200 object-cover"/>}
        {add.cv && !(add.cvType==="image"||add.cv.startsWith("data:image")) && <button onClick={()=>openDataUrl(add.cv, add.cvName)} className="mt-2 text-sky-600 text-xs hover:underline flex items-center gap-1"><FileText size={13}/>Open {add.cvName||"CV"}</button>}
      </div>
      <p className="text-xs text-slate-400">Added here, this person also appears in the Recruitment pipeline at the "Applied" stage.</p>
      <Btn onClick={()=>save(add)}><Check size={15}/>Save to bank</Btn>
    </Modal>}
  </>);
}

function Offers({ data, update, brand }) {
  const rows = data.offers, setRows = r=>update("offers",r);
  const [f, setF] = useState({ name:"",email:"",phone:"",cnic:"",role:"",salary:"",start:today(),hasSpecial:false,special:"" });
  const [signed, setSigned] = useState({});
  const body = `Date: ${new Date().toLocaleDateString()}\n\nDear ${f.name||"[Name]"},\n\nWe are pleased to offer you the position of ${f.role||"[Role]"} at ${brand.company}. Below are the key details of your offer:\n\n• Position: ${f.role||"[Role]"}\n• Start date: ${f.start}\n• Monthly compensation: ${f.salary?fmt(f.salary):"[Amount]"}\n• Email on record: ${f.email||"[Email]"}\n• Contact: ${f.phone||"[Phone]"}\n• CNIC: ${f.cnic||"[CNIC]"}\n${f.hasSpecial&&f.special?`\nSpecial terms:\n${f.special}\n`:""}\nThis offer is contingent on standard verification of your documents. We look forward to welcoming you to the team.\n\nKindly sign and return a copy to confirm your acceptance.`;
  const save = ()=>{ setRows([{ id:uid(), docType:"Offer Letter", name:f.name, email:f.email, role:f.role, date:today(), body, signed },...rows]); };
  return (<>
    <Head title="Offer Letters" sub="Fill the basics — the letter writes itself"/>
    <div className="grid lg:grid-cols-2 gap-5">
      <Card><div className="p-5 space-y-3">
        <Field label="Candidate name" value={f.name} onChange={e=>setF({...f,name:e.target.value})}/>
        <div className="grid grid-cols-2 gap-3"><Field label="Email" value={f.email} onChange={e=>setF({...f,email:e.target.value})}/><Field label="Phone number" value={f.phone} onChange={e=>setF({...f,phone:e.target.value})}/></div>
        <Field label="CNIC number" value={f.cnic} onChange={e=>setF({...f,cnic:e.target.value})} placeholder="00000-0000000-0"/>
        <div className="grid grid-cols-2 gap-3"><Field label="Role" value={f.role} onChange={e=>setF({...f,role:e.target.value})}/><Field label="Monthly salary (PKR)" type="number" value={f.salary} onChange={e=>setF({...f,salary:e.target.value})}/></div>
        <Field label="Start date" type="date" value={f.start} onChange={e=>setF({...f,start:e.target.value})}/>
        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer"><input type="checkbox" checked={f.hasSpecial} onChange={e=>setF({...f,hasSpecial:e.target.checked})} className="accent-sky-600"/> Any special requirement?</label>
        {f.hasSpecial && <Area label="Special terms" value={f.special} onChange={e=>setF({...f,special:e.target.value})} placeholder="e.g. probation, remote days, signing bonus"/>}
        <div className="flex gap-2 pt-1"><Btn onClick={save}><Check size={15}/>Save offer</Btn><Btn variant="ghost" onClick={()=>window.print()}><Download size={15}/>Print</Btn></div>
      </div></Card>
      <Card><div className="p-4"><DocSheet brand={brand} body={body} signed={signed} setSigned={setSigned}/></div></Card>
    </div>
    {rows.length>0 && <div className="mt-6"><div className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium">Saved offers</div><Card><Table cols={["Candidate","Role","Date",""]}>{rows.map(o=>(<Row key={o.id}><Td className="font-medium">{o.name}</Td><Td className="text-slate-500">{o.role}</Td><Td className="text-slate-500">{o.date}</Td><Td><RowActions onDelete={()=>setRows(rows.filter(r=>r.id!==o.id))}/></Td></Row>))}</Table></Card></div>}
  </>);
}

const TEMPLATES = {
  "Experience Certificate": (b,n,r,x)=>`To Whom It May Concern,\n\nThis is to certify that ${n||"[Name]"} was employed at ${b.company} as ${r||"[Role]"}${x?` (${x})`:""}. During this tenure, their conduct and performance were found to be satisfactory.\n\nWe wish them success in their future endeavours.`,
  "Appointment Letter": (b,n,r,x)=>`Dear ${n||"[Name]"},\n\nThis letter confirms your appointment as ${r||"[Role]"} at ${b.company}, effective ${x||"[Date]"}. You will be subject to the terms and policies of the company.\n\nWelcome aboard.`,
  "Salary Certificate": (b,n,r,x)=>`To Whom It May Concern,\n\nThis is to certify that ${n||"[Name]"} is currently employed at ${b.company} as ${r||"[Role]"}, drawing a monthly salary of ${x||"[Amount]"}. This certificate is issued upon request for official purposes.`,
  "Custom Letter": (b,n,r,x)=>x||"Type your letter content here…",
};
function Letters({ data, update, brand }) {
  const rows=data.letters, setRows=r=>update("letters",r);
  const [type,setType]=useState("Experience Certificate");
  const [name,setName]=useState(""); const [roleF,setRoleF]=useState(""); const [extra,setExtra]=useState("");
  const [signed,setSigned]=useState({});
  const body=TEMPLATES[type](brand,name,roleF,extra);
  const save=()=>setRows([{id:uid(),docType:type,type,name,date:today(),body,signed},...rows]);
  return (<>
    <Head title="Letters & Certificates" sub="Generate, sign, stamp and save"/>
    <div className="grid lg:grid-cols-2 gap-5">
      <Card><div className="p-5 space-y-3">
        <Select label="Document type" options={Object.keys(TEMPLATES)} value={type} onChange={e=>setType(e.target.value)}/>
        <label className="block"><span className="text-xs text-slate-500 mb-1 block">Recipient</span><input list="emps" value={name} onChange={e=>setName(e.target.value)} placeholder="Name" className={inputCls}/><datalist id="emps">{data.employees.map(e=><option key={e.id} value={e.name}/>)}</datalist></label>
        {type!=="Custom Letter" && <Field label="Role" value={roleF} onChange={e=>setRoleF(e.target.value)}/>}
        {type==="Custom Letter" ? <Area label="Letter body" value={extra} onChange={e=>setExtra(e.target.value)}/> : <Field label="Amount / Date / Detail" value={extra} onChange={e=>setExtra(e.target.value)} placeholder="e.g. PKR 120,000 or Jan 2024 – Jun 2026"/>}
        <div className="flex gap-2"><Btn onClick={save}><Check size={15}/>Save document</Btn><Btn variant="ghost" onClick={()=>window.print()}><Download size={15}/>Print</Btn></div>
      </div></Card>
      <Card><div className="p-4"><DocSheet brand={brand} body={body} signed={signed} setSigned={setSigned}/></div></Card>
    </div>
    {rows.length>0 && <div className="mt-6"><div className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium">Saved documents</div><Card><Table cols={["Type","Recipient","Date",""]}>{rows.map(d=>(<Row key={d.id}><Td className="font-medium">{d.type}</Td><Td className="text-slate-500">{d.name||"—"}</Td><Td className="text-slate-500">{d.date}</Td><Td><RowActions onDelete={()=>setRows(rows.filter(r=>r.id!==d.id))}/></Td></Row>))}</Table></Card></div>}
  </>);
}

function Proposals({ data, update, patch, brand }) {
  const rows=data.proposals, setRows=r=>update("proposals",r);
  const [f,setF]=useState({ client:"",title:"",overview:"",scope:"",timeline:"",investment:"" });
  const [signed,setSigned]=useState({});
  const [aiText,setAiText]=useState(""); const [busy,setBusy]=useState(false); const [msg,setMsg]=useState("");
  const [tplOpen,setTplOpen]=useState(false); const [tpl,setTpl]=useState(data.aiTemplates?.proposal||"");
  const body = aiText || `PROJECT PROPOSAL\nPrepared for: ${f.client||"[Client]"}\nDate: ${new Date().toLocaleDateString()}\n\n${f.title||"[Proposal title]"}\n\n1. Overview\n${f.overview||"…"}\n\n2. Scope of work\n${f.scope||"…"}\n\n3. Timeline\n${f.timeline||"…"}\n\n4. Investment\n${f.investment||"…"}\n\nWe appreciate the opportunity to work with ${f.client||"you"} and are confident in delivering exceptional results.`;
  const draft=async()=>{ setBusy(true); setMsg(""); try{ const r=await aiDraft("proposal",f,data.aiTemplates?.proposal||""); setAiText(r.text||""); }catch(e){ setMsg(e.message); } setBusy(false); };
  const save=()=>{ setRows([{id:uid(),docType:"Proposal",client:f.client,title:f.title,date:today(),body,signed},...rows]); setMsg("Proposal saved below."); setAiText(""); setF({ client:"",title:"",overview:"",scope:"",timeline:"",investment:"" }); };
  const saveTpl=()=>{ patch({ aiTemplates: { ...(data.aiTemplates||{}), proposal: tpl } }, "Saved proposal AI template"); setTplOpen(false); };
  return (<>
    <Head title="Proposals" sub="Build, AI-draft, sign and save a client proposal" action={<Btn variant="ghost" onClick={()=>setTplOpen(true)}><FileText size={15}/>AI template</Btn>}/>
    <div className="grid lg:grid-cols-2 gap-5">
      <Card><div className="p-5 space-y-3">
        <div className="grid grid-cols-2 gap-3"><ClientInput clients={data.clients} value={f.client} onChange={e=>setF({...f,client:e.target.value})}/><Field label="Title" value={f.title} onChange={e=>setF({...f,title:e.target.value})}/></div>
        <Area label="Overview" value={f.overview} onChange={e=>setF({...f,overview:e.target.value})}/>
        <Area label="Scope of work" value={f.scope} onChange={e=>setF({...f,scope:e.target.value})}/>
        <Area label="Timeline" value={f.timeline} onChange={e=>setF({...f,timeline:e.target.value})}/>
        <Area label="Investment" value={f.investment} onChange={e=>setF({...f,investment:e.target.value})}/>
        <div className="flex flex-wrap gap-2">
          <Btn variant="ok" onClick={draft}>{busy?<Loader2 size={15} className="animate-spin"/>:<PenTool size={15}/>}Draft with AI</Btn>
          <Btn onClick={save}><Check size={15}/>Save proposal</Btn>
          <Btn variant="ghost" onClick={()=>window.print()}><Download size={15}/>Print</Btn>
        </div>
        {aiText && <button onClick={()=>setAiText("")} className="text-xs text-slate-400 hover:underline">Clear AI draft (use template layout)</button>}
        {msg && <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{msg}</div>}
      </div></Card>
      <Card><div className="p-4"><DocSheet brand={brand} body={body} signed={signed} setSigned={setSigned}/></div></Card>
    </div>
    {rows.length>0 && <div className="mt-6"><div className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium">Saved proposals</div><Card><Table cols={["Client","Title","Date",""]}>{rows.map(p=>(<Row key={p.id}><Td className="font-medium">{p.client}</Td><Td className="text-slate-500">{p.title}</Td><Td className="text-slate-500">{p.date}</Td><Td><RowActions onDelete={()=>setRows(rows.filter(r=>r.id!==p.id))}/></Td></Row>))}</Table></Card></div>}
    {tplOpen && <Modal title="Saved AI template" onClose={()=>setTplOpen(false)}>
      <p className="text-xs text-slate-500">Save a reusable style/structure. The AI uses it as a guide each time you click "Draft with AI".</p>
      <Area label="Template / style guide" value={tpl} onChange={e=>setTpl(e.target.value)} placeholder="e.g. Always open with a warm greeting, use three sections (Approach, Deliverables, Investment), keep tone confident and concise, sign off as the Svype team."/>
      <Btn onClick={saveTpl}><Check size={15}/>Save template</Btn>
    </Modal>}
  </>);
}

function Quotations({ data, update, brand }) {
  const rows=data.quotations, setRows=r=>update("quotations",r);
  const [client,setClient]=useState(""); const [currency,setCurrency]=useState("PKR"); const [validity,setValidity]=useState("Valid for 15 days");
  const [items,setItems]=useState([{id:uid(),desc:"",qty:1,rate:""}]);
  const [signed,setSigned]=useState({});
  const total=items.reduce((s,i)=>s+(+i.qty)*(+i.rate||0),0);
  const num="QTN-"+(1000+rows.length+1);
  const body=`QUOTATION  ·  ${num}\nFor: ${client||"[Client]"}\nDate: ${new Date().toLocaleDateString()}\n\n${items.map((i,n)=>`${n+1}. ${i.desc||"Item"} — ${i.qty} × ${fmt(i.rate,currency)} = ${fmt((+i.qty)*(+i.rate||0),currency)}`).join("\n")}\n\nTotal: ${fmt(total,currency)}\n${validity}`;
  const setItem=(id,k,v)=>setItems(items.map(i=>i.id===id?{...i,[k]:v}:i));
  const onClient=(e)=>{ const v=e.target.value; setClient(v); const c=data.clients.find(x=>x.name===v); if(c) setCurrency(c.currency||"PKR"); };
  const save=()=>setRows([{id:uid(),docType:"Quotation",number:num,client,currency,amount:total,date:today(),body,signed},...rows]);
  return (<>
    <Head title="Quotations" sub="Itemised, totalled, signed and stamped"/>
    <div className="grid lg:grid-cols-2 gap-5">
      <Card><div className="p-5 space-y-3">
        <div className="grid grid-cols-2 gap-3"><ClientInput clients={data.clients} value={client} onChange={onClient}/><Select label="Currency" options={CURRENCIES} value={currency} onChange={e=>setCurrency(e.target.value)}/></div>
        <div><span className="text-xs text-slate-500 mb-1 block">Line items</span>
          <div className="space-y-2">{items.map(i=>(<div key={i.id} className="flex gap-2 items-center">
            <input value={i.desc} onChange={e=>setItem(i.id,"desc",e.target.value)} placeholder="Description" className={inputCls+" flex-1"}/>
            <input value={i.qty} onChange={e=>setItem(i.id,"qty",e.target.value)} type="number" className={inputCls+" w-14"}/>
            <input value={i.rate} onChange={e=>setItem(i.id,"rate",e.target.value)} type="number" placeholder="Rate" className={inputCls+" w-24"}/>
            <button onClick={()=>setItems(items.filter(x=>x.id!==i.id))} className="text-slate-400 hover:text-rose-500"><X size={15}/></button></div>))}</div>
          <button onClick={()=>setItems([...items,{id:uid(),desc:"",qty:1,rate:""}])} className="text-sky-600 text-xs mt-2 font-medium hover:underline">+ Add line</button>
        </div>
        <Field label="Validity note" value={validity} onChange={e=>setValidity(e.target.value)}/>
        <div className="text-right font-bold">Total: {fmt(total,currency)}</div>
        <div className="flex gap-2"><Btn onClick={save}><Check size={15}/>Save quotation</Btn><Btn variant="ghost" onClick={()=>window.print()}><Download size={15}/>Print</Btn></div>
      </div></Card>
      <Card><div className="p-4"><DocSheet brand={brand} body={body} signed={signed} setSigned={setSigned}/></div></Card>
    </div>
    {rows.length>0 && <div className="mt-6"><div className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium">Saved quotations</div><Card><Table cols={["Number","Client","Amount","Date",""]}>{rows.map(q=>(<Row key={q.id}><Td className="font-medium">{q.number}</Td><Td className="text-slate-500">{q.client}</Td><Td>{fmt(q.amount,q.currency)}</Td><Td className="text-slate-500">{q.date}</Td><Td><RowActions onDelete={()=>setRows(rows.filter(r=>r.id!==q.id))}/></Td></Row>))}</Table></Card></div>}
  </>);
}

function retainerInvoiceHTML(inv, brand) {
  const money = (n) => `${inv.currency || "PKR"} ${Number(n||0).toLocaleString()}`;
  const logo = brand.logo ? `<img src="${brand.logo}" style="height:54px;object-fit:contain"/>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${inv.number}</title>
  <style>
    *{font-family:Arial,Helvetica,sans-serif;color:#0f172a;box-sizing:border-box}
    body{margin:0;padding:40px}
    .hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ${brand.accent||"#0284c7"};padding-bottom:16px;margin-bottom:24px}
    .co{font-size:20px;font-weight:bold}.tag{color:#64748b;font-size:12px}
    .meta{text-align:right;font-size:12px;color:#475569}
    h1{font-size:26px;letter-spacing:1px;margin:0 0 4px}
    table{width:100%;border-collapse:collapse;margin-top:20px}
    th,td{text-align:left;padding:10px;border-bottom:1px solid #e2e8f0;font-size:14px}
    th{background:#f8fafc;color:#475569;text-transform:uppercase;font-size:11px}
    .tot{text-align:right;font-size:18px;font-weight:bold;margin-top:18px}
    .foot{margin-top:40px;color:#64748b;font-size:12px}
    .pill{display:inline-block;padding:3px 10px;border-radius:6px;font-size:12px;background:#fef3c7;color:#b45309}
  </style></head><body>
  <div class="hd"><div style="display:flex;gap:12px;align-items:center">${logo}<div><div class="co">${brand.company||""}</div><div class="tag">${brand.tagline||""}</div></div></div>
  <div class="meta">${(brand.offices||[]).map(o=>`${o.city}: ${o.address}`).join("<br>")||brand.address||""}<br>${[brand.phone,brand.email,brand.website].filter(Boolean).join(" &middot; ")||brand.contact||""}</div></div>
  <h1>INVOICE</h1>
  <div style="display:flex;justify-content:space-between;font-size:13px;color:#475569;margin-top:8px">
    <div><b>Billed to:</b><br>${inv.client||""}</div>
    <div style="text-align:right">
      <b>Invoice #:</b> ${inv.number}<br>
      <b>Billing month:</b> ${inv.month||"—"}<br>
      <b>Issued:</b> ${inv.date||today()}<br>
      <b>Due:</b> ${inv.due||"—"}
    </div>
  </div>
  <table><thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
  <tbody>
    <tr><td>Monthly retainer — ${inv.month||""}</td><td style="text-align:right">${money(inv.base)}</td></tr>
    ${+inv.carry ? `<tr><td>Brought forward (previous balance)</td><td style="text-align:right">${money(inv.carry)}</td></tr>` : ""}
  </tbody></table>
  <div class="tot">Total due: ${money(inv.total)}</div>
  <div class="foot">Status: <span class="pill">${inv.status}</span><br><br>Kindly transfer the amount due and share the receipt. Thank you for your business.</div>
  <script>window.onload=()=>{setTimeout(()=>window.print(),300)}</script>
  </body></html>`;
}
function openInvoicePDF(inv, brand) {
  const w = window.open("", "_blank");
  if (!w) { alert("Allow pop-ups to download the invoice PDF."); return; }
  w.document.write(retainerInvoiceHTML(inv, brand));
  w.document.close();
}

// ===== Vault crypto (AES-GCM with PBKDF2-derived key from a master password) =====
const _enc = new TextEncoder(), _dec = new TextDecoder();
const _b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const _unb64 = (s) => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
async function deriveKey(masterPw, saltB64) {
  const salt = _unb64(saltB64);
  const baseKey = await crypto.subtle.importKey("raw", _enc.encode(masterPw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name:"PBKDF2", salt, iterations:150000, hash:"SHA-256" },
    baseKey, { name:"AES-GCM", length:256 }, false, ["encrypt","decrypt"]
  );
}
async function vaultEncrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name:"AES-GCM", iv }, key, _enc.encode(plaintext));
  return { iv:_b64(iv), ct:_b64(ct) };
}
async function vaultDecrypt(key, ivB64, ctB64) {
  const pt = await crypto.subtle.decrypt({ name:"AES-GCM", iv:_unb64(ivB64) }, key, _unb64(ctB64));
  return _dec.decode(pt);
}
function randSaltB64(){ return _b64(crypto.getRandomValues(new Uint8Array(16))); }

// Build a payment receipt record from a paid invoice.
function makeReceipt({ client, amount, currency, forText, account, source, sourceNumber }) {
  return {
    id: uid(),
    number: `RCPT-${Date.now().toString().slice(-6)}`,
    client, amount: +amount || 0, currency: currency || "PKR",
    for: forText || "", account: account || "", source: source || "", sourceNumber: sourceNumber || "",
    date: today(),
  };
}
function receiptHTML(r, brand) {
  const money = (n) => `${r.currency || "PKR"} ${Number(n||0).toLocaleString()}`;
  const logo = brand.logo ? `<img src="${brand.logo}" style="height:54px;object-fit:contain"/>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${r.number}</title>
  <style>
    *{font-family:Arial,Helvetica,sans-serif;color:#0f172a;box-sizing:border-box}
    body{margin:0;padding:40px}
    .hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid ${brand.accent||"#0284c7"};padding-bottom:16px;margin-bottom:24px}
    .co{font-size:20px;font-weight:bold}.tag{color:#64748b;font-size:12px}
    .meta{text-align:right;font-size:12px;color:#475569}
    h1{font-size:26px;letter-spacing:1px;margin:0 0 4px;color:#16a34a}
    table{width:100%;border-collapse:collapse;margin-top:20px}
    th,td{text-align:left;padding:10px;border-bottom:1px solid #e2e8f0;font-size:14px}
    th{background:#f8fafc;color:#475569;text-transform:uppercase;font-size:11px}
    .tot{text-align:right;font-size:18px;font-weight:bold;margin-top:18px}
    .stamp{display:inline-block;border:3px solid #16a34a;color:#16a34a;font-weight:bold;letter-spacing:2px;padding:6px 16px;border-radius:8px;transform:rotate(-8deg);font-size:18px;margin-top:24px}
    .foot{margin-top:30px;color:#64748b;font-size:12px}
  </style></head><body>
  <div class="hd"><div style="display:flex;gap:12px;align-items:center">${logo}<div><div class="co">${brand.company||""}</div><div class="tag">${brand.tagline||""}</div></div></div>
  <div class="meta">${(brand.offices||[]).map(o=>`${o.city}: ${o.address}`).join("<br>")||brand.address||""}<br>${[brand.phone,brand.email,brand.website].filter(Boolean).join(" &middot; ")||brand.contact||""}</div></div>
  <h1>PAYMENT RECEIPT</h1>
  <div style="display:flex;justify-content:space-between;font-size:13px;color:#475569;margin-top:8px">
    <div><b>Received from:</b><br>${r.client||""}</div>
    <div style="text-align:right">
      <b>Receipt #:</b> ${r.number}<br>
      <b>Date:</b> ${r.date||today()}<br>
      ${r.sourceNumber?`<b>Against invoice:</b> ${r.sourceNumber}<br>`:""}
      ${r.account?`<b>Received in:</b> ${r.account}`:""}
    </div>
  </div>
  <table><thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
  <tbody><tr><td>${r.for||"Payment received"}</td><td style="text-align:right">${money(r.amount)}</td></tr></tbody></table>
  <div class="tot">Total received: ${money(r.amount)}</div>
  <div class="stamp">PAID</div>
  <div class="foot">This is a computer-generated receipt confirming the amount above has been received with thanks.</div>
  <script>window.onload=()=>{setTimeout(()=>window.print(),300)}</script>
  </body></html>`;
}
function openReceiptPDF(r, brand) {
  const w = window.open("", "_blank");
  if (!w) { alert("Allow pop-ups to download the receipt PDF."); return; }
  w.document.write(receiptHTML(r, brand));
  w.document.close();
}

function Retainers({ data, update, patch, brand, go }) {
  const rets = data.retainers, invs = data.retainerInvoices, clients = data.clients;
  const accounts = (data.bankAccounts||[]).map(a=>({ id:a.id, name:a.label }));
  const [view, setView] = useState("invoices");
  const bc = useBatch(data.retainers);
  const bi = useBatch(data.retainerInvoices);
  const [edit, setEdit] = useState(null); const [pay, setPay] = useState(null); const [manual, setManual] = useState(null); const [extend, setExtend] = useState(null);
  const saveExtend = () => { patch({ retainerInvoices: invs.map(i=>i.id===extend.id?{...i, due: extend.due, dueExtended:true}:i) }, `Extended due date for ${extend.client} (${extend.number})`); setExtend(null); };
  const clearUnpaid = () => {
    const unpaid = invs.filter(i=>i.status!=="Paid" && i.status!=="Partial");
    const openRecv = (data.receivables||[]).filter(r=>r.status!=="Paid");
    if (!unpaid.length && !openRecv.length) { alert("Nothing to clear — no unpaid invoices and no open receivables."); return; }
    if (!confirm(`This will delete:\n\n• ${unpaid.length} unpaid retainer invoice(s)\n• ${openRecv.length} open receivable entr(ies)\n\nPaid and partially-paid records are kept (they are your record of money received). Nothing regenerates on its own — you can re-create them any time with Generate now. Continue?`)) return;
    const keepIds = new Set(invs.filter(i=>i.status==="Paid"||i.status==="Partial").map(i=>i.id));
    const keepRecvIds = new Set(openRecv.map(r=>r.id));
    patch({
      retainerInvoices: invs.filter(i=>keepIds.has(i.id)),
      receivables: (data.receivables||[]).filter(r=>!keepRecvIds.has(r.id)),
    }, `Cleared ${unpaid.length} unpaid invoices and ${openRecv.length} open receivables`);
  };
  const blank = { client:"", whatsapp:"", amount:"", currency:"PKR", billing:"Prepaid", billingDay:1, status:"Active", carry:0 };
  const onClient=(v)=>{ const c=clients.find(x=>x.name===v); setEdit(e=>({...e,client:v,...(c?{currency:c.currency||"PKR",whatsapp:c.whatsapp||e.whatsapp}:{})})); };
  const saveClient = (c) => {
    const existsInCrm = clients.some(x=>x.name.toLowerCase()===(c.client||"").toLowerCase());
    const extra = (!existsInCrm && c.client) ? { clients:[...clients, { id:uid(), name:c.client, email:"", whatsapp:c.whatsapp||"", currency:c.currency||"PKR", notes:"Added via Retainers" }] } : {};
    const newRets = c.id?rets.map(r=>r.id===c.id?c:r):[...rets,{...c,id:uid(),carry:+c.carry||0}];
    patch({ retainers:newRets, ...extra }, c.id?`Updated retainer ${c.client}`:`Added retainer client ${c.client}`); setEdit(null);
  };
  const [billAsk, setBillAsk] = useState(null); // { [retainerId]: "Prepaid"|"Postpaid" }
  const runGeneration = (db) => {
    const after = generateRetainerInvoices(db, true); // only ever runs when you click
    if (after !== db) patch({ retainerInvoices: after.retainerInvoices, retainers: after.retainers }, `Generated retainer invoices`);
    else alert("Nothing new to generate — every active client already has an invoice for their billing period.\n\nPrepaid clients are billed for the upcoming month, postpaid clients for the month just finished.");
  };
  const [genAsk, setGenAsk] = useState(null);
  const openGenPreview = (db) => {
    const pre = nextMonthInfo(), post = currentMonthInfo();
    const items = (db.retainers||[]).filter(r=>r.status==="Active").map(r=>{
      const cyc = r.billing==="Postpaid" ? post : pre;
      const exists = (db.retainerInvoices||[]).some(i=>i.retainerId===r.id && i.monthKey===cyc.key);
      return { id:r.id, client:r.client, amount:r.amount, currency:r.currency, billing:r.billing==="Postpaid"?"Postpaid":"Prepaid", period:cyc.label, exists };
    });
    setGenAsk({ db, items });
  };
  const genDue = () => {
    const missing = rets.filter(r=>r.status==="Active" && r.billing!=="Prepaid" && r.billing!=="Postpaid");
    if (missing.length) { setBillAsk(Object.fromEntries(missing.map(r=>[r.id, ""]))); return; }
    openGenPreview(data);
  };
  const saveBillingAndGenerate = () => {
    if (Object.values(billAsk).some(v=>!v)) { alert("Choose Prepaid or Postpaid for every client — this is saved once and remembered."); return; }
    const newRets = rets.map(r=>billAsk[r.id] ? { ...r, billing: billAsk[r.id] } : r);
    setBillAsk(null);
    openGenPreview({ ...data, retainers: newRets });
  };
  // manual invoice
  const newManual = () => setManual({ client:"", retainerId:"", month: monthLabel(), base:"", carry:0, currency:"PKR", date: today(), due:"", sendOn:"" });
  const onManualClient = (v) => { const r = rets.find(x=>x.client===v); const c = clients.find(x=>x.name===v); setManual(m=>({ ...m, client:v, retainerId:r?.id||"", base: r? r.amount : m.base, carry: r? (+r.carry||0) : 0, currency: (r?.currency||c?.currency||m.currency) })); };
  const saveManual = () => {
    const m = manual; if (!m.client || !m.base) return;
    const base = +m.base||0, carry = +m.carry||0;
    const mk = (m.month||"").toLowerCase().replace(/\s+/g,"-");
    const inv = { id:uid(), retainerId:m.retainerId||null, client:m.client, number:`RET-${Date.now().toString().slice(-6)}`, monthKey:mk, month:m.month, base, carry, total:base+carry, currency:m.currency||"PKR", status:"Unpaid", paidAmount:0, account:"", date:m.date||today(), due:m.due||"", sendOn:m.sendOn||"", paidDate:"" };
    patch({ retainerInvoices:[...invs, inv] }, `Created invoice for ${m.client} (${m.month})`); setManual(null);
  };
  const sendWA = (inv) => { const r = rets.find(x=>x.id===inv.retainerId); const num = (r?.whatsapp||"").replace(/\D/g,""); const msg = `*${brand.company}*\n\nInvoice: ${inv.number}\nPeriod: ${inv.month}\nAmount due: ${fmt(inv.total,inv.currency)}` + (inv.due?`\nDue: ${inv.due}`:``) + (inv.carry?`\n(Includes ${fmt(inv.carry,inv.currency)} carried forward)`:``) + `\n\nKindly confirm once transferred. Thank you.`; window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, "_blank"); };
  const confirmPay = ({ received, accountName, carryChoice, overChoice }) => {
    const recv = +received||0; const shortfall = Math.max(0, pay.total - recv); const overpay = Math.max(0, recv - pay.total);
    const status = shortfall<=0 ? "Paid" : (recv>0 ? "Partial" : "Unpaid");
    const newInvs = invs.map(i=>i.id===pay.id ? { ...i, status, paidAmount:recv, account:accountName, paidDate:today() } : i);
    let newRets = rets;
    if (shortfall>0 && carryChoice==="next") newRets = rets.map(r=>r.id===pay.retainerId ? { ...r, carry:(+r.carry||0)+shortfall } : r);
    if (overpay>0 && overChoice==="credit") newRets = newRets.map(r=>r.id===pay.retainerId ? { ...r, carry:(+r.carry||0)-overpay } : r);
    // create a payment receipt for the amount received
    const patchObj = { retainerInvoices:newInvs, retainers:newRets };
    if (recv > 0) {
      const r = makeReceipt({ client:pay.client, amount:recv, currency:pay.currency, forText:`Retainer — ${pay.month}`, account:accountName, source:"retainer", sourceNumber:pay.number });
      patchObj.receipts = [r, ...(data.receipts||[])];
    }
    patch(patchObj, `Payment recorded for ${pay.client} (${pay.number})`); setPay(null);
  };
  return (<>
    <Head title="Retainers" sub="Invoices are created only when you click Generate now (never on refresh). Issued 1st, due 5th of next month." action={<div className="flex gap-2"><Btn variant="ghost" onClick={()=>go("accounts")}><Landmark size={15}/>Accounts</Btn><Btn onClick={()=>setEdit(blank)}><Plus size={15}/>Add client</Btn></div>}/>
    <div className="flex flex-wrap gap-2 mb-4"><Btn variant={view==="invoices"?"primary":"ghost"} onClick={()=>setView("invoices")}>Invoices</Btn><Btn variant={view==="clients"?"primary":"ghost"} onClick={()=>setView("clients")}>Clients</Btn>{view==="invoices" && <><Btn variant="ghost" onClick={genDue}><Repeat size={15}/>Generate now</Btn><Btn variant="ghost" onClick={newManual}><Plus size={15}/>Create invoice</Btn><Btn variant="ghost" onClick={clearUnpaid}><X size={15}/>Clear unpaid & receivables</Btn></>}</div>
    {view==="clients" ? (
      <>
      <BatchBar count={bc.count} noun="client" onClear={bc.clear} onDelete={()=>{ const ids=new Set(bc.selected); update("retainers", rets.filter(x=>!ids.has(x.id)), `Removed ${ids.size} retainer client(s)`); bc.clear(); }}/>
      <Card><Table cols={[<SelBox key="a" on={bc.allOn} onChange={bc.toggleAll} title="Select all"/>,"Client","Billing","Monthly","Carried fwd","Status",""]}>{rets.length===0?<tr><td colSpan={7}><Empty msg="No retainer clients yet"/></td></tr>:rets.map(r=>{
        const cyc = r.billing==="Postpaid" ? currentMonthInfo() : nextMonthInfo();
        return (<Row key={r.id}><SelTd on={bc.has(r.id)} onChange={()=>bc.toggle(r.id)}/><Td className="font-medium">{r.client}<div className="text-xs text-slate-400">{r.whatsapp||"no WhatsApp"}</div></Td>
        <Td>{r.billing==="Postpaid"
          ? <span className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">Postpaid</span>
          : <span className="text-xs px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">Prepaid</span>}
          <div className="text-xs text-slate-400 mt-0.5">bills {cyc.label}</div></Td>
        <Td>{fmt(r.amount,r.currency)}</Td><Td className={+r.carry?"text-amber-600 font-medium":"text-slate-400"}>{r.carry?fmt(r.carry,r.currency):"—"}</Td><Td><Pill s={r.status}/></Td>
        <Td><div className="flex items-center gap-1 justify-end"><button onClick={()=>setEdit(r)} className="text-xs text-sky-600 hover:underline whitespace-nowrap">Edit retainer</button><RowActions onDelete={()=>update("retainers",rets.filter(x=>x.id!==r.id))}/></div></Td></Row>);})}</Table></Card>
      </>
    ) : (
      <>
      <BatchBar count={bi.count} noun="invoice" onClear={bi.clear} onDelete={()=>{ const ids=new Set(bi.selected); patch({ retainerInvoices: invs.filter(x=>!ids.has(x.id)) }, `Deleted ${ids.size} retainer invoice(s)`); bi.clear(); }}/>
      <Card><Table cols={[<SelBox key="a" on={bi.allOn} onChange={bi.toggleAll} title="Select all"/>,"Invoice","Client","Period","Due","Total","Status",""]}>{invs.length===0?<tr><td colSpan={8}><Empty msg="No invoices yet — generate this month or create one"/></td></tr>:[...invs].reverse().map(i=>(
        <Row key={i.id}><SelTd on={bi.has(i.id)} onChange={()=>bi.toggle(i.id)}/><Td className="font-medium">{i.number}</Td><Td className="text-slate-500">{i.client}</Td><Td className="text-slate-500">{i.month}{i.billing&&<div className="text-xs text-slate-400">{i.billing}</div>}</Td><Td className="text-slate-500">{i.due||"—"}{i.dueExtended&&<div className="text-xs text-amber-600">extended</div>}{i.sendOn?<div className="text-xs text-slate-400">send {i.sendOn}</div>:null}</Td><Td>{fmt(i.total,i.currency)}{i.status==="Partial"&&<div className="text-xs text-orange-600">received {fmt(i.paidAmount,i.currency)}</div>}{i.status==="Paid"&&i.account&&<div className="text-xs text-slate-400">{i.account}</div>}</Td><Td><Pill s={i.status}/></Td>
        <Td><RowActions onDelete={()=>{ const parent=rets.find(r=>r.id===i.retainerId); patch({ retainerInvoices:invs.filter(x=>x.id!==i.id), retainers: parent?rets.map(r=>r.id===parent.id?{...r,lastGenCycle: i.monthKey||r.lastGenCycle}:r):rets }, `Deleted invoice ${i.number}`); }}><button onClick={()=>openInvoicePDF(i, brand)} title="Download PDF invoice" className="p-1.5 rounded text-slate-400 hover:text-sky-600 hover:bg-slate-100"><Download size={14}/></button><button onClick={()=>sendWA(i)} title="Send on WhatsApp" className="p-1.5 rounded text-slate-400 hover:text-green-600 hover:bg-slate-100"><Send size={14}/></button>{i.status!=="Paid" && <button onClick={()=>setExtend({ id:i.id, client:i.client, number:i.number, due:i.due||today() })} title="Extend due date" className="p-1.5 rounded text-slate-400 hover:text-amber-600 hover:bg-slate-100"><CalendarClock size={15}/></button>}{i.status!=="Paid" && <button onClick={()=>setPay(i)} title="Mark as paid" className="p-1.5 rounded text-slate-400 hover:text-emerald-600 hover:bg-slate-100"><Check size={15}/></button>}</RowActions></Td></Row>))}</Table></Card>
      </>
    )}
    {edit && <Modal title={edit.id?"Edit retainer client":"Add retainer client"} onClose={()=>setEdit(null)}>
      <ClientInput clients={clients} label="Client name" value={edit.client} onChange={e=>onClient(e.target.value)}/>
      <Field label="WhatsApp number (with country code)" value={edit.whatsapp} onChange={e=>setEdit({...edit,whatsapp:e.target.value})} placeholder="923001234567"/>
      <div className="grid grid-cols-2 gap-3"><Field label="Monthly amount" type="number" value={edit.amount} onChange={e=>setEdit({...edit,amount:e.target.value})}/><Select label="Currency" options={CURRENCIES} value={edit.currency} onChange={e=>setEdit({...edit,currency:e.target.value})}/></div>
      <Select label="Billing type" options={["Prepaid — pays for the upcoming month","Postpaid — pays after the month ends"]} value={edit.billing==="Postpaid"?"Postpaid — pays after the month ends":"Prepaid — pays for the upcoming month"} onChange={e=>setEdit({...edit,billing:e.target.value.startsWith("Postpaid")?"Postpaid":"Prepaid"})}/>
      <div className="grid grid-cols-2 gap-3"><Field label="Billing day" type="number" value={edit.billingDay} onChange={e=>setEdit({...edit,billingDay:e.target.value})}/><Select label="Status" options={["Active","Paused"]} value={edit.status} onChange={e=>setEdit({...edit,status:e.target.value})}/></div>
      <p className="text-xs text-slate-400">A new client name here is also added to your Clients list automatically.</p>
      <Btn onClick={()=>saveClient(edit)}><Check size={15}/>Save</Btn>
    </Modal>}
    {manual && <Modal title="Create invoice" onClose={()=>setManual(null)}>
      <ClientInput clients={clients} label="Client" value={manual.client} onChange={e=>onManualClient(e.target.value)}/>
      <div className="grid grid-cols-2 gap-3"><Field label="Billing month" value={manual.month} onChange={e=>setManual({...manual,month:e.target.value})} placeholder="e.g. June 2026"/><Select label="Currency" options={CURRENCIES} value={manual.currency} onChange={e=>setManual({...manual,currency:e.target.value})}/></div>
      <div className="grid grid-cols-2 gap-3"><Field label="Amount" type="number" value={manual.base} onChange={e=>setManual({...manual,base:e.target.value})}/><Field label="Carry forward (optional)" type="number" value={manual.carry} onChange={e=>setManual({...manual,carry:e.target.value})}/></div>
      <div className="grid grid-cols-3 gap-3"><Field label="Issue date" type="date" value={manual.date} onChange={e=>setManual({...manual,date:e.target.value})}/><Field label="Due date" type="date" value={manual.due} onChange={e=>setManual({...manual,due:e.target.value})}/><Field label="Send to client on" type="date" value={manual.sendOn} onChange={e=>setManual({...manual,sendOn:e.target.value})}/></div>
      <Btn onClick={saveManual}><Check size={15}/>Create invoice</Btn>
    </Modal>}
    {pay && <PayModal inv={pay} accounts={accounts} onClose={()=>setPay(null)} onConfirm={confirmPay} onManageAccounts={()=>{setPay(null);go("accounts");}}/>}
    {billAsk && <Modal title="One-time setup · billing type per client" onClose={()=>setBillAsk(null)}>
      <p className="text-xs text-slate-500">Choose how each client is billed. <b>Prepaid</b> pays for the upcoming month; <b>Postpaid</b> pays for the month just completed. This is saved on the client's retainer and won't be asked again.</p>
      <div className="space-y-2">{rets.filter(r=>billAsk[r.id]!==undefined).map(r=>(
        <div key={r.id} className="flex items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <div className="text-sm font-medium">{r.client}<div className="text-xs text-slate-400 font-normal">{fmt(r.amount, r.currency)}/mo</div></div>
          <div className="flex gap-1">{["Prepaid","Postpaid"].map(m=>(
            <button key={m} onClick={()=>setBillAsk({...billAsk,[r.id]:m})} className={`px-2.5 py-1.5 rounded-lg text-xs border transition ${billAsk[r.id]===m?"bg-sky-600 border-sky-600 text-white":"bg-white border-slate-300 text-slate-600 hover:border-sky-400"}`}>{m}</button>))}
          </div>
        </div>))}
      </div>
      <Btn onClick={saveBillingAndGenerate}><Check size={15}/>Save & generate invoices</Btn>
    </Modal>}
    {genAsk && (()=>{ const make=genAsk.items.filter(i=>!i.exists), skip=genAsk.items.filter(i=>i.exists); return (
      <Modal title="Generate retainer invoices" onClose={()=>setGenAsk(null)}>
        {make.length===0
          ? <div className="text-sm text-slate-600">Every active retainer client already has an invoice for their billing period. Nothing to generate — this is the guard that stops a second run creating duplicates.</div>
          : <>
            <div className="text-sm text-slate-600">This will create <b>{make.length}</b> invoice{make.length>1?"s":""}:</div>
            <div className="max-h-56 overflow-y-auto bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm space-y-1">
              {make.map(i=>(<div key={i.id} className="flex justify-between gap-2"><span>{i.client}<span className="text-xs text-slate-400 ml-1">{i.billing}</span></span><span className="text-slate-500 whitespace-nowrap">{i.period} · {fmt(i.amount,i.currency)}</span></div>))}
            </div>
          </>}
        {skip.length>0 && <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Skipping {skip.length} client(s) already invoiced for their period: {skip.slice(0,6).map(i=>i.client).join(", ")}{skip.length>6?"…":""}</div>}
        {make.length>0 && <Btn onClick={()=>{ runGeneration(genAsk.db); setGenAsk(null); }}><Check size={15}/>Generate {make.length} invoice{make.length>1?"s":""}</Btn>}
      </Modal>); })()}
    {extend && <Modal title={`Extend due date · ${extend.number}`} onClose={()=>setExtend(null)}>
      <p className="text-xs text-slate-500">Give {extend.client} more time to pay. This updates the invoice's due date.</p>
      <Field label="New due date" type="date" value={extend.due} onChange={e=>setExtend({...extend,due:e.target.value})}/>
      <Btn onClick={saveExtend}><Check size={15}/>Update due date</Btn>
    </Modal>}
  </>);
}
function PayModal({ inv, accounts, onClose, onConfirm, onManageAccounts }) {
  const [received, setReceived] = useState(String(inv.total));
  const [accountName, setAccountName] = useState(accounts[0]?.name || "");
  const [carryChoice, setCarryChoice] = useState("next");
  const [overChoice, setOverChoice] = useState("credit");
  const recv = +received||0;
  const shortfall = Math.max(0, inv.total - recv);
  const overpay = Math.max(0, recv - inv.total);
  return (<Modal title={`Record payment · ${inv.number}`} onClose={onClose}>
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm flex justify-between"><span className="text-slate-500">Amount due</span><b>{fmt(inv.total,inv.currency)}</b></div>
    <Field label={`How much was received? (${inv.currency})`} type="number" value={received} onChange={e=>setReceived(e.target.value)}/>
    {accounts.length>0 ? (<div><Select label="Received in which account?" options={accounts.map(a=>a.name)} value={accountName} onChange={e=>setAccountName(e.target.value)}/><button onClick={onManageAccounts} className="text-sky-600 text-xs mt-1 hover:underline">Manage accounts</button></div>) : (<Field label="Received in which account?" value={accountName} onChange={e=>setAccountName(e.target.value)} placeholder="Type account name"/>)}
    {shortfall>0 && <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2"><div className="text-sm text-amber-800">Short by {fmt(shortfall,inv.currency)}. What should happen to the rest?</div><label className="flex items-center gap-2 text-sm text-slate-700"><input type="radio" checked={carryChoice==="next"} onChange={()=>setCarryChoice("next")} className="accent-sky-600"/> Carry forward to next month's invoice</label><label className="flex items-center gap-2 text-sm text-slate-700"><input type="radio" checked={carryChoice==="discard"} onChange={()=>setCarryChoice("discard")} className="accent-sky-600"/> Leave it / write off</label></div>}
    {overpay>0 && <div className="bg-sky-50 border border-sky-200 rounded-lg p-3 space-y-2"><div className="text-sm text-sky-800">Paid {fmt(overpay,inv.currency)} more than due. What should happen to the extra?</div><label className="flex items-center gap-2 text-sm text-slate-700"><input type="radio" checked={overChoice==="credit"} onChange={()=>setOverChoice("credit")} className="accent-sky-600"/> Credit to next month (reduces next invoice)</label><label className="flex items-center gap-2 text-sm text-slate-700"><input type="radio" checked={overChoice==="keep"} onChange={()=>setOverChoice("keep")} className="accent-sky-600"/> Keep as extra / advance (no adjustment)</label></div>}
    <Btn onClick={()=>onConfirm({ received, accountName, carryChoice, overChoice })}><Check size={15}/>{shortfall>0?"Record partial payment":"Mark as paid"}</Btn>
  </Modal>);
}
function Ledger({ title, sub, rows, setRows, blank, fields, cols, render, extraActions, noun="record" }) {
  const [edit,setEdit]=useState(null);
  const b = useBatch(rows);
  const save=r=>{setRows(r.id?rows.map(x=>x.id===r.id?r:x):[...rows,{...r,id:uid()}]);setEdit(null);};
  const delSelected=()=>{ const ids=new Set(b.selected); setRows(rows.filter(x=>!ids.has(x.id))); b.clear(); };
  return (<>
    <Head title={title} sub={sub} action={<Btn onClick={()=>setEdit(blank())}><Plus size={15}/>Add</Btn>}/>
    <BatchBar count={b.count} noun={noun} onDelete={delSelected} onClear={b.clear}/>
    <Card><Table cols={[<SelBox key="a" on={b.allOn} onChange={b.toggleAll} title="Select all"/>,...cols,""]}>{rows.length===0?<tr><td colSpan={cols.length+2}><Empty msg="Nothing here yet"/></td></tr>:rows.map(r=>(<Row key={r.id}><SelTd on={b.has(r.id)} onChange={()=>b.toggle(r.id)}/>{render(r)}<Td><RowActions onEdit={()=>setEdit(r)} onDelete={()=>setRows(rows.filter(x=>x.id!==r.id))}>{extraActions?extraActions(r):null}</RowActions></Td></Row>))}</Table></Card>
    {edit && <Modal title={edit.id?"Edit":"Add"} onClose={()=>setEdit(null)}>{fields(edit,setEdit)}<Btn onClick={()=>save(edit)}><Check size={15}/>Save</Btn></Modal>}
  </>);
}
// ===== Custom invoice builder =====
// Any client, priced line by line, in any of our billing currencies. When a client
// is billed in one currency but pays in another, both are shown with the rate used.
const CUR_SYM = { PKR:"PKR", USD:"$", GBP:"GBP", SAR:"SAR", AED:"AED", CAD:"CAD" };
const lineTotal = (l) => (+l.qty || 0) * (+l.rate || 0);
const invTotals = (inv) => {
  const sub = (inv.items || []).reduce((t, l) => t + lineTotal(l), 0);
  const disc = +inv.discount || 0;
  const taxable = Math.max(0, sub - disc);
  const tax = taxable * ((+inv.taxPct || 0) / 100);
  const total = taxable + tax;
  const alt = inv.altCurrency && +inv.fxRate ? total * +inv.fxRate : null;
  return { sub, disc, tax, total, alt };
};
function InvoiceBuilder({ data, brand, edit, setEdit, onSave }) {
  const t = invTotals(edit);
  const setItem = (i, patchObj) => setEdit({ ...edit, items: edit.items.map((l, k) => k === i ? { ...l, ...patchObj } : l) });
  const bank = (data.bankAccounts || []).find(b => b.id === edit.bankId);
  return (<Modal title={edit.id ? `Invoice ${edit.number}` : "New invoice"} onClose={() => setEdit(null)} wide>
    <div className="grid sm:grid-cols-2 gap-3">
      <ClientInput data={data} value={edit.client} onChange={v => setEdit({ ...edit, client: v })}/>
      <Field label="Invoice number" value={edit.number} onChange={e => setEdit({ ...edit, number: e.target.value })}/>
      <Field label="Issue date" type="date" value={edit.date} onChange={e => setEdit({ ...edit, date: e.target.value })}/>
      <Field label="Due date" type="date" value={edit.due || ""} onChange={e => setEdit({ ...edit, due: e.target.value })}/>
    </div>
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 font-medium mb-2">Items</div>
      <div className="space-y-2">{(edit.items || []).map((l, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-6"><Field label={i === 0 ? "Description" : ""} value={l.desc} onChange={e => setItem(i, { desc: e.target.value })}/></div>
          <div className="col-span-2"><Field label={i === 0 ? "Qty" : ""} type="number" value={l.qty} onChange={e => setItem(i, { qty: e.target.value })}/></div>
          <div className="col-span-3"><Field label={i === 0 ? "Rate" : ""} type="number" value={l.rate} onChange={e => setItem(i, { rate: e.target.value })}/></div>
          <button onClick={() => setEdit({ ...edit, items: edit.items.filter((_, k) => k !== i) })} className="col-span-1 h-9 text-slate-300 hover:text-rose-500"><X size={15}/></button>
        </div>))}
      </div>
      <Btn variant="ghost" onClick={() => setEdit({ ...edit, items: [...(edit.items || []), { desc: "", qty: 1, rate: "" }] })}><Plus size={15}/>Add line</Btn>
    </div>
    <div className="grid sm:grid-cols-3 gap-3">
      <Select label="Bill in" options={CURRENCIES} value={edit.currency} onChange={e => setEdit({ ...edit, currency: e.target.value })}/>
      <Field label="Discount" type="number" value={edit.discount || ""} onChange={e => setEdit({ ...edit, discount: e.target.value })}/>
      <Field label="Tax %" type="number" value={edit.taxPct || ""} onChange={e => setEdit({ ...edit, taxPct: e.target.value })}/>
    </div>
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
      <div className="text-xs text-slate-500">Paying in a different currency? Show the equivalent on the invoice.</div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Select label="Also show in" options={["", ...CURRENCIES.filter(c => c !== edit.currency)]} value={edit.altCurrency || ""} onChange={e => setEdit({ ...edit, altCurrency: e.target.value })}/>
        <Field label={`Rate (1 ${edit.currency} = ? ${edit.altCurrency || "—"})`} type="number" value={edit.fxRate || ""} onChange={e => setEdit({ ...edit, fxRate: e.target.value })}/>
      </div>
      {t.alt != null && <div className="text-sm text-slate-700">Equivalent: <b>{fmt(t.alt, edit.altCurrency)}</b> at 1 {edit.currency} = {edit.fxRate} {edit.altCurrency}</div>}
    </div>
    <Select label="Bank account shown on the invoice" options={["", ...(data.bankAccounts || []).map(b => b.label || b.bank || b.title)]}
      value={bank ? (bank.label || bank.bank || bank.title) : ""}
      onChange={e => { const b = (data.bankAccounts || []).find(x => (x.label || x.bank || x.title) === e.target.value); setEdit({ ...edit, bankId: b ? b.id : "" }); }}/>
    <Area label="Notes / terms" value={edit.notes || ""} onChange={e => setEdit({ ...edit, notes: e.target.value })}/>
    <div className="bg-white border border-slate-200 rounded-lg p-3 text-sm space-y-1">
      <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span>{fmt(t.sub, edit.currency)}</span></div>
      {!!t.disc && <div className="flex justify-between"><span className="text-slate-500">Discount</span><span>-{fmt(t.disc, edit.currency)}</span></div>}
      {!!t.tax && <div className="flex justify-between"><span className="text-slate-500">Tax</span><span>{fmt(t.tax, edit.currency)}</span></div>}
      <div className="flex justify-between font-semibold text-base border-t border-slate-200 pt-1"><span>Total</span><span>{fmt(t.total, edit.currency)}</span></div>
      {t.alt != null && <div className="flex justify-between text-slate-500"><span>Payable in {edit.altCurrency}</span><span>{fmt(t.alt, edit.altCurrency)}</span></div>}
    </div>
    <Btn onClick={() => onSave({ ...edit, amount: t.total, altAmount: t.alt })}><Check size={15}/>Save invoice</Btn>
  </Modal>);
}
function customInvoiceHTML(inv, brand, bank) {
  const t = invTotals(inv);
  const rows = (inv.items || []).map(l => `<tr><td>${l.desc || ""}</td><td class="r">${l.qty || 0}</td><td class="r">${fmt(l.rate, inv.currency)}</td><td class="r">${fmt(lineTotal(l), inv.currency)}</td></tr>`).join("");
  const offices = (brand.offices || []).map(o => `${o.city}: ${o.address}`).join("<br>");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${inv.number}</title><style>
    body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:#0f172a;margin:0;padding:38px}
    .top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
    .logo{height:52px}.co{font-size:22px;font-weight:700}.tag{color:#64748b;font-size:12px}
    .title{color:${brand.accent || "#0284c7"};font-size:20px;font-weight:700;text-align:right}
    .meta{color:#64748b;font-size:12px;text-align:right}
    .bar{height:3px;background:${brand.accent || "#0284c7"};margin:14px 0 22px}
    .who{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:20px;font-size:13px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{background:${brand.accent || "#0284c7"};color:#fff;text-align:left;padding:9px 10px;font-size:11px;letter-spacing:.04em}
    td{padding:9px 10px;border-bottom:1px solid #eef2f7}.r{text-align:right}
    .tot{margin-left:auto;width:290px;font-size:13px;margin-top:14px}
    .tot div{display:flex;justify-content:space-between;padding:5px 0}
    .grand{border-top:2px solid #0f172a;font-weight:700;font-size:16px}
    .alt{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px;margin-top:10px;font-size:12.5px}
    .bank{margin-top:24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;font-size:12.5px}
    .bank b{display:block;font-size:11px;letter-spacing:.05em;color:#64748b;margin-bottom:6px}
    .foot{margin-top:26px;border-top:1px solid #e2e8f0;padding-top:10px;color:#94a3b8;font-size:11px}
    @media print{body{padding:0}}
  </style></head><body>
    <div class="top"><div>${brand.logo ? `<img class="logo" src="${brand.logo}">` : ""}<div class="co">${brand.company || ""}</div><div class="tag">${brand.tagline || ""}</div></div>
      <div><div class="title">INVOICE</div><div class="meta">${inv.number}<br>Issued ${inv.date || ""}${inv.due ? `<br>Due ${inv.due}` : ""}</div></div></div>
    <div class="bar"></div>
    <div class="who"><b>Billed to</b><br><span style="font-size:15px;font-weight:600">${inv.client || ""}</span></div>
    <table><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="tot">
      <div><span>Subtotal</span><span>${fmt(t.sub, inv.currency)}</span></div>
      ${t.disc ? `<div><span>Discount</span><span>-${fmt(t.disc, inv.currency)}</span></div>` : ""}
      ${t.tax ? `<div><span>Tax ${inv.taxPct}%</span><span>${fmt(t.tax, inv.currency)}</span></div>` : ""}
      <div class="grand"><span>Total</span><span>${fmt(t.total, inv.currency)}</span></div>
    </div>
    ${t.alt != null ? `<div class="alt"><b>Payable in ${inv.altCurrency}: ${fmt(t.alt, inv.altCurrency)}</b><br>Converted at 1 ${inv.currency} = ${inv.fxRate} ${inv.altCurrency} on ${inv.date || today()}. The ${inv.currency} amount above is the billed amount.</div>` : ""}
    ${bank ? `<div class="bank"><b>PAYMENT DETAILS</b>
      ${bank.title ? `Account title: ${bank.title}<br>` : ""}${bank.bank ? `Bank: ${bank.bank}<br>` : ""}
      ${bank.number ? `Account number: ${bank.number}<br>` : ""}${bank.iban ? `IBAN: ${bank.iban}<br>` : ""}
      ${bank.swift ? `SWIFT: ${bank.swift}<br>` : ""}${bank.branch ? `Branch: ${bank.branch}` : ""}</div>` : ""}
    ${inv.notes ? `<div style="margin-top:16px;font-size:12.5px;color:#475569">${String(inv.notes).replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>` : ""}
    <div class="foot">${offices}<br>${[brand.phone, brand.email, brand.website].filter(Boolean).join(" &middot; ")}</div>
    <script>window.onload=()=>window.print()<\/script>
  </body></html>`;
}
const openCustomInvoice = (inv, brand, bank) => {
  const w = window.open("", "_blank");
  if (!w) { alert("Allow pop-ups to print the invoice."); return; }
  w.document.write(customInvoiceHTML(inv, brand, bank));
  w.document.close();
};
function Invoices({ data, update, patch, brand }) {
  const rows=data.invoices; const clients=data.clients;
  const setRows=(r)=>{
    const wasById = Object.fromEntries(rows.map(x=>[x.id,x]));
    const newlyPaid = r.filter(x=>x.status==="Paid" && (!wasById[x.id] || wasById[x.id].status!=="Paid"));
    if (newlyPaid.length) {
      const receipts = newlyPaid.map(x=>makeReceipt({ client:x.client, amount:x.amount, currency:x.currency, forText:`Invoice ${x.number}`, source:"invoice", sourceNumber:x.number }));
      patch({ invoices:r, receipts:[...receipts, ...(data.receipts||[])] }, `Invoice marked paid — receipt created`);
    } else {
      update("invoices", r);
    }
  };
  const [inv, setInv] = useState(null);
  const bankOf = (r)=> (data.bankAccounts||[]).find(b=>b.id===r.bankId) || null;
  const newInvoice = () => setInv({ client:"", number:"INV-"+(1000+rows.length+1), date:today(), due:"", currency:"PKR",
    items:[{desc:"",qty:1,rate:""}], discount:"", taxPct:"", altCurrency:"", fxRate:"", bankId:(data.bankAccounts||[])[0]?.id||"", notes:"", status:"Draft", type:"Invoice" });
  const saveInvoice = (v) => {
    setRows(v.id ? rows.map(x=>x.id===v.id?v:x) : [{ ...v, id:uid() }, ...rows]);
    setInv(null);
  };
  return (<>
    {inv && <InvoiceBuilder data={data} brand={brand} edit={inv} setEdit={setInv} onSave={saveInvoice}/>}
    <Ledger noun="invoice" title="Invoices & Receipts" sub="Billing to clients · marking an invoice Paid creates a receipt in the Receipts tab" rows={rows} setRows={setRows}
    blank={()=>({client:"",number:"INV-"+(1000+rows.length+1),amount:"",currency:"PKR",date:today(),status:"Draft",type:"Invoice"})}
    cols={["Number","Client","Type","Amount","Date","Status"]}
    extraActions={r=> (r.items||[]).length ? <><button onClick={()=>setInv(r)} title="Edit invoice" className="p-1.5 rounded text-slate-400 hover:text-sky-600 hover:bg-slate-100"><Edit3 size={15}/></button><button onClick={()=>openCustomInvoice(r, brand, bankOf(r))} title="Print / save PDF" className="p-1.5 rounded text-slate-400 hover:text-sky-600 hover:bg-slate-100"><Download size={15}/></button></> : null}
    render={r=>(<><Td className="font-medium">{r.number}{(r.items||[]).length?<div className="text-xs text-slate-400">{r.items.length} line(s)</div>:null}</Td><Td className="text-slate-500">{r.client}</Td><Td className="text-slate-500">{r.type}</Td><Td>{fmt(r.amount,r.currency)}{r.altAmount?<div className="text-xs text-slate-400">= {fmt(r.altAmount,r.altCurrency)}</div>:null}</Td><Td className="text-slate-500">{r.date}</Td><Td><Pill s={r.status}/></Td></>)}
    fields={(e,s)=>(<><ClientInput clients={clients} value={e.client} onChange={ev=>{const v=ev.target.value;const c=clients.find(x=>x.name===v);s({...e,client:v,...(c?{currency:c.currency||"PKR"}:{})});}}/><Field label="Number" value={e.number} onChange={ev=>s({...e,number:ev.target.value})}/><Select label="Type" options={["Invoice","Receipt"]} value={e.type} onChange={ev=>s({...e,type:ev.target.value})}/><div className="grid grid-cols-2 gap-3"><Field label="Amount" type="number" value={e.amount} onChange={ev=>s({...e,amount:ev.target.value})}/><Select label="Currency" options={CURRENCIES} value={e.currency} onChange={ev=>s({...e,currency:ev.target.value})}/></div><Field label="Date" type="date" value={e.date} onChange={ev=>s({...e,date:ev.target.value})}/><Select label="Status" options={["Draft","Sent","Paid","Overdue"]} value={e.status} onChange={ev=>s({...e,status:ev.target.value})}/></>)}/>
    <div className="mt-4"><Btn onClick={newInvoice}><Plus size={15}/>Build a custom invoice</Btn>
      <p className="text-xs text-slate-400 mt-2">Line items, any currency, your bank details, and a second currency with the rate when a client pays in something else.</p></div>
  </>);
}
function Receipts({ data, update, brand }) {
  const br = useBatch(data.receipts||[]);
  const rows = data.receipts || [];
  const clients = data.clients || [];
  const waNum = (client) => (clients.find(c=>c.name===client)?.whatsapp || "").replace(/\D/g,"");
  const sendWA = (r) => {
    const num = waNum(r.client);
    const msg = `*${brand.company}*\n\nPayment Receipt: ${r.number}\nReceived: ${fmt(r.amount,r.currency)}\nFor: ${r.for}\nDate: ${r.date}` + (r.account?`\nReceived in: ${r.account}`:``) + `\n\nThank you for your payment.`;
    if (num) window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, "_blank");
    else alert("No WhatsApp number on file for this client.");
  };
  const total = rows.reduce((s,r)=>s+ +r.amount,0);
  return (<>
    <Head title="Receipts" sub={`Payment receipts · ${rows.length} issued · ${fmt(total)} received in total`}/>
    <BatchBar count={br.count} noun="receipt" onClear={br.clear} onDelete={()=>{ const ids=new Set(br.selected); update("receipts", rows.filter(x=>!ids.has(x.id)), `Deleted ${ids.size} receipt(s)`); br.clear(); }}/>
    <Card><Table cols={[<SelBox key="a" on={br.allOn} onChange={br.toggleAll} title="Select all"/>,"Receipt","Client","For","Amount","Account","Date",""]}>{rows.length===0?<tr><td colSpan={8}><Empty msg="No receipts yet — they're created automatically when you mark a client invoice or retainer as paid"/></td></tr>:rows.map(r=>(
      <Row key={r.id}><SelTd on={br.has(r.id)} onChange={()=>br.toggle(r.id)}/><Td className="font-medium">{r.number}</Td><Td className="text-slate-500">{r.client}</Td><Td className="text-slate-500">{r.for}</Td><Td className="font-semibold">{fmt(r.amount,r.currency)}</Td><Td className="text-slate-500">{r.account||"—"}</Td><Td className="text-slate-500">{r.date}</Td>
      <Td><RowActions onDelete={()=>update("receipts", rows.filter(x=>x.id!==r.id), `Deleted receipt ${r.number}`)}>
        <button onClick={()=>openReceiptPDF(r, brand)} title="Download receipt PDF" className="p-1.5 rounded text-slate-400 hover:text-sky-600 hover:bg-slate-100"><Download size={14}/></button>
        <button onClick={()=>sendWA(r)} title="Send on WhatsApp" className="p-1.5 rounded text-slate-400 hover:text-green-600 hover:bg-slate-100"><Send size={14}/></button>
      </RowActions></Td></Row>))}</Table></Card>
  </>);
}
function Payables({ data, update, patch, brand }) {
  const rows=data.payables;
  // When a payable changes, if a vendor-bill payable becomes Paid, flip the linked vendor bill to Paid too.
  const setRows=(r)=>{
    const wasById = Object.fromEntries(rows.map(p=>[p.id,p]));
    const newlyPaidBillIds = r.filter(p=>p.kind==="vendorbill" && p.status==="Paid" && wasById[p.id] && wasById[p.id].status!=="Paid").map(p=>p.billId);
    if (newlyPaidBillIds.length) {
      patch({ payables:r, vendorBills:(data.vendorBills||[]).map(b=>newlyPaidBillIds.includes(b.id)?{...b,paid:true,status:"Paid",paidDate:today()}:b) }, `Vendor bill paid from Payables`);
    } else {
      update("payables", r);
    }
  };
  const markVendorPaid = (r)=>{
    patch({ payables: rows.map(p=>p.id===r.id?{...p,status:"Paid",settled:true,paidDate:today()}:p), vendorBills:(data.vendorBills||[]).map(b=>b.id===r.billId?{...b,paid:true,status:"Paid",paidDate:today()}:b) }, `Vendor bill paid: ${r.vendor}`);
    // notify the vendor on WhatsApp
    const bill = (data.vendorBills||[]).find(b=>b.id===r.billId);
    const num = (r.whatsapp || bill?.whatsapp || "").replace(/\D/g,"");
    const work = (r.desc||"").replace(/^Vendor bill:\s*/,"") || bill?.desc || "your work";
    if (num) {
      const msg = `*${brand.company}*\n\nAssalamu Alaikum ${r.vendor},\n\nYour payment of ${fmt(r.amount)} for ${work} has been processed. Please confirm once received.\n\nJazakAllah, thank you for your work.`;
      window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, "_blank");
    }
  };
  const [appr, setAppr] = useState(null);
  const [rej, setRej] = useState(null);
  const openReject = (r)=> setRej({ id:r.id, vendor:r.vendor, amount:r.amount, desc:r.desc, reason:"", appealed:(+r.appealCount||0)>0 });
  const confirmReject = ()=>{
    if (!rej.reason.trim()) return;
    setRows(rows.map(x=>x.id!==rej.id ? x : {
      ...x, status:"Rejected",
      rejections:[...(x.rejections||[]), { reason:rej.reason.trim(), on:today() }],
      // A claim that has already been appealed is closed for good on the next rejection.
      finalRejected: (+x.appealCount||0) > 0,
    }), `Rejected claim: ${rej.desc} — ${rej.reason.trim()}`);
    setRej(null);
  };
  const months = Array.from({length:6}).map((_,i)=>{ const d=new Date(); d.setMonth(d.getMonth()+i); return d.toLocaleString("default",{month:"long",year:"numeric"}); });
  const openApprove = (r)=> setAppr({ id:r.id, vendor:r.vendor, amount:r.amount, mode:"salary", month: months[0], date: today() });
  const confirmApprove = ()=>{
    const a = appr;
    setRows(rows.map(x=>{
      if (x.id!==a.id) return x;
      if (a.mode==="salary") return { ...x, status:"Approved", payVia:"salary", payMonth:a.month };
      // direct / instant
      return { ...x, status:"Paid", settled:true, payVia:"direct", paidDate:a.date };
    }));
    setAppr(null);
  };
  return (<>
    <Ledger noun="payable" title="Payables" sub={`Owed · ${fmt(rows.filter(r=>r.status!=="Paid" && r.status!=="Rejected").reduce((s,r)=>s+ +r.amount,0))} · approved vendor bills land here as unpaid until you mark them paid`} rows={rows} setRows={setRows}
      blank={()=>({vendor:"",desc:"",amount:"",due:today(),status:"Pending"})}
      cols={["Vendor","Description","Amount","Due","Status"]}
      render={r=>(<><Td className="font-medium">{r.vendor}</Td><Td className="text-slate-500"><div className="flex flex-col gap-0.5"><div className="flex items-center gap-2">{(r.receipt||r.receiptFileId)&&<button onClick={(e)=>{e.stopPropagation();openStored(fileRef(r,"receipt"), r.receiptName||"receipt");}} title="Open receipt" className="shrink-0 w-8 h-8 rounded border border-slate-200 grid place-items-center hover:ring-2 hover:ring-sky-400 overflow-hidden"><StoredImg d={fileRef(r,"receipt")} className="w-8 h-8 object-cover"/><FileText size={13} className="text-slate-400"/></button>}{r.desc}{r.payVia==="salary"&&<span className="text-xs text-sky-600">→ {r.payMonth} salary</span>}{r.kind==="vendorbill"&&<span className="text-xs text-slate-400">vendor bill</span>}</div>
        {(r.rejections||[]).length>0 && <div className="text-xs text-rose-600">Rejected: {r.rejections[r.rejections.length-1].reason}{r.finalRejected?" · final":""}</div>}
        {(r.appeals||[]).length>0 && r.status==="Pending" && <div className="text-xs text-amber-600">Appealed: {r.appeals[r.appeals.length-1].reason}</div>}
      </div></Td><Td>{fmt(r.amount)}</Td><Td className="text-slate-500">{r.due}</Td><Td><Pill s={r.status}/></Td></>)}
      extraActions={r=> r.kind==="reimbursement" && r.status!=="Approved" && r.status!=="Paid" ? <>{r.status!=="Rejected" && <button onClick={()=>openApprove(r)} title="Approve reimbursement" className="p-1.5 rounded text-slate-400 hover:text-emerald-600 hover:bg-slate-100"><Check size={15}/></button>}{!r.finalRejected && <button onClick={()=>openReject(r)} title={r.status==="Rejected"?"Already rejected":"Reject this claim"} className="p-1.5 rounded text-slate-400 hover:text-rose-600 hover:bg-slate-100 disabled:opacity-30" disabled={r.status==="Rejected"}><X size={15}/></button>}</> : (r.kind==="vendorbill" && r.status!=="Paid" ? <button onClick={()=>markVendorPaid(r)} title="Mark vendor bill as paid" className="px-2 py-1 rounded text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-200">Mark paid</button> : null)}
      fields={(e,s)=>(<><Field label="Vendor" value={e.vendor} onChange={ev=>s({...e,vendor:ev.target.value})}/><Field label="Description" value={e.desc} onChange={ev=>s({...e,desc:ev.target.value})}/><Field label="Amount (PKR)" type="number" value={e.amount} onChange={ev=>s({...e,amount:ev.target.value})}/><Field label="Due" type="date" value={e.due} onChange={ev=>s({...e,due:ev.target.value})}/><Select label="Status" options={["Pending","Approved","Paid","Overdue"]} value={e.status} onChange={ev=>s({...e,status:ev.target.value})}/></>)}/>
    {rej && <Modal title={`Reject claim · ${rej.vendor}`} onClose={()=>setRej(null)}>
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm flex justify-between"><span className="text-slate-500">{rej.desc}</span><b>{fmt(rej.amount)}</b></div>
      <Area label="Reason for rejecting" value={rej.reason} onChange={e=>setRej({...rej,reason:e.target.value})}/>
      <div className={`text-xs rounded-lg px-3 py-2 ${rej.appealed?"bg-rose-50 border border-rose-200 text-rose-700":"bg-slate-50 border border-slate-200 text-slate-600"}`}>
        {rej.appealed
          ? "This claim has already been appealed once. Rejecting now closes it permanently — the employee cannot appeal again."
          : "The employee will see your reason and may appeal once with an explanation."}
      </div>
      <Btn onClick={confirmReject} disabled={!rej.reason.trim()}><X size={15}/>{rej.appealed?"Reject finally":"Reject claim"}</Btn>
    </Modal>}
    {appr && <Modal title={`Approve reimbursement · ${appr.vendor}`} onClose={()=>setAppr(null)}>
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm flex justify-between"><span className="text-slate-500">Amount</span><b>{fmt(appr.amount)}</b></div>
      {(appr.receipt||appr.receiptFileId) && <div><span className="text-xs text-slate-500 mb-1 block">Attached receipt / invoice — tap to open full size</span>
        <button onClick={()=>openStored(fileRef(appr,"receipt"), appr.receiptName||"receipt")} className="block text-left"><StoredImg d={fileRef(appr,"receipt")} className="h-40 rounded-lg border border-slate-200 object-cover hover:ring-2 hover:ring-sky-400"/><span className="flex items-center gap-2 text-sm text-sky-600 hover:underline mt-1"><FileText size={15}/>{appr.receiptName||"Open attachment"} ↗</span></button></div>}
      <Select label="How should this be paid?" options={["salary","direct"]} value={appr.mode} onChange={e=>setAppr({...appr,mode:e.target.value})}/>
      {appr.mode==="salary"
        ? <Select label="Add to which month's salary?" options={months} value={appr.month} onChange={e=>setAppr({...appr,month:e.target.value})}/>
        : <Field label="Pay on date (today = instant)" type="date" value={appr.date} onChange={e=>setAppr({...appr,date:e.target.value})}/>}
      <p className="text-xs text-slate-400">{appr.mode==="salary" ? "It will be added to that month's payslip when you run payroll for that month." : "It will be marked paid directly on this date (outside salary)."}</p>
      <Btn onClick={confirmApprove}><Check size={15}/>Approve</Btn>
    </Modal>}
  </>);
}
function Receivables({ data, update }) {
  const rows=data.receivables, setRows=r=>update("receivables",r); const clients=data.clients;
  return <Ledger noun="receivable" title="Receivables" sub={`Expected · ${fmt(rows.filter(r=>r.status!=="Paid").reduce((s,r)=>s+ +r.amount,0))}`} rows={rows} setRows={setRows}
    blank={()=>({client:"",desc:"",amount:"",due:today(),status:"Outstanding"})}
    cols={["Client","Description","Amount","Due","Status"]}
    render={r=>(<><Td className="font-medium">{r.client}</Td><Td className="text-slate-500">{r.desc}</Td><Td>{fmt(r.amount)}</Td><Td className="text-slate-500">{r.due}</Td><Td><Pill s={r.status}/></Td></>)}
    fields={(e,s)=>(<><ClientInput clients={clients} value={e.client} onChange={ev=>s({...e,client:ev.target.value})}/><Field label="Description" value={e.desc} onChange={ev=>s({...e,desc:ev.target.value})}/><Field label="Amount (PKR)" type="number" value={e.amount} onChange={ev=>s({...e,amount:ev.target.value})}/><Field label="Due" type="date" value={e.due} onChange={ev=>s({...e,due:ev.target.value})}/><Select label="Status" options={["Outstanding","Paid","Overdue"]} value={e.status} onChange={ev=>s({...e,status:ev.target.value})}/></>)}/>;
}

function Requests({ data, update, mutateData, go }) {
  const [kind, setKind] = useState("all");     // all | leave | cert | reimb
  const [st, setSt] = useState("open");        // open | decided | all
  const [busyId, setBusyId] = useState(null);
  const setReqStatus = async (id,sv)=>{ setBusyId("R"+id); try { await mutateData((cur)=>({ ...cur, requests:(cur.requests||[]).map(r=>r.id===id?{...r,status:sv,decidedOn:today()}:r) }), `Request marked ${sv}`); } finally { setBusyId(null); } };
  const setWfh = async (id,sv)=>{
    const w = (data.wfhRequests||[]).find(x=>x.id===id);
    setBusyId("W"+id);
    try { await mutateData((cur)=>({
      ...cur,
      wfhRequests:(cur.wfhRequests||[]).map(x=>x.id===id?{...x,status:sv,decidedOn:today()}:x),
      // Approving puts the day on the attendance sheet; declining takes the pending row off it.
      attendance:(cur.attendance||[]).flatMap(x=>{
        if (x.wfhReqId !== id) return [x];
        if (sv==="Rejected") return x.checkIn ? [{ ...x, status:"Requested" }] : [];
        return [{ ...x, status:"Present", office:x.office||"Work from home" }];
      }),
    }), `Work from home ${sv.toLowerCase()} for ${w?.employee} (${w?.date}) — they have been notified`); }
    finally { setBusyId(null); }
  };
  const setTimeReq = async (id,sv,field="timeReq")=>{
    const a = (data.attendance||[]).find(x=>x.id===id);
    setBusyId((field==="outReq"?"O":"T")+id);
    try { await mutateData((cur)=>({ ...cur, attendance:(cur.attendance||[]).flatMap(x=>{
        if (x.id !== id) return [x];
        // A claim for a day they never checked in at all: approving marks them present,
        // declining removes the placeholder so attendance stays clean (the decision is
        // still recorded in the activity log).
        if (sv === "Rejected" && x.viaRequest && !x.checkIn && !x.checkOut && !(field==="timeReq" ? x.outReq : x.timeReq)) return [];
        const upd = { ...x, [field]: { ...x[field], status:sv, decidedOn:today() } };
        if (sv === "Approved" && x.viaRequest) return [{ ...upd, status:"Present", office: x.office || "Added by HR approval" }];
        return [upd];
      }) }),
      `Check-in correction ${sv.toLowerCase()} for ${a?.employee} (${a?.date}) — they have been notified`); } finally { setBusyId(null); }
  };
  const setLeave = async (id,sv)=>{ const l=data.leaves.find(x=>x.id===id); setBusyId("L"+id); try { await mutateData((cur)=>({ ...cur, leaves:(cur.leaves||[]).map(x=>x.id===id?{...x,status:sv,decidedOn:today()}:x) }), `Leave ${sv.toLowerCase()} for ${l?.employee} — they have been notified`); } finally { setBusyId(null); } };
  const delReq = (id)=>mutateData((cur)=>({ ...cur, requests:(cur.requests||[]).filter(x=>x.id!==id) }));
  // Merge the three request streams into one tracked list
  const rows = [
    ...(data.leaves||[]).map(l=>({ key:"L"+l.id, id:l.id, kind:"leave", employee:l.employee, title:`${l.type||"Leave"} leave`, details:`${l.from} → ${l.to} · ${dayCount(l.from,l.to)}d${l.reason?` · ${l.reason}`:""}`, date:l.requestedOn||l.from, status:l.status, decidedOn:l.decidedOn })),
    ...(data.requests||[]).map(r=>({ key:"R"+r.id, id:r.id, kind:"cert", employee:r.employee, title:r.type, details:r.note||"", date:r.date, status:r.status, decidedOn:r.decidedOn })),
    ...(data.payables||[]).filter(p=>p.kind==="reimbursement").map(p=>({ key:"P"+p.id, id:p.id, kind:"reimb", employee:p.vendor, title:"Expense claim", details:`${fmt(p.amount)}${p.note?` · ${p.note}`:""}`, date:p.date, status:p.status, decidedOn:p.decidedOn })),
    ...(data.attendance||[]).filter(a=>a.timeReq).map(a=>({ key:"T"+a.id, id:a.id, kind:"time", field:"timeReq", employee:a.employee, title:"Check-in time correction", details:`${a.date}: ${a.checkIn?`recorded ${timeOf(a.checkIn)}`:"no check-in recorded"} → asking for ${timeOf(a.timeReq.requested)}${a.timeReq.reason?` · ${a.timeReq.reason}`:""}`, date:a.date, status:a.timeReq.status, decidedOn:a.timeReq.decidedOn })),
    ...(data.attendance||[]).filter(a=>a.outReq).map(a=>({ key:"O"+a.id, id:a.id, kind:"time", field:"outReq", employee:a.employee, title:"Check-out time correction", details:`${a.date}: ${a.checkOut?`recorded ${timeOf(a.checkOut)}`:"no check-out recorded"} → asking for ${timeOf(a.outReq.requested)}${a.outReq.reason?` · ${a.outReq.reason}`:""}`, date:a.date, status:a.outReq.status, decidedOn:a.outReq.decidedOn })),
    ...(data.wfhRequests||[]).map(w=>({ key:"W"+w.id, id:w.id, kind:"wfh", employee:w.employee, title:"Work from home", details:`${w.date}${w.reason?` · ${w.reason}`:""}`, date:w.date, status:w.status, decidedOn:w.decidedOn })),
  ].sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  const isOpen = (r)=> r.kind==="leave" ? r.status==="Pending" : r.kind==="cert" ? (r.status!=="Done"&&r.status!=="Declined") : r.status==="Pending";
  const filtered = rows.filter(r=>(kind==="all"||r.kind===kind) && (st==="all" ? true : st==="open" ? isOpen(r) : !isOpen(r)));
  // Batch actions apply to certificate/profile requests — the ones that pile up as
  // duplicates. Leave and expense decisions stay one-by-one on purpose.
  const bq = useBatch(filtered.filter(r=>r.kind==="cert").map(r=>({ id:r.key })));
  const bqIds = () => new Set(bq.selected.map(k=>k.slice(1)));
  const bulkDone = async () => { const ids=bqIds(); await mutateData((cur)=>({ ...cur, requests:(cur.requests||[]).map(r=>ids.has(r.id)?{...r,status:"Done",decidedOn:today()}:r) }), `Marked ${ids.size} request(s) done`); bq.clear(); };
  const bulkDelete = async () => { const ids=bqIds(); await mutateData((cur)=>({ ...cur, requests:(cur.requests||[]).filter(r=>!ids.has(r.id)) }), `Deleted ${ids.size} request(s)`); bq.clear(); };
  const openCount = rows.filter(isOpen).length;
  const KINDS = [["all","All"],["leave","Leave"],["wfh","Work from home"],["time","Time corrections"],["cert","Certificates"],["reimb","Expense claims"]];
  const kindPill = (k)=> k==="leave"?"bg-sky-100 text-sky-700":k==="cert"?"bg-violet-100 text-violet-700":k==="time"?"bg-teal-100 text-teal-700":k==="wfh"?"bg-indigo-100 text-indigo-700":"bg-amber-100 text-amber-700";
  return (<>
    <Head title="HR Requests" sub={`Every request your team sends — leave, certificates, expense claims · ${openCount} awaiting action`}/>
    <div className="flex flex-wrap gap-2 mb-4">
      {KINDS.map(([k,l])=>{ const n=rows.filter(r=>(k==="all"||r.kind===k)&&isOpen(r)).length; return <Btn key={k} variant={kind===k?"primary":"ghost"} onClick={()=>setKind(k)}>{l}{n?` · ${n}`:""}</Btn>; })}
      <div className="flex-1"/>
      {[["open","Awaiting"],["decided","Handled"],["all","All"]].map(([k,l])=><Btn key={k} variant={st===k?"primary":"ghost"} onClick={()=>setSt(k)}>{l}</Btn>)}
    </div>
    <BatchBar count={bq.count} noun="request" onClear={bq.clear} onDelete={bulkDelete}>
      <Btn variant="ghost" onClick={bulkDone}><Check size={15}/>Mark done</Btn>
    </BatchBar>
    <Card><Table cols={[<SelBox key="a" on={bq.allOn} onChange={bq.toggleAll} title="Select all certificate requests"/>,"Employee","Request","Details","Date","Status",""]}>{filtered.length===0?<tr><td colSpan={7}><Empty msg={st==="open"?"Nothing awaiting action — all caught up":"No requests here yet"}/></td></tr>:filtered.map(r=>(
      <Row key={r.key}>
        <Td className="w-8">{r.kind==="cert" ? <SelBox on={bq.has(r.key)} onChange={()=>bq.toggle(r.key)}/> : <span className="text-slate-300 text-xs">—</span>}</Td>
        <Td className="font-medium">{r.employee}</Td>
        <Td><span className={`text-xs px-2 py-0.5 rounded-full ${kindPill(r.kind)}`}>{r.title}</span></Td>
        <Td className="text-slate-500 text-xs max-w-[260px]">{r.details||"—"}</Td>
        <Td className="text-slate-500 whitespace-nowrap">{r.date}</Td>
        <Td><Pill s={r.status}/>{r.decidedOn&&<div className="text-xs text-slate-400 mt-0.5">{r.decidedOn}</div>}</Td>
        <Td>{busyId===r.key ? <span className="flex items-center gap-1.5 justify-end text-xs text-slate-500"><Loader2 size={13} className="animate-spin"/>Processing…</span>
          : r.kind==="time" && r.status==="Pending" ? <div className="flex gap-1 justify-end"><button disabled={!!busyId} onClick={()=>setTimeReq(r.id,"Approved",r.field)} title="Approve corrected time" className="p-1.5 rounded text-emerald-600 hover:bg-slate-100 disabled:opacity-40"><Check size={15}/></button><button disabled={!!busyId} onClick={()=>setTimeReq(r.id,"Rejected",r.field)} title="Decline — keep the recorded time" className="p-1.5 rounded text-rose-500 hover:bg-slate-100 disabled:opacity-40"><X size={15}/></button></div>
          : r.kind==="wfh" && r.status==="Pending" ? <div className="flex gap-1 justify-end"><button disabled={!!busyId} onClick={()=>setWfh(r.id,"Approved")} title="Approve work from home" className="p-1.5 rounded text-emerald-600 hover:bg-slate-100 disabled:opacity-40"><Check size={15}/></button><button disabled={!!busyId} onClick={()=>setWfh(r.id,"Rejected")} title="Decline" className="p-1.5 rounded text-rose-500 hover:bg-slate-100 disabled:opacity-40"><X size={15}/></button></div>
          : r.kind==="leave" && r.status==="Pending" ? <div className="flex gap-1 justify-end"><button disabled={!!busyId} onClick={()=>setLeave(r.id,"Approved")} title="Approve" className="p-1.5 rounded text-emerald-600 hover:bg-slate-100 disabled:opacity-40"><Check size={15}/></button><button disabled={!!busyId} onClick={()=>setLeave(r.id,"Rejected")} title="Decline" className="p-1.5 rounded text-rose-500 hover:bg-slate-100 disabled:opacity-40"><X size={15}/></button></div>
          : r.kind==="cert" ? <RowActions onDelete={()=>delReq(r.id)}>{r.status!=="Done"&&<button disabled={!!busyId} onClick={()=>setReqStatus(r.id,"Done")} title="Mark done" className="p-1.5 rounded text-emerald-600 hover:bg-slate-100 disabled:opacity-40"><Check size={15}/></button>}</RowActions>
          : r.kind==="reimb" && r.status==="Pending" ? <button onClick={()=>go("payables")} className="text-xs text-sky-600 hover:underline whitespace-nowrap">Review in Payables</button>
          : <span className="text-xs text-slate-400">—</span>}</Td>
      </Row>))}</Table></Card>
    <p className="text-xs text-slate-400 mt-3">Leave decisions notify the employee automatically. Expense claims are approved in Payables (where you choose salary or direct payment) — this list tracks their status.</p>
  </>);
}
function Announcements({ data, update }) {
  const rows = data.announcements; const [f, setF] = useState(null); const [confirmId, setConfirmId] = useState(null);
  const save = ()=>{ update("announcements", [{ id:uid(), title:f.title, body:f.body, date:today() }, ...rows], `Posted announcement: ${f.title}`); setF(null); };
  return (<>
    <Head title="Announcements" sub="Posted to every team member's home screen" action={<Btn onClick={()=>setF({title:"",body:""})}><Plus size={15}/>New post</Btn>}/>
    <div className="space-y-3">{rows.length===0?<Card><Empty msg="No announcements yet"/></Card>:rows.map(an=>(<Card key={an.id}><div className="p-5 flex justify-between gap-4"><div><div className="font-semibold">{an.title}</div><div className="text-sm text-slate-600 mt-1">{an.body}</div><div className="text-xs text-slate-400 mt-2">{an.date}</div></div>{confirmId===an.id?<span className="flex items-center gap-1 self-start shrink-0"><button onClick={()=>{update("announcements",rows.filter(x=>x.id!==an.id));setConfirmId(null);}} className="text-xs font-medium text-white bg-rose-600 hover:bg-rose-700 rounded px-2 py-1">Delete?</button><button onClick={()=>setConfirmId(null)} className="text-xs text-slate-500 px-1">No</button></span>:<button onClick={()=>setConfirmId(an.id)} className="text-slate-400 hover:text-rose-500 shrink-0"><Trash2 size={16}/></button>}</div></Card>))}</div>
    {f && <Modal title="New announcement" onClose={()=>setF(null)}><Field label="Title" value={f.title} onChange={e=>setF({...f,title:e.target.value})}/><Area label="Message" value={f.body} onChange={e=>setF({...f,body:e.target.value})}/><Btn onClick={save}><Check size={15}/>Post</Btn></Modal>}
  </>);
}

function Audit({ data }) {
  return (<>
    <Head title="Activity Log" sub="A record of key changes made in the workspace"/>
    <Card><Table cols={["When","Who","Action"]}>{(!data.audit||data.audit.length===0)?<tr><td colSpan={3}><Empty msg="No activity logged yet"/></td></tr>:data.audit.map(a=>(<Row key={a.id}><Td className="text-slate-500 whitespace-nowrap">{dtOf(a.date)}</Td><Td className="font-medium whitespace-nowrap">{a.who}</Td><Td>{a.action}</Td></Row>))}</Table></Card>
  </>);
}

function Vault({ data, patch }) {
  const meta = data.vaultMeta; // { salt, check:{iv,ct} } — check is the word "ok" encrypted, to verify the master pw
  const rows = data.vault || [];
  const [key, setKey] = useState(null);        // unlocked AES key (in memory only)
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null);      // entry being added/edited (plaintext password in memory)
  const [reveal, setReveal] = useState({});    // id -> decrypted password string
  const [q, setQ] = useState("");

  // First-time: set master password
  const setupMaster = async () => {
    if (pw.length < 6) { setErr("Use at least 6 characters."); return; }
    if (pw !== pw2) { setErr("Passwords don't match."); return; }
    setBusy(true);
    const salt = randSaltB64();
    const k = await deriveKey(pw, salt);
    const check = await vaultEncrypt(k, "vault-ok");
    patch({ vaultMeta: { salt, check } }, "Initialised the credentials vault");
    setKey(k); setPw(""); setPw2(""); setErr(""); setBusy(false);
  };
  // Unlock existing vault
  const unlock = async () => {
    setBusy(true); setErr("");
    try {
      const k = await deriveKey(pw, meta.salt);
      const test = await vaultDecrypt(k, meta.check.iv, meta.check.ct);
      if (test !== "vault-ok") throw new Error();
      setKey(k); setPw("");
    } catch { setErr("Wrong master password."); }
    setBusy(false);
  };
  const lock = () => { setKey(null); setReveal({}); };

  const saveEntry = async () => {
    if (!edit.label) { setErr("Add a label."); return; }
    const enc = await vaultEncrypt(key, edit.password || "");
    const rec = { id: edit.id || uid(), label:edit.label, username:edit.username||"", url:edit.url||"", category:edit.category||"Other", relatedTo:edit.relatedTo||"", notes:edit.notes||"", iv:enc.iv, ct:enc.ct, date: edit.date||today() };
    const next = edit.id ? rows.map(r=>r.id===edit.id?rec:r) : [...rows, rec];
    patch({ vault: next }, edit.id?`Updated vault entry "${edit.label}"`:`Added vault entry "${edit.label}"`);
    setEdit(null);
  };
  const openEdit = async (r) => {
    let plain = "";
    if (r) { try { plain = await vaultDecrypt(key, r.iv, r.ct); } catch {} }
    setEdit(r ? { ...r, password:plain } : { label:"", username:"", password:"", url:"", category:"Client", relatedTo:"", notes:"" });
  };
  const toggleReveal = async (r) => {
    if (reveal[r.id]) { setReveal(s=>{ const n={...s}; delete n[r.id]; return n; }); return; }
    try { const p = await vaultDecrypt(key, r.iv, r.ct); setReveal(s=>({ ...s, [r.id]:p })); } catch {}
  };
  const copyPw = async (r) => { try { const p = await vaultDecrypt(key, r.iv, r.ct); await navigator.clipboard.writeText(p); } catch {} };
  const del = (r) => patch({ vault: rows.filter(x=>x.id!==r.id) }, `Deleted vault entry "${r.label}"`);

  // --- screens ---
  if (!meta) return (<>
    <Head title="Vault" sub="Securely store usernames & passwords for clients, platforms and your own accounts"/>
    <Card><div className="p-6 max-w-md">
      <div className="flex items-center gap-2 font-semibold mb-1"><Lock size={16} className="text-sky-600"/>Set a master password</div>
      <p className="text-sm text-slate-500 mb-4">This unlocks the vault and encrypts every stored password. <b>If it's lost, stored passwords can't be recovered</b> — keep it safe.</p>
      <Field label="Master password" type="password" value={pw} onChange={e=>{setPw(e.target.value);setErr("");}}/>
      <Field label="Confirm master password" type="password" value={pw2} onChange={e=>{setPw2(e.target.value);setErr("");}}/>
      {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
      <Btn onClick={setupMaster} disabled={busy}>{busy?<Loader2 size={15} className="animate-spin"/>:<Lock size={15}/>}Create vault</Btn>
    </div></Card>
  </>);

  if (!key) return (<>
    <Head title="Vault" sub="Locked — enter the master password to view stored credentials"/>
    <Card><div className="p-6 max-w-md">
      <div className="flex items-center gap-2 font-semibold mb-3"><Lock size={16} className="text-sky-600"/>Unlock vault</div>
      <Field label="Master password" type="password" value={pw} onChange={e=>{setPw(e.target.value);setErr("");}}/>
      {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
      <Btn onClick={unlock} disabled={busy}>{busy?<Loader2 size={15} className="animate-spin"/>:<Lock size={15}/>}Unlock</Btn>
    </div></Card>
  </>);

  const filtered = rows.filter(r=>{ const s=(q||"").toLowerCase(); return !s || r.label.toLowerCase().includes(s) || (r.username||"").toLowerCase().includes(s) || (r.relatedTo||"").toLowerCase().includes(s) || (r.category||"").toLowerCase().includes(s); });
  return (<>
    <Head title="Vault" sub={`${rows.length} stored credentials · encrypted`} action={<div className="flex gap-2"><Btn variant="ghost" onClick={lock}><Lock size={15}/>Lock</Btn><Btn onClick={()=>openEdit(null)}><Plus size={15}/>Add credential</Btn></div>}/>
    <div className="mb-4"><Field label="" value={q} onChange={e=>setQ(e.target.value)} placeholder="Search by platform, username, client…"/></div>
    <Card><Table cols={["Platform / label","Username / email","Password","Category","Related to",""]}>{filtered.length===0?<tr><td colSpan={6}><Empty msg="No credentials stored yet"/></td></tr>:filtered.map(r=>(
      <Row key={r.id}><Td className="font-medium">{r.label}{r.url&&<a href={r.url.startsWith("http")?r.url:"https://"+r.url} target="_blank" rel="noopener" className="block text-xs text-sky-600 hover:underline truncate max-w-[160px]">{r.url}</a>}</Td>
      <Td className="text-slate-500">{r.username||"—"}</Td>
      <Td><div className="flex items-center gap-2"><span className="font-mono text-xs">{reveal[r.id]?reveal[r.id]:"••••••••"}</span><button onClick={()=>toggleReveal(r)} className="text-slate-400 hover:text-sky-600" title={reveal[r.id]?"Hide":"Reveal"}>{reveal[r.id]?<EyeOff size={14}/>:<Eye size={14}/>}</button><button onClick={()=>copyPw(r)} className="text-slate-400 hover:text-sky-600" title="Copy"><Copy size={14}/></button></div></Td>
      <Td><span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{r.category}</span></Td>
      <Td className="text-slate-500">{r.relatedTo||"—"}</Td>
      <Td><RowActions onEdit={()=>openEdit(r)} onDelete={()=>del(r)}/></Td></Row>))}</Table></Card>

    {edit && <Modal title={edit.id?"Edit credential":"Add credential"} onClose={()=>setEdit(null)}>
      <Field label="Platform / label" value={edit.label} onChange={e=>setEdit({...edit,label:e.target.value})} placeholder="e.g. Meta Ads — Ixora, Gmail, Bank portal"/>
      <Select label="Category" options={["Client","Own","Platform","Bank","Other"]} value={edit.category} onChange={e=>setEdit({...edit,category:e.target.value})}/>
      <Field label="Related to (client / person, optional)" value={edit.relatedTo} onChange={e=>setEdit({...edit,relatedTo:e.target.value})}/>
      <Field label="Username / email" value={edit.username} onChange={e=>setEdit({...edit,username:e.target.value})}/>
      <Field label="Password" value={edit.password} onChange={e=>setEdit({...edit,password:e.target.value})}/>
      <Field label="URL (optional)" value={edit.url} onChange={e=>setEdit({...edit,url:e.target.value})} placeholder="https://…"/>
      <Area label="Notes (optional)" value={edit.notes} onChange={e=>setEdit({...edit,notes:e.target.value})}/>
      {err && <div className="text-sm text-rose-600">{err}</div>}
      <Btn onClick={saveEntry}><Check size={15}/>Save</Btn>
    </Modal>}
  </>);
}

function StorageCard() {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const check = async () => {
    setBusy("check"); setMsg(null);
    try { setInfo(await apiReq("GET", "/files/_/state-size")); }
    catch (e) { setMsg({ ok:false, text:e.message || "Couldn't measure storage." }); }
    setBusy("");
  };
  useEffect(() => { check(); }, []);
  const cleanup = async () => {
    if (!confirm("Move every uploaded file out of the main data record into file storage?\n\nThis is safe — the files stay available exactly as before, they just stop being copied on every save.")) return;
    setBusy("move"); setMsg(null);
    try {
      const r = await apiReq("POST", "/files/migrate-state", {});
      setMsg({ ok:true, text:`Moved ${r.moved} file(s). The main record went from ${r.beforeMb} MB to ${r.afterMb} MB. Reloading…` });
      setTimeout(()=>window.location.reload(), 2500);
    } catch (e) { setMsg({ ok:false, text:e.message || "Cleanup failed." }); }
    setBusy("");
  };
  const heavy = info && info.docMb >= 3;
  return (<Card><div className="p-5 space-y-3">
    <div className="font-semibold text-sm">Storage health</div>
    {info ? (<div className="text-sm text-slate-600 space-y-1">
      <div className="flex justify-between"><span className="text-slate-500">Main data record</span><b className={heavy?"text-rose-600":"text-emerald-600"}>{info.docMb} MB</b></div>
      <div className="flex justify-between"><span className="text-slate-500">Files in storage</span><b>{info.files} ({info.filesMb} MB)</b></div>
    </div>) : <div className="text-sm text-slate-400">Checking…</div>}
    {heavy && <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">The main record is large because uploaded files are stored inside it. Every save has to send all of it — that is what made saving fail and the server restart. Run the cleanup below; it only needs doing once.</div>}
    {info && !heavy && <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">Healthy — uploads are kept out of the main record, so saves stay fast.</div>}
    <div className="flex flex-wrap gap-2">
      <Btn onClick={cleanup} disabled={!!busy}>{busy==="move"?<Loader2 size={15} className="animate-spin"/>:<Check size={15}/>}Move uploaded files to storage</Btn>
      <Btn variant="ghost" onClick={check} disabled={!!busy}>Re-check</Btn>
    </div>
    {msg && <div className={`text-xs rounded-lg px-3 py-2 ${msg.ok?"bg-emerald-50 border border-emerald-200 text-emerald-700":"bg-rose-50 border border-rose-200 text-rose-700"}`}>{msg.text}</div>}
  </div></Card>);
}
function NightlyBackupCard({ data, patch }) {
  const cfg = { enabled:true, time:"23:59", to:"", ...(data.backupConfig||{}) };
  const [f, setF] = useState(cfg);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [status, setStatus] = useState(null);
  useEffect(() => { apiReq("GET","/backup/status").then(setStatus).catch(()=>{}); }, []);
  const save = (next) => { setF(next); patch({ backupConfig:{ ...next } }, "Updated nightly backup settings"); };
  const sendNow = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await apiReq("POST","/backup/run-now",{});
      setMsg({ ok:true, text:`Backup emailed to ${r.to} — ${r.filename} (${r.sizeMb} MB). Check your inbox.` });
      apiReq("GET","/backup/status").then(setStatus).catch(()=>{});
    } catch (e) { setMsg({ ok:false, text:e.message || "The backup couldn't be sent." }); }
    setBusy(false);
  };
  const emailReady = status ? status.emailReady : true;
  return (<Card><div className="p-5 space-y-3">
    <div className="flex items-start justify-between gap-3">
      <div><div className="font-semibold text-sm">Nightly email backup</div>
        <p className="text-xs text-slate-500 mt-0.5">A full copy of your data is emailed every night, so you always have an off-site record.</p></div>
      <label className="flex items-center gap-2 text-xs text-slate-600 whitespace-nowrap cursor-pointer">
        <input type="checkbox" checked={f.enabled!==false} onChange={e=>save({...f, enabled:e.target.checked})}/>{f.enabled!==false?"On":"Off"}</label>
    </div>
    <div className="grid sm:grid-cols-2 gap-3">
      <Field label="Send to" value={f.to} onChange={e=>setF({...f,to:e.target.value})} onBlur={()=>save(f)} placeholder={status?.mailbox || "your@email.com"}/>
      <Field label="Time (Pakistan)" type="time" value={f.time} onChange={e=>save({...f,time:e.target.value})}/>
    </div>
    {!emailReady && <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Set up Settings → Email first — the backup is sent from that mailbox.</div>}
    {status?.lastSentOn && <div className="text-xs text-slate-500">Last run: {status.lastSentOn}{status.lastResult?` · ${status.lastResult}`:""}</div>}
    <div className="flex flex-wrap gap-2">
      <Btn onClick={sendNow} disabled={busy}>{busy?<Loader2 size={15} className="animate-spin"/>:<Send size={15}/>}{busy?"Sending…":"Send a backup now"}</Btn>
    </div>
    {msg && <div className={`text-xs rounded-lg px-3 py-2 ${msg.ok?"bg-emerald-50 border border-emerald-200 text-emerald-700":"bg-rose-50 border border-rose-200 text-rose-700"}`}>{msg.text}</div>}
    <p className="text-xs text-slate-400">The attached file restores with “Restore from backup” below. Large backups arrive zipped — the portal can read those directly.</p>
  </div></Card>);
}
function Backup({ data, brand, restore, wipe, patch }) {
  const [msg, setMsg] = useState("");
  const [confirm, setConfirm] = useState(false);
  const doExport = () => { download(`svype-backup-${today()}.json`, JSON.stringify({ db:data, brand })); setMsg("Backup downloaded."); };
  const doImport = async (file) => {
    if (!file) return;
    try {
      // Nightly backups arrive gzipped when they are large — read those too.
      const text = /\.gz$/i.test(file.name)
        ? await new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text()
        : await file.text();
      const obj = JSON.parse(text);
      if (!obj || !obj.db) throw new Error("shape");
      restore(obj.db, obj.brand);
      setMsg("Backup restored successfully.");
    } catch { setMsg("That file could not be read as a Svype OS backup."); }
  };
  return (<>
    <div className="mb-5 grid lg:grid-cols-2 gap-5"><StorageCard/><NightlyBackupCard data={data} patch={patch}/></div>
    <Head title="Backup & Data" sub="Your data lives in this browser — download a backup regularly, or restore from one"/>
    <div className="grid sm:grid-cols-2 gap-5">
      <Card><div className="p-5"><div className="font-semibold text-sm mb-1">Download backup</div><p className="text-sm text-slate-500 mb-4">Saves all your data (employees, clients, finance, documents, settings) to a single file you can keep safe.</p><Btn onClick={doExport}><Download size={15}/>Download backup file</Btn></div></Card>
      <Card><div className="p-5"><div className="font-semibold text-sm mb-1">Restore from backup</div><p className="text-sm text-slate-500 mb-4">Loads a previously downloaded backup. This replaces the current data — use it on a new device, or to migrate to the hosted version.</p><label className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 cursor-pointer"><Upload size={15}/>Choose backup file<input type="file" accept="application/json,.json" className="hidden" onChange={e=>doImport(e.target.files[0])}/></label></div></Card>
    </div>
    {msg && <div className="mt-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5">{msg}</div>}
    <div className="mt-5"><Card><div className="p-5">
      <div className="font-semibold text-sm mb-1 text-rose-600">Clear all data & reset</div>
      <p className="text-sm text-slate-500 mb-4">Permanently erases everything stored in this browser — all employees, clients, finance records, users and settings — and returns the app to first-time setup. This cannot be undone, so download a backup first.</p>
      {!confirm ? <Btn variant="danger" onClick={()=>setConfirm(true)}><Trash2 size={15}/>Clear all data</Btn>
      : <div className="flex flex-wrap items-center gap-2"><span className="text-sm text-slate-700">Are you sure? This wipes everything.</span><Btn variant="danger" onClick={wipe}><Trash2 size={15}/>Yes, erase everything</Btn><Btn variant="ghost" onClick={()=>setConfirm(false)}>Cancel</Btn></div>}
    </div></Card></div>
    <p className="text-xs text-slate-400 mt-4">Tip: download a backup before clearing your browser, switching devices, or moving to the server version.</p>
  </>);
}

function BankAccounts({ data, update }) {
  const rows = data.bankAccounts || [];
  const [edit, setEdit] = useState(null); const [tab, setTab] = useState("Company");
  const [copiedId, setCopiedId] = useState(null);
  const acctText = (a) => [
    a.title && `Account Title: ${a.title}`,
    a.bank && `Bank: ${a.bank}`,
    `Account Number: ${a.number}`,
    a.iban && `IBAN: ${a.iban}`,
  ].filter(Boolean).join("\n");
  const copyAcct = async (a) => {
    const text = acctText(a);
    try { await navigator.clipboard.writeText(text); }
    catch {
      // fallback for browsers where the clipboard API is blocked
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
      ta.select(); try { document.execCommand("copy"); } catch {} ta.remove();
    }
    setCopiedId(a.id); setTimeout(()=>setCopiedId(c=>c===a.id?null:c), 1800);
  };
  const blank = { type:"Company", label:"", title:"", number:"", iban:"", bank:"", notes:"" };
  const save = (a) => {
    if (!a.label || !a.number) return;
    if (a.id) update("bankAccounts", rows.map(x=>x.id===a.id?a:x), `Updated bank account: ${a.label}`);
    else update("bankAccounts", [{ ...a, id:uid() }, ...rows], `Added bank account: ${a.label}`);
    setEdit(null);
  };
  const list = rows.filter(a=>a.type===tab);
  return (<>
    <Head title="Bank Accounts" sub="Company and founder accounts — kept in one place for whenever they're needed" action={<Btn onClick={()=>setEdit({...blank, type:tab})}><Plus size={15}/>Add account</Btn>}/>
    <div className="flex flex-wrap gap-2 mb-4">{["Company","Founder personal"].map(t=>(<Btn key={t} variant={tab===t?"primary":"ghost"} onClick={()=>setTab(t)}>{t} ({rows.filter(a=>a.type===t).length})</Btn>))}</div>
    {list.length===0?<Card><Empty msg={`No ${tab.toLowerCase()} accounts yet`}/></Card>:<div className="grid sm:grid-cols-2 gap-4">{list.map(a=>(
      <Card key={a.id}><div className="p-4">
        <div className="flex items-start justify-between"><div className="font-semibold">{a.label}</div><RowActions onEdit={()=>setEdit(a)} onDelete={()=>update("bankAccounts", rows.filter(x=>x.id!==a.id), `Removed bank account: ${a.label}`)}/></div>
        <div className="text-sm mt-2 space-y-1">
          {a.bank && <div><span className="text-slate-500">Bank: </span>{a.bank}</div>}
          {a.title && <div><span className="text-slate-500">Title: </span>{a.title}</div>}
          <div><span className="text-slate-500">Account #: </span><b>{a.number}</b></div>
          {a.iban && <div><span className="text-slate-500">IBAN: </span><b>{a.iban}</b></div>}
          {a.notes && <div className="text-slate-500 text-xs mt-1">{a.notes}</div>}
        </div>
        <button onClick={()=>copyAcct(a)} className={`mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium border transition ${copiedId===a.id?"bg-emerald-50 border-emerald-300 text-emerald-700":"bg-white border-slate-300 text-slate-700 hover:border-sky-400 hover:text-sky-700"}`}>
          {copiedId===a.id ? <><Check size={15}/>Copied — ready to paste</> : <><Copy size={15}/>Copy bank details</>}
        </button>
      </div></Card>))}</div>}
    {edit && <Modal title={edit.id?"Edit account":"Add account"} onClose={()=>setEdit(null)}>
      <Select label="Type" options={["Company","Founder personal"]} value={edit.type} onChange={e=>setEdit({...edit,type:e.target.value})}/>
      <Field label="Label" value={edit.label} onChange={e=>setEdit({...edit,label:e.target.value})} placeholder="e.g. Meezan — Company Current"/>
      <Field label="Bank name" value={edit.bank} onChange={e=>setEdit({...edit,bank:e.target.value})}/>
      <Field label="Account title" value={edit.title} onChange={e=>setEdit({...edit,title:e.target.value})} placeholder="Name on the account"/>
      <Field label="Account number" value={edit.number} onChange={e=>setEdit({...edit,number:e.target.value})}/>
      <Field label="IBAN" value={edit.iban} onChange={e=>setEdit({...edit,iban:e.target.value})} placeholder="PK.."/>
      <Field label="Notes" value={edit.notes} onChange={e=>setEdit({...edit,notes:e.target.value})} placeholder="e.g. for vendor payments only"/>
      <Btn onClick={()=>save(edit)}><Check size={15}/>Save</Btn>
    </Modal>}
  </>);
}

function MeetingNotes({ data }) {
  const rows = (data.meetingNotes || []).slice().sort((a,b)=>b.date.localeCompare(a.date));
  const [client, setClient] = useState(""); const [emp, setEmp] = useState(""); const [view, setView] = useState(null);
  const clients = [...new Set(rows.map(n=>n.client).filter(Boolean))];
  const emps = [...new Set(rows.map(n=>n.employee).filter(Boolean))];
  const filtered = rows.filter(n=>(!client||n.client===client)&&(!emp||n.employee===emp));
  return (<>
    <Head title="Meeting Notes" sub="Client meeting notes logged by the team"/>
    <div className="flex flex-wrap gap-3 mb-4">
      <div className="max-w-xs flex-1 min-w-40"><Select label="Filter by client" options={["",...clients]} value={client} onChange={e=>setClient(e.target.value)}/></div>
      <div className="max-w-xs flex-1 min-w-40"><Select label="Filter by team member" options={["",...emps]} value={emp} onChange={e=>setEmp(e.target.value)}/></div>
    </div>
    {filtered.length===0?<Card><Empty msg="No meeting notes yet"/></Card>:<div className="space-y-3">{filtered.map(n=>(
      <Card key={n.id}><button onClick={()=>setView(n)} className="w-full text-left p-4 hover:bg-slate-50">
        <div className="flex items-center justify-between"><div className="font-semibold text-sm">{n.client||"(no client)"} · {n.title||"Meeting"}</div><span className="text-xs text-slate-400">{n.date}{n.edited?" · edited":""}</span></div>
        <div className="text-xs text-slate-500 mt-0.5">by {n.employee}</div>
        <div className="text-sm text-slate-600 mt-2 line-clamp-2" style={{display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{n.body}</div>
      </button></Card>))}</div>}
    {view && <Modal title={`${view.client||"Meeting"} · ${view.date}`} onClose={()=>setView(null)}>
      <div className="text-xs text-slate-500">By {view.employee}{view.title?` · ${view.title}`:""}</div>
      <div className="text-sm whitespace-pre-wrap bg-slate-50 border border-slate-200 rounded-lg p-3">{view.body}</div>
    </Modal>}
  </>);
}

function EmpMeetings({ data, update, me }) {
  const rows = (data.meetingNotes || []).filter(n=>n.employee===me.name).sort((a,b)=>b.date.localeCompare(a.date));
  const [edit, setEdit] = useState(null);
  const blank = { client:"", title:"", body:"", date:today() };
  const save = (n) => {
    if (!n.body) return;
    if (n.id) update("meetingNotes", (data.meetingNotes||[]).map(x=>x.id===n.id?{...n,edited:true}:x), `${me.name} edited a meeting note (${n.client||"no client"})`);
    else update("meetingNotes", [{ ...n, id:uid(), employee:me.name }, ...(data.meetingNotes||[])], `${me.name} added a meeting note (${n.client||"no client"})`);
    setEdit(null);
  };
  return (<>
    <Head title="Meeting Notes" sub="Log notes from your client meetings — HR & founder can see these" action={<Btn onClick={()=>setEdit(blank)}><Plus size={15}/>New note</Btn>}/>
    {rows.length===0?<Card><Empty msg="You haven't logged any meeting notes yet"/></Card>:<div className="space-y-3">{rows.map(n=>(
      <Card key={n.id}><div className="p-4">
        <div className="flex items-start justify-between"><div><div className="font-semibold text-sm">{n.client||"(no client)"} · {n.title||"Meeting"}</div><div className="text-xs text-slate-400">{n.date}{n.edited?" · edited":""}</div></div><button onClick={()=>setEdit(n)} className="text-slate-400 hover:text-sky-600"><Edit3 size={14}/></button></div>
        <div className="text-sm text-slate-600 mt-2 whitespace-pre-wrap">{n.body}</div>
      </div></Card>))}</div>}
    {edit && <Modal title={edit.id?"Edit note":"New meeting note"} onClose={()=>setEdit(null)}>
      <ClientInput clients={data.clients} value={edit.client} onChange={e=>setEdit({...edit,client:e.target.value})}/>
      <div className="grid grid-cols-2 gap-3"><Field label="Title" value={edit.title} onChange={e=>setEdit({...edit,title:e.target.value})} placeholder="e.g. Kickoff call"/><Field label="Date" type="date" value={edit.date} onChange={e=>setEdit({...edit,date:e.target.value})}/></div>
      <Area label="Notes" value={edit.body} onChange={e=>setEdit({...edit,body:e.target.value})} placeholder="What was discussed, decisions, action items…"/>
      <Btn onClick={()=>save(edit)}><Check size={15}/>{edit.id?"Save changes":"Save note"}</Btn>
    </Modal>}
  </>);
}

function BrandSettings({ brand, saveBrand }) {
  const [b,setB]=useState(brand); const [sigForm,setSigForm]=useState(null);
  const onLogo=async f=>{ if(f) setB({...b,logo:await readImage(f,400)}); };
  const apply=(next)=>{ setB(next); saveBrand(next); };
  const addSig=async(name,role,file)=>{ const sig=await readImage(file,500); apply({...b,signatories:[...b.signatories,{id:uid(),name,role,sig}]}); setSigForm(null); };
  const addStamp=async(label,file)=>{ const img=await readImage(file,500); apply({...b,stamps:[...b.stamps,{id:uid(),label,img}]}); };
  return (<>
    <Head title="Brand & Signatures" sub="Set once — used across every document" action={<Btn onClick={()=>saveBrand(b)}><Check size={15}/>Save changes</Btn>}/>
    <div className="grid lg:grid-cols-2 gap-5">
      <Card><div className="p-5 space-y-3"><div className="font-semibold text-sm mb-1">Letterhead</div>
        <div className="flex items-center gap-4"><label className="w-20 h-20 rounded-xl border-2 border-dashed border-slate-300 grid place-items-center cursor-pointer hover:border-sky-500 overflow-hidden">{b.logo?<img src={b.logo} className="w-full h-full object-contain p-1"/>:<Upload className="text-slate-400" size={18}/>}<input type="file" accept="image/*" className="hidden" onChange={e=>onLogo(e.target.files[0])}/></label><span className="text-xs text-slate-500">Click to replace logo</span></div>
        <Field label="Company name" value={b.company} onChange={e=>setB({...b,company:e.target.value})}/><Field label="Tagline" value={b.tagline} onChange={e=>setB({...b,tagline:e.target.value})}/><div className="grid sm:grid-cols-2 gap-3">
          <Field label="Islamabad office address" value={(b.offices?.[0]?.address)||""} onChange={e=>{const o=[...(b.offices||OFFICE_ADDRESSES)]; o[0]={...o[0],city:"Islamabad",address:e.target.value}; setB({...b,offices:o});}}/>
          <Field label="Lahore office address" value={(b.offices?.[1]?.address)||""} onChange={e=>{const o=[...(b.offices||OFFICE_ADDRESSES)]; o[1]={...o[1],city:"Lahore",address:e.target.value}; setB({...b,offices:o});}}/>
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          <Field label="Phone" value={b.phone||""} onChange={e=>setB({...b,phone:e.target.value})}/>
          <Field label="Email" value={b.email||""} onChange={e=>setB({...b,email:e.target.value})}/>
          <Field label="Website" value={b.website||""} onChange={e=>setB({...b,website:e.target.value})}/>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Select label="Payslip signature" options={["", ...(b.signatories||[]).map(x=>x.name)]} value={(b.signatories||[]).find(x=>x.id===b.payslipSigId)?.name || ""} onChange={e=>setB({...b, payslipSigId:(b.signatories||[]).find(x=>x.name===e.target.value)?.id || ""})}/>
          <Select label="Payslip stamp" options={["", ...(b.stamps||[]).map(x=>x.label)]} value={(b.stamps||[]).find(x=>x.id===b.payslipStampId)?.label || ""} onChange={e=>setB({...b, payslipStampId:(b.stamps||[]).find(x=>x.label===e.target.value)?.id || ""})}/>
        </div>
        <p className="text-xs text-slate-400 -mt-1">The chosen signature and stamp are printed on every salary slip PDF. Add them in the panels on the right first.</p>
        <label className="flex items-center gap-3"><span className="text-xs text-slate-500">Accent color</span><input type="color" value={b.accent} onChange={e=>setB({...b,accent:e.target.value})} className="w-10 h-8 bg-transparent rounded cursor-pointer"/></label>
      </div></Card>
      <div className="space-y-5">
        <Card><div className="p-5"><div className="flex items-center justify-between mb-3"><div className="font-semibold text-sm flex items-center gap-2"><PenTool size={15}/>Signatures</div><Btn variant="ghost" onClick={()=>setSigForm({name:"",role:"",file:null})}><Plus size={14}/>Add</Btn></div>
          {b.signatories.length===0?<div className="text-xs text-slate-400 py-4 text-center">No signatures yet.</div>:<div className="space-y-2">{b.signatories.map(s=>(<div key={s.id} className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg p-2"><img src={s.sig} className="h-8 bg-white rounded px-1 border border-slate-200"/><div className="flex-1"><div className="text-sm font-medium">{s.name}</div><div className="text-xs text-slate-500">{s.role}</div></div><button onClick={()=>apply({...b,signatories:b.signatories.filter(x=>x.id!==s.id)})} className="text-slate-400 hover:text-rose-500"><Trash2 size={14}/></button></div>))}</div>}
        </div></Card>
        <Card><div className="p-5"><div className="flex items-center justify-between mb-3"><div className="font-semibold text-sm flex items-center gap-2"><Stamp size={15}/>Stamps</div><label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 cursor-pointer"><Plus size={14}/>Add<input type="file" accept="image/*" className="hidden" onChange={e=>{const f=e.target.files[0];if(f){const l=prompt("Label this stamp (e.g. Company Seal)")||"Stamp";addStamp(l,f);}}}/></label></div>
          {b.stamps.length===0?<div className="text-xs text-slate-400 py-4 text-center">No stamps yet.</div>:<div className="flex flex-wrap gap-3">{b.stamps.map(s=>(<div key={s.id} className="relative bg-slate-50 border border-slate-200 rounded-lg p-2 w-24 text-center"><img src={s.img} className="h-14 mx-auto object-contain"/><div className="text-xs text-slate-500 mt-1 truncate">{s.label}</div><button onClick={()=>apply({...b,stamps:b.stamps.filter(x=>x.id!==s.id)})} className="absolute bg-white border border-slate-300 rounded-full p-1 text-slate-400 hover:text-rose-500" style={{top:-8,right:-8}}><X size={11}/></button></div>))}</div>}
        </div></Card>
      </div>
    </div>
    {sigForm && <Modal title="Add signature" onClose={()=>setSigForm(null)}><Field label="Signatory name" value={sigForm.name} onChange={e=>setSigForm({...sigForm,name:e.target.value})}/><Field label="Role / title" value={sigForm.role} onChange={e=>setSigForm({...sigForm,role:e.target.value})} placeholder="e.g. Founder & CEO"/><label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500"><Upload size={15}/>{sigForm.file?sigForm.file.name:"Upload signature PNG"}<input type="file" accept="image/*" className="hidden" onChange={e=>setSigForm({...sigForm,file:e.target.files[0]})}/></label><Btn onClick={()=>sigForm.name&&sigForm.file&&addSig(sigForm.name,sigForm.role,sigForm.file)}><Check size={15}/>Save signature</Btn></Modal>}
  </>);
}

/* ===================== TEAM CHAT (server-backed) ===================== */
function TeamChat({ session }) {
  const myId = Number(localStorage.getItem("svype_chat_uid") || 0);
  const myName = session?.username || session?.name || "me";
  const [channels, setChannels] = useState([]);
  const [directory, setDirectory] = useState([]);
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [newCh, setNewCh] = useState("");
  const [showDir, setShowDir] = useState(false);
  const wsRef = useRef(null);
  const endRef = useRef(null);

  const loadChannels = async () => {
    try { const ch = await apiReq("GET", "/chat/channels"); setChannels(ch); if (!active && ch.length) setActive(ch[0]); } catch {}
  };
  useEffect(() => { loadChannels(); apiReq("GET", "/chat/directory").then(setDirectory).catch(()=>{}); }, []);

  useEffect(() => {
    const ws = chatSocket((m) => { if (m.type === "message" && m.channelId === active?.id) setMessages((p) => p.some(x=>x.id===m.message.id) ? p : [...p, m.message]); });
    wsRef.current = ws;
    return () => ws.close();
  }, [active?.id]);

  useEffect(() => {
    if (!active) return;
    apiReq("GET", `/chat/channels/${active.id}/messages`).then((ms) => {
      setMessages(ms);
      const send = () => wsRef.current?.readyState === 1 && wsRef.current.send(JSON.stringify({ type: "join", channelId: active.id }));
      if (wsRef.current?.readyState === 1) send(); else setTimeout(send, 300);
    }).catch(()=>{});
  }, [active]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = async () => { if (!text.trim() || !active) return; const body = text.trim(); setText(""); try { const msg = await apiReq("POST", `/chat/channels/${active.id}/messages`, { body }); if (msg && msg.id) setMessages((p) => p.some(x=>x.id===msg.id) ? p : [...p, msg]); } catch {} };
  const createChannel = async () => { if (!newCh.trim()) return; try { const c = await apiReq("POST", "/chat/channels", { name: newCh.trim() }); setNewCh(""); await loadChannels(); setActive(c); } catch {} };
  const startDm = async (userId) => { try { const c = await apiReq("POST", "/chat/dm", { userId }); setShowDir(false); await loadChannels(); setActive(c); } catch {} };

  const chans = channels.filter((c) => c.kind === "channel");
  const dms = channels.filter((c) => c.kind === "dm");

  return (<>
    <Head title="Team Chat" sub="Channels and direct messages for everyone in the company"/>
    <div className="flex bg-white border border-slate-200 rounded-xl overflow-hidden" style={{ height: "70vh" }}>
      <div className="w-56 shrink-0 border-r border-slate-200 flex flex-col">
        <div className="p-3 border-b border-slate-100 flex items-center gap-1">
          <input value={newCh} onChange={(e) => setNewCh(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createChannel()} placeholder="new channel" className={inputCls + " text-xs"} />
          <button onClick={createChannel} className="p-2 rounded bg-sky-600 text-white"><Plus size={14} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          <div className="text-xs uppercase text-slate-400 px-2 mb-1">Channels</div>
          {chans.map((c) => (
            <button key={c.id} onClick={() => setActive(c)} className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-1.5 ${active?.id === c.id ? "bg-sky-50 text-sky-700" : "hover:bg-slate-50"}`}><Hash size={13} />{c.name}</button>
          ))}
          <div className="flex items-center justify-between mt-3 mb-1 px-2"><span className="text-xs uppercase text-slate-400">Direct</span><button onClick={() => setShowDir((s) => !s)} className="text-sky-600"><Plus size={13} /></button></div>
          {showDir && (<div className="bg-slate-50 rounded p-1 mb-2">{directory.length ? directory.map((u) => (<button key={u.id} onClick={() => startDm(u.id)} className="w-full text-left px-2 py-1 rounded text-xs hover:bg-white">{u.username}</button>)) : <div className="text-xs text-slate-400 px-2 py-1">No other users yet</div>}</div>)}
          {dms.map((c) => (<button key={c.id} onClick={() => setActive(c)} className={`w-full text-left px-2 py-1.5 rounded text-sm ${active?.id === c.id ? "bg-sky-50 text-sky-700" : "hover:bg-slate-50"}`}>@ {c.name}</button>))}
        </div>
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        {active ? (<>
          <div className="px-4 py-3 border-b border-slate-100 font-semibold text-sm flex items-center gap-1.5">{active.kind === "channel" ? <Hash size={15} /> : "@"} {active.name}</div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((m) => (
              <div key={m.id} className={`flex flex-col ${m.userId === myId ? "items-end" : "items-start"}`}>
                <div className="text-xs text-slate-400 mb-0.5">{m.username} · {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                <div className={`px-3 py-2 rounded-2xl text-sm max-w-md ${m.userId === myId ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-800"}`}>{m.body}</div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <div className="p-3 border-t border-slate-100 flex gap-2">
            <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={`Message ${active.kind === "channel" ? "#" + active.name : active.name}`} className={inputCls} />
            <button onClick={send} className="px-4 rounded-lg bg-sky-600 text-white"><Send size={16} /></button>
          </div>
        </>) : (<div className="flex-1 grid place-items-center text-slate-400 text-sm">Select or create a channel to start chatting</div>)}
      </div>
    </div>
  </>);
}
