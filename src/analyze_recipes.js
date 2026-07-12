const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'admin-items.json');
if (fs.existsSync(filePath)) {
  const items = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const rcps = items.filter(item => item.id.toLowerCase().includes('rcp_') || item.id.toLowerCase().includes('recipe'));
  console.log(`Found ${rcps.length} recipe items.`);
  const categories = {};
  rcps.slice(0, 15).forEach(item => {
    console.log(`Sample: id=${item.id}, category=${item.category}, name=${item.name}`);
  });
  rcps.forEach(item => {
    categories[item.category] = (categories[item.category] || 0) + 1;
  });
  console.log("Categories of recipes:", categories);
} else {
  console.log("admin-items.json not found at " + filePath);
}
