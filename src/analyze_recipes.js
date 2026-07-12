const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'admin-items.json');
if (fs.existsSync(filePath)) {
  const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log("Total items loaded:", items.length);
  if (items.length > 0) {
    console.log("Keys of first item:", Object.keys(items[0]));
    console.log("First item sample:", JSON.stringify(items[0], null, 2));
    
    // Print all unique categories
    const cats = {};
    items.forEach(item => {
      cats[item.category] = (cats[item.category] || 0) + 1;
    });
    console.log("Unique categories:", cats);
    
    // Search for schematics and print samples
    const schems = items.filter(item => item.category === 'schematics');
    console.log(`Found ${schems.length} items in category 'schematics'.`);
    console.log("Sample schematics:");
    schems.slice(0, 15).forEach(item => {
      console.log(`id=${item.id}, name=${item.name}`);
    });
  }
} else {
  console.log("admin-items.json not found at " + filePath);
}
