const express = require("express");
const { pool } = require("../db");
const { auth, adminOnly, staffOnly } = require("../middleware/auth");
const { rowOut } = require("./crud");

const router = express.Router();
const who = (req) => req.user?.username || "system";
async function logAudit(w, action) { try { await pool.query("INSERT INTO audit (who, action) VALUES ($1,$2)", [w, action]); } catch {} }

/* ---------- Pakistan payroll calc ---------- */
function annualTax(a) {
  if (a <= 600000) return 0;
  if (a <= 1200000) return (a - 600000) * 0.01;
  if (a <= 2200000) return 6000 + (a - 1200000) * 0.11;
  if (a <= 3200000) return 116000 + (a - 2200000) * 0.23;
  if (a <= 4100000) return 346000 + (a - 3200000) * 0.30;
  return 616000 + (a - 4100000) * 0.35;
}
const EOBI = 250;

/* ---------- Payroll ---------- */
router.get("/payroll", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM payroll ORDER BY id DESC");
  res.json(r.rows.map(rowOut));
});

router.post("/payroll/run", auth, staffOnly, async (req, res) => {
  const month = req.body.month;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const emps = (await client.query("SELECT * FROM employees WHERE status='Active'")).rows;
    const reimb = (await client.query(
      "SELECT * FROM payables WHERE kind='reimbursement' AND status='Approved' AND settled=FALSE"
    )).rows;
    const advances = (await client.query("SELECT * FROM advances WHERE status='Active' AND remaining>0")).rows;

    for (const e of emps) {
      const basic = +e.salary || 0;
      const allowances = Math.round(basic * 0.1);
      const empReimb = reimb.filter((p) => p.vendor === e.name).reduce((s, p) => s + +p.amount, 0);
      const tax = Math.round(annualTax((basic + allowances) * 12) / 12);
      const pf = Math.round(basic * (+e.pf || 0) / 100);
      const adv = advances.filter((a) => a.employee === e.name)
        .reduce((s, a) => s + Math.min(+a.installment, +a.remaining), 0);
      const deductions = tax + EOBI + pf + adv;
      await client.query(
        `INSERT INTO payroll (employee, month, basic, allowances, reimbursements, tax, eobi, pf, advance, deductions, paid)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE)`,
        [e.name, month, basic, allowances, empReimb, tax, EOBI, pf, adv, deductions]
      );
    }
    // settle reimbursements
    await client.query(
      "UPDATE payables SET settled=TRUE, status='Paid' WHERE kind='reimbursement' AND status='Approved' AND settled=FALSE"
    );
    // reduce advances
    for (const a of advances) {
      const d = Math.min(+a.installment, +a.remaining);
      const rem = +a.remaining - d;
      await client.query("UPDATE advances SET remaining=$2, status=$3 WHERE id=$1", [a.id, rem, rem <= 0 ? "Cleared" : "Active"]);
    }
    await client.query("COMMIT");
    await logAudit(who(req), `Ran payroll for ${month}`);
    const out = await pool.query("SELECT * FROM payroll ORDER BY id DESC");
    res.json(out.rows.map(rowOut));
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post("/payroll/:id/paid", auth, staffOnly, async (req, res) => {
  const { proof, payMethod } = req.body;
  const r = await pool.query(
    "UPDATE payroll SET paid=TRUE, proof=$2, pay_method=$3, paid_on=CURRENT_DATE WHERE id=$1 RETURNING *",
    [req.params.id, proof || null, payMethod || null]
  );
  await logAudit(who(req), `Marked salary paid: ${r.rows[0]?.employee} (${r.rows[0]?.month})`);
  res.json(rowOut(r.rows[0]));
});

/* ---------- Vendor bills (dual approval) ---------- */
router.get("/vendor-bills", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM vendor_bills ORDER BY id DESC");
  res.json(r.rows.map(rowOut));
});

function billStatus(b) {
  if (b.paid) return "Paid";
  if (b.hr_approved && b.founder_approved) return "Approved";
  if (b.hr_approved) return "Pending Founder";
  return "Pending HR";
}

router.post("/vendor-bills", auth, staffOnly, async (req, res) => {
  const b = req.body;
  const r = await pool.query(
    `INSERT INTO vendor_bills (vendor, descr, category, amount, currency, due, file, file_name, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Pending HR') RETURNING *`,
    [b.vendor, b.descr, b.category, b.amount, b.currency || "PKR", b.due || null, b.file || null, b.fileName || null]
  );
  await logAudit(who(req), `Uploaded vendor bill: ${b.vendor}`);
  res.json(rowOut(r.rows[0]));
});

router.put("/vendor-bills/:id", auth, staffOnly, async (req, res) => {
  const b = req.body;
  const r = await pool.query(
    `UPDATE vendor_bills SET vendor=$2, descr=$3, category=$4, amount=$5, currency=$6, due=$7, file=$8, file_name=$9 WHERE id=$1 RETURNING *`,
    [req.params.id, b.vendor, b.descr, b.category, b.amount, b.currency, b.due || null, b.file || null, b.fileName || null]
  );
  res.json(rowOut(r.rows[0]));
});

router.post("/vendor-bills/:id/approve", auth, async (req, res) => {
  const kind = req.body.kind; // 'hr' | 'founder'
  if (kind === "founder" && req.user.role !== "admin")
    return res.status(403).json({ error: "Only the founder can give final approval" });
  if (!["admin", "hr"].includes(req.user.role))
    return res.status(403).json({ error: "Not allowed" });
  const cur = (await pool.query("SELECT * FROM vendor_bills WHERE id=$1", [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: "Not found" });
  const stamp = JSON.stringify({ by: kind === "hr" ? "HR" : "Founder", on: new Date().toISOString().slice(0, 10) });
  const col = kind === "hr" ? "hr_approved" : "founder_approved";
  const upd = (await pool.query(`UPDATE vendor_bills SET ${col}=$2 WHERE id=$1 RETURNING *`, [req.params.id, stamp])).rows[0];
  const status = billStatus(upd);
  const fin = (await pool.query("UPDATE vendor_bills SET status=$2 WHERE id=$1 RETURNING *", [req.params.id, status])).rows[0];
  await logAudit(who(req), `${kind === "hr" ? "HR" : "Founder"} approved vendor bill: ${cur.vendor}`);
  res.json(rowOut(fin));
});

router.post("/vendor-bills/:id/pay", auth, staffOnly, async (req, res) => {
  const b = (await pool.query("SELECT * FROM vendor_bills WHERE id=$1", [req.params.id])).rows[0];
  if (!b || !b.hr_approved || !b.founder_approved) return res.status(400).json({ error: "Needs both approvals first" });
  await pool.query(
    `INSERT INTO payables (vendor, descr, amount, due, status, kind, bill_id, receipt)
     VALUES ($1,$2,$3,$4,'Pending','vendorbill',$5,$6)`,
    [b.vendor, `Vendor bill: ${b.descr || b.category}`, b.amount, b.due, b.id, b.file]
  );
  const r = await pool.query("UPDATE vendor_bills SET paid=TRUE, status='Paid' WHERE id=$1 RETURNING *", [req.params.id]);
  await logAudit(who(req), `Vendor bill sent to Payables: ${b.vendor}`);
  res.json(rowOut(r.rows[0]));
});

router.delete("/vendor-bills/:id", auth, staffOnly, async (req, res) => {
  await pool.query("DELETE FROM vendor_bills WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

/* ---------- Payables reimbursement approve ---------- */
router.post("/payables/:id/approve", auth, staffOnly, async (req, res) => {
  const r = await pool.query("UPDATE payables SET status='Approved' WHERE id=$1 RETURNING *", [req.params.id]);
  await logAudit(who(req), `Approved reimbursement: ${r.rows[0]?.vendor}`);
  res.json(rowOut(r.rows[0]));
});

/* ---------- Retainers: generate due + pay ---------- */
function monthKey() { return new Date().toISOString().slice(0, 7); }
function monthLabel() { return new Date().toLocaleString("default", { month: "long", year: "numeric" }); }

router.post("/retainers/generate", auth, staffOnly, async (req, res) => {
  const mk = monthKey(), ml = monthLabel();
  const rets = (await pool.query("SELECT * FROM retainers WHERE status='Active'")).rows;
  for (const r of rets) {
    const exists = await pool.query("SELECT 1 FROM retainer_invoices WHERE retainer_id=$1 AND month_key=$2", [r.id, mk]);
    if (exists.rowCount) continue;
    const base = +r.amount || 0, carry = +r.carry || 0;
    const count = (await pool.query("SELECT COUNT(*) FROM retainer_invoices")).rows[0].count;
    await pool.query(
      `INSERT INTO retainer_invoices (retainer_id, client, number, month_key, month, base, carry, total, currency, status, paid_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Unpaid',0)`,
      [r.id, r.client, `RET-${mk.replace("-", "")}-${+count + 1}`, mk, ml, base, carry, base + carry, r.currency || "PKR"]
    );
    await pool.query("UPDATE retainers SET carry=0 WHERE id=$1", [r.id]);
  }
  const out = await pool.query("SELECT * FROM retainer_invoices ORDER BY id DESC");
  res.json(out.rows.map(rowOut));
});

router.post("/retainer-invoices/:id/pay", auth, staffOnly, async (req, res) => {
  const { received, accountName, carryChoice } = req.body;
  const inv = (await pool.query("SELECT * FROM retainer_invoices WHERE id=$1", [req.params.id])).rows[0];
  if (!inv) return res.status(404).json({ error: "Not found" });
  const recv = +received || 0;
  const shortfall = Math.max(0, +inv.total - recv);
  const status = shortfall <= 0 ? "Paid" : recv > 0 ? "Partial" : "Unpaid";
  await pool.query(
    "UPDATE retainer_invoices SET status=$2, paid_amount=$3, account=$4, paid_date=CURRENT_DATE WHERE id=$1",
    [req.params.id, status, recv, accountName || null]
  );
  if (shortfall > 0 && carryChoice === "next")
    await pool.query("UPDATE retainers SET carry=carry+$2 WHERE id=$1", [inv.retainer_id, shortfall]);
  await logAudit(who(req), `Payment recorded for ${inv.client} (${inv.number})`);
  const out = await pool.query("SELECT * FROM retainer_invoices ORDER BY id DESC");
  res.json(out.rows.map(rowOut));
});

router.get("/retainer-invoices", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM retainer_invoices ORDER BY id DESC");
  res.json(r.rows.map(rowOut));
});

/* ---------- Brand (singleton) ---------- */
router.get("/brand", auth, async (req, res) => {
  const r = await pool.query("SELECT * FROM brand WHERE id=1");
  res.json(rowOut(r.rows[0]));
});
router.put("/brand", auth, staffOnly, async (req, res) => {
  const b = req.body;
  const r = await pool.query(
    `UPDATE brand SET company=$1, tagline=$2, address=$3, contact=$4, accent=$5, logo=$6, signatories=$7, stamps=$8 WHERE id=1 RETURNING *`,
    [b.company, b.tagline, b.address, b.contact, b.accent, b.logo || null,
     JSON.stringify(b.signatories || []), JSON.stringify(b.stamps || [])]
  );
  res.json(rowOut(r.rows[0]));
});

/* ---------- Audit ---------- */
router.get("/audit", auth, staffOnly, async (req, res) => {
  const r = await pool.query("SELECT * FROM audit ORDER BY id DESC LIMIT 500");
  res.json(r.rows.map(rowOut));
});
router.post("/audit", auth, async (req, res) => {
  await logAudit(who(req), req.body.action || "");
  res.json({ ok: true });
});

module.exports = router;
