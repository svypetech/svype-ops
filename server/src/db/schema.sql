-- Svype OS — PostgreSQL schema
-- One company per deployment (single-tenant). All data shared across users.

CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  password     TEXT NOT NULL,                 -- bcrypt hash
  role         TEXT NOT NULL CHECK (role IN ('admin','hr','employee')),
  emp_id       INTEGER,                       -- links to employees.id when role=employee
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  perms        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employees (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  role       TEXT,
  dept       TEXT,
  email      TEXT,
  phone      TEXT,
  cnic       TEXT,
  salary     NUMERIC NOT NULL DEFAULT 0,
  pf         NUMERIC NOT NULL DEFAULT 0,
  joined     DATE,
  status     TEXT NOT NULL DEFAULT 'Active',
  bank_name  TEXT,
  account    TEXT,
  docs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  email     TEXT,
  whatsapp  TEXT,
  currency  TEXT NOT NULL DEFAULT 'PKR',
  notes     TEXT
);

CREATE TABLE IF NOT EXISTS attendance (
  id        SERIAL PRIMARY KEY,
  employee  TEXT NOT NULL,
  date      DATE NOT NULL,
  status    TEXT NOT NULL,
  check_in  TIMESTAMPTZ,
  check_out TIMESTAMPTZ,
  location  JSONB
);

CREATE TABLE IF NOT EXISTS leaves (
  id        SERIAL PRIMARY KEY,
  employee  TEXT NOT NULL,
  type      TEXT NOT NULL,
  from_date DATE NOT NULL,
  to_date   DATE NOT NULL,
  reason    TEXT,
  status    TEXT NOT NULL DEFAULT 'Pending'
);

