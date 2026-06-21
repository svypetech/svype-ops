import React, { useState, useEffect, useRef } from "react";
import {
  LayoutDashboard, Users, CalendarCheck, Wallet, UserPlus, FolderOpen,
  FileText, ArrowDownCircle, ArrowUpCircle, ScrollText, Plus, Trash2,
  Edit3, X, Check, LogOut, Search, Download, Building2, Loader2, Settings,
  Upload, PenTool, Stamp, ChevronLeft, FileSignature, Receipt, Paperclip,
  Repeat, Send, Landmark, Menu, Megaphone, Inbox, UserCircle, Clock, MapPin,
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
let _stateCache = { doc: null, brand: null };
const DB = {
  async get(key, fb) {
    try {
      const st = await apiReq("GET", "/state");
      _stateCache = st || { doc: null, brand: null };
      if (key === "svype_db") return _stateCache.doc ?? fb;
      if (key === "svype_brand") return _stateCache.brand ?? fb;
      return fb;
    } catch { return fb; }
  },
  async set(key, v) {
    try {
      if (key === "svype_db") { _stateCache.doc = v; await apiReq("PUT", "/state", { doc: v }); }
      else if (key === "svype_brand") { _stateCache.brand = v; await apiReq("PUT", "/state", { brand: v }); }
    } catch (e) { console.error("save failed", e); }
  },
};
const uid = () => Math.random().toString(36).slice(2, 10);
const today = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);
const monthLabel = () => new Date().toLocaleString("default", { month: "long", year: "numeric" });
const fmt = (n, cur) => `${cur || "PKR"} ${Number(n || 0).toLocaleString()}`;
const timeOf = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
const dtOf = (iso) => iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const dayCount = (from, to) => { const a = new Date(from), b = new Date(to); return Math.max(1, Math.round((b - a) / 86400000) + 1); };
const daysUntil = (d) => Math.round((new Date(d) - new Date()) / 86400000);
const ENTITLEMENT = { Annual: 14, Sick: 8, Casual: 10 };
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

function readImage(file, maxW = 700) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => { const img = new Image(); img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas"); c.width = img.width * scale; c.height = img.height * scale;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL("image/png"));
    }; img.src = r.result; };
    r.readAsDataURL(file);
  });
}
function download(name, text) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "application/json" })); a.download = name; a.click(); }
// Read ANY file (PDF, doc, image) as a base64 data URL so it can be stored and re-opened.
function readFile(file) {
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
}
// Open a stored data URL (PDF/image/etc.) in a new tab.
function openDataUrl(dataUrl, name) {
  if (!dataUrl) return;
  try {
    const [meta, b64] = dataUrl.split(",");
    const mime = (meta.match(/data:(.*?);/) || [])[1] || "application/octet-stream";
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener";
    if (name) a.download = name;
    a.click(); setTimeout(()=>URL.revokeObjectURL(url), 10000);
  } catch { window.open(dataUrl, "_blank"); }
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
  accounts: [],
  announcements: [],
  requests: [], audit: [],
  users: [],
};
const SEED_BRAND = { company: "Svype Tech Limited", tagline: "Digital Marketing & Creative Agency", address: "Islamabad · Lahore, Pakistan", contact: "hello@svype.com · www.svype.com", accent: "#0284c7", logo: null, signatories: [], stamps: [] };

function ensureRetainerInvoices(db) {
  const mk = monthKey(), ml = monthLabel();
  const inv = [...(db.retainerInvoices || [])];
  let changed = false;
  const rets = (db.retainers || []).map((r) => {
    if (r.status !== "Active") return r;
    // Only auto-generate ONCE per retainer per month. The marker (lastGenMonth) means
    // deleting the generated invoice will NOT cause it to come back — generation already happened.
    if (r.lastGenMonth === mk) return r;
    const base = +r.amount || 0, carry = +r.carry || 0;
    inv.push({ id: uid(), retainerId: r.id, client: r.client, number: `RET-${mk.replace("-", "")}-${inv.length + 1}`, monthKey: mk, month: ml, base, carry, total: base + carry, currency: r.currency || "PKR", status: "Unpaid", paidAmount: 0, account: "", date: today(), paidDate: "" });
    changed = true; return { ...r, carry: 0, lastGenMonth: mk };
  });
  return changed ? { ...db, retainerInvoices: inv, retainers: rets } : db;
}

