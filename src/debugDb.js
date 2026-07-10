require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '15432'),
  user: process.env.DB_USER || 'dune',
  password: process.env.DB_PASSWORD || 'dune',
  database: process.env.DB_NAME || 'dune',
});

async function main() {
  const schema = process.env.DB_SCHEMA || 'dune';
  console.log(`Connecting to DB to inspect building 144...`);
  try {
    const actorRes = await pool.query(`SELECT id, class, map, transform::text, partition_id, dimension_index, serial FROM ${schema}.actors WHERE id = 144`);
    console.log('\n================ ACTOR 144 ================');
    console.log(JSON.stringify(actorRes.rows, null, 2));

    const instancesRes = await pool.query(`SELECT instance_id, building_type, transform::text, health, shelter, building_flags FROM ${schema}.building_instances WHERE building_id = 144 LIMIT 5`);
    console.log('\n================ INSTANCES SAMPLE (BUILDING 144) ================');
    console.log(JSON.stringify(instancesRes.rows, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

main();

