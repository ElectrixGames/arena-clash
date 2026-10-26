// Arena Clash multiplayer server
// Run with:  npm install   then   node index.js
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 8192 });

/* ---------------- settings ---------------- */
const MAPS = ['blockyard', 'dustbowl', 'frostbite', 'neon'];
const MAX_PLAYERS = 8;
const MATCH_TIME = 240;      // seconds
const KILL_LIMIT = 15;
const LOBBY_COUNTDOWN = 10;  // public lobbies start this many seconds after 2+ players join
const VOTE_TIME = 10;
const RESULTS_TIME = 10;
const RESPAWN_DELAY = 2500;  // ms
// per weapon: max damage per shot, fire rate (seconds) - used to reject cheated hits
const WEAPONS = [
  { max: 32, rate: 0.1 },    // AR
  { max: 20, rate: 0.065 },  // SMG
  { max: 135, rate: 0.85 },  // Shotgun (all pellets)
  { max: 200, rate: 1.3 },   // Sniper
  { max: 48, rate: 0.2 },    // Pistol
];
const PIECES = { wall: 150, floor: 120, ramp: 120 };

/* ---------------- state ---------------- */
let nextId = 1;
const players = new Map(); // id -> player
const rooms = new Map();   // code -> room

const num = (v, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) return null; return Math.max(lo, Math.min(hi, v)); };
const r2 = (v) => Math.round(v * 100) / 100;
const cleanName = (n) => String(n || '').replace(/[^\w \-]/g, '').trim().slice(0, 14) || 'Player';
const cleanText = (t) => String(t || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);

function send(p, msg) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s);
}
function makeCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = ''; for (let i = 0; i < 5; i++) c += abc[Math.floor(Math.random() * abc.length)]; } while (rooms.has(c));
  return c;
}
function createRoom(isPrivate) {
  const room = { code: makeCode(), isPrivate, hostId: null, players: new Map(), state: 'waiting', countdown: 0,
    choices: [], votes: new Map(), map: 'blockyard', endsAt: 0, structs: new Map() };
  rooms.set(room.code, room);
  return room;
}
function roomInfo(room) {
  const counts = {};
  for (const m of room.choices) counts[m] = 0;
  for (const m of room.votes.values()) if (m in counts) counts[m]++;
  return {
    t: 'room', code: room.code, isPrivate: room.isPrivate, host: room.hostId, state: room.state, countdown: room.countdown,
    choices: room.choices, votes: counts, map: room.map, limit: KILL_LIMIT,
    timeLeft: room.state === 'playing' ? Math.max(0, (room.endsAt - Date.now()) / 1000) : 0,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, kills: p.kills, deaths: p.deaths })),
  };
}
const sendRoom = (room) => broadcast(room, roomInfo(room));
const sysChat = (room, text) => broadcast(room, { t: 'chat', sys: true, text });

function startMsg(room) {
  return { t: 'start', map: room.map, limit: KILL_LIMIT, timeLeft: Math.max(0, (room.endsAt - Date.now()) / 1000), structs: [...room.structs.values()] };
}
function resetPlayer(p) { p.kills = 0; p.deaths = 0; p.hp = 100; p.dead = true; p.diedAt = 0; p.lastShot = [0, 0, 0, 0, 0]; p.lastStruct = [0, 0, 0, 0, 0]; }

