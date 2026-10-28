// Arena Clash multiplayer server (v4: modes, teams, cosmetics, leaderboard)
// Run with:  npm install   then   node index.js
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 16384 });

/* ================= settings you can tweak ================= */
const MAPS = ['blockyard', 'dustbowl', 'frostbite', 'neon'];
const MODES = {
  ffa: { limit: 15 },                         // free-for-all, first to 15 kills
  tdm: { limit: 30, teams: true },            // team deathmatch, first team to 30
  snipers: { limit: 10, weapons: [3, 4, 7, 10] }, // sniper, handgun, revolver + grenades
};
const MODE_IDS = Object.keys(MODES);
const MAX_PLAYERS = 8;
const MATCH_TIME = 240;      // seconds
const LOBBY_COUNTDOWN = 10;  // public lobbies start this long after 2+ players are in
const VOTE_TIME = 12;
const RESULTS_TIME = 10;
const RESPAWN_DELAY = 2500;  // ms
const SPAWN_SHIELD = 1500;   // ms of protection after spawning
// per weapon: max damage per target per shot, fire rate (seconds). Used to reject cheated hits.
const WEAPONS = [
  { max: 32, rate: 0.1 },    // 0 AR
  { max: 20, rate: 0.065 },  // 1 SMG
  { max: 135, rate: 0.85 },  // 2 Shotgun (all pellets)
  { max: 200, rate: 1.3 },   // 3 Sniper
  { max: 48, rate: 0.2 },    // 4 Pistol
  { max: 44, rate: 0.07 },   // 5 Burst Rifle (per bullet)
  { max: 110, rate: 1.4 },   // 6 Rocket Launcher (splash)
  { max: 90, rate: 0.55 },   // 7 Revolver
  { max: 40, rate: 0.115 },  // 8 AK-47
  { max: 16, rate: 0.05 },   // 9 Minigun
  { max: 100, rate: 0.8 },   // 10 Grenade (splash)
];
const BUILD_SLOT = 15;
const PIECES = { wall: 150, floor: 120, ramp: 120 };
const HATS = ['none', 'cap', 'crown', 'cowboy', 'horns', 'halo', 'tophat', 'headphones'];
const EFFECTS = ['sparks', 'confetti', 'pixels', 'fire'];
const GUN_SKINS = ['classic', 'gold', 'neon', 'camo', 'frost', 'lava', 'candy', 'galaxy'];

/* ================= state ================= */
let nextId = 1;
const players = new Map();
const rooms = new Map();
const leaderboard = new Map(); // lowercased name -> { name, kills, wins, matches } (kept in memory)

const num = (v, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) return null; return Math.max(lo, Math.min(hi, v)); };
const int = (v, lo, hi) => Math.floor(num(v, lo, hi) || 0);
const r2 = (v) => Math.round(v * 100) / 100;
const cleanName = (n) => String(n || '').replace(/[^\w \-]/g, '').trim().slice(0, 14) || 'Player';
const cleanText = (t) => String(t || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);

function send(p, msg) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const p of room.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s);
}
function broadcastAll(msg) { const s = JSON.stringify(msg); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s); }
function makeCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c;
  do { c = ''; for (let i = 0; i < 5; i++) c += abc[Math.floor(Math.random() * abc.length)]; } while (rooms.has(c));
  return c;
}
function createRoom(isPrivate) {
  const room = { code: makeCode(), isPrivate, hostId: null, players: new Map(), state: 'waiting', countdown: 0,
    choices: [], votes: new Map(), map: 'blockyard', mode: 'ffa', endsAt: 0, structs: new Map(), teamScores: [0, 0] };
  rooms.set(room.code, room); return room;
}
const limitOf = (room) => MODES[room.mode].limit;
const isTeams = (room) => !!MODES[room.mode].teams;
function tally(room) {
  const maps = {}, modes = {};
  for (const m of room.choices) maps[m] = 0;
  for (const m of MODE_IDS) modes[m] = 0;
  for (const v of room.votes.values()) { if (v.map in maps) maps[v.map]++; if (v.mode in modes) modes[v.mode]++; }
  return { maps, modes };
}
function roomInfo(room) {
  const t = tally(room);
  return {
    t: 'room', code: room.code, isPrivate: room.isPrivate, host: room.hostId, state: room.state, countdown: room.countdown,
    choices: room.choices, votes: t.maps, modeChoices: MODE_IDS, modeVotes: t.modes, map: room.map, mode: room.mode,
    limit: limitOf(room), teamScores: room.teamScores,
    timeLeft: room.state === 'playing' ? Math.max(0, (room.endsAt - Date.now()) / 1000) : 0,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, hat: p.hat, effect: p.effect, gunSkin: p.gunSkin, team: p.team, kills: p.kills, deaths: p.deaths })),
  };
}
const sendRoom = (room) => broadcast(room, roomInfo(room));
const sysChat = (room, text) => broadcast(room, { t: 'chat', sys: true, text });
function startMsg(room) {
  return { t: 'start', map: room.map, mode: room.mode, limit: limitOf(room), teamScores: room.teamScores,
    timeLeft: Math.max(0, (room.endsAt - Date.now()) / 1000), structs: [...room.structs.values()] };
}
function resetPlayer(p) {
  p.kills = 0; p.deaths = 0; p.hp = 100; p.dead = true; p.diedAt = 0; p.spawnAt = 0;
  p.lastShot = WEAPONS.map(() => 0); p.lastStruct = WEAPONS.map(() => 0);
}
function smallerTeam(room, except) {
  let a = 0, b = 0;
  for (const p of room.players.values()) if (p !== except) { if (p.team === 0) a++; else b++; }
  return a <= b ? 0 : 1;
}

