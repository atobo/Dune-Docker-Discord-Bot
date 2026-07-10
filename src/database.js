const { Pool } = require('pg');
const http = require('http');

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
        faction: row.funcom || 'N/A',
        x: 0.0,
        y: 0.0,
        z: 0.0
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
      faction: info.factionColumn ? row[info.factionColumn] : 'N/A',
      x: 0.0,
      y: 0.0,
      z: 0.0
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

async function getAllCharactersWithPawnIds() {
  const schema = process.env.DB_SCHEMA || 'dune';
  try {
    const res = await pool.query(`
      SELECT player_pawn_id AS actor_id, 
             ${schema}.decrypt_user_data(encrypted_character_name) AS name
      FROM ${schema}.encrypted_player_state
      WHERE encrypted_character_name IS NOT NULL
    `);
    return res.rows.map(r => ({ name: r.name, actorId: r.actor_id }));
  } catch (error) {
    console.error('[Database] Error fetching decrypted characters:', error.message);
    return [];
  }
}

async function grantBlueprintToPlayer(characterName, blueprint, itemType, customName) {
  const schema = process.env.DB_SCHEMA || 'dune';
  const client = await pool.connect();

  try {
    // 1. Resolve actor_id and player_controller_id for character
    const charRes = await client.query(`
      SELECT player_pawn_id AS actor_id, player_controller_id 
      FROM ${schema}.encrypted_player_state 
      WHERE LOWER(${schema}.decrypt_user_data(encrypted_character_name)) = LOWER($1)
    `, [characterName]);

    if (charRes.rows.length === 0) {
      throw new Error(`Character "${characterName}" not found in database.`);
    }
    const actorId = charRes.rows[0].actor_id;
    const playerControllerId = charRes.rows[0].player_controller_id;

    // 2. Find inventory of type 0
    const invRes = await client.query(`
      SELECT id FROM ${schema}.inventories 
      WHERE actor_id = $1 AND inventory_type = 0 
      LIMIT 1
    `, [actorId]);

    if (invRes.rows.length === 0) {
      throw new Error(`Backpack inventory not found for character "${characterName}".`);
    }
    const inventoryId = invRes.rows[0].id;

    // 3. Find next position_index
    const posRes = await client.query(`
      SELECT COALESCE(MAX(position_index) + 1, 0) AS next_pos 
      FROM ${schema}.items 
      WHERE inventory_id = $1
    `, [inventoryId]);
    const nextPos = parseInt(posRes.rows[0].next_pos) || 0;

    // 4. Resolve Template ID
    const templateId = itemType === 'backup' ? 'BaseBackupTool' : 'BuildingBlueprint_CopyDevice';
    const name = customName || blueprint.name || "Imported Blueprint";

    // Start transaction
    await client.query('BEGIN');

    // 5. Insert Item
    const stats = {
      FCustomizationStats: [[], {}],
      FBuildingBlueprintItemStats: [[], { PlayerBlueprintId: "!!bbp#0", BuildingBlueprintName: name }],
      FItemStackAndDurabilityStats: [[], { DecayedMaxDurability: 0.0 }]
    };

    const itemInsertRes = await client.query(`
      INSERT INTO ${schema}.items (inventory_id, stack_size, position_index, template_id, quality_level, stats)
      VALUES ($1, 1, $2, $3, 0, $4::jsonb)
      RETURNING id
    `, [inventoryId, nextPos, templateId, JSON.stringify(stats)]);

    const itemId = itemInsertRes.rows[0].id;

    // 6. Create building blueprint
    const bpInsertRes = await client.query(`
      INSERT INTO ${schema}.building_blueprints (item_id, player_id, building_blueprint_map)
      VALUES ($1, $2, '')
      RETURNING id
    `, [itemId, playerControllerId]);

    const blueprintId = bpInsertRes.rows[0].id;

    // 7. Update Item Stats with real blueprint database ID
    const updatedStats = { ...stats };
    updatedStats.FBuildingBlueprintItemStats[1].PlayerBlueprintId = `!!bbp#${blueprintId}`;

    await client.query(`
      UPDATE ${schema}.items
      SET stats = $1::jsonb
      WHERE id = $2
    `, [JSON.stringify(updatedStats), itemId]);

    // 8. Insert Instances
    if (blueprint.instances && blueprint.instances.length > 0) {
      const chunks = [];
      const chunkSize = 50;
      for (let i = 0; i < blueprint.instances.length; i += chunkSize) {
        chunks.push(blueprint.instances.slice(i, i + chunkSize));
      }

      for (const chunk of chunks) {
        let valueStrings = [];
        let params = [blueprintId];
        let pIndex = 2;

        chunk.forEach((inst, idx) => {
          const stability = inst.provides_stability != null ? inst.provides_stability : true;
          params.push(inst.instance_id || (idx + 1));
          params.push(inst.building_type);
          params.push([inst.x, inst.y, inst.z, inst.rotation]);
          params.push(stability);

          valueStrings.push(`($1, $${pIndex}, $${pIndex+1}, $${pIndex+2}::real[], true, $${pIndex+3}, 0)`);
          pIndex += 4;
        });

        const queryText = `
          INSERT INTO ${schema}.building_blueprint_instances
          (building_blueprint_id, instance_id, building_type, transform, hologram, provides_stability, health)
          VALUES ${valueStrings.join(', ')}
        `;
        await client.query(queryText, params);
      }
    }

    // 9. Insert Placeables
    if (blueprint.placeables && blueprint.placeables.length > 0) {
      const chunks = [];
      const chunkSize = 50;
      for (let i = 0; i < blueprint.placeables.length; i += chunkSize) {
        chunks.push(blueprint.placeables.slice(i, i + chunkSize));
      }

      for (const chunk of chunks) {
        let valueStrings = [];
        let params = [blueprintId];
        let pIndex = 2;

        chunk.forEach((pl, idx) => {
          params.push(pl.placeable_id || (idx + 1));
          params.push(pl.building_type);
          params.push([pl.x, pl.y, pl.z, pl.rx ?? 0, pl.ry ?? 0, pl.rz ?? 0]);

          valueStrings.push(`($1, $${pIndex}, $${pIndex+1}, $${pIndex+2}::real[], true)`);
          pIndex += 3;
        });

        const queryText = `
          INSERT INTO ${schema}.building_blueprint_placeables
          (building_blueprint_id, placeable_id, building_type, transform, hologram)
          VALUES ${valueStrings.join(', ')}
        `;
        await client.query(queryText, params);
      }
    }

    // 10. Insert Pentashields
    if (blueprint.pentashields && blueprint.pentashields.length > 0) {
      for (const ps of blueprint.pentashields) {
        const s = ps.scale || [1, 1, 1];
        await client.query(`
          INSERT INTO ${schema}.building_blueprint_pentashields (building_blueprint_id, placeable_id, scale)
          VALUES ($1, $2, $3::smallint[])
        `, [blueprintId, ps.placeable_id ?? 0, s]);
      }
    }

    await client.query('COMMIT');
    console.log(`[Database] Successfully granted blueprint as ${templateId} directly to player "${characterName}" (Blueprint ID: ${blueprintId})`);
    return { success: true, blueprintId, itemId };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[Database] Error in grantBlueprintToPlayer for character "${characterName}":`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

function dockerRequest(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: '/var/run/docker.sock',
      method: method,
      path: path
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : true);
          } catch (e) {
            resolve(data);
          }
        } else if (res.statusCode === 304) {
          resolve(true); // Container already stopped/started
        } else {
          reject(new Error(`Docker status ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function manageServerContainers(action) {
  try {
    const containers = await dockerRequest('GET', '/containers/json?all=true');
    const orchestrators = [];
    const mapServers = [];
    
    containers.forEach(c => {
      const name = c.Names[0] || '';
      const image = c.Image || '';
      
      // Match orchestrator / autoscaler containers
      if (name.includes('orchestrator') || name.includes('autoscaler')) {
        orchestrators.push(c.Id);
      }
      
      // Match active game servers (excluding overmap, director, router, gateway)
      if (image.includes('seabass-server') && 
          !image.includes('gateway') && 
          !image.includes('director') && 
          !image.includes('text-router') && 
          !name.includes('overmap')) {
        mapServers.push(c.Id);
      }
    });

    if (action === 'stop') {
      console.log(`[Docker] Temporarily stopping ${orchestrators.length} orchestrator/autoscaler containers...`);
      for (const id of orchestrators) {
        await dockerRequest('POST', `/containers/${id}/stop?t=5`);
      }
      console.log(`[Docker] Temporarily stopping ${mapServers.length} active map server containers...`);
      for (const id of mapServers) {
        await dockerRequest('POST', `/containers/${id}/stop?t=5`);
      }
    } else if (action === 'start') {
      console.log(`[Docker] Resuming ${mapServers.length} active map server containers...`);
      for (const id of mapServers) {
        await dockerRequest('POST', `/containers/${id}/start`);
      }
      console.log(`[Docker] Resuming ${orchestrators.length} orchestrator/autoscaler containers...`);
      for (const id of orchestrators) {
        await dockerRequest('POST', `/containers/${id}/start`);
      }
    }
  } catch (err) {
    console.error(`[Docker] Failed to ${action} containers:`, err.message);
  }
}

async function constructBlueprintAtPlayer(characterName, blueprint, offsetX = 0, offsetY = 0, offsetZ = 0) {
  const schema = process.env.DB_SCHEMA || 'dune';
  const client = await pool.connect();
  let stoppedContainers = false;

  try {
    // 1. Resolve player pawn ID
    const charRes = await client.query(`
      SELECT player_pawn_id AS actor_id, player_controller_id 
      FROM ${schema}.encrypted_player_state 
      WHERE LOWER(${schema}.decrypt_user_data(encrypted_character_name)) = LOWER($1)
    `, [characterName]);

    if (charRes.rows.length === 0) {
      throw new Error(`Character "${characterName}" not found in database.`);
    }
    const actorId = charRes.rows[0].actor_id;

    // Fetch player character entity ID
    const entityRes = await client.query(`
      SELECT entity_id 
      FROM ${schema}.actor_fgl_entities 
      WHERE actor_id = $1 AND slot_name = 'DuneCharacter'
    `, [actorId]);
    const ownerEntityId = entityRes.rows.length > 0 ? entityRes.rows[0].entity_id : null;

    // 2. Fetch player location and map details
    const playerActorRes = await client.query(`
      SELECT transform::text, map, partition_id, dimension_index 
      FROM ${schema}.actors 
      WHERE id = $1
    `, [actorId]);

    if (playerActorRes.rows.length === 0) {
      throw new Error(`Player actor ID ${actorId} not found in actors table.`);
    }
    const { transform, map, partition_id, dimension_index } = playerActorRes.rows[0];

    // Parse player transform
    const cleanTransform = transform.replace(/[()"']/g, '');
    const locParts = cleanTransform.split(',').map(Number);
    if (locParts.length < 3 || locParts.some(isNaN)) {
      throw new Error('Invalid transform format parsed from database: ' + transform);
    }
    const px = locParts[0];
    const py = locParts[1];
    const pz = locParts[2];

    // Apply offsets to get final building anchor location
    const ax = px + offsetX;
    const ay = py + offsetY;
    const az = pz + offsetZ - 50; // default sink foundations by 50 units

    // 3. Find blueprint center
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;

    blueprint.instances.forEach(i => {
      if (i.x < minX) minX = i.x;
      if (i.x > maxX) maxX = i.x;
      if (i.y < minY) minY = i.y;
      if (i.y > maxY) maxY = i.y;
      if (i.z < minZ) minZ = i.z;
      if (i.z > maxZ) maxZ = i.z;
    });

    const cx = (minX + maxX) / 2 || 0;
    const cy = (minY + maxY) / 2 || 0;
    const cz = minZ !== Infinity ? minZ : 0;

    // Stop active map server containers before database operations
    await manageServerContainers('stop');
    stoppedContainers = true;

    // Start transaction
    await client.query('BEGIN');

    // 4. Generate new building actor ID and entity ID
    const idRes = await client.query(`SELECT nextval('${schema}.actors_id_seq') AS id`);
    const buildingId = idRes.rows[0].id;

    const fglRes = await client.query(`SELECT nextval('${schema}.character_transfer_fgl_entities_entity_id_seq') AS entity_id`);
    const buildingEntityId = fglRes.rows[0].entity_id;

    // 5. Insert Building Actor
    const buildingClass = '/Game/Dune/Systems/Building/Pieces/BP_DuneBuildingBase.BP_DuneBuildingBase_C';
    const buildingProperties = {
      DamageableActorComponent: {
        m_TotalMaxHealth: 0.0,
        m_CurrentMaxHealth: 0.0
      }
    };

    await client.query(`
      INSERT INTO ${schema}.actors (id, class, map, transform, partition_id, dimension_index, gas_attributes, properties, owner_account_id, serial)
      VALUES ($1, $2, $3, ROW(ROW($4, $5, $6)::dune.vector, ROW(0.0, 0.0, 0.0, 1.0)::dune.quaternion)::dune.transform, $7, $8, '{}'::jsonb, $9::jsonb, NULL, 1)
    `, [buildingId, buildingClass, map, ax, ay, az, partition_id, dimension_index, JSON.stringify(buildingProperties)]);

    // Insert FGL Entity and Link to Actor
    const buildingComponents = {
      FHealthComponent: [0, { m_CurrentHealth: 0.0, m_MaxDownButNotOutStateHealth: 0.0, m_CurrentDownButNotOutStateHealth: 0.0 }],
      FAggroControllerComponent: [0, { m_TotalDamageDone: 0.0 }],
      FBiomeWeatherModifierComponent: [1, { m_CurrentSandColor: { A: 1.0, B: 0.06859, G: 0.145263, r: 0.428689 }, CurrentSandBuildupModifier: 0.3, CurrentTemperatureModifier: 1.0 }]
    };

    await client.query(`
      INSERT INTO ${schema}.fgl_entities (entity_id, components)
      VALUES ($1, $2::jsonb)
    `, [buildingEntityId, JSON.stringify(buildingComponents)]);

    await client.query(`
      INSERT INTO ${schema}.actor_fgl_entities (actor_id, entity_id, slot_name)
      VALUES ($1, $2, 'Actor')
    `, [buildingId, buildingEntityId]);

    // 6. Insert Building record
    await client.query(`
      INSERT INTO ${schema}.buildings (id) 
      VALUES ($1)
    `, [buildingId]);

    // 7. Insert Instances
    if (blueprint.instances && blueprint.instances.length > 0) {
      const chunks = [];
      const chunkSize = 50;
      for (let i = 0; i < blueprint.instances.length; i += chunkSize) {
        chunks.push(blueprint.instances.slice(i, i + chunkSize));
      }

      let globalInstanceId = 1;

      for (const chunk of chunks) {
        let valueStrings = [];
        let params = [buildingId];
        let pIndex = 2;

        chunk.forEach((inst) => {
          const wx = ax + (inst.x - cx);
          const wy = ay + (inst.y - cy);
          const wz = az + (inst.z - cz);

          const rad = (inst.rotation * Math.PI) / 360;
          const qz = Math.sin(rad);
          const qw = Math.cos(rad);

          const isFoundation = inst.provides_stability || (inst.building_type && inst.building_type.toLowerCase().includes('foundation'));
          const flags = isFoundation ? 161 : 0;

          params.push(inst.instance_id || globalInstanceId++);
          params.push(inst.building_type);
          params.push([wx, wy, wz, 0.0, 0.0, qz, qw]);
          params.push(ownerEntityId);
          params.push(flags);

          valueStrings.push(`($1, $${pIndex}, $${pIndex+1}, $${pIndex+2}::real[], $${pIndex+3}, $${pIndex+4}, 100.0, 0.0, 0, 0, 0, 0.0)`);
          pIndex += 5;
        });

        const queryText = `
          INSERT INTO ${schema}.building_instances
          (building_id, instance_id, building_type, transform, owner_entity_id, building_flags, health, shelter, stabilization_begin_timespan, stabilization_end_timespan, stabilization_state, sand_buildup)
          VALUES ${valueStrings.join(', ')}
        `;
        await client.query(queryText, params);
      }
    }

    await client.query('COMMIT');
    console.log(`[Database] Instantly constructed building ID ${buildingId} at player "${characterName}" location + offset: (${ax}, ${ay}, ${az})`);
    return { success: true, buildingId, x: ax, y: ay, z: az };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    if (stoppedContainers) {
      await manageServerContainers('start');
    }
  }
}

async function getBuildings() {
  const schema = process.env.DB_SCHEMA || 'dune';
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT 
        b.id AS building_id,
        a.map,
        a.transform::text AS transform,
        (SELECT COUNT(*) FROM ${schema}.building_instances bi WHERE bi.building_id = b.id) AS pieces_count,
        (
          SELECT DISTINCT LOWER(${schema}.decrypt_user_data(eps.encrypted_character_name))
          FROM ${schema}.building_instances bi
          JOIN ${schema}.actor_fgl_entities afe ON bi.owner_entity_id = afe.entity_id AND afe.slot_name = 'DuneCharacter'
          JOIN ${schema}.encrypted_player_state eps ON afe.actor_id = eps.player_pawn_id
          WHERE bi.building_id = b.id AND bi.owner_entity_id IS NOT NULL
          LIMIT 1
        ) AS owner_name
      FROM ${schema}.buildings b
      LEFT JOIN ${schema}.actors a ON b.id = a.id
      ORDER BY b.id DESC
    `);
    
    // Parse coordinates from transform strings
    return res.rows.map(row => {
      let x = 0, y = 0, z = 0;
      if (row.transform) {
        const clean = row.transform.replace(/[()"']/g, '');
        const parts = clean.split(',').map(Number);
        if (parts.length >= 3 && !parts.some(isNaN)) {
          x = parts[0];
          y = parts[1];
          z = parts[2];
        }
      }
      return {
        buildingId: row.building_id,
        map: row.map || 'Unknown',
        piecesCount: parseInt(row.pieces_count) || 0,
        ownerName: row.owner_name || 'System / Unknown',
        coords: { x, y, z }
      };
    });
  } catch (error) {
    console.error(`[Database] Error in getBuildings:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function deleteBuilding(buildingId) {
  const schema = process.env.DB_SCHEMA || 'dune';
  const client = await pool.connect();
  let stoppedContainers = false;
  try {
    // Stop containers before making database updates
    await manageServerContainers('stop');
    stoppedContainers = true;

    await client.query('BEGIN');

    // 1. Delete FGL linkage (cascades to clean up fgl_entities via trigger)
    await client.query(`DELETE FROM ${schema}.actor_fgl_entities WHERE actor_id = $1`, [buildingId]);

    // 2. Delete building instances
    await client.query(`DELETE FROM ${schema}.building_instances WHERE building_id = $1`, [buildingId]);

    // 3. Delete building record
    await client.query(`DELETE FROM ${schema}.buildings WHERE id = $1`, [buildingId]);

    // 4. Delete base actor
    await client.query(`DELETE FROM ${schema}.actors WHERE id = $1`, [buildingId]);

    await client.query('COMMIT');
    console.log(`[Database] Successfully deleted building ID ${buildingId} and stopped/started containers.`);
    return { success: true };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[Database] Error in deleteBuilding for ID ${buildingId}:`, error.message);
    throw error;
  } finally {
    client.release();
    if (stoppedContainers) {
      await manageServerContainers('start');
    }
  }
}

async function shiftBuildingHeight(buildingId, zDelta) {
  const schema = process.env.DB_SCHEMA || 'dune';
  const client = await pool.connect();
  let stoppedContainers = false;
  try {
    // Stop containers before updating database
    await manageServerContainers('stop');
    stoppedContainers = true;

    await client.query('BEGIN');

    // 1. Shift the base actor's Z transform component
    await client.query(`
      UPDATE ${schema}.actors
      SET transform = ROW(
        ROW(
          ((transform).location).x,
          ((transform).location).y,
          ((transform).location).z + $2
        )::dune.vector,
        (transform).rotation
      )::dune.transform
      WHERE id = $1
    `, [buildingId, zDelta]);

    // 2. Shift all Snapped Building Instances' Z coordinate
    // Since transform is real[] array, index 3 is Z coordinate (1-indexed)
    await client.query(`
      UPDATE ${schema}.building_instances
      SET transform[3] = transform[3] + $2
      WHERE building_id = $1
    `, [buildingId, zDelta]);

    await client.query('COMMIT');
    console.log(`[Database] Shifted building ID ${buildingId} height by ${zDelta} units.`);
    return { success: true };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[Database] Error in shiftBuildingHeight for ID ${buildingId}:`, error.message);
    throw error;
  } finally {
    client.release();
    if (stoppedContainers) {
      await manageServerContainers('start');
    }
  }
}

async function getLootContainers() {
  const schema = process.env.DB_SCHEMA || 'dune';
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT 
        a.id AS container_id,
        a.class,
        a.map,
        a.transform::text AS transform,
        inv.id AS inventory_id,
        inv.max_item_count,
        (SELECT COUNT(*) FROM ${schema}.items i WHERE i.inventory_id = inv.id) AS item_count,
        pa.actor_name AS custom_name,
        COALESCE(
          -- 1. Direct permission rank owner
          (
            SELECT DISTINCT LOWER(${schema}.decrypt_user_data(eps.encrypted_character_name))
            FROM ${schema}.permission_actor_rank par
            JOIN ${schema}.encrypted_player_state eps ON par.player_id = eps.player_controller_id
            WHERE par.permission_actor_id = a.id
            LIMIT 1
          ),
          -- 2. Parent-inherited permission owner (e.g. child objects)
          (
            SELECT DISTINCT LOWER(${schema}.decrypt_user_data(eps.encrypted_character_name))
            FROM ${schema}.travel_actor_parent tap
            JOIN ${schema}.permission_actor_rank par ON tap.parent_id = par.permission_actor_id
            JOIN ${schema}.encrypted_player_state eps ON par.player_id = eps.player_controller_id
            WHERE tap.id = a.id
            LIMIT 1
          ),
          -- 3. Placeable landclaim totem owner
          (
            SELECT DISTINCT LOWER(${schema}.decrypt_user_data(eps.encrypted_character_name))
            FROM ${schema}.placeables p
            JOIN ${schema}.actor_fgl_entities afe ON p.owner_entity_id = afe.entity_id
            JOIN ${schema}.permission_actor_rank par ON afe.actor_id = par.permission_actor_id
            JOIN ${schema}.encrypted_player_state eps ON par.player_id = eps.player_controller_id
            WHERE p.id = a.id
            LIMIT 1
          )
        ) AS owner_name
      FROM ${schema}.inventories inv
      JOIN ${schema}.actors a ON inv.actor_id = a.id
      LEFT JOIN ${schema}.permission_actor pa ON a.id = pa.actor_id
      WHERE a.class NOT LIKE '%Character%' AND a.class NOT LIKE '%Thrall%'
      ORDER BY a.class, a.id
    `);
    
    return res.rows.map(row => {
      let x = 0, y = 0, z = 0;
      if (row.transform) {
        const clean = row.transform.replace(/[()"']/g, '');
        const parts = clean.split(',').map(Number);
        if (parts.length >= 3 && !parts.some(isNaN)) {
          x = parts[0];
          y = parts[1];
          z = parts[2];
        }
      }
      return {
        containerId: row.container_id,
        class: row.class,
        map: row.map || 'Unknown',
        inventoryId: row.inventory_id,
        maxItemCount: row.max_item_count || 24,
        itemCount: parseInt(row.item_count) || 0,
        customName: row.custom_name || '',
        ownerName: row.owner_name || 'System / Unknown',
        coords: { x, y, z }
      };
    });
  } catch (error) {
    console.error(`[Database] Error in getLootContainers:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function getContainerItems(containerId) {
  const schema = process.env.DB_SCHEMA || 'dune';
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT 
        i.id AS item_id,
        i.stack_size,
        i.position_index,
        i.template_id,
        i.stats
      FROM ${schema}.items i
      JOIN ${schema}.inventories inv ON i.inventory_id = inv.id
      WHERE inv.actor_id = $1
      ORDER BY i.position_index
    `, [containerId]);
    
    return res.rows.map(row => ({
      itemId: row.item_id,
      stackSize: parseInt(row.stack_size) || 1,
      positionIndex: parseInt(row.position_index),
      templateId: row.template_id,
      stats: row.stats || {}
    }));
  } catch (error) {
    console.error(`[Database] Error in getContainerItems for container ${containerId}:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function updateLootItem(itemId, stackSize, templateId) {
  const schema = process.env.DB_SCHEMA || 'dune';
  const client = await pool.connect();
  try {
    await client.query(`
      UPDATE ${schema}.items 
      SET stack_size = $2, template_id = $3
      WHERE id = $1
    `, [itemId, stackSize, templateId]);
    return { success: true };
  } catch (error) {
    console.error(`[Database] Error in updateLootItem for item ${itemId}:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function addLootItem(inventoryId, templateId, stackSize, positionIndex) {
  const schema = process.env.DB_SCHEMA || 'dune';
  const client = await pool.connect();
  try {
    const res = await client.query(`
      INSERT INTO ${schema}.items 
      (inventory_id, template_id, stack_size, position_index, is_new, acquisition_time, stats, quality_level)
      VALUES ($1, $2, $3, $4, true, 0, '{}'::jsonb, 0)
      RETURNING id
    `, [inventoryId, templateId, stackSize, positionIndex]);
    return { success: true, itemId: res.rows[0].id };
  } catch (error) {
    console.error(`[Database] Error in addLootItem for inventory ${inventoryId}:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function deleteLootItem(itemId) {
  const schema = process.env.DB_SCHEMA || 'dune';
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM ${schema}.items WHERE id = $1`, [itemId]);
    return { success: true };
  } catch (error) {
    console.error(`[Database] Error in deleteLootItem for item ${itemId}:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function getItemTemplates() {
  const schema = process.env.DB_SCHEMA || 'dune';
  const client = await pool.connect();
  try {
    const res = await client.query(`
      SELECT DISTINCT template_id 
      FROM ${schema}.items 
      WHERE template_id IS NOT NULL AND template_id <> ''
      ORDER BY template_id
    `);
    return res.rows.map(row => row.template_id);
  } catch (error) {
    console.error(`[Database] Error in getItemTemplates:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  testConnection,
  getOnlinePlayers,
  getAllPlayers,
  discoverSchema,
  getFuncomToCharacterMap,
  giveItemToPlayer,
  getAllCharactersWithPawnIds,
  grantBlueprintToPlayer,
  constructBlueprintAtPlayer,
  getBuildings,
  deleteBuilding,
  shiftBuildingHeight,
  getLootContainers,
  getContainerItems,
  updateLootItem,
  addLootItem,
  deleteLootItem,
  getItemTemplates
};