function joinRoom(p, room) {
  leaveRoom(p);
  if (room.players.size >= MAX_PLAYERS) return send(p, { t: 'err', text: 'That room is full.' });
  resetPlayer(p);
  room.players.set(p.id, p); p.room = room;
  if (!room.hostId) room.hostId = p.id;
  sendRoom(room);
  sysChat(room, p.name + ' joined');
  if (room.state === 'playing') send(p, startMsg(room));
  maybeCountdown(room);
}
function leaveRoom(p) {
  const room = p.room; if (!room) return;
  room.players.delete(p.id); p.room = null;
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = room.players.keys().next().value;
  broadcast(room, { t: 'left', id: p.id });
  sysChat(room, p.name + ' left');
  if (room.state === 'waiting' && room.countdown > 0 && room.players.size < 2) room.countdown = 0;
  sendRoom(room);
}
function maybeCountdown(room) {
  if (!room.isPrivate && room.state === 'waiting' && room.countdown === 0 && room.players.size >= 2) {
    room.countdown = LOBBY_COUNTDOWN; sendRoom(room);
  }
}
function startVote(room) {
  room.state = 'voting'; room.countdown = VOTE_TIME; room.votes.clear();
  room.choices = MAPS.slice().sort(() => Math.random() - 0.5).slice(0, 3);
  sendRoom(room);
}
function startMatch(room) {
  const counts = {}; for (const m of room.choices) counts[m] = 0;
  for (const m of room.votes.values()) if (m in counts) counts[m]++;
  const top = Math.max(...Object.values(counts));
  const tied = room.choices.filter(m => counts[m] === top);
  room.map = tied[Math.floor(Math.random() * tied.length)];
  room.state = 'playing'; room.countdown = 0; room.endsAt = Date.now() + MATCH_TIME * 1000; room.structs.clear();
  for (const p of room.players.values()) resetPlayer(p);
  broadcast(room, startMsg(room));
  sendRoom(room);
}
function endMatch(room, reason) {
  if (room.state !== 'playing') return;
  room.state = 'results'; room.countdown = RESULTS_TIME;
  const standings = [...room.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths }));
  broadcast(room, { t: 'end', reason, standings });
  sendRoom(room);
}

/* ---------------- timers ---------------- */
setInterval(() => { // once a second: lobby / vote / results countdowns
  for (const room of rooms.values()) {
    if (room.state === 'waiting' && room.countdown > 0) {
      if (!room.isPrivate && room.players.size < 2) { room.countdown = 0; sendRoom(room); continue; }
      room.countdown--; if (room.countdown <= 0) startVote(room); else sendRoom(room);
    } else if (room.state === 'voting') {
      room.countdown--; if (room.countdown <= 0) startMatch(room); else sendRoom(room);
    } else if (room.state === 'results') {
      room.countdown--;
      if (room.countdown <= 0) {
        room.state = 'waiting'; room.countdown = 0;
        for (const p of room.players.values()) resetPlayer(p);
        sendRoom(room); maybeCountdown(room);
      } else sendRoom(room);
    }
  }
}, 1000);

setInterval(() => { // 20 times a second: share positions during matches
  for (const room of rooms.values()) {
    if (room.state !== 'playing') continue;
    const l = [...room.players.values()].map(p => [p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.yaw), r2(p.pitch), p.w, Math.max(0, Math.round(p.hp)), p.dead ? 1 : 0]);
    broadcast(room, { t: 'st', l });
    if (Date.now() >= room.endsAt) endMatch(room, 'time');
  }
}, 50);

setInterval(() => { // online player count for the main menu
  const msg = JSON.stringify({ t: 'online', n: players.size });
  for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(msg);
}, 5000);

