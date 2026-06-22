require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '15432'),
    user: process.env.DB_USER || 'dune',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'dune',
  });

  const searchHex = '3E75EF6EA75D1A52'; 
  const searchDec = '4500766661160016466';

  try {
    await client.connect();
    console.log(`Connected to database. Searching for hex "${searchHex}" or decimal "${searchDec}"...`);

    const schema = process.env.DB_SCHEMA || 'dune';
    // Get all tables and columns in the configured schema (no type limits)
    const res = await client.query(`
      SELECT table_name, column_name 
      FROM information_schema.columns 
      WHERE table_schema = $1
    `, [schema]);

    console.log(`Found ${res.rows.length} columns to check. Searching...`);

    for (const row of res.rows) {
      const { table_name, column_name } = row;
      try {
        const query = `
          SELECT COUNT(*) FROM ${schema}.${table_name} 
          WHERE LOWER(${column_name}::text) = $1 
             OR LOWER(${column_name}::text) = $2
             OR LOWER(${column_name}::text) LIKE $3
        `;
        const searchRes = await client.query(query, [searchHex.toLowerCase(), searchDec.toLowerCase(), `%${searchHex.toLowerCase()}%`]);
        const count = parseInt(searchRes.rows[0].count);
        if (count > 0) {
          console.log(`\n[FOUND] Table: "${table_name}", Column: "${column_name}" has ${count} matching records.`);
          
          // Print matching records
          const records = await client.query(`
            SELECT * FROM ${schema}.${table_name} 
            WHERE LOWER(${column_name}::text) = $1 
               OR LOWER(${column_name}::text) = $2
               OR LOWER(${column_name}::text) LIKE $3 
            LIMIT 5
          `, [searchHex.toLowerCase(), searchDec.toLowerCase(), `%${searchHex.toLowerCase()}%`]);
          console.log(JSON.stringify(records.rows, null, 2));
        }
      } catch (err) {
        // Skip columns that fail query
      }
    }
    console.log('\nSearch completed.');
  } catch (err) {
    console.error('Error running search:', err.message);
  } finally {
    await client.end();
  }
}

main();
