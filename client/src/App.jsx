import React, { useState, useEffect, useCallback, useRef } from "react";
import { LayoutDashboard, Users, Wallet, MessageSquare, LogOut, Loader2, Hash, Send, Plus, Check, X, Search, Bell } from "lucide-react";
import { api, getToken, setToken, openSocket } from "./lib/api.js";
import { useStore } from "./lib/store.js";

const ROLES = { admin: "Founder (Admin)", hr: "HR / PM", employee: "Employee" };

export default function App() {
  const [booting, setBooting] = useState(true);
  const [hasFounders, setHasFounders] = useState(true);
  const [session, setSession] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const st = await api.get("/auth/state");
        setHasFounders(st.hasFounders);
        if (getToken()) {
          try { setSession(await api.get("/auth/me")); } catch { setToken(null); }
        }
      } catch {}
      setBooting(false);
    })();
  }, []);

  if (booting) return <Center><Loader2 className="animate-spin text-sky-600" /></Center>;
  if (!hasFounders) return <FirstRun onDone={(t, u) => { setToken(t); setSession(u); setHasFounders(true); }} />;
  if (!session) return <Login onLogin={(t, u) => { setToken(t); setSession(u); }} />;
  return <Shell session={session} onLogout={() => { setToken(null); setSession(null); }} />;
}

const Center = ({ children }) => <div className="min-h-screen grid place-items-center bg-slate-50">{children}</div>;
const inputCls = "w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-sky-500";
const darkInput = "w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white outline-none focus:border-sky-500";