/* ---------------- notifications + search ---------------- */
function adminNotes(data) {
  const out = [];
  data.retainerInvoices.filter(i=>i.status!=="Paid").forEach(i=>out.push({ text:`${i.client}: retainer ${fmt(i.total,i.currency)} unpaid`, tab:"retainers" }));
  data.receivables.filter(r=>r.status==="Overdue").forEach(r=>out.push({ text:`${r.client}: receivable overdue`, tab:"receivables" }));
  data.payables.filter(p=>p.kind==="reimbursement" && p.status==="Pending").forEach(p=>out.push({ text:`${p.vendor}: reimbursement to approve`, tab:"payables" }));
  data.leaves.filter(l=>l.status==="Pending").forEach(l=>out.push({ text:`${l.employee}: leave pending`, tab:"attendance" }));
  data.requests.filter(r=>r.status!=="Done").forEach(r=>out.push({ text:`${r.employee}: ${r.type}`, tab:"requests" }));
  data.employees.forEach(e=>(e.docs||[]).forEach(d=>{ if(d.expiry){ const dd=daysUntil(d.expiry); if(dd<=30) out.push({ text:`${e.name}: ${d.name} ${dd<0?"expired":"expires in "+dd+"d"}`, tab:"employees" }); }}));
  return out;
}
function empNotes(data, me) {
  const out = [];
  data.leaves.filter(l=>l.employee===me.name && l.status!=="Pending").slice(0,5).forEach(l=>out.push({ text:`Leave ${l.from}: ${l.status}`, tab:"attendance" }));
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
  { id:"chat", label:"Team Chat", icon:MessageSquare },
  { id:"employees", label:"Employees", icon:Users },
  { id:"users", label:"Users & Access", icon:UserCircle },
  { id:"permissions", label:"Permissions", icon:Settings, adminOnly:true },
  { id:"clients", label:"Clients", icon:Contact },
  { id:"attendance", label:"Attendance & Leave", icon:CalendarCheck },
  { id:"payroll", label:"Payroll & Slips", icon:Wallet },
  { id:"advances", label:"Advances & Loans", icon:HandCoins },
  { id:"vendorbills", label:"Vendor Bills", icon:Receipt },
  { id:"timesheets", label:"Work & Timesheets", icon:Clock },
  { id:"meetings", label:"Meeting Notes", icon:FileText },
  { id:"recruit", label:"Recruitment", icon:UserPlus },
  { id:"cvbank", label:"CV Bank", icon:FolderOpen },
  { id:"offers", label:"Offer Letters", icon:FileSignature },
  { id:"letters", label:"Letters & Certificates", icon:ScrollText },
  { id:"requests", label:"Requests", icon:Inbox },
  { id:"announce", label:"Announcements", icon:Megaphone },
  { id:"proposals", label:"Proposals", icon:FileText },
  { id:"quotations", label:"Quotations", icon:Receipt },
  { id:"retainers", label:"Retainers", icon:Repeat },
  { id:"invoices", label:"Invoices & Receipts", icon:FolderOpen },
  { id:"payables", label:"Payables", icon:ArrowUpCircle },
  { id:"receivables", label:"Receivables", icon:ArrowDownCircle },
  { id:"accounts", label:"Bank Accounts", icon:Landmark },
  { id:"brand", label:"Brand & Signatures", icon:Settings },
  { id:"audit", label:"Activity Log", icon:History },
  { id:"backup", label:"Backup & Data", icon:Database },
];
const EMP_NAV = [
  { id:"dash", label:"Home", icon:LayoutDashboard },
  { id:"chat", label:"Team Chat", icon:MessageSquare },
  { id:"profile", label:"My Profile", icon:UserCircle },
  { id:"attendance", label:"Attendance & Leave", icon:CalendarCheck },
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
  const [brand, setBrand] = useState(SEED_BRAND);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => { (async () => {
    const d = await DB.get("svype_db", null);
    let merged = d ? { ...SEED, ...d } : SEED;
    const after = ensureRetainerInvoices(merged);
    setData(after);
    if (!d || after !== merged) DB.set("svype_db", after);
    const b = await DB.get("svype_brand", null);
    if (b) setBrand(b); else { await DB.set("svype_brand", SEED_BRAND); setNeedsSetup(true); }
    // re-issue a chat token if we restored a session but lost the token
    try {
      const s = localStorage.getItem("svype_session");
      if (s && !getChatToken()) await identifyForChat(JSON.parse(s));
    } catch {}
    setLoading(false);
  })(); }, []);

  const role = session?.role || null;
  const meId = session?.empId || null;
  const who = () => role === "employee" ? (data.employees.find(e=>e.id===meId)?.name || session?.username || "Employee") : (ROLES[role] || "System");
  const auditEntry = (msg) => ({ id:uid(), who:who(), action:msg, date:new Date().toISOString() });
  // Always merge against the freshest state (functional updater) so two quick saves never clobber each other.
  const commit = (mutate, msg) => {
    setData((cur) => {
      let next = mutate(cur);
      if (msg) next = { ...next, audit: [auditEntry(msg), ...(cur.audit||[])].slice(0,500) };
      DB.set("svype_db", next);
      return next;
    });
  };
  const persist = (n) => commit(() => n);
  const update = (k, rows, audit) => commit((cur) => ({ ...cur, [k]: rows }), audit);
  const patch = (obj, audit) => commit((cur) => ({ ...cur, ...obj }), audit);
  const saveBrand = (b) => { setBrand(b); DB.set("svype_brand", b); };
  const restore = (db, br) => { if (db) commit(() => ({ ...SEED, ...db })); if (br) saveBrand(br); };
  const wipe = () => { const fresh = JSON.parse(JSON.stringify(SEED)); DB.set("svype_db", fresh); DB.set("svype_brand", SEED_BRAND); setData(fresh); setBrand(SEED_BRAND); setSession(null); setTab("dash"); };
  const reset = () => { setSession(null); setTab("dash"); };

  if (loading) return <div className="min-h-screen grid place-items-center bg-slate-50 text-sky-600"><Loader2 className="animate-spin"/></div>;
  const hasFounders = (data.users||[]).some(u=>u.role==="admin" || u.role==="hr");
  if (!hasFounders) return <FirstRunSetup data={data} brand={brand} onCreate={(u)=>{ update("users", [...(data.users||[]), u], `Created first ${u.role} account "${u.username}"`); }}/>;
  if (!session) return <Login data={data} brand={brand} onLogin={(u)=>{ identifyForChat(u); setSession(u); setTab("dash"); }}/>;
  if (needsSetup && role !== "employee") return <BrandSetup brand={brand} saveBrand={saveBrand} done={()=>setNeedsSetup(false)} />;

  const isEmp = role === "employee";
  const me = isEmp ? data.employees.find(e=>e.id===meId) : null;
  const perms = session?.perms || null; // null/undefined = full access
  const canSee = (n) => {
    if (n.adminOnly && role !== "admin") return false;
    if (role === "admin") return true; // founder always full
    if (n.id === "dash") return true;
    if (!perms) return true; // no restrictions set
    return perms[n.id] !== false;
  };
  const visible = (isEmp ? EMP_NAV : NAV).filter(canSee);
  const active = visible.find(n=>n.id===tab) ? tab : "dash";
  const notes = isEmp && me ? empNotes(data, me) : adminNotes(data);
  const props = { data, update, patch, role, brand, saveBrand, me, restore, wipe, session, go:setTab };

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
          {visible.map(n=>{ const I=n.icon; return (
            <button key={n.id} onClick={()=>{setTab(n.id);setNavOpen(false);}} className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm transition ${active===n.id?"bg-slate-800 text-white border-r-2 border-sky-500":"text-slate-400 hover:text-white hover:bg-slate-800"}`}>
              <I size={17}/> {n.label}</button>); })}
        </nav>
        <div className="p-4 border-t border-slate-700">
          <div className="text-xs text-slate-400 mb-2">{isEmp && me ? me.name : ROLES[role]}</div>
          <button onClick={reset} className="flex items-center gap-2 text-sm text-slate-300 hover:text-white"><LogOut size={15}/>Sign out</button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="sticky top-0 z-30 flex items-center gap-3 px-4 py-2.5 bg-white border-b border-slate-200">
          <button onClick={()=>setNavOpen(true)} className="lg:hidden text-slate-600"><Menu size={22}/></button>
          {!isEmp ? <GlobalSearch data={data} go={setTab}/> : <div className="font-semibold text-sm text-slate-700">Team Portal</div>}
          <div className="flex-1"/>
          <NotifBell items={notes} go={setTab}/>
        </div>
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
            {active==="payslips" && <EmpPayslips {...props}/>}
            {active==="timesheet" && <EmpTimesheet {...props}/>}
            {active==="meetings" && <EmpMeetings {...props}/>}
            {active==="expenses" && <EmpExpenses {...props}/>}
          </>)) : (<>
            {active==="dash" && <Dashboard {...props}/>}
            {active==="chat" && <TeamChat session={session}/>}
            {active==="employees" && <Employees {...props}/>}
            {active==="users" && <UsersAccess {...props}/>}
            {active==="permissions" && <Permissions {...props}/>}
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
            {active==="payables" && <Payables {...props}/>}
            {active==="receivables" && <Receivables {...props}/>}
            {active==="accounts" && <BankAccounts {...props}/>}
            {active==="brand" && <BrandSettings {...props}/>}
            {active==="audit" && <Audit {...props}/>}
            {active==="backup" && <Backup {...props}/>}
          </>)}
        </div>
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
        <div className="absolute z-30 mt-1 w-72 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
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
        <div className="absolute right-0 z-30 mt-1 w-72 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
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
function Login({ data, brand, onLogin }) {
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [err, setErr] = useState("");
  const submit = () => {
    const user = (data.users||[]).find(x=>x.username.toLowerCase()===u.trim().toLowerCase() && x.password===p);
    if (!user) { setErr("Incorrect username or password."); return; }
    if (!user.active) { setErr("This account has been deactivated. Contact HR."); return; }
    if (user.role === "employee" && user.empId) {
      const emp = data.employees.find(e=>e.id===user.empId);
      if (emp && emp.status !== "Active") { setErr("Your employee profile is inactive. Contact HR."); return; }
    }
    onLogin(user);
  };
  return (<div className="min-h-screen grid place-items-center bg-slate-900 text-white p-4"><div className="text-center max-w-sm w-full">
    {brand.logo ? <img src={brand.logo} className="w-16 h-16 rounded-2xl object-contain bg-slate-800 mx-auto mb-5"/> : <div className="w-14 h-14 rounded-2xl bg-sky-600 grid place-items-center text-white font-black text-2xl mx-auto mb-5">S</div>}
    <h1 className="text-2xl font-bold tracking-tight">{brand.company}</h1>
    <p className="text-slate-400 text-sm mb-8">Sign in to your account.</p>
    <div className="space-y-3 text-left">
      <div><span className="text-xs text-slate-400 mb-1 block">Username</span><input value={u} onChange={e=>{setU(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&submit()} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-sky-500" placeholder="username"/></div>
      <div><span className="text-xs text-slate-400 mb-1 block">Password</span><input type="password" value={p} onChange={e=>{setP(e.target.value);setErr("");}} onKeyDown={e=>e.key==="Enter"&&submit()} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-sky-500" placeholder="••••••••"/></div>
      {err && <div className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div>}
      <button onClick={submit} className="w-full py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white font-medium transition">Sign in</button>
    </div>
    <p className="text-xs text-slate-500 mt-6">Don't have an account? Ask HR to create one for you.</p>
  </div></div>);
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
    <div className="space-y-3"><Field label="Company name" value={b.company} onChange={e=>setB({...b,company:e.target.value})}/><Field label="Tagline" value={b.tagline} onChange={e=>setB({...b,tagline:e.target.value})}/><Field label="Address" value={b.address} onChange={e=>setB({...b,address:e.target.value})}/><Field label="Contact line" value={b.contact} onChange={e=>setB({...b,contact:e.target.value})}/></div>
    <div className="mt-6 flex justify-end gap-2"><Btn variant="ghost" onClick={()=>{saveBrand(b);done();}}>Skip for now</Btn><Btn onClick={()=>{saveBrand(b);done();}}><Check size={15}/>Save letterhead</Btn></div>
  </div></div>);
}

/* ---------------- shared UI ---------------- */
const Head = ({ title, sub, action }) => (<div className="flex flex-wrap items-end justify-between gap-3 mb-6"><div><h2 className="text-xl font-bold tracking-tight text-slate-900">{title}</h2>{sub && <p className="text-sm text-slate-500 mt-0.5">{sub}</p>}</div>{action}</div>);
const Btn = ({ children, onClick, variant="primary" }) => { const s={primary:"bg-sky-600 text-white hover:bg-sky-700",ghost:"bg-white border border-slate-300 text-slate-700 hover:bg-slate-100",danger:"bg-white border border-rose-300 text-rose-600 hover:bg-rose-50",ok:"bg-emerald-600 text-white hover:bg-emerald-700"}; return <button onClick={onClick} className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium transition ${s[variant]}`}>{children}</button>; };
const Card = ({ children }) => <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">{children}</div>;
const Pill = ({ s }) => { const m={Active:"bg-emerald-100 text-emerald-700",Paid:"bg-emerald-100 text-emerald-700",Sent:"bg-sky-100 text-sky-700",Accepted:"bg-emerald-100 text-emerald-700",Done:"bg-emerald-100 text-emerald-700",Cleared:"bg-emerald-100 text-emerald-700",Pending:"bg-amber-100 text-amber-700",Unpaid:"bg-amber-100 text-amber-700",Open:"bg-amber-100 text-amber-700",Requested:"bg-amber-100 text-amber-700","Pending HR":"bg-amber-100 text-amber-700","Pending Founder":"bg-sky-100 text-sky-700",Partial:"bg-orange-100 text-orange-700",Outstanding:"bg-amber-100 text-amber-700",Overdue:"bg-rose-100 text-rose-700",Approved:"bg-emerald-100 text-emerald-700",Rejected:"bg-rose-100 text-rose-700",Draft:"bg-slate-100 text-slate-600",Inactive:"bg-slate-100 text-slate-600",Paused:"bg-slate-100 text-slate-600"}; return <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${m[s]||"bg-slate-100 text-slate-600"}`}>{s}</span>; };
function Modal({ title, onClose, children }) {
  return <div className="fixed inset-0 grid place-items-center z-50 p-4" style={{background:"rgba(15,23,42,.5)"}} onClick={onClose}>
    <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-y-auto shadow-xl" style={{maxHeight:"85vh"}} onClick={e=>e.stopPropagation()}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200"><h3 className="font-semibold text-slate-900">{title}</h3><button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18}/></button></div>
      <div className="p-5 space-y-3">{children}</div></div></div>;
}
const inputCls = "w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:ring-1 focus:ring-sky-200 outline-none";
const Field = ({ label, ...p }) => (<label className="block"><span className="text-xs text-slate-500 mb-1 block">{label}</span><input {...p} className={inputCls}/></label>);
const Area = ({ label, ...p }) => (<label className="block"><span className="text-xs text-slate-500 mb-1 block">{label}</span><textarea {...p} rows={3} className={inputCls+" resize-y"}/></label>);
const Select = ({ label, options, ...p }) => (<label className="block"><span className="text-xs text-slate-500 mb-1 block">{label}</span><select {...p} className={inputCls}>{options.map(o=><option key={o} value={o}>{o||"—"}</option>)}</select></label>);
const Table = ({ cols, children }) => (<div className="overflow-x-auto"><table className="w-full text-sm" style={{minWidth:480}}><thead><tr className="text-left text-slate-500 text-xs uppercase tracking-wider border-b border-slate-200 bg-slate-50">{cols.map(c=><th key={c} className="px-4 py-3 font-medium">{c}</th>)}</tr></thead><tbody>{children}</tbody></table></div>);
const Row = ({ children, onClick }) => <tr onClick={onClick} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 ${onClick?"cursor-pointer":""}`}>{children}</tr>;
const Td = ({ children, className="" }) => <td className={`px-4 py-3 ${className}`}>{children}</td>;
const RowActions = ({ onEdit, onDelete, children }) => (<div className="flex gap-1 justify-end items-center" onClick={e=>e.stopPropagation()}>{children}{onEdit&&<button onClick={onEdit} className="p-1.5 rounded text-slate-400 hover:text-sky-600 hover:bg-slate-100"><Edit3 size={14}/></button>}{onDelete&&<button onClick={onDelete} className="p-1.5 rounded text-slate-400 hover:text-rose-500 hover:bg-slate-100"><Trash2 size={14}/></button>}</div>);
const Empty = ({ msg }) => <div className="px-4 py-12 text-center text-slate-400 text-sm">{msg}</div>;
function ClientInput({ label="Client", clients, value, onChange }) {
  return (<label className="block"><span className="text-xs text-slate-500 mb-1 block">{label}</span>
    <input list="client-list" value={value} onChange={onChange} className={inputCls} placeholder="Type or pick a client"/>
    <datalist id="client-list">{clients.map(c=><option key={c.id} value={c.name}/>)}</datalist></label>);
}

/* ---------------- leave helpers ---------------- */
function leaveUsed(data, name) { const used={Annual:0,Sick:0,Casual:0}; data.leaves.filter(l=>l.employee===name&&l.status==="Approved").forEach(l=>{ if(used[l.type]!=null) used[l.type]+=dayCount(l.from,l.to); }); return used; }
function LeaveBalances({ data, name }) {
  const used = leaveUsed(data, name);
  return (<div className="grid grid-cols-3 gap-3">{Object.keys(ENTITLEMENT).map(t=>{ const left=ENTITLEMENT[t]-used[t]; return (
    <Card key={t}><div className="p-4 text-center"><div className="text-2xl font-bold text-slate-900">{left}</div><div className="text-xs text-slate-500 mt-0.5">{t} left</div><div className="text-xs text-slate-400">of {ENTITLEMENT[t]}</div></div></Card>); })}</div>);
}

/* ---------------- payroll calc ---------------- */
function computePayslip(e, data, month) {
  const basic = +e.salary || 0;
  const allowances = Math.round(basic * 0.1);
  const reimb = data.payables.filter(p=>p.kind==="reimbursement" && p.vendor===e.name && p.status==="Approved" && !p.settled && p.payVia==="salary" && (!p.payMonth || p.payMonth===month)).reduce((s,p)=>s+ +p.amount,0);
  const tax = 0;   // not auto-calculated — set manually per payslip if needed
  const eobi = 0;  // not auto-calculated
  const pf = Math.round(basic * (+e.pf||0) / 100);
  const advance = data.advances.filter(a=>a.employee===e.name && a.status==="Active" && a.remaining>0).reduce((s,a)=>s+Math.min(+a.installment, a.remaining),0);
  const deductions = tax + eobi + pf + advance;
  return { id:uid(), employee:e.name, month, basic, allowances, reimbursements:reimb, tax, eobi, pf, advance, deductions, paid:false, date:today() };
}
const netPay = (p) => +p.basic + +p.allowances + (+p.reimbursements||0) - (+p.deductions||0);

/* ---------------- document sheet ---------------- */
function Letterhead({ brand }) {
  return (<div className="flex items-start justify-between border-b-2 pb-3 mb-5" style={{ borderColor: brand.accent }}>
    <div className="flex items-center gap-3">{brand.logo ? <img src={brand.logo} className="h-12 object-contain"/> : <Building2 size={28}/>}<div><div className="font-bold text-base leading-tight">{brand.company}</div><div className="text-xs text-slate-500">{brand.tagline}</div></div></div>
    <div className="text-right text-xs text-slate-500 leading-tight"><div>{brand.address}</div><div>{brand.contact}</div></div></div>);
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
function checkInOut(data, update, name, which) {
  const set = (loc) => {
    const ex = data.attendance.find(a=>a.employee===name && a.date===today());
    const now = new Date().toISOString();
    if (ex) update("attendance", data.attendance.map(a=>a===ex ? { ...a, status:"Present", ...(which==="in"?{checkIn:now,location:loc||a.location}:{checkOut:now}) } : a));
    else update("attendance", [...data.attendance, { id:uid(), employee:name, date:today(), status:"Present", checkIn:which==="in"?now:null, checkOut:which==="out"?now:null, location:loc }]);
  };
  if (which==="in" && navigator.geolocation) navigator.geolocation.getCurrentPosition(p=>set({lat:p.coords.latitude,lng:p.coords.longitude}), ()=>set(null), {timeout:4000});
  else set(null);
}
function CheckInCard({ data, update, me }) {
  const a = data.attendance.find(x=>x.employee===me.name && x.date===today());
  return (<Card><div className="p-5">
    <div className="flex items-center gap-2 text-sm font-semibold mb-3"><Clock size={16} className="text-sky-600"/>Today · {new Date().toLocaleDateString()}</div>
    <div className="flex flex-wrap items-center gap-3">
      <Btn variant={a?.checkIn?"ghost":"primary"} onClick={()=>checkInOut(data,update,me.name,"in")}>Check in{a?.checkIn?` · ${timeOf(a.checkIn)}`:""}</Btn>
      <Btn variant={a?.checkOut?"ghost":"ok"} onClick={()=>checkInOut(data,update,me.name,"out")}>Check out{a?.checkOut?` · ${timeOf(a.checkOut)}`:""}</Btn>
      {a?.location && <span className="text-xs text-slate-400 flex items-center gap-1"><MapPin size={12}/>location saved</span>}
    </div></div></Card>);
}
function EmpDashboard({ data, update, me }) {
  const myClaims = data.payables.filter(p=>p.kind==="reimbursement" && p.vendor===me.name && p.status!=="Paid").length;
  return (<>
    <Head title={`Hi, ${me.name.split(" ")[0]}`} sub={`${me.role} · ${me.dept}`}/>
    <div className="space-y-5">
      <CheckInCard data={data} update={update} me={me}/>
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
    <div className="grid sm:grid-cols-2 gap-4 mb-6">{[["Email",me.email],["Phone",me.phone],["CNIC",me.cnic],["Salary",fmt(me.salary)],["Joined",me.joined],["Status",me.status]].map(([k,v])=>(<Card key={k}><div className="p-4"><div className="text-xs text-slate-500">{k}</div><div className="font-medium mt-0.5">{v||"—"}</div></div></Card>))}</div>
    <div className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium">My documents</div>
    <Card><div className="p-4">{(!me.docs||me.docs.length===0)?<Empty msg="No documents on file"/>:<div className="grid sm:grid-cols-3 gap-3">{me.docs.map(d=>(<div key={d.id} className="bg-slate-50 border border-slate-200 rounded-lg overflow-hidden">{d.img?<img src={d.img} className="w-full h-32 object-cover"/>:<div className="h-32 grid place-items-center text-slate-400"><FileText/></div>}<div className="p-2 text-xs truncate">{d.name}{d.expiry&&<span className="block text-slate-400">exp {d.expiry}</span>}</div></div>))}</div>}</div></Card>
    {req!==null && <Modal title="Request a profile change" onClose={()=>setReq(null)}><Area label="What needs updating?" value={req} onChange={e=>setReq(e.target.value)} placeholder="e.g. New phone number, updated CNIC scan"/><Btn onClick={submit}><Check size={15}/>Send to HR</Btn></Modal>}
    {cert && <Modal title="Request a certificate / letter" onClose={()=>setCert(null)}>
      <Select label="What do you need?" options={["Salary Certificate","Experience Certificate","Employment Verification","Appointment Letter","Other"]} value={cert.type} onChange={e=>setCert({...cert,type:e.target.value})}/>
      <Area label="Any details for HR (optional)" value={cert.note} onChange={e=>setCert({...cert,note:e.target.value})} placeholder="e.g. addressed to the bank, needed by Friday"/>
      <Btn onClick={submitCert}><Check size={15}/>Send request to HR</Btn>
    </Modal>}
  </>);
}
function EmpAttendance({ data, update, me }) {
  const [lf, setLf] = useState(null);
  const blank = { employee:me.name, type:"Annual", from:today(), to:today(), reason:"", status:"Pending" };
  const myLeaves = data.leaves.filter(l=>l.employee===me.name);
  const myAtt = data.attendance.filter(a=>a.employee===me.name).slice().reverse().slice(0,10);
  const save = (l)=>{ update("leaves", [...data.leaves, { ...l, id:uid() }]); setLf(null); };
  return (<>
    <Head title="Attendance & Leave" sub="Check in, track your days, request leave"/>
    <div className="space-y-5">
      <CheckInCard data={data} update={update} me={me}/>
      <LeaveBalances data={data} name={me.name}/>
      <div className="flex justify-between items-center"><div className="text-xs uppercase tracking-wider text-slate-500 font-medium">My leave requests</div><Btn onClick={()=>setLf(blank)}><Plus size={15}/>Request leave</Btn></div>
      <Card><Table cols={["Type","From","To","Days","Status"]}>{myLeaves.length===0?<tr><td colSpan={5}><Empty msg="No leave requests yet"/></td></tr>:myLeaves.map(l=>(<Row key={l.id}><Td>{l.type}</Td><Td className="text-slate-500">{l.from}</Td><Td className="text-slate-500">{l.to}</Td><Td>{dayCount(l.from,l.to)}</Td><Td><Pill s={l.status}/></Td></Row>))}</Table></Card>
      <div className="text-xs uppercase tracking-wider text-slate-500 font-medium">Recent attendance</div>
      <Card><Table cols={["Date","Status","In","Out"]}>{myAtt.length===0?<tr><td colSpan={4}><Empty msg="No attendance recorded"/></td></tr>:myAtt.map(a=>(<Row key={a.id}><Td>{a.date}</Td><Td>{a.status}</Td><Td className="text-slate-500">{timeOf(a.checkIn)||"—"}</Td><Td className="text-slate-500">{timeOf(a.checkOut)||"—"}</Td></Row>))}</Table></Card>
    </div>
    {lf && <Modal title="Request leave" onClose={()=>setLf(null)}><Select label="Type" options={["Annual","Sick","Casual","Unpaid"]} value={lf.type} onChange={e=>setLf({...lf,type:e.target.value})}/><div className="grid grid-cols-2 gap-3"><Field label="From" type="date" value={lf.from} onChange={e=>setLf({...lf,from:e.target.value})}/><Field label="To" type="date" value={lf.to} onChange={e=>setLf({...lf,to:e.target.value})}/></div><Field label="Reason" value={lf.reason} onChange={e=>setLf({...lf,reason:e.target.value})}/><Btn onClick={()=>save(lf)}><Check size={15}/>Submit</Btn></Modal>}
  </>);
}
function EmpPayslips({ data, update, brand, me }) {
  const [slip, setSlip] = useState(null);
  const slips = data.payroll.filter(p=>p.employee===me.name);
  const requestCert = (type) => update("requests", [{ id:uid(), employee:me.name, type, status:"Requested", date:today() }, ...data.requests], `${me.name} requested ${type}`);
  return (<>
    <Head title="Payslips" sub="Download your slips or request a certificate"/>
    <div className="flex flex-wrap gap-2 mb-4"><Btn variant="ghost" onClick={()=>requestCert("Salary Certificate")}><FileSignature size={15}/>Request salary certificate</Btn><Btn variant="ghost" onClick={()=>requestCert("Experience Certificate")}><ScrollText size={15}/>Request experience certificate</Btn></div>
    <Card><Table cols={["Month","Net pay","Status",""]}>{slips.length===0?<tr><td colSpan={4}><Empty msg="No payslips yet"/></td></tr>:slips.map(p=>(<Row key={p.id}><Td className="font-medium">{p.month}</Td><Td>{fmt(netPay(p))}</Td><Td><Pill s={p.paid?"Paid":"Pending"}/></Td><Td><button onClick={()=>setSlip(p)} className="text-sky-600 text-xs font-medium hover:underline">View / download</button></Td></Row>))}</Table></Card>
    {slip && <SlipModal slip={slip} brand={brand} onClose={()=>setSlip(null)}/>}
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
function EmpExpenses({ data, update, me }) {
  const [f, setF] = useState({ desc:"", amount:"", receipt:null });
  const [err, setErr] = useState("");
  const mine = data.payables.filter(p=>p.kind==="reimbursement" && p.vendor===me.name);
  const onReceipt = async (file) => { if (file) { setF({ ...f, receipt: await readImage(file, 900) }); setErr(""); } };
  const submit = () => {
    if (!f.desc || !f.amount) { setErr("Please add a description and amount."); return; }
    if (!f.receipt) { setErr("A photo of the bill/receipt is required to submit a claim."); return; }
    update("payables", [{ id:uid(), vendor:me.name, desc:"Reimbursement: "+f.desc, amount:+f.amount, due:today(), status:"Pending", kind:"reimbursement", settled:false, receipt:f.receipt }, ...data.payables], `${me.name} submitted an expense claim`);
    setF({ desc:"", amount:"", receipt:null }); setErr("");
  };
  return (<>
    <Head title="Expense Claims" sub="Submit a claim with a receipt — approved claims are added to your salary"/>
    <div className="grid lg:grid-cols-2 gap-5">
      <Card><div className="p-5 space-y-3">
        <Field label="What was it for?" value={f.desc} onChange={e=>setF({...f,desc:e.target.value})} placeholder="e.g. Client meeting fuel, props for shoot"/>
        <Field label="Amount (PKR)" type="number" value={f.amount} onChange={e=>setF({...f,amount:e.target.value})}/>
        <div><span className="text-xs text-slate-500 mb-1 block">Receipt / bill photo <span className="text-rose-500">*required</span></span>
          <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500"><Paperclip size={15}/>{f.receipt?"Receipt attached":"Attach receipt / bill"}<input type="file" accept="image/*" className="hidden" onChange={e=>onReceipt(e.target.files[0])}/></label>
          {f.receipt && <img src={f.receipt} className="mt-2 h-28 rounded-lg border border-slate-200 object-cover"/>}
        </div>
        {err && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{err}</div>}
        <Btn onClick={submit}><Check size={15}/>Submit claim</Btn>
      </div></Card>
      <Card><Table cols={["Description","Amount","Status"]}>{mine.length===0?<tr><td colSpan={3}><Empty msg="No claims submitted"/></td></tr>:mine.map(p=>(<Row key={p.id}><Td className="font-medium">{p.desc.replace("Reimbursement: ","")}</Td><Td>{fmt(p.amount)}</Td><Td><Pill s={p.status}/></Td></Row>))}</Table></Card>
    </div></>);
}

/* shared slip modal */
function SlipModal({ slip, brand, onClose }) {
  return (<Modal title="Salary slip" onClose={onClose}>
    <div className="bg-white text-slate-900 rounded-lg p-5 text-sm border border-slate-200"><Letterhead brand={brand}/>
      <div className="flex justify-between mb-1"><span className="text-slate-500">Employee</span><b>{slip.employee}</b></div>
      <div className="flex justify-between mb-3"><span className="text-slate-500">Period</span><b>{slip.month}</b></div>
      <div className="space-y-1 border-t pt-3">
        <div className="flex justify-between"><span>Basic</span><span>{fmt(slip.basic)}</span></div>
        <div className="flex justify-between"><span>Allowances</span><span>{fmt(slip.allowances)}</span></div>
        {+slip.reimbursements>0 && <div className="flex justify-between"><span>Reimbursements</span><span>{fmt(slip.reimbursements)}</span></div>}
        <div className="flex justify-between text-slate-500 pt-2"><span>Income tax</span><span>-{fmt(slip.tax)}</span></div>
        <div className="flex justify-between text-slate-500"><span>EOBI</span><span>-{fmt(slip.eobi)}</span></div>
        {+slip.pf>0 && <div className="flex justify-between text-slate-500"><span>Provident fund</span><span>-{fmt(slip.pf)}</span></div>}
        {+slip.advance>0 && <div className="flex justify-between text-slate-500"><span>Advance / loan</span><span>-{fmt(slip.advance)}</span></div>}
        <div className="flex justify-between border-t pt-2 mt-2 font-bold"><span>Net pay</span><span>{fmt(netPay(slip))}</span></div>
      </div></div>
    <Btn variant="ghost" onClick={()=>window.print()}><Download size={15}/>Print / Save PDF</Btn>
  </Modal>);
}

/* ================= ADMIN / HR ================= */
function Dashboard({ data, role, go }) {
  const mrr = data.retainers.filter(r=>r.status==="Active").reduce((s,r)=>s+ +r.amount,0);
  const stats = [
    { label:"Active employees", value:data.employees.filter(e=>e.status==="Active").length, icon:Users },
    { label:"Clients", value:data.clients.length, icon:Contact },
    { label:"Retainer MRR (PKR)", value:fmt(mrr), icon:Repeat },
    { label:"Payables", value:fmt(data.payables.filter(p=>p.status!=="Paid").reduce((s,p)=>s+ +p.amount,0)), icon:ArrowUpCircle },
  ];
  const notes = adminNotes(data);
  return (<>
    <Head title="Dashboard" sub={`Welcome back · ${ROLES[role]}`}/>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">{stats.map(s=>{const I=s.icon;return(<Card key={s.label}><div className="p-5"><I className="text-sky-600 mb-3" size={20}/><div className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 break-words">{s.value}</div><div className="text-xs text-slate-500 mt-1">{s.label}</div></div></Card>);})}</div>
    <Card><div className="px-5 py-4 border-b border-slate-200 font-semibold text-sm">Needs attention</div>
      {notes.length===0?<Empty msg="Nothing pending — you're all caught up"/>:<div className="divide-y divide-slate-100">{notes.map((n,i)=>(<button key={i} onClick={()=>go(n.tab)} className="w-full text-left px-5 py-3 text-sm hover:bg-slate-50">{n.text}</button>))}</div>}
    </Card></>);
}

function Clients({ data, update, patch }) {
  const rows = data.clients;
  const [edit, setEdit] = useState(null); const [open, setOpen] = useState(null);
  const [show, setShow] = useState("active");
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
  if (open) { const c = rows.find(r=>r.id===open); if (c) return <ClientProfile c={c} data={data} onBack={()=>setOpen(null)} onEdit={()=>openEdit(c)}/>; }
  const isActive = (c)=> (c.status||"Active")==="Active";
  const filtered = rows.filter(c=> show==="all" ? true : show==="active" ? isActive(c) : !isActive(c));
  const activeCount = rows.filter(isActive).length;
  return (<>
    <Head title="Clients" sub={`${activeCount} active · ${rows.length} total · used across retainers, invoices, proposals, quotations`} action={<Btn onClick={()=>setEdit(blank)}><Plus size={15}/>Add client</Btn>}/>
    <div className="flex flex-wrap gap-2 mb-4"><Btn variant={show==="active"?"primary":"ghost"} onClick={()=>setShow("active")}>Active</Btn><Btn variant={show==="inactive"?"primary":"ghost"} onClick={()=>setShow("inactive")}>Inactive</Btn><Btn variant={show==="all"?"primary":"ghost"} onClick={()=>setShow("all")}>All</Btn></div>
    <Card><Table cols={["Client","Status","Currency","Retainer","WhatsApp","Email",""]}>{filtered.length===0?<tr><td colSpan={7}><Empty msg={show==="inactive"?"No inactive clients":"No clients yet"}/></td></tr>:filtered.map(c=>{ const r=data.retainers.find(x=>x.client===c.name && x.status==="Active"); const act=isActive(c); return (
      <Row key={c.id} onClick={()=>setOpen(c.id)}><Td className="font-medium">{c.name}{c.notes&&<div className="text-xs text-slate-400">{c.notes}</div>}</Td><Td><Pill s={act?"Active":"Inactive"}/></Td><Td>{c.currency}</Td><Td className="text-slate-500">{r?fmt(r.amount,r.currency):"—"}</Td><Td className="text-slate-500">{c.whatsapp||"—"}</Td><Td className="text-slate-500">{c.email||"—"}</Td>
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
      <p className="text-xs text-slate-400">Set a monthly retainer to add this client to the Retainers section automatically. Marking a client inactive pauses their retainer.</p>
      <Area label="Notes" value={edit.notes} onChange={e=>setEdit({...edit,notes:e.target.value})}/>
      <Btn onClick={()=>save(edit)}><Check size={15}/>Save</Btn>
    </Modal>}
  </>);
}
function ClientProfile({ c, data, onBack, onEdit }) {
  const inv = data.invoices.filter(i=>i.client===c.name);
  const ret = data.retainers.filter(r=>r.client===c.name);
  const prop = data.proposals.filter(p=>p.client===c.name);
  const quo = data.quotations.filter(q=>q.client===c.name);
  const notes = (data.meetingNotes||[]).filter(n=>n.client===c.name).sort((a,b)=>b.date.localeCompare(a.date));
  const hrs = data.timesheets.filter(t=>t.client===c.name).reduce((s,t)=>s+ +t.hours,0);
  return (<>
    <button onClick={onBack} className="flex items-center gap-1 text-sm text-slate-500 hover:text-sky-600 mb-4"><ChevronLeft size={16}/>Back to clients</button>
    <div className="flex items-start justify-between mb-6"><div><h2 className="text-xl font-bold tracking-tight text-slate-900">{c.name}</h2><p className="text-sm text-slate-500">{c.currency} · {c.whatsapp||"no WhatsApp"} · {c.email||"no email"}</p></div><Btn variant="ghost" onClick={onEdit}><Edit3 size={15}/>Edit</Btn></div>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {[["Invoices",inv.length],["Retainers",ret.length],["Proposals",prop.length],["Hours logged",hrs]].map(([k,v])=>(<Card key={k}><div className="p-4"><div className="text-2xl font-bold text-slate-900">{v}</div><div className="text-xs text-slate-500 mt-0.5">{k}</div></div></Card>))}
    </div>
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
  const blank = { username:"", password:"", role:"employee", empId:"", active:true };
  const save = (u) => {
    const uname = u.username.trim().toLowerCase();
    if (!uname || !u.password) return;
    if (users.some(x=>x.username.toLowerCase()===uname && x.id!==u.id)) { alert("That username is already taken."); return; }
    if (u.id) setUsers(users.map(x=>x.id===u.id?{...u,username:uname}:x), `Updated login for ${uname}`);
    else setUsers([...users, { ...u, username:uname, id:uid() }], `Created login "${uname}" (${u.role})`);
    setEdit(null);
  };
  const doReset = () => { setUsers(users.map(x=>x.id===reset.id?{...x,password:reset.password}:x), `Reset password for ${reset.username}`); setReset(null); };
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
      <Field label="Password" value={edit.password} onChange={e=>setEdit({...edit,password:e.target.value})} placeholder="set a password"/>
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
      <Field label="New password" value={reset.password} onChange={e=>setReset({...reset,password:e.target.value})} placeholder="enter new password"/>
      <Btn onClick={()=>reset.password&&doReset()}><Check size={15}/>Set new password</Btn>
    </Modal>}
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

function Employees({ data, update }) {
  const rows = data.employees, setRows = (r)=>update("employees",r);
  const [edit, setEdit] = useState(null); const [open, setOpen] = useState(null); const [q, setQ] = useState("");
  const [lookup, setLookup] = useState("");
  const blank = { name:"",role:"",dept:"",email:"",phone:"",cnic:"",salary:"",pf:0,joined:today(),status:"Active",bankName:"",account:"",docs:[] };
  const save = (e)=>{
    const isNew = !e.id;
    const rec = isNew ? { ...e, id: uid() } : e;
    const next = isNew ? [...rows, rec] : rows.map(r=>r.id===rec.id?rec:r);
    update("employees", next, isNew ? `Added employee ${rec.name}` : `Updated employee ${rec.name}`);
    setEdit(null);
  };
  const filtered = rows.filter(r=>r.name.toLowerCase().includes(q.toLowerCase()));
  const found = lookup ? rows.find(r=>r.name.toLowerCase().includes(lookup.toLowerCase())) : null;
  if (open) { const emp = rows.find(r=>r.id===open); if (emp) return <EmployeeProfile emp={emp} data={data} onBack={()=>setOpen(null)} onEdit={()=>setEdit(emp)} />; }
  return (<>
    <Head title="Employees" sub={`${rows.length} on record · tap a name to open their file`} action={<Btn onClick={()=>setEdit(blank)}><Plus size={15}/>Add employee</Btn>}/>
    <Card><div className="p-4">
      <div className="text-xs uppercase tracking-wider text-slate-500 mb-2 font-medium flex items-center gap-1.5"><Landmark size={13}/>Quick account lookup</div>
      <div className="relative max-w-sm"><Search size={15} className="absolute left-3 top-2.5 text-slate-400"/><input list="emp-names" value={lookup} onChange={e=>setLookup(e.target.value)} placeholder="Type an employee name…" className={inputCls+" pl-9"}/><datalist id="emp-names">{rows.map(e=><option key={e.id} value={e.name}/>)}</datalist></div>
      {lookup && (found ? <div className="mt-3 bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm flex flex-wrap gap-x-6 gap-y-1"><span><span className="text-slate-500">Name:</span> <b>{found.name}</b></span><span><span className="text-slate-500">Bank:</span> {found.bankName||"—"}</span><span><span className="text-slate-500">Account / IBAN:</span> <b>{found.account||"— not on file —"}</b></span></div> : <div className="mt-3 text-sm text-slate-400">No employee matches that name.</div>)}
    </div></Card>
    <div className="relative my-4 max-w-xs"><Search size={15} className="absolute left-3 top-2.5 text-slate-400"/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search name" className={inputCls+" pl-9"}/></div>
    <Card><Table cols={["Name","Role","Account / IBAN","Salary","Status",""]}>{filtered.length===0?<tr><td colSpan={6}><Empty msg="No employees"/></td></tr>:filtered.map(e=>(
      <Row key={e.id} onClick={()=>setOpen(e.id)}><Td><div className="font-medium">{e.name}</div><div className="text-xs text-slate-400">{e.email}</div></Td><Td className="text-slate-500">{e.role}</Td><Td className="text-slate-500">{e.account||"—"}</Td><Td className="text-slate-500">{fmt(e.salary)}</Td><Td><Pill s={e.status}/></Td><Td><RowActions onEdit={()=>setEdit(e)} onDelete={()=>update("employees",rows.filter(r=>r.id!==e.id), `Removed employee ${e.name}`)}/></Td></Row>))}</Table></Card>
    {edit && <EmployeeForm edit={edit} setEdit={setEdit} save={save}/>}
  </>);
}
function EmployeeForm({ edit, setEdit, save }) {
  const addDocs = async (files) => { const arr = [...(edit.docs||[])]; for (const f of files) { const isImg = f.type.startsWith("image/"); arr.push({ id:uid(), name:f.name, type:isImg?"image":"file", img: isImg ? await readImage(f, 900) : null, expiry:"", date:today() }); } setEdit({ ...edit, docs: arr }); };
  const setDocExpiry = (id, v) => setEdit({ ...edit, docs: edit.docs.map(d=>d.id===id?{...d,expiry:v}:d) });
  return <Modal title={edit.id?"Edit employee":"Add employee"} onClose={()=>setEdit(null)}>
    <Field label="Full name" value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})}/>
    <div className="grid grid-cols-2 gap-3"><Field label="Role" value={edit.role} onChange={e=>setEdit({...edit,role:e.target.value})}/><Field label="Department" value={edit.dept} onChange={e=>setEdit({...edit,dept:e.target.value})}/></div>
    <div className="grid grid-cols-2 gap-3"><Field label="Email" value={edit.email} onChange={e=>setEdit({...edit,email:e.target.value})}/><Field label="Phone" value={edit.phone} onChange={e=>setEdit({...edit,phone:e.target.value})}/></div>
    <div className="grid grid-cols-2 gap-3"><Field label="CNIC number" value={edit.cnic} onChange={e=>setEdit({...edit,cnic:e.target.value})} placeholder="00000-0000000-0"/><Field label="Monthly salary (PKR)" type="number" value={edit.salary} onChange={e=>setEdit({...edit,salary:e.target.value})}/></div>
    <div className="grid grid-cols-2 gap-3"><Field label="Provident fund (% of basic)" type="number" value={edit.pf} onChange={e=>setEdit({...edit,pf:e.target.value})}/><Field label="Joined" type="date" value={edit.joined} onChange={e=>setEdit({...edit,joined:e.target.value})}/></div>
    <Select label="Status" options={["Active","Inactive"]} value={edit.status} onChange={e=>setEdit({...edit,status:e.target.value})}/>
    <div className="grid grid-cols-2 gap-3"><Field label="Bank name" value={edit.bankName||""} onChange={e=>setEdit({...edit,bankName:e.target.value})} placeholder="e.g. Meezan Bank"/><Field label="Account number / IBAN" value={edit.account||""} onChange={e=>setEdit({...edit,account:e.target.value})}/></div>
    <div><span className="text-xs text-slate-500 mb-1 block">Documents (set an expiry to get reminders)</span>
      <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500"><Paperclip size={15}/> Upload files<input type="file" multiple accept="image/*,.pdf" className="hidden" onChange={e=>addDocs([...e.target.files])}/></label>
      {(edit.docs||[]).length>0 && <div className="mt-2 space-y-2">{edit.docs.map(d=>(<div key={d.id} className="bg-slate-50 border border-slate-200 rounded px-2 py-2"><div className="flex items-center justify-between text-xs"><span className="truncate">{d.name}</span><button onClick={()=>setEdit({...edit,docs:edit.docs.filter(x=>x.id!==d.id)})} className="text-slate-400 hover:text-rose-500"><X size={13}/></button></div><div className="flex items-center gap-2 mt-1"><span className="text-xs text-slate-400">Expiry</span><input type="date" value={d.expiry||""} onChange={e=>setDocExpiry(d.id,e.target.value)} className="bg-white border border-slate-300 rounded px-2 py-1 text-xs outline-none focus:border-sky-500"/></div></div>))}</div>}
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
    <div className="flex items-start justify-between mb-6"><div className="flex items-center gap-4"><div className="w-14 h-14 rounded-2xl bg-sky-100 text-sky-700 grid place-items-center font-bold text-xl">{emp.name[0]}</div><div><h2 className="text-xl font-bold tracking-tight text-slate-900">{emp.name}</h2><p className="text-sm text-slate-500">{emp.role} · {emp.dept}</p></div></div><Btn variant="ghost" onClick={onEdit}><Edit3 size={15}/>Edit</Btn></div>
    <div className="flex gap-1 mb-5 border-b border-slate-200 overflow-x-auto">{tabs.map(([k,l])=>(<button key={k} onClick={()=>setT(k)} className={`px-4 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${t===k?"border-sky-600 text-sky-700 font-medium":"border-transparent text-slate-500 hover:text-slate-800"}`}>{l}</button>))}</div>
    {t==="overview" && <div className="grid sm:grid-cols-2 gap-4">{[["Email",emp.email],["Phone",emp.phone],["CNIC",emp.cnic],["Salary",fmt(emp.salary)],["Provident fund",(emp.pf||0)+"%"],["Joined",emp.joined],["Bank",emp.bankName],["Account / IBAN",emp.account]].map(([k,v])=>(<Card key={k}><div className="p-4"><div className="text-xs text-slate-500">{k}</div><div className="font-medium mt-0.5">{v||"—"}</div></div></Card>))}</div>}
    {t==="docs" && <Card><div className="p-4">{(!emp.docs||emp.docs.length===0)?<Empty msg="No documents on file."/>:<div className="grid sm:grid-cols-3 gap-3">{emp.docs.map(d=>{const dd=d.expiry?daysUntil(d.expiry):null;return(<div key={d.id} className="bg-slate-50 border border-slate-200 rounded-lg overflow-hidden">{d.img?<img src={d.img} className="w-full h-32 object-cover"/>:<div className="h-32 grid place-items-center text-slate-400"><FileText/></div>}<div className="p-2 text-xs"><div className="truncate">{d.name}</div>{d.expiry&&<div className={dd<=30?"text-rose-600":"text-slate-400"}>exp {d.expiry}{dd<=30?` · ${dd<0?"expired":dd+"d"}`:""}</div>}</div></div>);})}</div>}</div></Card>}
    {t==="payroll" && <Card><Table cols={["Month","Basic","Net","Status"]}>{slips.length===0?<tr><td colSpan={4}><Empty msg="No payroll history"/></td></tr>:slips.map(p=>(<Row key={p.id}><Td>{p.month}</Td><Td>{fmt(p.basic)}</Td><Td className="font-semibold">{fmt(netPay(p))}</Td><Td><Pill s={p.paid?"Paid":"Pending"}/></Td></Row>))}</Table></Card>}
    {t==="advances" && <Card><Table cols={["Date","Total","Installment","Remaining","Status"]}>{advs.length===0?<tr><td colSpan={5}><Empty msg="No advances"/></td></tr>:advs.map(a=>(<Row key={a.id}><Td className="text-slate-500">{a.date}</Td><Td>{fmt(a.total)}</Td><Td>{fmt(a.installment)}</Td><Td>{fmt(a.remaining)}</Td><Td><Pill s={a.status}/></Td></Row>))}</Table></Card>}
    {t==="letters" && <Card><Table cols={["Type","Date"]}>{empLetters.length===0?<tr><td colSpan={2}><Empty msg="No letters issued"/></td></tr>:empLetters.map(l=>(<Row key={l.id}><Td>{l.docType||l.type}</Td><Td className="text-slate-500">{l.date}</Td></Row>))}</Table></Card>}
  </>);
}

function Attendance({ data, update }) {
  const [view, setView] = useState("attendance");
  const mark = (emp,status)=>{ const ex=data.attendance.find(a=>a.employee===emp&&a.date===today()); update("attendance", ex?data.attendance.map(a=>a===ex?{...a,status}:a):[...data.attendance,{id:uid(),employee:emp,date:today(),status}]); };
  const setStatus=(id,s)=>{ const l=data.leaves.find(x=>x.id===id); update("leaves",data.leaves.map(x=>x.id===id?{...x,status:s}:x), `Leave ${s.toLowerCase()} for ${l?.employee}`); };
  const locLink = (loc) => loc && loc.lat ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : null;
  const history = [...data.attendance].sort((a,b)=> (b.date||"").localeCompare(a.date||"") || (b.checkIn||"").localeCompare(a.checkIn||""));
  return (<>
    <Head title="Attendance & Leave" sub="Team marking, check-in/out log, and leave approvals"/>
    <div className="flex flex-wrap gap-2 mb-4"><Btn variant={view==="attendance"?"primary":"ghost"} onClick={()=>setView("attendance")}>Today's attendance</Btn><Btn variant={view==="history"?"primary":"ghost"} onClick={()=>setView("history")}>Check-in/out log</Btn><Btn variant={view==="leave"?"primary":"ghost"} onClick={()=>setView("leave")}>Leave requests</Btn></div>
    {view==="attendance"?(
      <Card><Table cols={["Employee","Today","In / Out","Location",""]}>{data.employees.filter(e=>e.status==="Active").map(e=>{const a=data.attendance.find(x=>x.employee===e.name&&x.date===today());const ll=locLink(a?.location);return(
        <Row key={e.id}><Td className="font-medium">{e.name}</Td><Td>{a?<span className="text-xs text-slate-600">{a.status}</span>:<span className="text-slate-400 text-xs">Not marked</span>}</Td><Td className="text-xs text-slate-500">{a?.checkIn?timeOf(a.checkIn):"—"} / {a?.checkOut?timeOf(a.checkOut):"—"}</Td><Td className="text-xs">{ll?<a href={ll} target="_blank" rel="noopener" className="text-sky-600 hover:underline flex items-center gap-1"><MapPin size={12}/>map</a>:<span className="text-slate-400">—</span>}</Td>
        <Td><div className="flex gap-1 justify-end"><button onClick={()=>mark(e.name,"Present")} className="px-2 py-1 rounded text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-200">Present</button><button onClick={()=>mark(e.name,"Absent")} className="px-2 py-1 rounded text-xs bg-rose-100 text-rose-700 hover:bg-rose-200">Absent</button><button onClick={()=>mark(e.name,"Leave")} className="px-2 py-1 rounded text-xs bg-amber-100 text-amber-700 hover:bg-amber-200">Leave</button></div></Td></Row>);})}</Table></Card>
    ):view==="history"?(
      <Card><Table cols={["Date","Employee","Status","Check-in","Check-out","Location"]}>{history.length===0?<tr><td colSpan={6}><Empty msg="No attendance recorded yet"/></td></tr>:history.map(a=>{const ll=locLink(a.location);return(
        <Row key={a.id}><Td className="text-slate-500 whitespace-nowrap">{a.date}</Td><Td className="font-medium">{a.employee}</Td><Td>{a.status}</Td><Td className="text-slate-500">{a.checkIn?timeOf(a.checkIn):"—"}</Td><Td className="text-slate-500">{a.checkOut?timeOf(a.checkOut):"—"}</Td><Td className="text-xs">{ll?<a href={ll} target="_blank" rel="noopener" className="text-sky-600 hover:underline flex items-center gap-1"><MapPin size={12}/>view</a>:<span className="text-slate-400">—</span>}</Td></Row>);})}</Table></Card>
    ):(
      <Card><Table cols={["Employee","Type","From","To","Days","Status",""]}>{data.leaves.length===0?<tr><td colSpan={7}><Empty msg="No leave requests"/></td></tr>:data.leaves.map(l=>(
        <Row key={l.id}><Td className="font-medium">{l.employee}</Td><Td className="text-slate-500">{l.type}</Td><Td className="text-slate-500">{l.from}</Td><Td className="text-slate-500">{l.to}</Td><Td>{dayCount(l.from,l.to)}</Td><Td><Pill s={l.status}/></Td>
        <Td>{l.status==="Pending"?<div className="flex gap-1 justify-end"><button onClick={()=>setStatus(l.id,"Approved")} className="p-1.5 rounded text-emerald-600 hover:bg-slate-100"><Check size={14}/></button><button onClick={()=>setStatus(l.id,"Rejected")} className="p-1.5 rounded text-rose-500 hover:bg-slate-100"><X size={14}/></button></div>:<span className="text-xs text-slate-400">—</span>}</Td></Row>))}</Table></Card>
    )}
  </>);
}

function Payroll({ data, patch, update, brand }) {
  const [slip, setSlip] = useState(null);
  const [payProof, setPayProof] = useState(null);
  const [editDed, setEditDed] = useState(null);
  const month = monthLabel();
  const run=()=>{
    const ids=[]; data.payables.forEach(p=>{ if(p.kind==="reimbursement"&&p.status==="Approved"&&!p.settled&&p.payVia==="salary"&&(!p.payMonth||p.payMonth===month)) ids.push(p.id); });
    const runs=data.employees.filter(e=>e.status==="Active").map(e=>computePayslip(e,data,month));
    const newPayables=data.payables.map(p=>ids.includes(p.id)?{...p,settled:true,status:"Paid"}:p);
    const newAdvances=data.advances.map(a=>{ if(a.status==="Active"&&a.remaining>0){ const d=Math.min(+a.installment,a.remaining); const rem=a.remaining-d; return {...a,remaining:rem,status:rem<=0?"Cleared":"Active"};} return a; });
    patch({ payroll:[...runs,...data.payroll], payables:newPayables, advances:newAdvances }, `Ran payroll for ${month}`);
  };
  const saveDed = () => {
    const tax=+editDed.tax||0, eobi=+editDed.eobi||0, pf=+editDed.pf||0, advance=+editDed.advance||0;
    const deductions = tax+eobi+pf+advance;
    update("payroll", data.payroll.map(x=>x.id===editDed.id?{...x,tax,eobi,pf,advance,deductions}:x), `Adjusted deductions for ${editDed.employee} (${editDed.month})`);
    setEditDed(null);
  };
  const pendingReimb = data.payables.filter(p=>p.kind==="reimbursement"&&p.status==="Approved"&&!p.settled).reduce((s,p)=>s+ +p.amount,0);
  const empEmail = (name) => data.employees.find(e=>e.name===name)?.email || "";
  const empAcct = (name) => data.employees.find(e=>e.name===name)?.account || "";
  return (<>
    <Head title="Payroll & Salary Slips" sub={`${month} · PF & advances deducted · tax/EOBI are manual (0 unless you set them)${pendingReimb?` · ${fmt(pendingReimb)} reimbursements queued`:""}`} action={<Btn onClick={run}><Wallet size={15}/>Run payroll · {month}</Btn>}/>
    <Card><Table cols={["Employee","Month","Net","Account / IBAN","Payment","",""]}>{data.payroll.length===0?<tr><td colSpan={7}><Empty msg="No payroll runs yet"/></td></tr>:data.payroll.map(p=>(
      <Row key={p.id}>
        <Td className="font-medium">{p.employee}</Td><Td className="text-slate-500">{p.month}</Td><Td className="font-semibold">{fmt(netPay(p))}</Td>
        <Td className="text-slate-500 text-xs">{empAcct(p.employee)||"— not on file —"}</Td>
        <Td>{p.paid?<span className="flex items-center gap-2"><Pill s="Paid"/>{p.proof&&<img src={p.proof} className="w-7 h-7 rounded object-cover border border-slate-200"/>}</span>:<Pill s="Pending"/>}</Td>
        <Td><button onClick={()=>setSlip(p)} className="text-sky-600 text-xs font-medium hover:underline">View slip</button></Td>
        <Td><RowActions>{!p.paid && <button onClick={()=>setEditDed({...p})} title="Edit deductions (tax/EOBI/PF)" className="px-2 py-1 rounded text-xs bg-slate-100 text-slate-600 hover:bg-slate-200">Deductions</button>}{!p.paid && <button onClick={()=>setPayProof({ ...p, proof:null })} className="px-2 py-1 rounded text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-200">Mark paid</button>}{p.paid && <button onClick={()=>setPayProof({ ...p })} title="Update payment" className="p-1.5 rounded text-slate-400 hover:text-sky-600 hover:bg-slate-100"><Edit3 size={14}/></button>}</RowActions></Td>
      </Row>))}</Table></Card>
    {slip && <SlipModal slip={slip} brand={brand} onClose={()=>setSlip(null)}/>}
    {editDed && <Modal title={`Deductions · ${editDed.employee}`} onClose={()=>setEditDed(null)}>
      <p className="text-xs text-slate-500">These are blank (0) by default. Enter any amounts that apply for {editDed.month}.</p>
      <div className="grid grid-cols-2 gap-3"><Field label="Income tax" type="number" value={editDed.tax} onChange={e=>setEditDed({...editDed,tax:e.target.value})}/><Field label="EOBI" type="number" value={editDed.eobi} onChange={e=>setEditDed({...editDed,eobi:e.target.value})}/></div>
      <div className="grid grid-cols-2 gap-3"><Field label="Provident fund" type="number" value={editDed.pf} onChange={e=>setEditDed({...editDed,pf:e.target.value})}/><Field label="Advance / loan" type="number" value={editDed.advance} onChange={e=>setEditDed({...editDed,advance:e.target.value})}/></div>
      <Btn onClick={saveDed}><Check size={15}/>Save deductions</Btn>
    </Modal>}
    {payProof && <PayrollPaidModal rec={payProof} brand={brand} email={empEmail(payProof.employee)} onClose={()=>setPayProof(null)}
      onSave={(proof, method)=>{ update("payroll", data.payroll.map(x=>x.id===payProof.id?{...x,paid:true,proof,payMethod:method,paidOn:today()}:x), `Marked salary paid: ${payProof.employee} (${payProof.month})`); setPayProof(null); }}/>}
  </>);
}
function PayrollPaidModal({ rec, brand, email, onClose, onSave }) {
  const [proof, setProof] = useState(rec.proof || null);
  const [method, setMethod] = useState(rec.payMethod || "Bank transfer");
  const onImg = async (f) => { if (f) setProof(await readImage(f, 1000)); };
  const subject = `Salary Disbursed — ${rec.month} — ${brand.company}`;
  const bodyText = `Dear ${rec.employee},\n\nWe're pleased to inform you that your salary for ${rec.month} has been disbursed.\n\n  Net amount:   ${fmt(netPay(rec))}\n  Method:       ${method}\n  Date:         ${today()}\n\nThe payment proof has been recorded in our system. Please allow a short time for it to reflect in your account. If you have any questions about your payslip, reach out to HR.\n\nThank you for your continued contribution.\n\nWarm regards,\n${brand.company}\n${brand.contact || ""}`;
  const sendEmail = () => {
    if (!email) { alert("This employee has no email on file. Add one under Employees."); return; }
    window.open(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText)}`, "_blank");
  };
  return (<Modal title={`Record salary payment · ${rec.employee}`} onClose={onClose}>
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm flex justify-between"><span className="text-slate-500">Net pay · {rec.month}</span><b>{fmt(netPay(rec))}</b></div>
    <Select label="Payment method" options={["Bank transfer","Cheque","Cash","Wise / online"]} value={method} onChange={e=>setMethod(e.target.value)}/>
    <div><span className="text-xs text-slate-500 mb-1 block">Payment proof (transfer screenshot or cheque photo)</span>
      <label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-slate-300 cursor-pointer hover:border-sky-500 text-sm text-slate-500"><Paperclip size={15}/>{proof?"Proof attached":"Attach screenshot / cheque"}<input type="file" accept="image/*" className="hidden" onChange={e=>onImg(e.target.files[0])}/></label>
      {proof && <img src={proof} className="mt-2 h-32 rounded-lg border border-slate-200 object-cover"/>}
    </div>
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
      <div className="text-xs font-medium text-slate-600 mb-1 flex items-center gap-1.5"><Mail size={13}/>Disbursement email {email?`→ ${email}`:"(no email on file)"}</div>
      <div className="text-xs text-slate-500 whitespace-pre-wrap" style={{maxHeight:120, overflow:"auto"}}>{bodyText}</div>
    </div>
    <div className="flex gap-2">
      <Btn variant="ok" onClick={()=>onSave(proof, method)}><Check size={15}/>Save as paid</Btn>
      <Btn variant="ghost" onClick={sendEmail}><Mail size={15}/>Email employee</Btn>
    </div>
    <p className="text-xs text-slate-400">"Email employee" opens your mail app with the message pre-filled — you press send.</p>
  </Modal>);
}

function VendorBills({ data, update, patch, role, brand }) {
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
    const data = isImg ? await readImage(f, 1100) : await readFile(f);
    setFn({ ...cur, fileName:f.name, fileType: isImg ? "image" : "file", file: data });
  };
  return (<>
    <Head title="Vendor Bills" sub="Upload vendor invoices → HR approves → Founder approves → moves to Payables (unpaid) → mark paid from Payables" action={<Btn onClick={()=>setEdit(blank)}><Plus size={15}/>Upload bill</Btn>}/>
    <Card><Table cols={["Vendor","For","Amount","Due","HR","Founder","Status",""]}>
      {rows.length===0?<tr><td colSpan={8}><Empty msg="No vendor bills uploaded yet"/></td></tr>:rows.map(b=>(
        <Row key={b.id}>
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
        {edit.file && (edit.fileType==="image" || edit.file.startsWith("data:image")) && <img src={edit.file} className="mt-2 h-32 rounded-lg border border-slate-200 object-cover"/>}
        {edit.file && !(edit.fileType==="image" || edit.file.startsWith("data:image")) && <button onClick={()=>openDataUrl(edit.file, edit.fileName)} className="mt-2 text-sky-600 text-xs hover:underline flex items-center gap-1"><FileText size={13}/>Open {edit.fileName||"file"}</button>}
      </div>
      {edit._err && <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{edit._err}</div>}
      <Btn onClick={()=>{ if(!edit.vendor){ setEdit({...edit,_err:"Vendor name is required."}); return; } if(!edit.whatsapp){ setEdit({...edit,_err:"Vendor WhatsApp number is required."}); return; } if(!edit.amount){ setEdit({...edit,_err:"Amount is required."}); return; } save(edit); }}><Check size={15}/>{edit.id?"Save":"Upload bill"}</Btn>
    </Modal>}

    {viewBill && <Modal title={`Bill · ${viewBill.vendor}`} onClose={()=>setViewBill(null)}>
      {viewBill.file && (viewBill.fileType==="image" || (viewBill.file||"").startsWith("data:image"))
        ? <img src={viewBill.file} className="w-full rounded-lg border border-slate-200"/>
        : viewBill.file
          ? <Btn variant="ghost" onClick={()=>openDataUrl(viewBill.file, viewBill.fileName)}><FileText size={15}/>Open {viewBill.fileName||"bill file"}</Btn>
          : <div className="text-sm text-slate-500 text-center py-6">No file attached.</div>}
      <div className="text-sm space-y-1"><div className="flex justify-between"><span className="text-slate-500">Amount</span><b>{fmt(viewBill.amount,viewBill.currency)}</b></div><div className="flex justify-between"><span className="text-slate-500">Due</span><span>{viewBill.due}</span></div></div>
    </Modal>}
  </>);
}

function Advances({ data, update }) {
  const rows = data.advances, setRows=r=>update("advances",r);
  const [edit, setEdit] = useState(null);
  const blank = { employee:data.employees[0]?.name||"", total:"", installment:"", date:today() };
  const save = (a)=>{ const rec={ ...a, id:uid(), total:+a.total, installment:+a.installment, remaining:+a.total, status:"Active" }; update("advances",[rec,...rows], `Advance ${fmt(rec.total)} to ${rec.employee}`); setEdit(null); };
  return (<>
    <Head title="Advances & Loans" sub="Installments auto-deduct from payslips until cleared" action={<Btn onClick={()=>setEdit(blank)}><Plus size={15}/>New advance</Btn>}/>
    <Card><Table cols={["Employee","Date","Total","Installment","Remaining","Status",""]}>{rows.length===0?<tr><td colSpan={7}><Empty msg="No advances or loans"/></td></tr>:rows.map(a=>(
      <Row key={a.id}><Td className="font-medium">{a.employee}</Td><Td className="text-slate-500">{a.date}</Td><Td>{fmt(a.total)}</Td><Td>{fmt(a.installment)}</Td><Td className={a.remaining>0?"text-amber-600 font-medium":"text-slate-400"}>{fmt(a.remaining)}</Td><Td><Pill s={a.status}/></Td><Td><RowActions onDelete={()=>setRows(rows.filter(x=>x.id!==a.id))}/></Td></Row>))}</Table></Card>
    {edit && <Modal title="New advance / loan" onClose={()=>setEdit(null)}>
      <Select label="Employee" options={data.employees.map(e=>e.name)} value={edit.employee} onChange={e=>setEdit({...edit,employee:e.target.value})}/>
      <div className="grid grid-cols-2 gap-3"><Field label="Total amount (PKR)" type="number" value={edit.total} onChange={e=>setEdit({...edit,total:e.target.value})}/><Field label="Monthly installment (PKR)" type="number" value={edit.installment} onChange={e=>setEdit({...edit,installment:e.target.value})}/></div>
      <Field label="Date" type="date" value={edit.date} onChange={e=>setEdit({...edit,date:e.target.value})}/>
      <Btn onClick={()=>{ if(edit.employee&&edit.total&&edit.installment) save(edit); }}><Check size={15}/>Save</Btn>
    </Modal>}
  </>);
}

function Timesheets({ data }) {
  const [client, setClient] = useState(""); const [emp, setEmp] = useState(""); const [day, setDay] = useState("");
  const all = data.timesheets;
  const clients = [...new Set(all.map(t=>t.client).filter(Boolean))];
  const emps = [...new Set(all.map(t=>t.employee).filter(Boolean))];
  const rows = all.filter(t=>(!client||t.client===client)&&(!emp||t.employee===emp)&&(!day||t.date===day)).slice().sort((a,b)=>b.date.localeCompare(a.date));
  const byClient = {}; all.forEach(t=>{ if(t.hours) byClient[t.client]=(byClient[t.client]||0)+ +t.hours; });
  const todayCount = all.filter(t=>t.date===today()).length;
  return (<>
    <Head title="Work & Timesheets" sub={`Daily work logged by the team · ${todayCount} update(s) today`}/>
    {Object.keys(byClient).length>0 && <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">{Object.entries(byClient).map(([c,h])=>(<Card key={c}><div className="p-4"><div className="text-2xl font-bold text-slate-900">{h}h</div><div className="text-xs text-slate-500 mt-0.5">{c}</div></div></Card>))}</div>}
    <div className="flex flex-wrap gap-3 mb-4">
      <div className="max-w-xs flex-1 min-w-36"><Select label="Employee" options={["",...emps]} value={emp} onChange={e=>setEmp(e.target.value)}/></div>
      <div className="max-w-xs flex-1 min-w-36"><Select label="Client" options={["",...clients]} value={client} onChange={e=>setClient(e.target.value)}/></div>
      <div className="max-w-xs flex-1 min-w-36"><Field label="Date" type="date" value={day} onChange={e=>setDay(e.target.value)}/></div>
    </div>
    <Card><Table cols={["Date","Employee","Client","Work done","Status","Hrs"]}>{rows.length===0?<tr><td colSpan={6}><Empty msg="No work logged for this filter"/></td></tr>:rows.map(t=>(<Row key={t.id}><Td className="text-slate-500 whitespace-nowrap">{t.date}</Td><Td className="font-medium">{t.employee}</Td><Td>{t.client}</Td><Td className="text-slate-600">{t.work||t.note}{t.edited?<span className="text-slate-400 text-xs"> · edited</span>:null}</Td><Td><Pill s={t.status==="Completed"?"Done":t.status||"Done"}/></Td><Td className="text-slate-500">{t.hours||"—"}</Td></Row>))}</Table></Card>
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
      <div className="flex gap-2"><Btn onClick={()=>save(edit)}><Check size={15}/>Save</Btn>{edit.id&&<Btn variant="danger" onClick={()=>{setRows(rows.filter(r=>r.id!==edit.id));setEdit(null);}}><Trash2 size={15}/>Remove</Btn>}</div>
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
  <div class="meta">${brand.address||""}<br>${brand.contact||""}</div></div>
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

function Retainers({ data, update, patch, brand, go }) {
  const rets = data.retainers, invs = data.retainerInvoices, clients = data.clients;
  const accounts = (data.bankAccounts||[]).map(a=>({ id:a.id, name:a.label }));
  const [view, setView] = useState("invoices");
  const [edit, setEdit] = useState(null); const [pay, setPay] = useState(null); const [manual, setManual] = useState(null);
  const blank = { client:"", whatsapp:"", amount:"", currency:"PKR", billingDay:1, status:"Active", carry:0 };
  const onClient=(v)=>{ const c=clients.find(x=>x.name===v); setEdit(e=>({...e,client:v,...(c?{currency:c.currency||"PKR",whatsapp:c.whatsapp||e.whatsapp}:{})})); };
  const saveClient = (c) => {
    const existsInCrm = clients.some(x=>x.name.toLowerCase()===(c.client||"").toLowerCase());
    const extra = (!existsInCrm && c.client) ? { clients:[...clients, { id:uid(), name:c.client, email:"", whatsapp:c.whatsapp||"", currency:c.currency||"PKR", notes:"Added via Retainers" }] } : {};
    const newRets = c.id?rets.map(r=>r.id===c.id?c:r):[...rets,{...c,id:uid(),carry:+c.carry||0}];
    patch({ retainers:newRets, ...extra }, c.id?`Updated retainer ${c.client}`:`Added retainer client ${c.client}`); setEdit(null);
  };
  const genDue = () => {
    const mk = monthKey(), ml = monthLabel();
    const existing = invs.filter(i=>i.monthKey===mk);
    const newInvs = [];
    rets.filter(r=>r.status==="Active").forEach(r=>{
      if (existing.find(i=>i.retainerId===r.id)) return; // already has one this month
      const base=+r.amount||0, carry=+r.carry||0;
      newInvs.push({ id:uid(), retainerId:r.id, client:r.client, number:`RET-${mk.replace("-","")}-${invs.length+newInvs.length+1}`, monthKey:mk, month:ml, base, carry, total:base+carry, currency:r.currency||"PKR", status:"Unpaid", paidAmount:0, account:"", date:today(), paidDate:"" });
    });
    if (newInvs.length) patch({ retainerInvoices:[...invs, ...newInvs], retainers: rets.map(r=>r.status==="Active"?{...r,carry:0,lastGenMonth:mk}:r) }, `Generated ${newInvs.length} retainer invoice(s) for ${ml}`);
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
    // overpayment credited to next month reduces next invoice (stored as negative carry = credit)
    if (overpay>0 && overChoice==="credit") newRets = newRets.map(r=>r.id===pay.retainerId ? { ...r, carry:(+r.carry||0)-overpay } : r);
    patch({ retainerInvoices:newInvs, retainers:newRets }, `Payment recorded for ${pay.client} (${pay.number})`); setPay(null);
  };
  return (<>
    <Head title="Retainers" sub="Recurring clients · auto-generated monthly, or create an invoice manually" action={<div className="flex gap-2"><Btn variant="ghost" onClick={()=>go("accounts")}><Landmark size={15}/>Accounts</Btn><Btn onClick={()=>setEdit(blank)}><Plus size={15}/>Add client</Btn></div>}/>
    <div className="flex flex-wrap gap-2 mb-4"><Btn variant={view==="invoices"?"primary":"ghost"} onClick={()=>setView("invoices")}>Invoices</Btn><Btn variant={view==="clients"?"primary":"ghost"} onClick={()=>setView("clients")}>Clients</Btn>{view==="invoices" && <><Btn variant="ghost" onClick={genDue}><Repeat size={15}/>Generate this month</Btn><Btn variant="ghost" onClick={newManual}><Plus size={15}/>Create invoice</Btn></>}</div>
    {view==="clients" ? (
      <Card><Table cols={["Client","WhatsApp","Monthly","Carried fwd","Status",""]}>{rets.length===0?<tr><td colSpan={6}><Empty msg="No retainer clients yet"/></td></tr>:rets.map(r=>(
        <Row key={r.id}><Td className="font-medium">{r.client}</Td><Td className="text-slate-500">{r.whatsapp||"—"}</Td><Td>{fmt(r.amount,r.currency)}</Td><Td className={+r.carry?"text-amber-600 font-medium":"text-slate-400"}>{r.carry?fmt(r.carry,r.currency):"—"}</Td><Td><Pill s={r.status}/></Td><Td><RowActions onEdit={()=>setEdit(r)} onDelete={()=>update("retainers",rets.filter(x=>x.id!==r.id))}/></Td></Row>))}</Table></Card>
    ) : (
      <Card><Table cols={["Invoice","Client","Period","Due","Total","Status",""]}>{invs.length===0?<tr><td colSpan={7}><Empty msg="No invoices yet — generate this month or create one"/></td></tr>:[...invs].reverse().map(i=>(
        <Row key={i.id}><Td className="font-medium">{i.number}</Td><Td className="text-slate-500">{i.client}</Td><Td className="text-slate-500">{i.month}</Td><Td className="text-slate-500">{i.due||"—"}{i.sendOn?<div className="text-xs text-slate-400">send {i.sendOn}</div>:null}</Td><Td>{fmt(i.total,i.currency)}{i.status==="Partial"&&<div className="text-xs text-orange-600">received {fmt(i.paidAmount,i.currency)}</div>}{i.status==="Paid"&&i.account&&<div className="text-xs text-slate-400">{i.account}</div>}</Td><Td><Pill s={i.status}/></Td>
        <Td><RowActions onDelete={()=>{ const parent=rets.find(r=>r.id===i.retainerId); patch({ retainerInvoices:invs.filter(x=>x.id!==i.id), retainers: parent?rets.map(r=>r.id===parent.id?{...r,lastGenMonth: i.monthKey||monthKey()}:r):rets }, `Deleted invoice ${i.number}`); }}><button onClick={()=>openInvoicePDF(i, brand)} title="Download PDF invoice" className="p-1.5 rounded text-slate-400 hover:text-sky-600 hover:bg-slate-100"><Download size={14}/></button><button onClick={()=>sendWA(i)} title="Send on WhatsApp" className="p-1.5 rounded text-slate-400 hover:text-green-600 hover:bg-slate-100"><Send size={14}/></button>{i.status!=="Paid" && <button onClick={()=>setPay(i)} title="Mark as paid" className="p-1.5 rounded text-slate-400 hover:text-emerald-600 hover:bg-slate-100"><Check size={15}/></button>}</RowActions></Td></Row>))}</Table></Card>
    )}
    {edit && <Modal title={edit.id?"Edit retainer client":"Add retainer client"} onClose={()=>setEdit(null)}>
      <ClientInput clients={clients} label="Client name" value={edit.client} onChange={e=>onClient(e.target.value)}/>
      <Field label="WhatsApp number (with country code)" value={edit.whatsapp} onChange={e=>setEdit({...edit,whatsapp:e.target.value})} placeholder="923001234567"/>
      <div className="grid grid-cols-2 gap-3"><Field label="Monthly amount" type="number" value={edit.amount} onChange={e=>setEdit({...edit,amount:e.target.value})}/><Select label="Currency" options={CURRENCIES} value={edit.currency} onChange={e=>setEdit({...edit,currency:e.target.value})}/></div>
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
function Ledger({ title, sub, rows, setRows, blank, fields, cols, render, extraActions }) {
  const [edit,setEdit]=useState(null);
  const save=r=>{setRows(r.id?rows.map(x=>x.id===r.id?r:x):[...rows,{...r,id:uid()}]);setEdit(null);};
  return (<>
    <Head title={title} sub={sub} action={<Btn onClick={()=>setEdit(blank())}><Plus size={15}/>Add</Btn>}/>
    <Card><Table cols={[...cols,""]}>{rows.length===0?<tr><td colSpan={cols.length+1}><Empty msg="Nothing here yet"/></td></tr>:rows.map(r=>(<Row key={r.id}>{render(r)}<Td><RowActions onEdit={()=>setEdit(r)} onDelete={()=>setRows(rows.filter(x=>x.id!==r.id))}>{extraActions?extraActions(r):null}</RowActions></Td></Row>))}</Table></Card>
    {edit && <Modal title={edit.id?"Edit":"Add"} onClose={()=>setEdit(null)}>{fields(edit,setEdit)}<Btn onClick={()=>save(edit)}><Check size={15}/>Save</Btn></Modal>}
  </>);
}
function Invoices({ data, update }) {
  const rows=data.invoices, setRows=r=>update("invoices",r); const clients=data.clients;
  return <Ledger title="Invoices & Receipts" sub="Billing to clients" rows={rows} setRows={setRows}
    blank={()=>({client:"",number:"INV-"+(1000+rows.length+1),amount:"",currency:"PKR",date:today(),status:"Draft",type:"Invoice"})}
    cols={["Number","Client","Type","Amount","Date","Status"]}
    render={r=>(<><Td className="font-medium">{r.number}</Td><Td className="text-slate-500">{r.client}</Td><Td className="text-slate-500">{r.type}</Td><Td>{fmt(r.amount,r.currency)}</Td><Td className="text-slate-500">{r.date}</Td><Td><Pill s={r.status}/></Td></>)}
    fields={(e,s)=>(<><ClientInput clients={clients} value={e.client} onChange={ev=>{const v=ev.target.value;const c=clients.find(x=>x.name===v);s({...e,client:v,...(c?{currency:c.currency||"PKR"}:{})});}}/><Field label="Number" value={e.number} onChange={ev=>s({...e,number:ev.target.value})}/><Select label="Type" options={["Invoice","Receipt"]} value={e.type} onChange={ev=>s({...e,type:ev.target.value})}/><div className="grid grid-cols-2 gap-3"><Field label="Amount" type="number" value={e.amount} onChange={ev=>s({...e,amount:ev.target.value})}/><Select label="Currency" options={CURRENCIES} value={e.currency} onChange={ev=>s({...e,currency:ev.target.value})}/></div><Field label="Date" type="date" value={e.date} onChange={ev=>s({...e,date:ev.target.value})}/><Select label="Status" options={["Draft","Sent","Paid","Overdue"]} value={e.status} onChange={ev=>s({...e,status:ev.target.value})}/></>)}/>;
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
    <Ledger title="Payables" sub={`Owed · ${fmt(rows.filter(r=>r.status!=="Paid").reduce((s,r)=>s+ +r.amount,0))} · approved vendor bills land here as unpaid until you mark them paid`} rows={rows} setRows={setRows}
      blank={()=>({vendor:"",desc:"",amount:"",due:today(),status:"Pending"})}
      cols={["Vendor","Description","Amount","Due","Status"]}
      render={r=>(<><Td className="font-medium">{r.vendor}</Td><Td className="text-slate-500"><div className="flex items-center gap-2">{r.receipt&&<img src={r.receipt} className="w-8 h-8 rounded object-cover border border-slate-200"/>}{r.desc}{r.payVia==="salary"&&<span className="text-xs text-sky-600">→ {r.payMonth} salary</span>}{r.kind==="vendorbill"&&<span className="text-xs text-slate-400">vendor bill</span>}</div></Td><Td>{fmt(r.amount)}</Td><Td className="text-slate-500">{r.due}</Td><Td><Pill s={r.status}/></Td></>)}
      extraActions={r=> r.kind==="reimbursement" && r.status!=="Approved" && r.status!=="Paid" ? <button onClick={()=>openApprove(r)} title="Approve reimbursement" className="p-1.5 rounded text-slate-400 hover:text-emerald-600 hover:bg-slate-100"><Check size={15}/></button> : (r.kind==="vendorbill" && r.status!=="Paid" ? <button onClick={()=>markVendorPaid(r)} title="Mark vendor bill as paid" className="px-2 py-1 rounded text-xs bg-emerald-100 text-emerald-700 hover:bg-emerald-200">Mark paid</button> : null)}
      fields={(e,s)=>(<><Field label="Vendor" value={e.vendor} onChange={ev=>s({...e,vendor:ev.target.value})}/><Field label="Description" value={e.desc} onChange={ev=>s({...e,desc:ev.target.value})}/><Field label="Amount (PKR)" type="number" value={e.amount} onChange={ev=>s({...e,amount:ev.target.value})}/><Field label="Due" type="date" value={e.due} onChange={ev=>s({...e,due:ev.target.value})}/><Select label="Status" options={["Pending","Approved","Paid","Overdue"]} value={e.status} onChange={ev=>s({...e,status:ev.target.value})}/></>)}/>
    {appr && <Modal title={`Approve reimbursement · ${appr.vendor}`} onClose={()=>setAppr(null)}>
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm flex justify-between"><span className="text-slate-500">Amount</span><b>{fmt(appr.amount)}</b></div>
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
  return <Ledger title="Receivables" sub={`Expected · ${fmt(rows.filter(r=>r.status!=="Paid").reduce((s,r)=>s+ +r.amount,0))}`} rows={rows} setRows={setRows}
    blank={()=>({client:"",desc:"",amount:"",due:today(),status:"Outstanding"})}
    cols={["Client","Description","Amount","Due","Status"]}
    render={r=>(<><Td className="font-medium">{r.client}</Td><Td className="text-slate-500">{r.desc}</Td><Td>{fmt(r.amount)}</Td><Td className="text-slate-500">{r.due}</Td><Td><Pill s={r.status}/></Td></>)}
    fields={(e,s)=>(<><ClientInput clients={clients} value={e.client} onChange={ev=>s({...e,client:ev.target.value})}/><Field label="Description" value={e.desc} onChange={ev=>s({...e,desc:ev.target.value})}/><Field label="Amount (PKR)" type="number" value={e.amount} onChange={ev=>s({...e,amount:ev.target.value})}/><Field label="Due" type="date" value={e.due} onChange={ev=>s({...e,due:ev.target.value})}/><Select label="Status" options={["Outstanding","Paid","Overdue"]} value={e.status} onChange={ev=>s({...e,status:ev.target.value})}/></>)}/>;
}

function Requests({ data, update }) {
  const rows = data.requests;
  const setStatus = (id,s)=>update("requests", rows.map(r=>r.id===id?{...r,status:s}:r));
  return (<>
    <Head title="Requests" sub="Certificate and profile-edit requests from your team"/>
    <Card><Table cols={["Employee","Type","Note","Date","Status",""]}>{rows.length===0?<tr><td colSpan={6}><Empty msg="No requests"/></td></tr>:rows.map(r=>(
      <Row key={r.id}><Td className="font-medium">{r.employee}</Td><Td className="text-slate-500">{r.type}</Td><Td className="text-slate-500">{r.note||"—"}</Td><Td className="text-slate-500">{r.date}</Td><Td><Pill s={r.status}/></Td><Td><RowActions onDelete={()=>update("requests",rows.filter(x=>x.id!==r.id))}>{r.status!=="Done"&&<button onClick={()=>setStatus(r.id,"Done")} className="p-1.5 rounded text-emerald-600 hover:bg-slate-100" title="Mark done"><Check size={15}/></button>}</RowActions></Td></Row>))}</Table></Card>
  </>);
}
function Announcements({ data, update }) {
  const rows = data.announcements; const [f, setF] = useState(null);
  const save = ()=>{ update("announcements", [{ id:uid(), title:f.title, body:f.body, date:today() }, ...rows], `Posted announcement: ${f.title}`); setF(null); };
  return (<>
    <Head title="Announcements" sub="Posted to every team member's home screen" action={<Btn onClick={()=>setF({title:"",body:""})}><Plus size={15}/>New post</Btn>}/>
    <div className="space-y-3">{rows.length===0?<Card><Empty msg="No announcements yet"/></Card>:rows.map(an=>(<Card key={an.id}><div className="p-5 flex justify-between gap-4"><div><div className="font-semibold">{an.title}</div><div className="text-sm text-slate-600 mt-1">{an.body}</div><div className="text-xs text-slate-400 mt-2">{an.date}</div></div><button onClick={()=>update("announcements",rows.filter(x=>x.id!==an.id))} className="text-slate-400 hover:text-rose-500 shrink-0"><Trash2 size={16}/></button></div></Card>))}</div>
    {f && <Modal title="New announcement" onClose={()=>setF(null)}><Field label="Title" value={f.title} onChange={e=>setF({...f,title:e.target.value})}/><Area label="Message" value={f.body} onChange={e=>setF({...f,body:e.target.value})}/><Btn onClick={save}><Check size={15}/>Post</Btn></Modal>}
  </>);
}

function Audit({ data }) {
  return (<>
    <Head title="Activity Log" sub="A record of key changes made in the workspace"/>
    <Card><Table cols={["When","Who","Action"]}>{(!data.audit||data.audit.length===0)?<tr><td colSpan={3}><Empty msg="No activity logged yet"/></td></tr>:data.audit.map(a=>(<Row key={a.id}><Td className="text-slate-500 whitespace-nowrap">{dtOf(a.date)}</Td><Td className="font-medium whitespace-nowrap">{a.who}</Td><Td>{a.action}</Td></Row>))}</Table></Card>
  </>);
}

function Backup({ data, brand, restore, wipe }) {
  const [msg, setMsg] = useState("");
  const [confirm, setConfirm] = useState(false);
  const doExport = () => { download(`svype-backup-${today()}.json`, JSON.stringify({ db:data, brand })); setMsg("Backup downloaded."); };
  const doImport = (file) => { if(!file) return; const r=new FileReader(); r.onload=()=>{ try{ const obj=JSON.parse(r.result); restore(obj.db, obj.brand); setMsg("Backup restored successfully."); }catch{ setMsg("That file couldn't be read — make sure it's a Svype backup."); } }; r.readAsText(file); };
  return (<>
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
        <Field label="Company name" value={b.company} onChange={e=>setB({...b,company:e.target.value})}/><Field label="Tagline" value={b.tagline} onChange={e=>setB({...b,tagline:e.target.value})}/><Field label="Address" value={b.address} onChange={e=>setB({...b,address:e.target.value})}/><Field label="Contact line" value={b.contact} onChange={e=>setB({...b,contact:e.target.value})}/>
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
