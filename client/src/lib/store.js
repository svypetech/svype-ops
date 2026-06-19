import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "./api";

// collection key -> endpoint
const EP = {
  employees: "/employees", clients: "/clients", attendance: "/attendance", leaves: "/leaves",
  advances: "/advances", timesheets: "/timesheets", candidates: "/candidates", invoices: "/invoices",
  payables: "/payables", receivables: "/receivables", letters: "/letters", proposals: "/proposals",
  quotations: "/quotations", offers: "/offers", retainers: "/retainers", bankAccounts: "/bank-accounts",
  meetingNotes: "/meeting-notes", announcements: "/announcements", requests: "/requests",
  payroll: "/payroll", vendorBills: "/vendor-bills", retainerInvoices: "/retainer-invoices",
  audit: "/audit", users: "/auth/users",
};
const KEYS = Object.keys(EP);

// fields that on the server map to from_date/to_date
const fixLeaveOut = (r) => ({ ...r, from: r.fromDate ?? r.from, to: r.toDate ?? r.to });

export function useStore(session) {
  const [data, setData] = useState(() => Object.fromEntries(KEYS.map((k) => [k, []])));
  const [loading, setLoading] = useState(true);
  const dataRef = useRef(data);
  dataRef.current = data;

  const loadAll = useCallback(async () => {
    const out = {};
    await Promise.all(
      KEYS.map(async (k) => {
        try {
          let rows = await api.get(EP[k]);
          if (k === "leaves") rows = rows.map(fixLeaveOut);
          out[k] = rows || [];
        } catch {
          out[k] = [];
        }
      })
    );
    setData(out);
    setLoading(false);
  }, []);

  useEffect(() => { if (session) loadAll(); }, [session, loadAll]);

  // Diff-based update: compares incoming rows with current to issue create/update/delete.
  const update = useCallback(async (key, rows, audit) => {
    const ep = EP[key];
    setData((d) => ({ ...d, [key]: rows })); // optimistic
    if (!ep) return;
    const prev = dataRef.current[key] || [];
    const prevById = Object.fromEntries(prev.map((r) => [r.id, r]));
    const nextIds = new Set(rows.map((r) => r.id).filter(Boolean));
    try {
      // deletes
      for (const r of prev) if (r.id && !nextIds.has(r.id)) await api.del(`${ep}/${r.id}`);
      // creates + updates
      for (const r of rows) {
        const body = key === "leaves" ? { ...r, fromDate: r.from, toDate: r.to } : r;
        if (!r.id || typeof r.id === "string") {
          // new (string/local id) -> create
          const { id, ...rest } = body;
          await api.post(ep, rest);
        } else if (JSON.stringify(prevById[r.id]) !== JSON.stringify(r)) {
          await api.put(`${ep}/${r.id}`, body);
        }
      }
      if (audit) await api.post("/audit", { action: audit });
    } catch (e) { console.error(e); }
    await loadAll();
  }, [loadAll]);

  const patch = useCallback(async (obj, audit) => {
    for (const k of Object.keys(obj)) await update(k, obj[k], undefined);
    if (audit) { try { await api.post("/audit", { action: audit }); } catch {} }
    await loadAll();
  }, [update, loadAll]);

  return { data, loading, update, patch, reload: loadAll };
}
