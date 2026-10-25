// ===== THE WHITE SERPENT - the lobby relay =====
// A tiny WebSocket server with no dependencies. It keeps the list of open war-lobbies and passes messages between
// the players in each one; the battle itself runs on the host player's machine (it decides everything, the others
// send their controls and receive what happens).
//  * The desktop game starts one inside itself when you CREATE A LOBBY (players on your network find it by a UDP
//    beacon; friends elsewhere join by your address, if your router forwards the port).
//  * Run it on any server for cross-platform online play (Windows, Android, iPhone):  node server/relay.js [port]
//    then put its address (wss://...) in the game's Multiplayer > Online server.
// Protocol (JSON text frames):
//   -> {t:'hello', name, platform}                      <- {t:'welcome', id}
//   -> {t:'list'}                                       <- {t:'lobbies', list:[{id, name, mode, players, max, open, host}]}
//   -> {t:'create', lobby:{name, mode, max}}            <- {t:'created', id}
//   -> {t:'join', id}                                   <- {t:'joined', id, host}   (the host gets {t:'peer', ev:'join', id, name, platform})
//   -> {t:'update', lobby:{...}}  (host)                -> {t:'to', to: id | 'host' | 'all', d}   <- {t:'msg', from, d}
//   -> {t:'leave'}                                      <- {t:'peer', ev:'leave', id}  /  {t:'closed'} when the host goes
'use strict';
const http = require('http'), crypto = require('crypto');

