const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '15432'),
  user: process.env.DB_USER || 'dune',
  password: process.env.DB_PASSWORD || 'dune',
  database: process.env.DB_NAME || 'dune'
});

async function main() {
  try {
    const res = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'dune' 
      ORDER BY table_name;
    `);
    
    console.log("All tables in dune schema:");
    const names = res.rows.map(r => r.table_name);
    console.log(JSON.stringify(names, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

main();