function joinRoom(p, room) {
  leaveRoom(p);
  if (room.players.size >= MAX_PLAYERS) return send(p, { t: 'err', text: 'That room is full.' });
  resetPlayer(p); p.team = smallerTeam(room, p);
  room.players.set(p.id, p); p.room = room;
  if (!room.hostId) room.hostId = p.id;
  sendRoom(room); sysChat(room, p.name + ' joined');
  if (room.state === 'playing') send(p, startMsg(room));
  maybeCountdown(room);
}
function leaveRoom(p) {
  const room = p.room; if (!room) return;
  room.players.delete(p.id); p.room = null;
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = room.players.keys().next().value;
  broadcast(room, { t: 'left', id: p.id }); sysChat(room, p.name + ' left');
  if (room.state === 'waiting' && room.countdown > 0 && room.players.size < 2) room.countdown = 0;
  sendRoom(room);
}
function maybeCountdown(room) {
  if (!room.isPrivate && room.state === 'waiting' && room.countdown === 0 && room.players.size >= 2) { room.countdown = LOBBY_COUNTDOWN; sendRoom(room); }
}
function startVote(room) {
  room.state = 'voting'; room.countdown = VOTE_TIME; room.votes.clear();
  room.choices = MAPS.slice().sort(() => Math.random() - 0.5).slice(0, 3);
  sendRoom(room);
}
function topPick(counts) {
  const keys = Object.keys(counts), top = Math.max(...keys.map(k => counts[k]));
  const tied = keys.filter(k => counts[k] === top); return tied[Math.floor(Math.random() * tied.length)];
}
function startMatch(room) {
  const t = tally(room);
  room.map = topPick(t.maps); room.mode = topPick(t.modes);
  room.state = 'playing'; room.countdown = 0; room.endsAt = Date.now() + MATCH_TIME * 1000;
  room.structs.clear(); room.teamScores = [0, 0];
  const list = [...room.players.values()].sort(() => Math.random() - 0.5);
  list.forEach((p, i) => { resetPlayer(p); p.team = i % 2; });
  broadcast(room, startMsg(room)); sendRoom(room);
}
function endMatch(room, reason) {
  if (room.state !== 'playing') return;
  room.state = 'results'; room.countdown = RESULTS_TIME;
  const all = [...room.players.values()];
  const standings = all.slice().sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, team: p.team }));
  let winTeam = null; const winners = new Set();
  if (isTeams(room)) {
    const [a, b] = room.teamScores; winTeam = a === b ? -1 : (a > b ? 0 : 1);
    if (winTeam >= 0) all.filter(p => p.team === winTeam).forEach(p => winners.add(p.id));
  } else if (standings[0] && standings[0].kills > 0) winners.add(standings[0].id);
  broadcast(room, { t: 'end', reason, standings, mode: room.mode, teamScores: room.teamScores, winTeam, winners: [...winners] });
  // leaderboard
  for (const p of all) {
    const key = p.name.toLowerCase(), e = leaderboard.get(key) || { name: p.name, kills: 0, wins: 0, matches: 0 };
    e.name = p.name; e.kills += p.kills; e.matches++; if (winners.has(p.id)) e.wins++;
    leaderboard.set(key, e);
  }
  broadcastAll({ t: 'lb', top: lbTop() });
  sendRoom(room);
}
const lbTop = () => [...leaderboard.values()].sort((a, b) => b.wins - a.wins || b.kills - a.kills).slice(0, 10);

