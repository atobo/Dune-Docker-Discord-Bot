require('dotenv').config();
const database = require('./database');
const pool = database.pool;

const TARGET_TABLES = ['player_state', 'accounts', 'actors', 'actor_state', 'overmap_players'];

async function probeTable(schema, tableName) {
  console.log(`\n==================================================`);
  console.log(`Probing table: "${tableName}"`);
  console.log(`==================================================`);

  try {
    // Check if table exists
    const existsRes = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = $1 AND table_name = $2
      )`,
      [schema, tableName]
    );

    if (!existsRes.rows[0].exists) {
      console.log(`Table "${tableName}" does not exist in schema "${schema}".`);
      return;
    }

    // Get columns
    const columnsRes = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND table_schema = $2`,
      [tableName, schema]
    );
    console.log('Columns & Types:');
    columnsRes.rows.forEach(col => {
      console.log(`  - ${col.column_name} (${col.data_type})`);
    });

    // Fetch count
    const countRes = await pool.query(`SELECT COUNT(*) FROM ${schema}.${tableName}`);
    console.log(`Total rows: ${countRes.rows[0].count}`);

    // Fetch first 3 records
    console.log('First 3 records:');
    const recordsRes = await pool.query(`SELECT * FROM ${schema}.${tableName} LIMIT 3`);
    if (recordsRes.rows.length === 0) {
      console.log('  No records found in table.');
    } else {
      console.log(JSON.stringify(recordsRes.rows, null, 2));
    }
  } catch (err) {
    console.error(`Error probing table "${tableName}":`, err.message);
  }
}

async function main() {
  const schema = process.env.DB_SCHEMA || 'dune';
  console.log(`Connecting to database ${process.env.DB_NAME || 'dune'} on ${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || '15432'}...`);
  
  try {
    const timeRes = await pool.query('SELECT NOW()');
    console.log(`Connected. DB Time: ${timeRes.rows[0].now}`);

    for (const tableName of TARGET_TABLES) {
      await probeTable(schema, tableName);
    }

    console.log(`\n==================================================`);
    console.log(`Testing getOnlinePlayers() Function`);
    console.log(`==================================================`);
    const players = await database.getOnlinePlayers();
    console.log('\nFinal returned online players structure:', JSON.stringify(players, null, 2));

  } catch (error) {
    console.error('Error debugging database:', error.message);
  } finally {
    await pool.end();
  }
}

main();

