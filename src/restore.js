const { Pool } = require('pg');
const pool = new Pool({
  host: '127.0.0.1',
  port: 15432,
  user: 'dune',
  password: 'dune',
  database: 'dune'
});

const query = `
UPDATE dune.items i SET stack_size = CASE 
    WHEN i.template_id = 'SolarisCoin' THEN i.stack_size
    WHEN i.template_id LIKE 'Emote_%' 
         OR i.template_id LIKE 'Stillsuit_%' 
         OR i.template_id LIKE 'Combat_%'
         OR i.template_id LIKE '%Rifle%'
         OR i.template_id LIKE '%Scattergun%'
         OR i.template_id LIKE '%Shotgun%'
         OR i.template_id LIKE '%Tool%'
         OR i.template_id LIKE '%Backup%'
         OR i.template_id LIKE '%Light%'
         OR i.template_id LIKE '%Belt%'
         OR i.template_id LIKE '%Scythe%'
         OR i.template_id LIKE '%Key%'
         OR i.template_id LIKE '%Corpse%'
         OR i.template_id LIKE 'Radiation_Suit%'
         OR i.template_id LIKE 'UniqueAr%'
         OR i.template_id LIKE 'Holtzman%'
         OR i.template_id LIKE 'PowerPack%'
         OR i.template_id LIKE 'healthpack%'
         OR i.template_id = 'FullSuspensorBelt'
         OR i.template_id = 'BasicBuildingTool'
         OR i.template_id = 'MiningTool_2h_Advanced'
         OR i.template_id = 'RepairTool5'
         OR i.template_id = 'BaseBackupTool'
         OR i.template_id = 'VehicleBackupTool'
         OR i.template_id = 'DewReaper_Scythe'
         OR i.template_id = 'JourneySubLeaderKey'
         OR i.template_id = 'JourneyShieldDissembler'
         OR i.template_id = 'ContractSlavers1DeserterArmors'
         OR i.template_id = 'ContractPlanetologist1AReels'
         OR i.template_id LIKE 'Contract%'
    THEN 1
    ELSE GREATEST(1, ROUND(i.stack_size / 50.0)::bigint)
END
FROM dune.inventories inv
WHERE i.inventory_id = inv.id
  AND inv.actor_id = '7'
`;

pool.query(query)
  .then(() => {
    console.log('Successfully restored Nalita\'s items to normal quantities.');
    pool.end();
  })
  .catch((err) => {
    console.error(err);
    pool.end();
  });
