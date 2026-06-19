const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function init() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
  // ensure single brand row exists
  await pool.query(
    `INSERT INTO brand (id, company, tagline, address, contact)
     VALUES (1, 'Svype Tech Limited', 'Digital Marketing & Creative Agency', 'Islamabad · Lahore, Pakistan', 'hello@svype.com')
     ON CONFLICT (id) DO NOTHING`
  );
  console.log("DB schema ready");
}

module.exports = { pool, init };