/* ---------------- messages ---------------- */
function handle(p, m) {
  const room = p.room, now = Date.now();
  switch (m.t) {
    case 'hello':
      p.name = cleanName(m.name); p.color = Math.floor(num(m.color, 0, 7) || 0);
      break;
    case 'quick': {
      let best = null;
      for (const r of rooms.values()) if (!r.isPrivate && r.players.size < MAX_PLAYERS && (!best || r.players.size > best.players.size)) best = r;
      joinRoom(p, best || createRoom(false));
      break;
    }
    case 'create': joinRoom(p, createRoom(true)); break;
    case 'join': {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return send(p, { t: 'err', text: 'No room with that code. Check it and try again.' });
      joinRoom(p, r);
      break;
    }
    case 'leave': leaveRoom(p); break;
    case 'chat': {
      if (!room || now - (p.lastChat || 0) < 600) return;
      const text = cleanText(m.text); if (!text) return;
      p.lastChat = now;
      broadcast(room, { t: 'chat', name: p.name, color: p.color, text });
      break;
    }
    case 'start':
      if (room && room.isPrivate && room.hostId === p.id && room.state === 'waiting') startVote(room);
      break;
    case 'vote':
      if (room && room.state === 'voting' && room.choices.includes(m.map)) { room.votes.set(p.id, m.map); sendRoom(room); }
      break;
    case 's': { // position update
      if (!room || room.state !== 'playing') return;
      const x = num(m.x, -45, 45), y = num(m.y, -5, 80), z = num(m.z, -45, 45);
      if (x === null || y === null || z === null) return;
      p.x = x; p.y = y; p.z = z; p.yaw = num(m.yaw, -1e4, 1e4) || 0; p.pitch = num(m.pitch, -2, 2) || 0;
      p.w = Math.floor(num(m.w, 0, 5) || 0);
      break;
    }
    case 'spawn': {
      if (!room || room.state !== 'playing' || !p.dead || (p.diedAt && now - p.diedAt < RESPAWN_DELAY)) return;
      const x = num(m.x, -40, 40), y = num(m.y, 0, 80), z = num(m.z, -40, 40);
      if (x === null || y === null || z === null) return;
      p.x = x; p.y = y; p.z = z; p.dead = false; p.hp = 100;
      broadcast(room, { t: 'spawn', id: p.id, x, y, z });
      broadcast(room, { t: 'hp', id: p.id, hp: 100 });
      break;
    }
    case 'shot': { // tracer effect for everyone else
      if (!room || room.state !== 'playing' || p.dead || !Array.isArray(m.a) || !Array.isArray(m.b)) return;
      const a = m.a.slice(0, 3).map(v => num(v, -300, 300) || 0);
      const b = m.b.slice(0, 9).filter(Array.isArray).map(e => e.slice(0, 3).map(v => num(v, -300, 300) || 0));
      broadcast(room, { t: 'shot', id: p.id, a, b }, p);
      break;
    }
    case 'hit': {
      if (!room || room.state !== 'playing' || p.dead) return;
      const target = room.players.get(m.id), w = Math.floor(num(m.w, 0, 4) || 0), spec = WEAPONS[w];
      if (!target || target === p || target.dead) return;
      if (now - p.lastShot[w] < spec.rate * 1000 * 0.5) return; // firing faster than the gun allows
      p.lastShot[w] = now;
      const dmg = num(m.dmg, 0, spec.max); if (!dmg) return;
      target.hp -= dmg;
      if (target.hp <= 0) {
        target.hp = 0; target.dead = true; target.diedAt = now; target.deaths++;
        p.kills++; p.hp = Math.min(100, p.hp + 25);
        broadcast(room, { t: 'kill', k: p.id, v: target.id, head: !!m.head });
        broadcast(room, { t: 'hp', id: p.id, hp: p.hp });
        if (p.kills >= KILL_LIMIT) endMatch(room, 'kills');
      } else broadcast(room, { t: 'hp', id: target.id, hp: Math.round(target.hp), by: p.id });
      break;
    }
    case 'build': {
      if (!room || room.state !== 'playing' || p.dead || now - (p.lastBuild || 0) < 90 || room.structs.size > 800) return;
      const kind = m.kind; if (!(kind in PIECES)) return;
      const x = num(m.x, -40, 40), z = num(m.z, -40, 40), level = num(m.level, 0, 40);
      const dx = Math.sign(num(m.dx, -1, 1) || 0), dz = Math.sign(num(m.dz, -1, 1) || 0);
      if (x === null || z === null || level === null || level % 4 !== 0 || Math.abs(dx) + Math.abs(dz) !== 1) return;
      const key = kind[0] + x + ',' + z + ',' + level;
      if (room.structs.has(key)) return;
      p.lastBuild = now;
      const s = { key, kind, x, z, level, dir: { x: dx, z: dz }, hp: PIECES[kind] };
      room.structs.set(key, s);
      broadcast(room, { t: 'build', s });
      break;
    }
    case 'hs': { // shot hit a built piece
      if (!room || room.state !== 'playing' || p.dead) return;
      const s = room.structs.get(m.key), w = Math.floor(num(m.w, 0, 4) || 0), spec = WEAPONS[w];
      if (!s || now - p.lastStruct[w] < spec.rate * 1000 * 0.5) return;
      p.lastStruct[w] = now;
      s.hp -= num(m.dmg, 0, spec.max) || 0;
      if (s.hp <= 0) { room.structs.delete(s.key); broadcast(room, { t: 'sgone', key: s.key }); }
      else broadcast(room, { t: 'shp', key: s.key, hp: Math.round(s.hp) });
      break;
    }
  }
}

wss.on('connection', (ws) => {
  const p = { id: nextId++, ws, name: 'Player', color: 0, room: null, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, w: 0 };
  resetPlayer(p);
  players.set(p.id, p);
  send(p, { t: 'welcome', id: p.id, online: players.size });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m && typeof m.t === 'string') { try { handle(p, m); } catch (e) { console.error(e); } }
  });
  ws.on('close', () => { leaveRoom(p); players.delete(p.id); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Arena Clash server running on port ' + PORT));
