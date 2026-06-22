const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '15432'),
  user: process.env.DB_USER || 'dune',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'dune',
});

// Cache table/column info after discovery
let schemaInfo = null;

async function discoverSchema() {
  if (schemaInfo) return schemaInfo;

  const schema = process.env.DB_SCHEMA || 'dune';
  console.log(`[Database] Initiating schema discovery for schema: ${schema}...`);

  try {
    // 1. Get all tables in the schema
    const tablesRes = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema]
    );

    const tables = tablesRes.rows.map(r => r.table_name);
    console.log(`[Database] Found tables: ${tables.join(', ')}`);

    // 2. Identify character/player table
    let characterTable = tables.find(t => t.toLowerCase() === 'characters' || t.toLowerCase() === 'character_characters')
      || tables.find(t => t.toLowerCase().includes('character'))
      || tables.find(t => t.toLowerCase().includes('player'));

    if (!characterTable) {
      throw new Error('Could not identify a player or character table in the database schema.');
    }

    console.log(`[Database] Identified player/character table: "${characterTable}"`);

    // 3. Get columns for identified table
    const columnsRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = $2`,
      [characterTable, schema]
    );

    const columns = columnsRes.rows.map(r => r.column_name.toLowerCase());
    console.log(`[Database] Columns in "${characterTable}": ${columns.join(', ')}`);

    // 4. Map key properties to columns
    schemaInfo = {
      tableName: `${schema}.${characterTable}`,
      nameColumn: columns.find(c => c === 'name' || c.includes('name')),
      levelColumn: columns.find(c => c === 'level' || c.includes('level') || c === 'xp'),
      onlineColumn: columns.find(c => c === 'online' || c === 'is_online' || c.includes('active') || c.includes('status')),
      factionColumn: columns.find(c => c === 'faction' || c.includes('faction') || c === 'guild')
    };

    console.log('[Database] Schema mapping completed:', schemaInfo);
    return schemaInfo;
  } catch (error) {
    console.error('[Database] Schema discovery failed:', error.message);
    return null;
  }
}

async function getOnlinePlayers() {
  const schema = process.env.DB_SCHEMA || 'dune';
  console.log(`[Database] getOnlinePlayers() initiated using schema: "${schema}"`);
  
  try {
    const tablesRes = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema]
    );
    const tables = tablesRes.rows.map(r => r.table_name.toLowerCase());
    console.log(`[Database] Discovered tables in schema "${schema}":`, tables);

    if (tables.includes('player_state') && tables.includes('accounts')) {
      console.log('[Database] Match found: "player_state" and "accounts" tables exist. Executing specialized join query.');
      const query = `
        SELECT p.character_name AS name, a.funcom_id AS funcom
        FROM ${schema}.player_state p
        LEFT JOIN ${schema}.accounts a ON p.account_id = a.id
        WHERE LOWER(p.online_status::text) = 'online'
        LIMIT 100
      `;
      console.log(`[Database] Running query:\n${query}`);
      const res = await pool.query(query);
      console.log(`[Database] Query returned ${res.rows.length} rows:`, res.rows);
      return res.rows.map(row => ({
        name: row.name || 'Unknown',
        level: 'N/A',
        faction: row.funcom || 'N/A'
      }));
    }

    console.log('[Database] "player_state" or "accounts" table missing. Falling back to generic schema discovery.');
    const info = await discoverSchema();
    if (!info) {
      console.log('[Database] Generic schema discovery returned null. No players found.');
      return [];
    }

    let query = `SELECT ${info.nameColumn || '*'} `;
    if (info.levelColumn) query += `, ${info.levelColumn} `;
    if (info.factionColumn) query += `, ${info.factionColumn} `;
    query += `FROM ${info.tableName}`;

    const conditions = [];
    if (info.onlineColumn) {
      // Avoid boolean comparison with enum types by checking both text cast and boolean
      conditions.push(`(LOWER(${info.onlineColumn}::text) = 'online' OR ${info.onlineColumn}::text = 'true')`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` LIMIT 100`;
    console.log(`[Database] Running generic query:\n${query}`);

    const res = await pool.query(query);
    console.log(`[Database] Generic query returned ${res.rows.length} rows:`, res.rows);
    return res.rows.map(row => ({
      name: row[info.nameColumn] || 'Unknown',
      level: info.levelColumn ? row[info.levelColumn] : 'N/A',
      faction: info.factionColumn ? row[info.factionColumn] : 'N/A'
    }));
  } catch (error) {
    console.error('[Database] Error fetching online players:', error);
    return [];
  }
}

async function getFuncomToCharacterMap() {
  const schema = process.env.DB_SCHEMA || 'dune';
  const map = new Map();
  try {
    const tablesRes = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema]
    );
    const tables = tablesRes.rows.map(r => r.table_name.toLowerCase());

    if (tables.includes('player_state') && tables.includes('accounts')) {
      const query = `
        SELECT p.character_name AS name, a.funcom_id AS funcom
        FROM ${schema}.player_state p
        LEFT JOIN ${schema}.accounts a ON p.account_id = a.id
        WHERE a.funcom_id IS NOT NULL AND p.character_name IS NOT NULL
      `;
      const res = await pool.query(query);
      for (const row of res.rows) {
        if (row.funcom && row.name) {
          const cleanFuncom = row.funcom.toLowerCase().split('#')[0];
          map.set(cleanFuncom, row.name);
        }
      }
      console.log(`[Database] Loaded ${map.size} account-to-character mappings from DB.`);
    }
  } catch (error) {
    console.error('[Database] Error fetching funcom-to-character map:', error.message);
  }
  return map;
}

async function getAllPlayers() {
  const schema = process.env.DB_SCHEMA || 'dune';
  try {
    const tablesRes = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema]
    );
    const tables = tablesRes.rows.map(r => r.table_name.toLowerCase());

    if (tables.includes('player_state')) {
      const query = `
        SELECT character_name AS name
        FROM ${schema}.player_state
        WHERE character_name IS NOT NULL
        LIMIT 100
      `;
      const res = await pool.query(query);
      return res.rows.map(row => ({ name: row.name }));
    }

    const info = await discoverSchema();
    if (!info || !info.nameColumn) {
      return [];
    }

    const query = `SELECT ${info.nameColumn} AS name FROM ${info.tableName} LIMIT 100`;
    const res = await pool.query(query);
    return res.rows.map(row => ({ name: row.name }));
  } catch (error) {
    console.error('[Database] Error fetching all players:', error.message);
    return [];
  }
}

async function testConnection() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('[Database] Database connection successful at:', res.rows[0].now);
    return true;
  } catch (error) {
    console.error('[Database] Database connection failed:', error.message);
    return false;
  }
}

async function giveItemToPlayer(characterName, itemId, quantity) {
  const schema = process.env.DB_SCHEMA || 'dune';

  try {
    // 1. Find the actor_id (player_pawn_id) for the character using decrypt_user_data
    const charRes = await pool.query(`
      SELECT eps.player_pawn_id AS actor_id 
      FROM ${schema}.encrypted_player_state eps 
      WHERE LOWER(${schema}.decrypt_user_data(eps.encrypted_character_name)) = LOWER($1)
    `, [characterName]);

    if (charRes.rows.length === 0) {
      throw new Error(`Character "${characterName}" not found in database.`);
    }

    const actorId = charRes.rows[0].actor_id;

    // 2. Find the inventory_id of type 'Backpack' (0) for this character
    const invRes = await pool.query(`
      SELECT id 
      FROM ${schema}.inventories 
      WHERE actor_id = $1 AND inventory_type = 0
      LIMIT 1
    `, [actorId]);

    if (invRes.rows.length === 0) {
      throw new Error(`Main bag inventory for character "${characterName}" (ID: ${actorId}) not found.`);
    }

    const inventoryId = invRes.rows[0].id;

    // 3. Find the next position_index in this inventory
    const posRes = await pool.query(`
      SELECT COALESCE(MAX(position_index) + 1, 0) AS next_pos 
      FROM ${schema}.items 
      WHERE inventory_id = $1
    `, [inventoryId]);

    const nextPos = parseInt(posRes.rows[0].next_pos) || 0;

    // 4. Insert the item. Consumable/general items use specific durability stats.
    const stats = '{"FItemStackAndDurabilityStats": [[], {"DecayedMaxDurability": 0.0}]}';

    await pool.query(`
      INSERT INTO ${schema}.items (inventory_id, template_id, stack_size, position_index, stats)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [inventoryId, itemId, quantity, nextPos, stats]);

    console.log(`[Database] Successfully added ${quantity}x ${itemId} to player "${characterName}" (Actor ID: ${actorId}, Inventory ID: ${inventoryId}, Pos: ${nextPos})`);
    return { actorId, inventoryId, positionIndex: nextPos };
  } catch (error) {
    console.error(`[Database] Error in giveItemToPlayer for character "${characterName}":`, error.message);
    throw error;
  }
}

module.exports = {
  pool,
  testConnection,
  getOnlinePlayers,
  getAllPlayers,
  discoverSchema,
  getFuncomToCharacterMap,
  giveItemToPlayer
};
