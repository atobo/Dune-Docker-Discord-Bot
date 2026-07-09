const http = require('http');

const data = JSON.stringify({
  mapName: "Abbir",
  dimension: 0,
  body: "test"
});

const req = http.request({
  hostname: '127.0.0.1',
  port: 3005, // Assuming API_PORT=3005
  path: '/api/admin/map-chat',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer TFF-Dune-Admin-Token-777' // Assuming API_AUTH_TOKEN
  }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    try {
      console.log(JSON.parse(body));
    } catch {
      console.log(body);
    }
  });
});

req.on('error', e => console.error(e));
req.write(data);
req.end();