function applyDamage(room, attacker, target, dmg, head, w) {
  target.hp -= dmg;
  if (target.hp <= 0) {
    target.hp = 0; target.dead = true; target.diedAt = Date.now(); target.deaths++;
    attacker.kills++; attacker.hp = Math.min(100, attacker.hp + 25);
    if (isTeams(room)) room.teamScores[attacker.team]++;
    broadcast(room, { t: 'kill', k: attacker.id, v: target.id, head: !!head, w, ts: room.teamScores });
    broadcast(room, { t: 'hp', id: attacker.id, hp: attacker.hp });
    const lim = limitOf(room);
    if (isTeams(room) ? room.teamScores[attacker.team] >= lim : attacker.kills >= lim) endMatch(room, 'kills');
  } else broadcast(room, { t: 'hp', id: target.id, hp: Math.round(target.hp), by: attacker.id });
}
const weaponAllowed = (room, w) => { const list = MODES[room.mode].weapons; return !list || list.includes(w); };

/* ================= timers ================= */
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state === 'waiting' && room.countdown > 0) {
      if (!room.isPrivate && room.players.size < 2) { room.countdown = 0; sendRoom(room); continue; }
      room.countdown--; if (room.countdown <= 0) startVote(room); else sendRoom(room);
    } else if (room.state === 'voting') {
      room.countdown--; if (room.countdown <= 0) startMatch(room); else sendRoom(room);
    } else if (room.state === 'results') {
      room.countdown--;
      if (room.countdown <= 0) {
        room.state = 'waiting'; room.countdown = 0; room.teamScores = [0, 0];
        for (const p of room.players.values()) resetPlayer(p);
        sendRoom(room); maybeCountdown(room);
      } else sendRoom(room);
    }
  }
}, 1000);
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state !== 'playing') continue;
    const l = [...room.players.values()].map(p => [p.id, r2(p.x), r2(p.y), r2(p.z), r2(p.yaw), r2(p.pitch), p.w, Math.max(0, Math.round(p.hp)), p.dead ? 1 : 0]);
    broadcast(room, { t: 'st', l });
    if (Date.now() >= room.endsAt) endMatch(room, 'time');
  }
}, 50);
setInterval(() => broadcastAll({ t: 'online', n: players.size }), 5000);

