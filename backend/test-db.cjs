
require("dotenv").config();
const { Pool } = require("pg");

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
});

async function testConnection() {
  try {
    const result = await db.query(
      "SELECT current_database() AS database_name, NOW() AS server_time"
    );

    console.log("✅ DATABASE CONNECTED SUCCESSFULLY");
    console.log("Database:", result.rows[0].database_name);
    console.log("Server time:", result.rows[0].server_time);

    const tables = await db.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('registrations', 'payments')
      ORDER BY table_name
    `);

    console.log(
      "Tables found:",
      tables.rows.map(row => row.table_name).join(", ") || "None"
    );
  } catch (error) {
    console.error("❌ CONNECTION FAILED:", error.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

testConnection();
