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
      SELECT ps.character_name, fe.components->'FLevelComponent' as level_comp
      FROM dune.player_state ps
      LEFT JOIN dune.actor_fgl_entities afe ON afe.actor_id = ps.player_pawn_id AND afe.slot_name = 'DuneCharacter'
      LEFT JOIN dune.fgl_entities fe ON fe.entity_id = afe.entity_id
      WHERE ps.character_name = 'Nalita'
      LIMIT 1;
    `);
    console.log("Player level component details for Nalita:");
    console.log(JSON.stringify(res.rows[0], null, 2));
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

main();