/* ================= messages ================= */
function handle(p, m) {
  const room = p.room, now = Date.now();
  const playing = room && room.state === 'playing';
  switch (m.t) {
    case 'hello':
      p.name = cleanName(m.name); p.color = int(m.color, 0, 7);
      p.hat = HATS.includes(m.hat) ? m.hat : 'none'; p.effect = EFFECTS.includes(m.effect) ? m.effect : 'sparks';
      p.gunSkin = GUN_SKINS.includes(m.gunSkin) ? m.gunSkin : 'classic';
      if (p.room) sendRoom(p.room);
      break;
    case 'quick': {
      let best = null;
      for (const r of rooms.values()) if (!r.isPrivate && r.players.size < MAX_PLAYERS && (!best || r.players.size > best.players.size)) best = r;
      joinRoom(p, best || createRoom(false)); break;
    }
    case 'create': joinRoom(p, createRoom(true)); break;
    case 'join': {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return send(p, { t: 'err', text: 'No room with that code. Check it and try again.' });
      joinRoom(p, r); break;
    }
    case 'leave': leaveRoom(p); break;
    case 'lb': send(p, { t: 'lb', top: lbTop() }); break;
    case 'chat': {
      if (!room || now - (p.lastChat || 0) < 600) return;
      const text = cleanText(m.text); if (!text) return;
      p.lastChat = now; broadcast(room, { t: 'chat', name: p.name, color: p.color, text }); break;
    }
    case 'start':
      if (room && room.isPrivate && room.hostId === p.id && room.state === 'waiting') startVote(room);
      break;
    case 'vote': {
      if (!room || room.state !== 'voting') return;
      const v = room.votes.get(p.id) || {};
      if (room.choices.includes(m.map)) v.map = m.map;
      if (MODE_IDS.includes(m.mode)) v.mode = m.mode;
      room.votes.set(p.id, v); sendRoom(room); break;
    }
    case 's': {
      if (!playing) return;
      const x = num(m.x, -45, 45), y = num(m.y, -5, 80), z = num(m.z, -45, 45);
      if (x === null || y === null || z === null) return;
      p.x = x; p.y = y; p.z = z; p.yaw = num(m.yaw, -1e4, 1e4) || 0; p.pitch = num(m.pitch, -2, 2) || 0;
      p.w = int(m.w, 0, BUILD_SLOT); break;
    }
    case 'spawn': {
      if (!playing || !p.dead || (p.diedAt && now - p.diedAt < RESPAWN_DELAY)) return;
      const x = num(m.x, -40, 40), y = num(m.y, 0, 80), z = num(m.z, -40, 40);
      if (x === null || y === null || z === null) return;
      p.x = x; p.y = y; p.z = z; p.dead = false; p.hp = 100; p.spawnAt = now;
      broadcast(room, { t: 'spawn', id: p.id, x, y, z });
      broadcast(room, { t: 'hp', id: p.id, hp: 100 }); break;
    }
    case 'shot': {
      if (!playing || p.dead || !Array.isArray(m.a) || !Array.isArray(m.b)) return;
      const a = m.a.slice(0, 3).map(v => num(v, -300, 300) || 0);
      const b = m.b.slice(0, 9).filter(Array.isArray).map(e => e.slice(0, 3).map(v => num(v, -300, 300) || 0));
      broadcast(room, { t: 'shot', id: p.id, a, b }, p); break;
    }
    case 'gr': {
      if (!playing || p.dead || !Array.isArray(m.a) || !Array.isArray(m.v) || now - (p.lastNade || 0) < 700) return;
      p.lastNade = now;
      broadcast(room, { t: 'gr', id: p.id, a: m.a.slice(0, 3).map(v => num(v, -300, 300) || 0), v: m.v.slice(0, 3).map(v => num(v, -60, 60) || 0) }, p); break;
    }
    case 'rk': {
      if (!playing || p.dead || !Array.isArray(m.a) || !Array.isArray(m.v)) return;
      broadcast(room, { t: 'rk', id: p.id, a: m.a.slice(0, 3).map(v => num(v, -300, 300) || 0), v: m.v.slice(0, 3).map(v => num(v, -100, 100) || 0) }, p); break;
    }
    case 'hit': { // one message per shot, listing every player it hit
      if (!playing || p.dead || !Array.isArray(m.list)) return;
      const w = int(m.w, 0, WEAPONS.length - 1), spec = WEAPONS[w];
      if (!weaponAllowed(room, w) || now - p.lastShot[w] < spec.rate * 1000 * 0.5) return;
      p.lastShot[w] = now;
      for (const h of m.list.slice(0, 8)) {
        if (room.state !== 'playing') break;
        const target = room.players.get(h && h.id);
        if (!target || target === p || target.dead || now - target.spawnAt < SPAWN_SHIELD) continue;
        if (isTeams(room) && target.team === p.team) continue;
        const dmg = num(h.dmg, 0, spec.max); if (dmg) applyDamage(room, p, target, dmg, h.head, w);
      }
      break;
    }
    case 'build': {
      if (!playing || p.dead || now - (p.lastBuild || 0) < 90 || room.structs.size > 800) return;
      const kind = m.kind; if (!(kind in PIECES)) return;
      const x = num(m.x, -40, 40), z = num(m.z, -40, 40), level = num(m.level, 0, 40);
      const dx = Math.sign(num(m.dx, -1, 1) || 0), dz = Math.sign(num(m.dz, -1, 1) || 0);
      if (x === null || z === null || level === null || level % 4 !== 0 || Math.abs(dx) + Math.abs(dz) !== 1) return;
      const key = kind[0] + x + ',' + z + ',' + level;
      if (room.structs.has(key)) return;
      p.lastBuild = now;
      const s = { key, kind, x, z, level, dir: { x: dx, z: dz }, hp: PIECES[kind] };
      room.structs.set(key, s); broadcast(room, { t: 'build', s }); break;
    }
    case 'hs': {
      if (!playing || p.dead || !Array.isArray(m.list)) return;
      const w = int(m.w, 0, WEAPONS.length - 1), spec = WEAPONS[w];
      if (now - p.lastStruct[w] < spec.rate * 1000 * 0.5) return;
      p.lastStruct[w] = now;
      for (const h of m.list.slice(0, 12)) {
        const s = room.structs.get(h && h.key); if (!s) continue;
        s.hp -= num(h.dmg, 0, 160) || 0;
        if (s.hp <= 0) { room.structs.delete(s.key); broadcast(room, { t: 'sgone', key: s.key }); }
        else broadcast(room, { t: 'shp', key: s.key, hp: Math.round(s.hp) });
      }
      break;
    }
  }
}

wss.on('connection', (ws) => {
  const p = { id: nextId++, ws, name: 'Player', color: 0, hat: 'none', effect: 'sparks', gunSkin: 'classic', team: 0, room: null, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, w: 0 };
  resetPlayer(p); players.set(p.id, p);
  send(p, { t: 'welcome', id: p.id, online: players.size });
  send(p, { t: 'lb', top: lbTop() });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m && typeof m.t === 'string') { try { handle(p, m); } catch (e) { console.error(e); } }
  });
  ws.on('close', () => { leaveRoom(p); players.delete(p.id); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Arena Clash server running on port ' + PORT));