CREATE TABLE IF NOT EXISTS payroll (
  id            SERIAL PRIMARY KEY,
  employee      TEXT NOT NULL,
  month         TEXT NOT NULL,
  basic         NUMERIC NOT NULL DEFAULT 0,
  allowances    NUMERIC NOT NULL DEFAULT 0,
  reimbursements NUMERIC NOT NULL DEFAULT 0,
  tax           NUMERIC NOT NULL DEFAULT 0,
  eobi          NUMERIC NOT NULL DEFAULT 0,
  pf            NUMERIC NOT NULL DEFAULT 0,
  advance       NUMERIC NOT NULL DEFAULT 0,
  deductions    NUMERIC NOT NULL DEFAULT 0,
  paid          BOOLEAN NOT NULL DEFAULT FALSE,
  proof         TEXT,
  pay_method    TEXT,
  paid_on       DATE,
  date          DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS advances (
  id          SERIAL PRIMARY KEY,
  employee    TEXT NOT NULL,
  total       NUMERIC NOT NULL,
  installment NUMERIC NOT NULL,
  remaining   NUMERIC NOT NULL,
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  status      TEXT NOT NULL DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS timesheets (
  id       SERIAL PRIMARY KEY,
  employee TEXT NOT NULL,
  client   TEXT,
  date     DATE NOT NULL,
  work     TEXT,
  status   TEXT DEFAULT 'Completed',
  hours    NUMERIC DEFAULT 0,
  edited   BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS candidates (
  id       SERIAL PRIMARY KEY,
  name     TEXT NOT NULL,
  role     TEXT,
  email    TEXT,
  phone    TEXT,
  stage    TEXT DEFAULT 'Applied',
  notes    TEXT,
  cv       TEXT,
  cv_name  TEXT,
  date     DATE DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS invoices (
  id       SERIAL PRIMARY KEY,
  client   TEXT,
  number   TEXT,
  amount   NUMERIC DEFAULT 0,
  currency TEXT DEFAULT 'PKR',
  date     DATE DEFAULT CURRENT_DATE,
  status   TEXT DEFAULT 'Draft',
  type     TEXT DEFAULT 'Invoice'
);

CREATE TABLE IF NOT EXISTS payables (
  id      SERIAL PRIMARY KEY,
  vendor  TEXT,
  descr   TEXT,
  amount  NUMERIC DEFAULT 0,
  due     DATE,
  status  TEXT DEFAULT 'Pending',
  kind    TEXT,
  bill_id INTEGER,
  settled BOOLEAN DEFAULT FALSE,
  receipt TEXT
);

CREATE TABLE IF NOT EXISTS receivables (
  id     SERIAL PRIMARY KEY,
  client TEXT,
  descr  TEXT,
  amount NUMERIC DEFAULT 0,
  due    DATE,
  status TEXT DEFAULT 'Outstanding'
);

CREATE TABLE IF NOT EXISTS vendor_bills (
  id              SERIAL PRIMARY KEY,
  vendor          TEXT NOT NULL,
  descr           TEXT,
  category        TEXT,
  amount          NUMERIC NOT NULL DEFAULT 0,
  currency        TEXT DEFAULT 'PKR',
  due             DATE,
  file            TEXT,
  file_name       TEXT,
  hr_approved     JSONB,
  founder_approved JSONB,
  status          TEXT DEFAULT 'Pending HR',
  paid            BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS letters (
  id       SERIAL PRIMARY KEY,
  doc_type TEXT,
  type     TEXT,
  name     TEXT,
  date     DATE DEFAULT CURRENT_DATE,
  body     TEXT,
  signed   JSONB
);

CREATE TABLE IF NOT EXISTS proposals (
  id     SERIAL PRIMARY KEY,
  client TEXT,
  title  TEXT,
  date   DATE DEFAULT CURRENT_DATE,
  body   TEXT,
  signed JSONB
);

CREATE TABLE IF NOT EXISTS quotations (
  id       SERIAL PRIMARY KEY,
  number   TEXT,
  client   TEXT,
  currency TEXT DEFAULT 'PKR',
  amount   NUMERIC DEFAULT 0,
  date     DATE DEFAULT CURRENT_DATE,
  body     TEXT,
  signed   JSONB
);

CREATE TABLE IF NOT EXISTS offers (
  id       SERIAL PRIMARY KEY,
  doc_type TEXT DEFAULT 'Offer Letter',
  name     TEXT,
  email    TEXT,
  role     TEXT,
  date     DATE DEFAULT CURRENT_DATE,
  body     TEXT,
  signed   JSONB
);

CREATE TABLE IF NOT EXISTS retainers (
  id         SERIAL PRIMARY KEY,
  client     TEXT NOT NULL,
  whatsapp   TEXT,
  amount     NUMERIC DEFAULT 0,
  currency   TEXT DEFAULT 'PKR',
  billing_day INTEGER DEFAULT 1,
  status     TEXT DEFAULT 'Active',
  carry      NUMERIC DEFAULT 0
);

CREATE TABLE IF NOT EXISTS retainer_invoices (
  id          SERIAL PRIMARY KEY,
  retainer_id INTEGER,
  client      TEXT,
  number      TEXT,
  month_key   TEXT,
  month       TEXT,
  base        NUMERIC DEFAULT 0,
  carry       NUMERIC DEFAULT 0,
  total       NUMERIC DEFAULT 0,
  currency    TEXT DEFAULT 'PKR',
  status      TEXT DEFAULT 'Unpaid',
  paid_amount NUMERIC DEFAULT 0,
  account     TEXT,
  date        DATE DEFAULT CURRENT_DATE,
  paid_date   DATE
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id     SERIAL PRIMARY KEY,
  type   TEXT NOT NULL DEFAULT 'Company',
  label  TEXT NOT NULL,
  title  TEXT,
  number TEXT,
  iban   TEXT,
  bank   TEXT,
  notes  TEXT
);

CREATE TABLE IF NOT EXISTS meeting_notes (
  id       SERIAL PRIMARY KEY,
  employee TEXT NOT NULL,
  client   TEXT,
  title    TEXT,
  body     TEXT,
  date     DATE DEFAULT CURRENT_DATE,
  edited   BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS announcements (
  id    SERIAL PRIMARY KEY,
  title TEXT,
  body  TEXT,
  date  DATE DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS requests (
  id       SERIAL PRIMARY KEY,
  employee TEXT NOT NULL,
  type     TEXT,
  note     TEXT,
  status   TEXT DEFAULT 'Open',
  date     DATE DEFAULT CURRENT_DATE
);

CREATE TABLE IF NOT EXISTS audit (
  id    SERIAL PRIMARY KEY,
  who   TEXT,
  action TEXT,
  date  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS brand (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  company     TEXT,
  tagline     TEXT,
  address     TEXT,
  contact     TEXT,
  accent      TEXT DEFAULT '#0284c7',
  logo        TEXT,
  signatories JSONB NOT NULL DEFAULT '[]'::jsonb,
  stamps      JSONB NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT brand_singleton CHECK (id = 1)
);

-- ===== Chat =====
CREATE TABLE IF NOT EXISTS channels (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'channel',  -- 'channel' | 'dm'
  members    JSONB NOT NULL DEFAULT '[]'::jsonb, -- for DMs: [userId, userId]; channels open to all
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL,
  username   TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);

-- Whole-app shared state (the existing UI's `data` blob + brand)
CREATE TABLE IF NOT EXISTS app_state (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  doc        JSONB,
  brand      JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_state_singleton CHECK (id = 1)
);
