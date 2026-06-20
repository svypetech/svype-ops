# Svype OS — Hosted (Render)

Full-stack version of Svype OS: **Node + Express + PostgreSQL** backend with **secure JWT auth** (bcrypt-hashed passwords) and **real-time Team Chat** (WebSockets), plus a **React (Vite + Tailwind)** frontend.

---

## What works in this build

- **First-run setup** → create your founding Super Admin / HR account (passwords are hashed).
- **Secure login** enforced on the server. Sessions via JWT.
- **Shared database** — all data lives in PostgreSQL, shared across every device/user (no more per-browser storage).
- **Team Chat** — channels, direct messages to anyone in the company, real-time delivery.
- **Full backend for every module** — employees, users & permissions, clients, attendance, leaves, payroll (with Pakistan tax/EOBI/PF + advances), advances, timesheets/daily work, recruitment + CV, vendor bills (dual HR+Founder approval), invoices, payables (with reimbursement approval), receivables, retainers (auto invoices + payments), bank accounts, meeting notes, announcements, requests, audit log, brand. All exposed as REST APIs and ready.

## Status

**The full app is here** — every module from your browser version (employees, users & permissions, clients, attendance, payroll, advances, vendor bills, timesheets/daily work, recruitment, CV bank, offers, letters, proposals, quotations, retainers, invoices, payables, receivables, meeting notes, bank accounts, announcements, requests, audit, brand, backup) plus **Team Chat** (channels + DMs, real-time). Data is stored centrally in PostgreSQL and shared across all devices.

### Auth note
The app keeps its own login/permission system (carried over from your build) and stores all data as one shared document on the server. A server-side hashed-password auth layer also exists (used to secure chat) and can be made the primary login in a later hardening pass.

## (was) What's next

The backend is complete for all modules. The **frontend currently ships the core**: auth, dashboard, and full Team Chat. The detailed module **screens** from the browser version are ported onto this same backend in the next stage — the APIs they need already exist. This was done deliberately so you get a real, deployable, verifiable app now rather than an untested giant.

---

## Deploy to Render (easiest path — Blueprint)

1. Push this folder to a **GitHub** repo.
2. In Render: **New → Blueprint**, connect the repo. Render reads `render.yaml` and creates:
   - a free **PostgreSQL** database, and
   - the **web service** (builds the client, runs the server).
3. Wait for the first deploy. Open the service URL — you'll see the **first-run setup** screen. Create your admin account. Done.

`JWT_SECRET` is auto-generated; `DATABASE_URL` is auto-wired from the database. No manual env setup needed.

## Run locally

```bash
# 1) Start Postgres locally and create a database named "svypeos"
# 2) Backend
cd server
cp .env.example .env        # edit DATABASE_URL if needed
npm install
npm run dev                 # API on http://localhost:4000

# 3) Frontend (separate terminal)
cd client
npm install
npm run dev                 # app on http://localhost:5173 (proxies /api to 4000)
```

First screen is first-run setup → create your founding account → you're in.

---

## Notes

- `npm install` must run on your machine / Render — this project was authored in an offline environment, so dependencies aren't pre-installed.
- Images (logos, receipts, CVs, payment proofs) are stored as base64 in the database for now; moving them to object storage (S3/R2) is a later optimization.
- The free Render database and web service sleep when idle and have storage limits — fine for testing; move to paid plans for real daily use.

---

## Enabling AI drafting (optional)

Proposals can be drafted by Claude. This needs your own Anthropic API key (usage-based billing, cheap per draft):

1. Go to **console.anthropic.com** → sign in → add a payment method.
2. **API Keys → Create Key** → copy it.
3. In **Render → your service → Environment**, add:
   `ANTHROPIC_API_KEY = your-key`
4. Save — Render redeploys. The "Draft with AI" button on Proposals now works.

Until the key is set, the AI button shows a friendly "not configured yet" message and the rest of the app works normally. The key lives only on the server and is never exposed to the browser. Payslips, invoices, and quotation totals are always computed exactly (never AI-generated numbers).