function FirstRun({ onDone }) {
  const [role, setRole] = useState("admin");
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [err, setErr] = useState("");
  const create = async () => {
    if (!u || !p) { setErr("Enter a username and password."); return; }
    try { const r = await api.post("/auth/setup", { username: u, password: p, role }); onDone(r.token, r.user); }
    catch (e) { setErr(e.message); }
  };
  return (
    <div className="min-h-screen grid place-items-center bg-slate-900 text-white p-4">
      <div className="max-w-sm w-full">
        <div className="text-center mb-7">
          <div className="w-14 h-14 rounded-2xl bg-sky-600 grid place-items-center font-black text-2xl mx-auto mb-5">S</div>
          <h1 className="text-2xl font-bold">Welcome to Svype OS</h1>
          <p className="text-slate-400 text-sm mt-1">First-time setup — create your founding account.</p>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-5 space-y-4">
          <div className="flex gap-2">
            <button onClick={() => setRole("admin")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${role === "admin" ? "bg-sky-600" : "bg-slate-700 text-slate-300"}`}>Super Admin</button>
            <button onClick={() => setRole("hr")} className={`flex-1 py-2 rounded-lg text-sm font-medium ${role === "hr" ? "bg-sky-600" : "bg-slate-700 text-slate-300"}`}>HR</button>
          </div>
          <input value={u} onChange={(e) => { setU(e.target.value); setErr(""); }} placeholder="username" className={darkInput} />
          <input type="password" value={p} onChange={(e) => { setP(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="password" className={darkInput} />
          {err && <div className="text-sm text-rose-300">{err}</div>}
          <button onClick={create} className="w-full py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 font-medium">Create account</button>
        </div>
      </div>
    </div>
  );
}

function Login({ onLogin }) {
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [err, setErr] = useState("");
  const submit = async () => {
    try { const r = await api.post("/auth/login", { username: u, password: p }); onLogin(r.token, r.user); }
    catch (e) { setErr(e.message); }
  };
  return (
    <div className="min-h-screen grid place-items-center bg-slate-900 text-white p-4">
      <div className="max-w-sm w-full text-center">
        <div className="w-14 h-14 rounded-2xl bg-sky-600 grid place-items-center font-black text-2xl mx-auto mb-5">S</div>
        <h1 className="text-2xl font-bold">Svype OS</h1>
        <p className="text-slate-400 text-sm mb-8">Sign in to your account.</p>
        <div className="space-y-3 text-left">
          <input value={u} onChange={(e) => { setU(e.target.value); setErr(""); }} placeholder="username" className={darkInput} />
          <input type="password" value={p} onChange={(e) => { setP(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="password" className={darkInput} />
          {err && <div className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">{err}</div>}
          <button onClick={submit} className="w-full py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 font-medium">Sign in</button>
        </div>
        <p className="text-xs text-slate-500 mt-6">No account? Ask HR to create one for you.</p>
      </div>
    </div>
  );
}

const NAV = [
  { id: "dash", label: "Dashboard", icon: LayoutDashboard },
  { id: "team", label: "Team Chat", icon: MessageSquare },
];

function Shell({ session, onLogout }) {
  const [tab, setTab] = useState("dash");
  const { data, loading } = useStore(session);
  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-800">
      <aside className="w-60 shrink-0 bg-slate-900 text-slate-300 flex flex-col">
        <div className="px-5 py-5 border-b border-slate-700 flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-sky-600 grid place-items-center text-white font-black">S</div>
          <div><div className="font-bold text-sm text-white">Svype OS</div><div className="text-xs text-slate-400">{ROLES[session.role]}</div></div>
        </div>
        <nav className="flex-1 py-3">
          {NAV.map((n) => { const I = n.icon; return (
            <button key={n.id} onClick={() => setTab(n.id)} className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm ${tab === n.id ? "bg-slate-800 text-white border-r-2 border-sky-500" : "text-slate-400 hover:text-white hover:bg-slate-800"}`}>
              <I size={17} /> {n.label}
            </button>); })}
        </nav>
        <div className="p-4 border-t border-slate-700">
          <div className="text-xs text-slate-400 mb-2">{session.username}</div>
          <button onClick={onLogout} className="flex items-center gap-2 text-sm hover:text-white"><LogOut size={15} /> Sign out</button>
        </div>
      </aside>
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-8">
          {loading ? <Loader2 className="animate-spin text-sky-600" /> : (
            <>
              {tab === "dash" && <Dashboard data={data} session={session} />}
              {tab === "team" && <TeamChat session={session} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Dashboard({ data, session }) {
  const stats = [
    ["Employees", data.employees.length],
    ["Clients", data.clients.length],
    ["Open vendor bills", data.vendorBills.filter((b) => !b.paid).length],
    ["Unpaid retainers", data.retainerInvoices.filter((i) => i.status !== "Paid").length],
  ];
  return (
    <>
      <h2 className="text-xl font-bold mb-1">Dashboard</h2>
      <p className="text-sm text-slate-500 mb-6">Signed in as {session.username} · {ROLES[session.role]}</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(([k, v]) => (
          <div key={k} className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="text-2xl font-bold">{v}</div>
            <div className="text-xs text-slate-500 mt-1">{k}</div>
          </div>
        ))}
      </div>
      <p className="text-sm text-slate-500 mt-8">This is the hosted Svype OS core. Team Chat is live in the sidebar. The full module set ported from your browser app plugs into this same backend.</p>
    </>
  );
}

/* ===================== TEAM CHAT ===================== */
function TeamChat({ session }) {
  const [channels, setChannels] = useState([]);
  const [directory, setDirectory] = useState([]);
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [newCh, setNewCh] = useState("");
  const [showDir, setShowDir] = useState(false);
  const wsRef = useRef(null);
  const endRef = useRef(null);

  const loadChannels = useCallback(async () => {
    const ch = await api.get("/chat/channels");
    setChannels(ch);
    if (!active && ch.length) setActive(ch[0]);
  }, [active]);

  useEffect(() => { loadChannels(); api.get("/chat/directory").then(setDirectory).catch(() => {}); }, []);

  useEffect(() => {
    const ws = openSocket((m) => {
      if (m.type === "message" && m.channelId === active?.id) {
        setMessages((prev) => [...prev, m.message]);
      }
    });
    wsRef.current = ws;
    return () => ws.close();
  }, [active?.id]);

  useEffect(() => {
    if (!active) return;
    api.get(`/chat/channels/${active.id}/messages`).then((ms) => {
      setMessages(ms);
      if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: "join", channelId: active.id }));
    });
  }, [active]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = async () => {
    if (!text.trim() || !active) return;
    await api.post(`/chat/channels/${active.id}/messages`, { body: text.trim() });
    setText("");
  };
  const createChannel = async () => {
    if (!newCh.trim()) return;
    const c = await api.post("/chat/channels", { name: newCh.trim() });
    setNewCh(""); await loadChannels(); setActive(c);
  };
  const startDm = async (userId) => {
    const c = await api.post("/chat/dm", { userId });
    setShowDir(false); await loadChannels(); setActive(c);
  };

  const chans = channels.filter((c) => c.kind === "channel");
  const dms = channels.filter((c) => c.kind === "dm");

  return (
    <>
      <h2 className="text-xl font-bold mb-1">Team Chat</h2>
      <p className="text-sm text-slate-500 mb-5">Channels and direct messages for everyone in the company.</p>
      <div className="flex gap-4 bg-white border border-slate-200 rounded-xl overflow-hidden" style={{ height: "70vh" }}>
        <div className="w-56 shrink-0 border-r border-slate-200 flex flex-col">
          <div className="p-3 border-b border-slate-100">
            <div className="flex items-center gap-1">
              <input value={newCh} onChange={(e) => setNewCh(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createChannel()} placeholder="new channel" className={inputCls + " text-xs"} />
              <button onClick={createChannel} className="p-2 rounded bg-sky-600 text-white"><Plus size={14} /></button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            <div className="text-xs uppercase text-slate-400 px-2 mb-1">Channels</div>
            {chans.map((c) => (
              <button key={c.id} onClick={() => setActive(c)} className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-1.5 ${active?.id === c.id ? "bg-sky-50 text-sky-700" : "hover:bg-slate-50"}`}>
                <Hash size={13} />{c.name}
              </button>
            ))}
            <div className="flex items-center justify-between mt-3 mb-1 px-2">
              <span className="text-xs uppercase text-slate-400">Direct</span>
              <button onClick={() => setShowDir((s) => !s)} className="text-sky-600"><Plus size={13} /></button>
            </div>
            {showDir && (
              <div className="bg-slate-50 rounded p-1 mb-2">
                {directory.map((u) => (
                  <button key={u.id} onClick={() => startDm(u.id)} className="w-full text-left px-2 py-1 rounded text-xs hover:bg-white">{u.username}</button>
                ))}
                {directory.length === 0 && <div className="text-xs text-slate-400 px-2 py-1">No other users yet</div>}
              </div>
            )}
            {dms.map((c) => (
              <button key={c.id} onClick={() => setActive(c)} className={`w-full text-left px-2 py-1.5 rounded text-sm ${active?.id === c.id ? "bg-sky-50 text-sky-700" : "hover:bg-slate-50"}`}>@ {c.name}</button>
            ))}
          </div>
        </div>
        <div className="flex-1 flex flex-col min-w-0">
          {active ? (
            <>
              <div className="px-4 py-3 border-b border-slate-100 font-semibold text-sm flex items-center gap-1.5">
                {active.kind === "channel" ? <Hash size={15} /> : "@"} {active.name}
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.map((m) => (
                  <div key={m.id} className={`flex flex-col ${m.userId === session.id ? "items-end" : "items-start"}`}>
                    <div className="text-xs text-slate-400 mb-0.5">{m.username} · {new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                    <div className={`px-3 py-2 rounded-2xl text-sm max-w-md ${m.userId === session.id ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-800"}`}>{m.body}</div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>
              <div className="p-3 border-t border-slate-100 flex gap-2">
                <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={`Message ${active.kind === "channel" ? "#" + active.name : active.name}`} className={inputCls} />
                <button onClick={send} className="px-4 rounded-lg bg-sky-600 text-white"><Send size={16} /></button>
              </div>
            </>
          ) : (
            <div className="flex-1 grid place-items-center text-slate-400 text-sm">Select or create a channel to start chatting</div>
          )}
        </div>
      </div>
    </>
  );
}
