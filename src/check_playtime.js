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
      SELECT bap.*, ps.character_name 
      FROM dune.bot_active_playtime bap
      LEFT JOIN dune.player_state ps ON bap.character_id = ps.player_pawn_id;
    `);
    console.log("Playtime Table contents:");
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

main();