function createRelay(opts) {
  opts = opts || {};
  const clients = new Map(), lobbies = new Map(); let nextId = 1;
  // limits, so a public server stays healthy: players, lobbies, message size and rate
  const MAX_CLIENTS = opts.maxClients || 1500, MAX_LOBBIES = opts.maxLobbies || 300, MAX_MSG = 1024 * 1024, RATE = 120, BURST = 360;
  const server = http.createServer((req, res) => {
    // a plain GET tells what is here (the game uses it to check an address)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ game: 'the-white-serpent', relay: 1, lobbies: [...lobbies.values()].map(pub) }));
  });
  const pub = L => ({ id: L.id, name: L.name, mode: L.mode, players: L.members.size + 1, max: L.max, open: L.open, host: L.hostName, platform: L.platform, started: !!L.started });
  function send(c, obj) { if (c && c.alive) c.write(JSON.stringify(obj)); }
  function leave(c) {
    const L = c.lobby && lobbies.get(c.lobby); c.lobby = null; if (!L) return;
    if (L.host === c.id) { for (const m of L.members) { const mc = clients.get(m); if (mc) { mc.lobby = null; send(mc, { t: 'closed' }); } } lobbies.delete(L.id); }
    else { L.members.delete(c.id); send(clients.get(L.host), { t: 'peer', ev: 'leave', id: c.id }); }
    if (opts.onChange) opts.onChange(lobbies);
  }
  function onMessage(c, text) {
    // a token bucket: plenty for a battle (the host sends 15 snapshots a second, players 30 inputs), not for a flood
    const now = Date.now(); c.tokens = Math.min(BURST, c.tokens + (now - c.tt) / 1000 * RATE); c.tt = now;
    if (c.tokens < 1) { if (++c.drops > 2000) c.kill(); return; } c.tokens--;
    let m; try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') { c.name = String(m.name || 'Player').slice(0, 24); c.platform = String(m.platform || '').slice(0, 12); send(c, { t: 'welcome', id: c.id }); }
    else if (m.t === 'list') send(c, { t: 'lobbies', list: [...lobbies.values()].map(pub) });
    else if (m.t === 'create') {
      if (lobbies.size >= MAX_LOBBIES) return send(c, { t: 'error', why: 'The server is full of lobbies just now. Try again soon.' });
      leave(c); const lb = m.lobby || {}, id = 'L' + (nextId++);
      lobbies.set(id, { id, host: c.id, hostName: c.name, platform: c.platform, name: String(lb.name || c.name + '\'s war').slice(0, 40), mode: String(lb.mode || '').slice(0, 30), max: Math.max(2, Math.min(12, lb.max | 0 || 6)), open: true, members: new Set(), started: false });
      c.lobby = id; send(c, { t: 'created', id }); if (opts.onChange) opts.onChange(lobbies);
    }
    else if (m.t === 'join') {
      const L = lobbies.get(m.id);
      if (!L) return send(c, { t: 'error', why: 'That lobby is gone.' });
      if (!L.open || L.members.size + 1 >= L.max) return send(c, { t: 'error', why: 'That lobby is full or closed.' });
      leave(c); L.members.add(c.id); c.lobby = L.id;
      send(c, { t: 'joined', id: L.id, host: L.host }); send(clients.get(L.host), { t: 'peer', ev: 'join', id: c.id, name: c.name, platform: c.platform });
      if (opts.onChange) opts.onChange(lobbies);
    }
    else if (m.t === 'update') { const L = lobbies.get(c.lobby); if (L && L.host === c.id && m.lobby) { for (const k of ['name', 'mode']) if (m.lobby[k] !== undefined) L[k] = String(m.lobby[k]).slice(0, 40); if (m.lobby.max) L.max = Math.max(2, Math.min(12, m.lobby.max | 0)); if (m.lobby.open !== undefined) L.open = !!m.lobby.open; if (m.lobby.started !== undefined) L.started = !!m.lobby.started; if (opts.onChange) opts.onChange(lobbies); } }
    else if (m.t === 'kick') { const L = lobbies.get(c.lobby); if (L && L.host === c.id && L.members.has(m.id)) { const k = clients.get(m.id); L.members.delete(m.id); if (k) { k.lobby = null; send(k, { t: 'closed', why: 'The host removed you from the lobby.' }); } } }
    else if (m.t === 'leave') leave(c);
    else if (m.t === 'to') {
      const L = lobbies.get(c.lobby); if (!L) return;
      const out = { t: 'msg', from: c.id, d: m.d }, all = [L.host, ...L.members];
      if (m.to === 'all') { for (const id of all) if (id !== c.id) send(clients.get(id), out); }
      else if (m.to === 'host') send(clients.get(L.host), out);
      else if (all.includes(m.to)) send(clients.get(m.to), out);
    }
  }
  // ---- the WebSocket handshake and frames (RFC 6455), just what browsers need ----
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sock.setNoDelay(true);
    const c = { id: 'P' + (nextId++), name: 'Player', alive: true, lobby: null, buf: Buffer.alloc(0), frags: [] };
    c.ping = () => { if (c.alive) sock.write(Buffer.from([0x89, 0])); };
    c.write = text => { if (!c.alive) return; const p = Buffer.from(text, 'utf8'), n = p.length; let h; if (n < 126) h = Buffer.from([0x81, n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); } try { sock.write(Buffer.concat([h, p])); } catch (e) { } };
    if (clients.size >= MAX_CLIENTS) { try { sock.destroy(); } catch (e) { } return; }
    c.tokens = BURST; c.tt = Date.now(); c.drops = 0; c.pong = Date.now();
    clients.set(c.id, c);
    const close = () => { if (!c.alive) return; c.alive = false; leave(c); clients.delete(c.id); try { sock.destroy(); } catch (e) { } };
    sock.on('data', d => {
      c.buf = Buffer.concat([c.buf, d]);
      while (c.buf.length >= 2) {
        const b0 = c.buf[0], b1 = c.buf[1], op = b0 & 15, fin = b0 & 128, masked = b1 & 128; let len = b1 & 127, off = 2;
        if (len === 126) { if (c.buf.length < 4) return; len = c.buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (c.buf.length < 10) return; len = Number(c.buf.readBigUInt64BE(2)); off = 10; }
        if (len > MAX_MSG) return close();
        const need = off + (masked ? 4 : 0) + len; if (c.buf.length < need) return;
        let p = c.buf.slice(off + (masked ? 4 : 0), need);
        if (masked) { const mk = c.buf.slice(off, off + 4); p = Buffer.from(p); for (let i = 0; i < p.length; i++) p[i] ^= mk[i & 3]; }
        c.buf = c.buf.slice(need);
        if (op === 8) return close();
        if (op === 10) { c.pong = Date.now(); continue; }
        if (op === 9) { try { sock.write(Buffer.concat([Buffer.from([0x8a, p.length]), p])); } catch (e) { } continue; }
        if (op === 1 || op === 0) { c.frags.push(p); if (fin) { const text = Buffer.concat(c.frags).toString('utf8'); c.frags = []; onMessage(c, text); } }
      }
    });
    c.kill = close;
    sock.on('close', close); sock.on('error', close);
  });
  server.on('clientError', (err, sock) => { try { sock.destroy(); } catch (e) { } });
  // keep connections alive through proxies, and drop the dead ones
  const pinger = setInterval(() => { const now = Date.now(); for (const c of clients.values()) { if (now - c.pong > 75000) { c.kill(); continue; } try { c.ping(); } catch (e) { } } }, 25000);
  if (pinger.unref) pinger.unref();
  return {
    server, lobbies, clients,
    listen(port, host) { return new Promise((res, rej) => { server.once('error', rej); server.listen(port, host || '0.0.0.0', () => { server.removeListener('error', rej); res(server.address().port); }); }); },
    close() { for (const c of clients.values()) { c.alive = false; } try { server.close(); } catch (e) { } for (const s of server._wsSockets || []) try { s.destroy(); } catch (e) { } },
  };
}
module.exports = { createRelay };

// run on its own: node server/relay.js [port]
if (require.main === module) {
  const port = +process.argv[2] || +process.env.PORT || 47630;
  createRelay({ onChange: L => console.log(new Date().toISOString(), 'lobbies:', L.size) }).listen(port).then(p => console.log('The White Serpent relay listening on port', p));
}
