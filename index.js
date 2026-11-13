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
const MAPS = ['blockyard', 'dustbowl', 'frostbite', 'neon', 'temple', 'caverns', 'harvest'];   // PvP maps (Pumpkin Hollow is for Zombies)
const MODES = {
  ffa: { limit: 15 },                         // free-for-all, first to 15 kills
  tdm: { limit: 30, teams: true },            // team deathmatch, first team to 30
  snipers: { limit: 10, weapons: [3, 4, 7, 14, 15] }, // sniper, handgun, revolver + grenades and mines
  feast: { limit: 0, zombies: true },         // Feast Defense co-op: protect the Thanksgiving feast from 5 waves of turkeys
  gungame: { limit: 0, gungame: true },       // every kill gives you the next gun
  koth: { limit: 100, teams: true },          // King of the Hill: hold the zone to score
  ctf: { limit: 3, teams: true },             // Capture the Flag: first to 3 captures
  br: { limit: 0, br: true },                 // Battle Royale: one life, loot, shrinking storm
};
const RANKED_MODES = ['ffa', 'gungame', 'br'];
// Ranked: Bronze I-III, Silver I-III, Gold I-III, Platinum I-III, Diamond I-III (100 RP each), then Champion at 1500 RP
const RANK_TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'], CHAMPION_RP = 1500;
function rankName(rp) { rp = Math.max(0, rp || 0); if (rp >= CHAMPION_RP) return 'Champion'; return RANK_TIERS[Math.floor(rp / 300)] + ' ' + ['I', 'II', 'III'][Math.floor((rp % 300) / 100)]; }
function rpChange(place, n, kills) {   // 1st place +32 down to last place -24, plus 2 per kill (up to +10)
  const share = n > 1 ? place / (n - 1) : 0;
  return Math.round(32 - 56 * share) + Math.min(10, (kills || 0) * 2);
}
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
  { max: 16, rate: 0.065 },  // 9 Minigun
  { max: 160, rate: 1.6 },   // 10 Halloween RPG (big splash)
  { max: 60, rate: 0.5 },    // 11 Scythe (melee)
  { max: 0, rate: 0.4 },     // 12 Portal Gun (no damage)
  { max: 12, rate: 0.22 },   // 13 Turkey Launcher (the turkey's pecks)
  { max: 130, rate: 0.8 },   // 14 Grenade (splash)
  { max: 100, rate: 0.5 },   // 15 Land mine (splash)
];
const BUILD_SLOT = 15;
const PIECES = { wall: 150, floor: 120, ramp: 120 };
const HATS = ['none', 'cap', 'crown', 'cowboy', 'horns', 'halo', 'tophat', 'headphones', 'pilgrim', 'beanie', 'turkeyhat', 'pumpkinhead', 'viking', 'wizard'];
const EFFECTS = ['sparks', 'confetti', 'pixels', 'fire', 'leaves', 'lightning', 'hearts'];
const GUN_SKINS = ['classic', 'gold', 'neon', 'camo', 'frost', 'lava', 'candy', 'galaxy', 'rainbow', 'maple', 'harvest', 'pumpkinspice', 'autumnwood', 'sunset'];
const MYTHICS = { // Mythical skin -> the weapon it belongs to
  gobbler: 'turkey', harvestmoon: 'sniper', dragonfire: 'ar', voltage: 'smg', thunderclap: 'shotgun', starfall: 'sniper', royal: 'pistol', phantom: 'burst', doomsday: 'rocket', outlaw: 'revolver',
  viper: 'ak', overdrive: 'minigun', headless: 'pumpkin', reaper: 'scythe', inferno: 'scythe', frostbite: 'scythe', celestial: 'scythe', quantum: 'portal',
};
for (const w of ['ar', 'smg', 'shotgun', 'sniper', 'pistol', 'burst', 'rocket', 'revolver', 'ak', 'minigun', 'pumpkin', 'scythe', 'portal', 'turkey']) { MYTHICS['gold_' + w] = w; MYTHICS['diamond_' + w] = w; }   // mastery camos
const CUSTOM_THEMES = ['blockyard', 'dustbowl', 'frostbite', 'neon', 'harvest', 'temple', 'caverns'];
const MAX_CUSTOM_BLOCKS = 500;
/* ================= Battle Royale ================= */
// phases: [wait seconds, shrink seconds, end radius, storm damage per second]
const BR_HALF = 300;                  // Harvest Valley is 600 x 600
const BR_BUS = 40;                    // seconds the Drop Bus takes to cross the map
const BR_HP = 500;                    // everyone has 500 HP in Battle Royale
// phases: [wait seconds, shrink seconds, end radius, storm damage per second]
const BR_PHASES = [[BR_BUS + 25, 30, 260, 5], [25, 25, 150, 10], [20, 20, 80, 18], [18, 18, 35, 28], [15, 15, 0, 45]];   // faster storm
const boundOf = (room) => room && room.mode === 'br' ? BR_HALF : 40;
const BR_LOOT = [[0, 'common'], [1, 'common'], [2, 'common'], [5, 'rare'], [3, 'rare'], [7, 'rare'], [8, 'epic'], [6, 'epic'], [11, 'epic'], [9, 'legendary']];
function startBR(room) {
  const loot = []; let id = 1;
  const weight = { common: 5, rare: 3, epic: 2, legendary: 1 }, bag = [];
  for (const [w, r] of BR_LOOT) for (let i = 0; i < weight[r]; i++) bag.push(w);
  for (let i = 0; i < 260; i++) {
    const x = (Math.random() * 2 - 1) * (BR_HALF - 8), z = (Math.random() * 2 - 1) * (BR_HALF - 8);
    loot.push({ id: id++, x: r2(x), z: r2(z), w: Math.random() < .22 ? 'hp' : bag[Math.floor(Math.random() * bag.length)] });
  }
  const a = Math.random() * Math.PI * 2, e = BR_HALF + 20;   // the Drop Bus flies straight across the map
  const bus = [r2(Math.cos(a) * e), r2(Math.sin(a) * e), r2(-Math.cos(a + .35) * e), r2(-Math.sin(a + .35) * e), BR_BUS];
  const r0 = BR_HALF * 1.45;
  room.br = { phase: 0, wait: BR_PHASES[0][0], shrink: 0, cx: 0, cz: 0, r: r0, fromR: r0, toR: BR_PHASES[0][2], fx: 0, fz: 0, tx: 0, tz: 0, dps: 1, stormAcc: 0, loot, bus, started: Date.now() };
  for (const p of room.players.values()) { p.out = false; p.inv = [4]; p.spawnedOnce = false; p.placeT = 0; p.maxHp = BR_HP; }
}
function tickBR(room, dt) {
  const b = room.br; if (!b) return;
  const P_ = BR_PHASES[Math.min(b.phase, BR_PHASES.length - 1)];
  if (b.wait > 0) {
    b.wait -= dt;
    if (b.wait <= 0) { // start shrinking toward a new, smaller circle inside the current one
      b.shrink = P_[1]; b.fromR = b.r; b.toR = P_[2]; b.fx = b.cx; b.fz = b.cz;
      const a = Math.random() * Math.PI * 2, d = Math.random() * Math.max(0, b.r - b.toR) * .6;
      const lim = BR_HALF - 25; b.tx = Math.max(-lim, Math.min(lim, b.cx + Math.cos(a) * d)); b.tz = Math.max(-lim, Math.min(lim, b.cz + Math.sin(a) * d));
      broadcast(room, { t: 'obj', ev: 'storm' });
    }
  } else if (b.shrink > 0) {
    b.shrink -= dt; const k = 1 - Math.max(0, b.shrink) / P_[1];
    b.r = b.fromR + (b.toR - b.fromR) * k; b.cx = b.fx + (b.tx - b.fx) * k; b.cz = b.fz + (b.tz - b.fz) * k; b.dps = P_[3];
    if (b.shrink <= 0 && b.phase < BR_PHASES.length - 1) { b.phase++; b.wait = BR_PHASES[b.phase][0]; }
  }
  b.stormAcc += dt;
  if (b.stormAcc >= 1) {
    b.stormAcc = 0;
    for (const p of room.players.values()) {
      if (p.dead || !p.spawnedOnce || p.devGod || Math.hypot(p.x - b.cx, p.z - b.cz) <= b.r) continue;
      p.hp -= b.dps;
      if (p.hp <= 0) brOut(room, p, 0, 'storm'); else broadcast(room, { t: 'hp', id: p.id, hp: Math.round(p.hp), storm: 1 });
    }
  }
  const alive = [...room.players.values()].filter(p => !p.dead && p.spawnedOnce);
  b.alive = alive.length;
  if (Date.now() - b.started > (BR_BUS + 8) * 1000 && alive.length <= 1 && room.players.size > 0) {
    const everyone = [...room.players.values()].filter(p => p.spawnedOnce);
    if (everyone.length >= 2 || alive.length === 0) endMatch(room, 'br');
  }
}
function brOut(room, p, killerId, cause) {
  p.hp = 0; p.dead = true; p.out = true; p.diedAt = Date.now(); p.placeT = Date.now(); p.deaths++;
  if (!killerId) broadcast(room, { t: 'kill', k: p.id, v: p.id, self: true, cause, ts: room.teamScores });
}
/* ================= Friends (friend codes, online status, invites) ================= */
const byUid = new Map();   // friend code -> player (only while connected)
function friendStatus(code) {
  const q = byUid.get(code);
  if (!q) return { code, online: false };
  return { code, online: true, name: q.name, room: q.room ? q.room.code : null, state: q.room ? q.room.state : 'menu', full: q.room ? q.room.players.size >= MAX_PLAYERS : false };
}
/* ================= Accounts (MongoDB Atlas) ================= */
const crypto = require('crypto');
let accounts = null;   // the MongoDB collection, or null when accounts are off
const SHOP = {   // server-side prices, so nobody can buy things they can't afford
  gun: { 4: 0, 0: 0, 1: 0, 2: 0, 3: 300, 5: 400, 7: 400, 8: 600, 11: 700, 6: 800, 12: 900, 9: 1000, 10: 1200, 13: 1100 },
  gunUntil: { 10: Date.UTC(2026, 10, 8), 13: Date.UTC(2026, 11, 1) },   // limited weapons
  skin: { classic: 0, camo: 200, candy: 300, frost: 400, neon: 600, lava: 700, gold: 900, galaxy: 1200, rainbow: 1500, maple: 500, harvest: 700, pumpkinspice: 900 },
  mythic: { dragonfire: 2000, voltage: 1800, thunderclap: 1900, starfall: 2300, royal: 1800, phantom: 2000, doomsday: 2300, outlaw: 2000, viper: 2200,
    overdrive: 2400, headless: 2500, reaper: 2000, inferno: 2200, frostbite: 2200, celestial: 2500, quantum: 2200, gobbler: 2400 },
  bp: 1000,
};
const UNLOCKABLE = { hat: ['pumpkinhead', 'viking', 'wizard'], effect: ['lightning', 'hearts'], skin: ['autumnwood', 'sunset'], mythic: Object.keys(MYTHICS).filter(k => k === 'harvestmoon' || /^(gold|diamond)_/.test(k)) };
const EARN_PER_MSG = 1000, EARN_PER_HOUR = 5000, IMPORT_MAX = 20000;
const PROFILE_MAX = 400000;   // bytes of saved settings, stats, missions, friends and maps
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const hashTok = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const okName = (n) => /^[A-Za-z0-9_]{3,14}$/.test(String(n || ''));
function cleanWallet(w) {
  w = w && typeof w === 'object' ? w : {};
  const arr = (a, ok) => Array.isArray(a) ? [...new Set(a.filter(ok))].slice(0, 200) : [];
  return {
    crystals: Math.max(0, Math.min(IMPORT_MAX, Math.floor(Number(w.crystals) || 0))),
    guns: arr(w.guns, g => Number.isInteger(g) && g in SHOP.gun),
    skins: arr(w.skins, s => s in SHOP.skin || UNLOCKABLE.skin.includes(s)),
    mythics: arr(w.mythics, m => m in MYTHICS),
    hats: arr(w.hats, h => UNLOCKABLE.hat.includes(h)), effects: arr(w.effects, e => UNLOCKABLE.effect.includes(e)), bp: !!w.bp,
  };
}
const walletMsg = (a) => ({ t: 'wallet', w: a.wallet });
async function initDB() {
  if (!process.env.MONGODB_URI) { console.log('No MONGODB_URI set: accounts are turned off'); return; }
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    accounts = client.db('arenaclash').collection('accounts');
    await accounts.createIndex({ lower: 1 }, { unique: true });
    await accounts.createIndex({ tokens: 1 });
    console.log('Connected to MongoDB: accounts are on');
    broadcastAll({ t: 'accounts', on: true });   // tell anyone who connected while the database was still starting up
    refreshLB();
  } catch (e) { console.error('MongoDB connection failed:', e.message); accounts = null; }
}
let lbCache = null, rankedCache = [];
async function refreshLB() {
  if (!accounts) return;
  try {
    const top = await accounts.find({ 'lb.matches': { $gt: 0 } }, { projection: { username: 1, lb: 1 } }).sort({ 'lb.wins': -1, 'lb.kills': -1 }).limit(10).toArray();
    lbCache = top.map(a => ({ name: a.username, wins: a.lb.wins || 0, kills: a.lb.kills || 0, matches: a.lb.matches || 0 }));
    const rk = await accounts.find({ rp: { $gt: 0 } }, { projection: { username: 1, rp: 1 } }).sort({ rp: -1 }).limit(10).toArray();
    rankedCache = rk.map(a => ({ name: a.username, rp: a.rp, rank: rankName(a.rp) }));
  } catch (e) { console.error('leaderboard', e.message); }
}
setInterval(refreshLB, 60000);
function signedIn(p, a, token) {
  p.account = { id: a._id, username: a.username, uid: a.uid, dev: !!a.dev };
  p.rp = a.rp || 0; p.rank = rankName(p.rp);
  p.name = a.username; p.uid = a.uid; byUid.set(a.uid, p);
  if (a.dev) { p.dev = true; send(p, { t: 'devok' }); }
  send(p, { t: 'auth', ok: true, username: a.username, uid: a.uid, token, profile: a.profile || {}, updated: a.updated || 0, dev: !!a.dev, rp: p.rp });
  send(p, walletMsg(a));
  if (p.room) sendRoom(p.room);
}
async function newToken(a) {
  const token = crypto.randomBytes(24).toString('hex');
  const tokens = [hashTok(token), ...(a.tokens || [])].slice(0, 5);   // stay logged in on up to 5 devices
  await accounts.updateOne({ _id: a._id }, { $set: { tokens } });
  return token;
}
function slowDown(p) { const now = Date.now(); p.authTries = (p.authTries || []).filter(t => now - t < 60000); p.authTries.push(now); return p.authTries.length > 6; }
async function accountMsg(p, m) {
  if (!accounts) return send(p, { t: 'autherr', text: process.env.MONGODB_URI ? 'Accounts are still starting up. Try again in a few seconds.' : 'Accounts are offline right now. You can still play as a guest.' });
  const now = Date.now();
  if (m.t === 'signup') {
    if (slowDown(p)) return send(p, { t: 'autherr', text: 'Too many tries. Wait a minute and try again.' });
    if (!okName(m.username)) return send(p, { t: 'autherr', text: 'Usernames are 3 to 14 letters, numbers or _.' });
    if (String(m.password || '').length < 6 || String(m.password).length > 100) return send(p, { t: 'autherr', text: 'Passwords need at least 6 characters.' });
    const lower = m.username.toLowerCase();
    const dev = lower === DEV_NAME && DEV_KEY && m.devKey === DEV_KEY;
    if (lower === DEV_NAME && !dev) return send(p, { t: 'autherr', text: 'That name is reserved.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const imported = m.import ? cleanWallet(m.import.wallet) : cleanWallet({});
    const profile = m.import && m.import.profile && JSON.stringify(m.import.profile).length < PROFILE_MAX ? m.import.profile : {};
    const uid = /^[A-Z0-9]{8}$/.test(String(m.uid || '')) && !(await accounts.findOne({ uid: m.uid })) ? m.uid : crypto.randomBytes(6).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().padEnd(8, 'X').slice(0, 8);
    const a = { username: m.username, lower, salt, hash: hashPw(m.password, salt), uid, dev: !!dev, created: now, updated: now, tokens: [], wallet: imported, profile, lb: { kills: 0, wins: 0, matches: 0 }, earn: { hour: now, amount: 0 } };
    try { const r = await accounts.insertOne(a); a._id = r.insertedId; }
    catch (e) { return send(p, { t: 'autherr', text: e.code === 11000 ? 'That username is taken.' : 'Could not create the account. Try again.' }); }
    return signedIn(p, a, await newToken(a));
  }
  if (m.t === 'login') {
    if (slowDown(p)) return send(p, { t: 'autherr', text: 'Too many tries. Wait a minute and try again.' });
    const a = await accounts.findOne({ lower: String(m.username || '').toLowerCase() });
    if (!a || hashPw(m.password, a.salt) !== a.hash) return send(p, { t: 'autherr', text: 'Wrong username or password.' });
    if (a.lower === DEV_NAME && DEV_KEY && m.devKey === DEV_KEY && !a.dev) { a.dev = true; await accounts.updateOne({ _id: a._id }, { $set: { dev: true } }); }
    return signedIn(p, a, await newToken(a));
  }
  if (m.t === 'resume') {
    const a = await accounts.findOne({ tokens: hashTok(m.token) });
    if (!a) return send(p, { t: 'autherr', text: 'Your login expired. Please log in again.', expired: true });
    return signedIn(p, a, m.token);
  }
  if (!p.account) return;
  const id = p.account.id;
  if (m.t === 'logout') {
    if (m.token) await accounts.updateOne({ _id: id }, { $pull: { tokens: hashTok(m.token) } });
    const uid = p.account.uid; p.account = null; p.dev = false; p.devGod = false;
    if (byUid.get(uid) === p) { byUid.delete(uid); for (const q of players.values()) if (q.account && q.account.uid === uid) { byUid.set(uid, q); break; } }
    p.uid = null; return send(p, { t: 'loggedout' });
  }
  if (m.t === 'save') {
    if (!m.profile || typeof m.profile !== 'object' || JSON.stringify(m.profile).length > PROFILE_MAX) return;
    await accounts.updateOne({ _id: id }, { $set: { profile: m.profile, updated: Number(m.updated) || now } }); return;
  }
  const a = await accounts.findOne({ _id: id }); if (!a) return;
  const w = a.wallet || cleanWallet({});
  if (m.t === 'earn') {   // crystals are earned in-game; the server caps how fast
    let n = Math.max(0, Math.min(EARN_PER_MSG, Math.floor(Number(m.n) || 0)));
    if (!p.dev) {
      const e = a.earn && now - a.earn.hour < 3600e3 ? a.earn : { hour: now, amount: 0 };
      n = Math.min(n, Math.max(0, EARN_PER_HOUR - e.amount)); e.amount += n;
      await accounts.updateOne({ _id: id }, { $inc: { 'wallet.crystals': n }, $set: { earn: e } });
    } else await accounts.updateOne({ _id: id }, { $inc: { 'wallet.crystals': n } });
    w.crystals = (w.crystals || 0) + n; return send(p, { t: 'wallet', w });
  }
  if (m.t === 'buy') {   // { kind: 'gun' | 'skin' | 'mythic' | 'bp', id }
    let price = null, field = null, val = m.id;
    if (m.kind === 'gun') { val = Math.floor(Number(m.id)); price = SHOP.gun[val]; field = 'guns'; if (SHOP.gunUntil[val] && now > SHOP.gunUntil[val]) price = null; }
    if (m.kind === 'skin') { price = SHOP.skin[val]; field = 'skins'; }
    if (m.kind === 'mythic') { price = SHOP.mythic[val]; field = 'mythics'; }
    if (m.kind === 'bp') price = SHOP.bp;
    if (price == null) return send(p, walletMsg(a));
    if (p.dev) price = 0;
    const owned = m.kind === 'bp' ? w.bp : (w[field] || []).includes(val);
    if (owned) return send(p, walletMsg(a));
    if ((w.crystals || 0) < price) { send(p, { t: 'autherr', text: 'Not enough Clash Crystals.' }); return send(p, walletMsg(a)); }
    const upd = m.kind === 'bp' ? { $inc: { 'wallet.crystals': -price }, $set: { 'wallet.bp': true } } : { $inc: { 'wallet.crystals': -price }, $addToSet: { ['wallet.' + field]: val } };
    await accounts.updateOne({ _id: id, 'wallet.crystals': { $gte: price } }, upd);
    const fresh = await accounts.findOne({ _id: id }); return send(p, walletMsg(fresh));
  }
  if (m.t === 'unlock') {   // Battle Pass items and mastery camos (cosmetic only)
    const list = UNLOCKABLE[m.kind]; if (!list || !list.includes(m.id)) return;
    const field = { hat: 'hats', effect: 'effects', skin: 'skins', mythic: 'mythics' }[m.kind];
    await accounts.updateOne({ _id: id }, { $addToSet: { ['wallet.' + field]: m.id } });
    const fresh = await accounts.findOne({ _id: id }); return send(p, walletMsg(fresh));
  }
}
async function recordMatchForAccounts(room, winners, standings) {
  if (!accounts) return;
  if (room.ranked && standings && standings.length >= 2) {   // Ranked points
    const n = standings.length;
    for (let i = 0; i < n; i++) {
      const p = room.players.get(standings[i].id); if (!p || !p.account) continue;
      const before = p.rp || 0, delta = rpChange(i, n, standings[i].kills), rp = Math.max(0, before + delta);
      p.rp = rp; p.rank = rankName(rp);
      accounts.updateOne({ _id: p.account.id }, { $set: { rp } }).catch(() => {});
      send(p, { t: 'rank', before, rp, delta: rp - before, place: i + 1, of: n });
    }
  }
  for (const p of room.players.values()) if (p.account)
    accounts.updateOne({ _id: p.account.id }, { $inc: { 'lb.kills': p.kills || 0, 'lb.matches': 1, 'lb.wins': winners.has(p.id) ? 1 : 0 } }).catch(() => {});
}
async function giftToAccount(target, amount) {
  if (!accounts || !target.account) return false;
  await accounts.updateOne({ _id: target.account.id }, { $inc: { 'wallet.crystals': amount } });
  const fresh = await accounts.findOne({ _id: target.account.id }); if (fresh) send(target, walletMsg(fresh));
  return true;
}

const PLACE_BONUS = [100, 50, 25];   // Clash Crystals for 1st, 2nd and 3rd place
const PLACE_MIN_PLAYERS = 4;         // ...only when at least 4 players are in the match
const ZOMBIE_LIVES = [3, 3, 3, 3, 1];   // lives per wave
const DEV_NAME = 'electrix';           // reserved: only someone with the dev key can use this name online
const DEV_KEY = process.env.DEV_KEY || '';   // set this on Render: Environment -> DEV_KEY
/* ===== Building collapse: pieces that lose their connection to the ground fall down ===== */
function pieceBox(s) {
  if (s.kind === 'wall') { const ax = s.dir.x === 0; return [s.x - (ax ? 2 : .15), s.level, s.z - (ax ? .15 : 2), s.x + (ax ? 2 : .15), s.level + 4, s.z + (ax ? .15 : 2)]; }
  if (s.kind === 'floor') return [s.x - 2, s.level - .3, s.z - 2, s.x + 2, s.level, s.z + 2];
  return [s.x - 2, s.level, s.z - 2, s.x + 2, s.level + 4, s.z + 2];
}
function boxesTouch(a, b) { const e = .2; return a[0] <= b[3] + e && a[3] >= b[0] - e && a[1] <= b[4] + e && a[4] >= b[1] - e && a[2] <= b[5] + e && a[5] >= b[2] - e; }
function collapseStructs(room) {   // returns the keys that fell
  const list = [...room.structs.values()], boxes = new Map(list.map(s => [s.key, pieceBox(s)]));
  const safe = new Set(list.filter(s => s.level <= 0 || s.grounded).map(s => s.key)), queue = [...safe];
  while (queue.length) {
    const k = queue.pop(), bk = boxes.get(k);
    for (const s of list) if (!safe.has(s.key) && boxesTouch(bk, boxes.get(s.key))) { safe.add(s.key); queue.push(s.key); }
  }
  const fell = list.filter(s => !safe.has(s.key)).map(s => s.key);
  for (const k of fell) room.structs.delete(k);
  return fell;
}

/* ===== Zombie wave simulation (shared by the server and the game page) ===== */
function makeZombieSim(opts) {   // V1.5 Feast Defense: wild turkeys attack the players and the Thanksgiving feast
  const R_SPAWN = 46, R_ARENA = 31;
  const TYPES = {
    small: { hp: 60, speed: 3.2, reach: 1.5, dmg: 5, cd: 1, scale: 1, rad: .5 },       // Wild Turkey
    big: { hp: 160, speed: 2.7, reach: 2.3, dmg: 9, cd: 1.3, scale: 1.8, rad: .9 },     // Tom Turkey
    giant: { hp: 2000, speed: 1.6, reach: 4.2, dmg: 25, cd: 1.6, scale: 4.2, rad: 1.8 },  // GOBBLEZILLA
  };
  const WAVES = [{ small: 18, big: 4 }, { small: 24, big: 7 }, { small: 30, big: 10 }, { big: 14, giant: 1 }, { big: 18, giant: 1 }];
  const MAX_ALIVE = 22;
  const S = { wave: 0, state: 'intermission', timer: 8, zombies: [], bombs: [], queue: [], spawnT: 0, nextId: 1, bombId: 1, bombT: 4, nplayers: 1,
    feast: opts.feast ? { x: 0, z: 0, r: 2.6, hp: 2000, max: 2000, hitT: 0 } : null };
  const r2 = (v) => Math.round(v * 100) / 100;
  function startWave() {
    S.wave++; S.state = 'fighting';
    if (S.wave === 1 && S.feast) { S.feast.max = S.feast.hp = 2000 + 400 * Math.max(0, S.nplayers - 1); }
    const W = WAVES[S.wave - 1], k = 1 + .3 * Math.max(0, S.nplayers - 1);
    const list = [];
    for (let i = 0; i < Math.round((W.small || 0) * k); i++) list.push('small');
    for (let i = 0; i < Math.round((W.big || 0) * k); i++) list.push('big');
    list.sort(() => Math.random() - .5);
    if (W.giant) list.splice(Math.min(3, list.length), 0, 'giant');
    S.queue = list; S.spawnT = 0; S.bombT = 5;
    opts.event({ type: 'wave', wave: S.wave });
  }
  function spawn(type) {
    const a = Math.random() * Math.PI * 2;
    const hp = TYPES[type].hp * (type === 'giant' ? 1 + .5 * Math.max(0, S.nplayers - 1) : 1);
    const goal = S.feast && type !== 'giant' && Math.random() < .35 ? 'feast' : 'player';   // about a third of the flock goes straight for the food
    S.zombies.push({ id: S.nextId++, type, goal, x: Math.cos(a) * R_SPAWN, z: Math.sin(a) * R_SPAWN, yaw: 0, hp, max: hp, cd: 1, swing: 0 });
    if (type === 'giant') opts.event({ type: 'giant' });
  }
  function update(dt) {
    if (S.state === 'intermission') { S.timer -= dt; if (S.timer <= 0) startWave(); return; }
    if (S.state !== 'fighting') return;
    const ps = opts.players().filter(p => p.alive);
    if (S.queue.length && S.zombies.length < MAX_ALIVE) { S.spawnT -= dt; if (S.spawnT <= 0) { spawn(S.queue.shift()); S.spawnT = S.wave >= 4 ? 1.2 : .75; } }
    if (S.feast) S.feast.hitT = Math.max(0, S.feast.hitT - dt);
    for (const z of S.zombies) {
      const T = TYPES[z.type]; z.swing = Math.max(0, z.swing - dt); z.cd -= dt;
      const enraged = z.type === 'giant' && z.hp < z.max * .25;
      if (z.type === 'giant') { z.calm = (z.calm || 0) + dt; if (z.calm > 4) z.hp = Math.min(z.max, z.hp + 6 * dt); }
      let best = null, bd = Infinity;
      for (const p of ps) { const d = Math.hypot(p.x - z.x, p.z - z.z); if (d < bd) { bd = d; best = p; } }
      const goFeast = S.feast && (z.goal === 'feast' || !best);
      if (goFeast) { best = { x: S.feast.x, z: S.feast.z, feast: true }; bd = Math.max(.001, Math.hypot(S.feast.x - z.x, S.feast.z - z.z) - S.feast.r); }
      if (!best) { z.moving = false; continue; }
      const dx = best.x - z.x, dz = best.z - z.z, d = bd || .001, len = Math.hypot(dx, dz) || .001;
      z.yaw = Math.atan2(dx, dz);
      if (d > T.reach * .8) { const step = Math.min(T.speed * (enraged ? 1.25 : 1) * dt, d - T.reach * .75); z.x += dx / len * step; z.z += dz / len * step; z.moving = true; } else z.moving = false;
      if (d < T.reach && z.cd <= 0) {
        if (best.feast) {
          z.cd = T.cd * 1.3; z.swing = .45; S.feast.hp -= T.dmg * .8;
          if (S.feast.hitT <= 0) { S.feast.hitT = 2.5; opts.event({ type: 'feasthit' }); }
          if (S.feast.hp <= 0) { S.feast.hp = 0; S.state = 'lost'; opts.event({ type: 'feastlost' }); return; }
        } else if ((best.y || 0) < 2.6 * T.scale) { z.cd = T.cd; z.swing = .45; opts.hurt(best.id, T.dmg); }
      }
    }
    for (let i = 0; i < S.zombies.length; i++) for (let j = i + 1; j < S.zombies.length; j++) {
      const a = S.zombies[i], b = S.zombies[j], ra = TYPES[a.type].rad + TYPES[b.type].rad, dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d > 0 && d < ra) { const push = (ra - d) / 2, ux = dx / d, uz = dz / d; a.x -= ux * push; a.z -= uz * push; b.x += ux * push; b.z += uz * push; }
    }
    if (S.zombies.some(z => z.type === 'giant')) { // Gobblezilla throws pies: red circles first, then splat
      S.bombT -= dt;
      if (S.bombT <= 0) {
        const g = S.zombies.find(z => z.type === 'giant'), angry = g && g.hp < g.max * .25;
        S.bombT = (S.wave >= 5 ? 3.0 : 3.6) * (angry ? .8 : 1);
        const n = (S.wave >= 5 ? 4 : 3) + (angry ? 1 : 0);
        for (let i = 0; i < n; i++) {
          let x, z;
          if (ps.length && i < ps.length * 2) { const p = ps[i % ps.length]; x = p.x + (Math.random() - .5) * 6; z = p.z + (Math.random() - .5) * 6; }
          else { const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * R_ARENA; x = Math.cos(a) * r; z = Math.sin(a) * r; }
          S.bombs.push({ id: S.bombId++, x, z, t: S.wave >= 5 ? 1.8 : 2.1, r: 3.0 });
        }
      }
    }
    for (let i = S.bombs.length - 1; i >= 0; i--) {
      const b = S.bombs[i]; b.t -= dt;
      if (b.t <= 0) {
        for (const p of ps) if (Math.hypot(p.x - b.x, p.z - b.z) < b.r) opts.bombHit(p.id);
        opts.event({ type: 'boom', x: r2(b.x), z: r2(b.z) }); S.bombs.splice(i, 1);
      }
    }
    if (!S.queue.length && !S.zombies.length) {
      S.bombs = [];
      if (S.wave >= WAVES.length) { S.state = 'won'; opts.event({ type: 'won' }); }
      else { S.state = 'intermission'; S.timer = 8; if (S.feast) S.feast.hp = Math.min(S.feast.max, S.feast.hp + S.feast.max * .25); opts.event({ type: 'clear', wave: S.wave }); }
    }
  }
  function damage(zid, dmg) {
    const i = S.zombies.findIndex(z => z.id === zid); if (i < 0) return null;
    const z = S.zombies[i]; z.hp -= z.type === 'giant' ? dmg * .8 : dmg;
    if (z.type === 'giant') z.calm = 0;
    if (z.hp <= 0) { S.zombies.splice(i, 1); return { killed: true, type: z.type, x: z.x, z: z.z }; }
    return { killed: false, type: z.type };
  }
  function snapshot() {
    return { w: S.wave, s: S.state, t: Math.ceil(S.timer), left: S.queue.length + S.zombies.length,
      f: S.feast ? [Math.max(0, Math.round(S.feast.hp)), S.feast.max] : null,
      z: S.zombies.map(z => [z.id, z.type[0], r2(z.x), r2(z.z), r2(z.yaw), Math.max(0, Math.round(z.hp)), z.swing > 0 ? 1 : 0, z.moving ? 1 : 0, Math.round(z.max || 0)]),
      b: S.bombs.map(b => [b.id, r2(b.x), r2(b.z), r2(b.t), b.r]) };
  }
  return { S, TYPES, WAVES, update, damage, snapshot, stop() { S.state = 'over'; } };
}


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
  for (const m of (room.modeChoices || MODE_IDS)) modes[m] = 0;
  for (const v of room.votes.values()) { if (v.map in maps) maps[v.map]++; if (v.mode in modes) modes[v.mode]++; }
  return { maps, modes };
}
function roomInfo(room) {
  const t = tally(room);
  return {
    t: 'room', code: room.code, isPrivate: room.isPrivate, host: room.hostId, state: room.state, countdown: room.countdown,
    choices: room.choices, votes: t.maps, modeChoices: room.modeChoices || MODE_IDS, modeVotes: t.modes, ranked: !!room.ranked, map: room.map, mode: room.mode,
    limit: limitOf(room), teamScores: room.teamScores, custom: room.customMap ? room.customMap.name : null,
    timeLeft: room.state === 'playing' ? Math.max(0, (room.endsAt - Date.now()) / 1000) : 0,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, hat: p.hat, effect: p.effect, gunSkin: p.gunSkin, mythic: p.mythic, level: p.level || 1, rank: p.rank || 'bronze', gg: p.gg || 0, team: p.team, kills: p.kills, deaths: p.deaths, assists: p.assists || 0 })),
  };
}
const sendRoom = (room) => broadcast(room, roomInfo(room));
const sysChat = (room, text) => broadcast(room, { t: 'chat', sys: true, text });
function startMsg(room) {
  return { t: 'start', map: room.map, mode: room.mode, limit: limitOf(room), teamScores: room.teamScores,
    timeLeft: Math.max(0, (room.endsAt - Date.now()) / 1000), structs: [...room.structs.values()],
    custom: room.map === 'custom' ? room.customMap : undefined,
    loot: room.br ? room.br.loot : undefined, bus: room.br ? room.br.bus : undefined, busT: room.br ? (Date.now() - room.br.started) / 1000 : undefined };
}
function resetPlayer(p) {
  p.kills = 0; p.deaths = 0; p.assists = 0; p.maxHp = 100; p.hp = 100; p.dead = true; p.diedAt = 0; p.spawnAt = 0; p.dmgBy = new Map();
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
  if (room.state === 'playing' && room.br) { p.out = true; p.spawnedOnce = true; p.inv = [4]; }
  if (room.state === 'playing') { if (room.sim) { p.lives = 1; p.out = false; room.sim.S.nplayers = room.players.size; } send(p, startMsg(room)); }
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
  room.choices = room.customMap ? ['custom'] : MAPS.slice().sort(() => Math.random() - 0.5).slice(0, 3);
  room.modeChoices = room.ranked ? RANKED_MODES.slice()
    : ['feast', ...MODE_IDS.filter(m => m !== 'feast').sort(() => Math.random() - 0.5).slice(0, 3)];
  sendRoom(room);
}
function topPick(counts) {
  const keys = Object.keys(counts), top = Math.max(...keys.map(k => counts[k]));
  const tied = keys.filter(k => counts[k] === top); return tied[Math.floor(Math.random() * tied.length)];
}
function startMatch(room) {
  const t = tally(room);
  room.map = topPick(t.maps); room.mode = topPick(t.modes);
  room.sim = null;
  if (isCoop(room)) { room.map = 'harvest'; startZombies(room); }
  room.br = null;
  if (room.mode === 'br') { room.map = 'valley'; startBR(room); room.endsAt = Date.now() + 15 * 60 * 1000; }
  room.state = 'playing'; room.countdown = 0; room.endsAt = Date.now() + MATCH_TIME * 1000;
  room.structs.clear(); room.teamScores = [0, 0];
  const list = [...room.players.values()].sort(() => Math.random() - 0.5);
  list.forEach((p, i) => { resetPlayer(p); p.team = i % 2; });
  startObjectives(room);
  broadcast(room, startMsg(room)); sendRoom(room);
}
function isCoop(room) { return !!(MODES[room.mode] && MODES[room.mode].zombies); }
function startZombies(room) {
  room.zsnapT = 0;
  room.sim = makeZombieSim({
    feast: true,
    players: () => [...room.players.values()].map(p => ({ id: p.id, x: p.x, z: p.z, y: p.y, alive: !p.dead })),
    hurt: (id, dmg) => {
      const p = room.players.get(id); if (!p || p.dead || p.devGod || Date.now() - p.spawnAt < SPAWN_SHIELD) return;
      p.hp -= dmg; if (p.hp <= 0) zombieDeath(room, p, 'zombie'); else broadcast(room, { t: 'hp', id: p.id, hp: Math.round(p.hp) });
    },
    bombHit: (id) => { const p = room.players.get(id); if (p && !p.dead && !p.devGod && Date.now() - p.spawnAt >= SPAWN_SHIELD) zombieDeath(room, p, 'bomb'); },
    event: (ev) => {
      if (ev.type === 'wave') {
        const lives = ZOMBIE_LIVES[ev.wave - 1] || 1;
        for (const p of room.players.values()) {
          p.lives = lives; p.out = false; if (p.dead) p.diedAt = 0;
          else { p.hp = 100; broadcast(room, { t: 'hp', id: p.id, hp: 100 }); }   // full health at the start of each wave
        }
        broadcast(room, { t: 'zwave', wave: ev.wave, lives });
      } else if (ev.type === 'won') { endMatch(room, 'won'); return; }
      else if (ev.type === 'feastlost') { broadcast(room, { t: 'zev', ev }); endMatch(room, 'feast'); return; }
      broadcast(room, { t: 'zev', ev });
    },
  });
  room.sim.S.nplayers = room.players.size;
  for (const p of room.players.values()) { p.lives = 3; p.out = false; }
}
function zombieDeath(room, p, cause) {
  p.hp = 0; p.dead = true; p.diedAt = Date.now(); p.deaths++; p.lives = Math.max(0, (p.lives || 1) - 1); if (p.lives <= 0) p.out = true;
  broadcast(room, { t: 'zdeath', id: p.id, lives: p.lives, out: !!p.out, cause });
  const ps = [...room.players.values()];
  if (!ps.some(q => !q.dead) && !ps.some(q => q.dead && !q.out)) endMatch(room, 'wiped');
}
function endMatch(room, reason) {
  if (room.state !== 'playing') return;
  if (room.sim) room.sim.stop();
  room.state = 'results'; room.countdown = RESULTS_TIME;
  const all = [...room.players.values()];
  const brRank = (p) => !p.dead ? Infinity : (p.placeT || 0);
  const standings = all.slice().sort((a, b) => (room.mode === 'br' ? brRank(b) - brRank(a) : 0) || (room.mode === 'gungame' ? (b.gg || 0) - (a.gg || 0) : 0) || b.kills - a.kills || a.deaths - b.deaths)
    .map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, assists: p.assists || 0, team: p.team }));
  let winTeam = null; const winners = new Set();
  if (isCoop(room)) {
    if (reason === 'won') all.forEach(p => winners.add(p.id));
  } else if (isTeams(room)) {
    const [a, b] = room.teamScores; winTeam = a === b ? -1 : (a > b ? 0 : 1);
    if (winTeam >= 0) all.filter(p => p.team === winTeam).forEach(p => winners.add(p.id));
  } else if (room.mode === 'br') { if (standings[0] && !room.players.get(standings[0].id)?.dead) winners.add(standings[0].id); }
  else if (standings[0] && standings[0].kills > 0) winners.add(standings[0].id);
  room.koth = null; room.ctf = null;
  const place = {};
  if (all.length >= PLACE_MIN_PLAYERS) standings.slice(0, 3).forEach((q, i) => { if (q.kills > 0) place[q.id] = PLACE_BONUS[i]; });
  broadcast(room, { t: 'end', reason, standings, mode: room.mode, teamScores: room.teamScores, winTeam, winners: [...winners], place, players: all.length, wave: room.sim ? room.sim.S.wave : 0 });
  room.sim = null;
  // leaderboard
  for (const p of all) {
    const key = p.name.toLowerCase(), e = leaderboard.get(key) || { name: p.name, kills: 0, wins: 0, matches: 0 };
    e.name = p.name; e.kills += p.kills; e.matches++; if (winners.has(p.id)) e.wins++;
    leaderboard.set(key, e);
  }
  recordMatchForAccounts(room, winners, standings).then(() => setTimeout(refreshLB, 1500));
  broadcastAll({ t: 'lb', top: lbTop(), ranked: rankedCache });
  sendRoom(room);
}
const lbTop = () => lbCache && lbCache.length ? lbCache : [...leaderboard.values()].sort((a, b) => b.wins - a.wins || b.kills - a.kills).slice(0, 10);

function applyDamage(room, attacker, target, dmg, head, w) {
  if (target.devGod) return;
  target.hp -= dmg; target.dmgBy.set(attacker.id, Date.now());
  if (target.hp <= 0) {
    target.hp = 0; target.dead = true; target.diedAt = Date.now(); target.deaths++;
    if (room.br) { target.out = true; target.placeT = Date.now(); }
    attacker.kills++; attacker.hp = Math.min(attacker.maxHp || 100, attacker.hp + 25);
    if (isTeams(room) && room.mode === 'tdm') room.teamScores[attacker.team]++;
    if (room.mode === 'gungame') {
      attacker.gg = (attacker.gg || 0) + 1;
      if (w === 11 && target.gg > 0) target.gg--;   // a Scythe kill knocks the victim back one gun
      broadcast(room, { t: 'gg', id: attacker.id, tier: attacker.gg, vid: target.id, vtier: target.gg || 0 });
    }
    const as = [];  // assists: anyone else who hurt the victim in the last 10 seconds
    for (const [id, t] of target.dmgBy) { const q = room.players.get(id); if (q && id !== attacker.id && Date.now() - t < 10000) { q.assists = (q.assists || 0) + 1; as.push(id); } }
    target.dmgBy.clear();
    broadcast(room, { t: 'kill', k: attacker.id, v: target.id, head: !!head, w, ts: room.teamScores, as });
    broadcast(room, { t: 'hp', id: attacker.id, hp: attacker.hp });
    const lim = limitOf(room);
    if (room.mode === 'gungame') { if (attacker.gg >= GG_LIST.length) endMatch(room, 'gungame'); }
    else if (room.mode === 'tdm') { if (room.teamScores[attacker.team] >= lim) endMatch(room, 'kills'); }
    else if (!isTeams(room) && lim && attacker.kills >= lim) endMatch(room, 'kills');
  } else broadcast(room, { t: 'hp', id: target.id, hp: Math.round(target.hp), by: attacker.id, w });
}
const weaponAllowed = (room, w, p) => {
  if (room.mode === 'br') return w === 14 || w === 15 || (p && Array.isArray(p.inv) && p.inv.includes(w));
  if (room.mode === 'gungame') return p && w === GG_LIST[Math.min(GG_LIST.length - 1, p.gg || 0)];
  const list = MODES[room.mode].weapons; return !list || list.includes(w);
};
/* ================= V1.5 objective modes: Gun Game, King of the Hill, Capture the Flag ================= */
const GG_LIST = [0, 8, 1, 2, 5, 7, 3, 9, 4, 11];   // AR, AK, SMG, Shotgun, Burst, Revolver, Sniper, Minigun, Handgun, Scythe
const KOTH_SPOTS = [[0, 0], [18, -14], [-18, 14], [-16, -18], [16, 18], [0, 22], [0, -22]];
const KOTH_MOVE = 40, KOTH_R = 6;
const FLAG_HOME = [[0, 30], [0, -30]];   // Red base (team 0) and Blue base (team 1)
function startObjectives(room) {
  room.koth = null; room.ctf = null; room.objT = 0;
  if (room.mode === 'koth') {
    const s = KOTH_SPOTS[0];
    room.koth = { i: 0, x: s[0], z: s[1], t: KOTH_MOVE, owner: -1, pts: [0, 0] };
  }
  if (room.mode === 'ctf') {
    room.ctf = { flags: FLAG_HOME.map((h, team) => ({ team, x: h[0], z: h[1], carrier: 0, home: true, dropT: 0 })) };
  }
  for (const p of room.players.values()) { p.gg = 0; if (room.br) p.maxHp = BR_HP; }
}
function tickObjectives(room, dt) {
  const ps = [...room.players.values()];
  if (room.koth) {
    const k = room.koth;
    k.t -= dt;
    if (k.t <= 0) { k.i = (k.i + 1) % KOTH_SPOTS.length; [k.x, k.z] = KOTH_SPOTS[k.i]; k.t = KOTH_MOVE; broadcast(room, { t: 'obj', ev: 'move' }); }
    const inside = [0, 0];
    for (const p of ps) if (!p.dead && Math.hypot(p.x - k.x, p.z - k.z) < KOTH_R && p.y < 6) inside[p.team]++;
    k.owner = inside[0] && inside[1] ? -2 : inside[0] ? 0 : inside[1] ? 1 : -1;   // -2 contested, -1 empty
    if (k.owner >= 0) {
      k.pts[k.owner] += dt; room.teamScores[k.owner] = Math.floor(k.pts[k.owner]);
      if (room.teamScores[k.owner] >= limitOf(room)) { endMatch(room, 'objective'); return; }
    }
  }
  if (room.ctf) {
    for (const f of room.ctf.flags) {
      if (f.carrier) {
        const c = room.players.get(f.carrier);
        if (!c || c.dead) { f.carrier = 0; f.dropT = 20; broadcast(room, { t: 'obj', ev: 'drop', team: f.team, id: c ? c.id : 0 }); }
        else { f.x = c.x; f.z = c.z; }
      } else if (!f.home) {
        f.dropT -= dt;
        if (f.dropT <= 0) { f.home = true; [f.x, f.z] = FLAG_HOME[f.team]; broadcast(room, { t: 'obj', ev: 'return', team: f.team, id: 0 }); }
      }
    }
    for (const p of ps) {
      if (p.dead) continue;
      for (const f of room.ctf.flags) {
        if (f.carrier || Math.hypot(p.x - f.x, p.z - f.z) > 1.8 || p.y > 4) continue;
        if (p.team !== f.team) { f.carrier = p.id; f.home = false; broadcast(room, { t: 'obj', ev: 'take', team: f.team, id: p.id }); }
        else if (!f.home) { f.home = true; [f.x, f.z] = FLAG_HOME[f.team]; broadcast(room, { t: 'obj', ev: 'return', team: f.team, id: p.id }); }
      }
      const enemy = room.ctf.flags[1 - p.team], mine = room.ctf.flags[p.team], home = FLAG_HOME[p.team];
      if (enemy.carrier === p.id && mine.home && Math.hypot(p.x - home[0], p.z - home[1]) < 2.5) {
        enemy.carrier = 0; enemy.home = true; [enemy.x, enemy.z] = FLAG_HOME[enemy.team];
        room.teamScores[p.team]++; p.caps = (p.caps || 0) + 1;
        broadcast(room, { t: 'obj', ev: 'cap', team: p.team, id: p.id, ts: room.teamScores });
        if (room.teamScores[p.team] >= limitOf(room)) { endMatch(room, 'objective'); return; }
      }
    }
  }
  room.objT = (room.objT || 0) + dt;
  if (room.objT >= .2 && (room.koth || room.ctf || room.br)) {
    room.objT = 0;
    const s = { t: 'obj', ts: room.teamScores };
    if (room.br) { const b = room.br; s.br = [r2(b.cx), r2(b.cz), r2(b.r), r2(b.wait > 0 ? b.tx || b.cx : b.tx), r2(b.wait > 0 ? b.tz || b.cz : b.tz), r2(b.wait > 0 ? b.toR : b.toR), Math.ceil(b.wait > 0 ? b.wait : b.shrink), b.wait > 0 ? 0 : 1, b.alive || 0, b.phase]; }
    if (room.koth) s.koth = [r2(room.koth.x), r2(room.koth.z), KOTH_R, Math.ceil(room.koth.t), room.koth.owner];
    if (room.ctf) s.ctf = room.ctf.flags.map(f => [r2(f.x), r2(f.z), f.carrier, f.home ? 1 : 0]);
    broadcast(room, s);
  }
}


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
    if (room.sim) {
      room.sim.update(0.05);
      if (room.sim && (room.zsnapT = (room.zsnapT + 1) % 2) === 0) broadcast(room, { t: 'zs', s: room.sim.snapshot() });
    } else {
      tickObjectives(room, 0.05); tickBR(room, 0.05);
      if (room.state === 'playing' && Date.now() >= room.endsAt) endMatch(room, 'time');
    }
  }
}, 50);
setInterval(() => broadcastAll({ t: 'online', n: players.size }), 5000);
/* ===== The shared hub: everyone on the main menu walks around together ===== */
const HUB_TIMEOUT = 2500;
const inHub = (p) => p.hub && Date.now() - p.hub.t < HUB_TIMEOUT && !(p.room && p.room.state === 'playing');
setInterval(() => {
  const here = [...players.values()].filter(inHub);
  if (!here.length) return;
  const list = here.map(p => [p.id, p.name, p.hub.x, p.hub.y, p.hub.z, p.hub.f, p.color || 0, p.hat || 'none', p.rank && p.account ? p.rank : '', p.hub.g || 'ar', p.gunSkin || 'classic']);
  const msg = JSON.stringify({ t: 'hub', list });
  for (const p of here) if (p.ws.readyState === 1) p.ws.send(msg);
}, 120);

/* ================= messages ================= */
function handle(p, m) {
  const room = p.room, now = Date.now();
  const playing = room && room.state === 'playing';
  switch (m.t) {
    case 'hello':
      p.name = p.account ? p.account.username : cleanName(m.name);
      if (!p.account && /^[A-Z0-9]{8}$/.test(String(m.uid || ''))) { if (p.uid && byUid.get(p.uid) === p) byUid.delete(p.uid); p.uid = String(m.uid); byUid.set(p.uid, p); }
      p.dev = !!(p.account && p.account.dev);   // a developer account stays dev on every device
      if (p.dev) { /* signed in as the dev account */ }
      else if (p.name.toLowerCase() === DEV_NAME) {
        if (DEV_KEY && m.devKey === DEV_KEY) { p.dev = true; send(p, { t: 'devok' }); }
        else { p.name = 'Player' + p.id; send(p, { t: 'err', text: 'That name is reserved.' }); }
      }
      p.devGod = p.dev && !!m.god; p.color = int(m.color, 0, 7);
      p.hat = HATS.includes(m.hat) ? m.hat : 'none'; p.effect = EFFECTS.includes(m.effect) ? m.effect : 'sparks';
      p.gunSkin = GUN_SKINS.includes(m.gunSkin) ? m.gunSkin : 'classic';
      p.level = int(m.level, 1, 999) || 1; p.rank = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'champion'].includes(m.rank) ? m.rank : 'bronze';
      p.mythic = {};
      if (m.mythic && typeof m.mythic === 'object') for (const [w, id] of Object.entries(m.mythic).slice(0, 20)) if (MYTHICS[id] === w) p.mythic[w] = id;
      if (p.room) sendRoom(p.room);
      break;
    case 'quick': {
      const ranked = !!m.ranked; let best = null;
      if (ranked && !p.account) return send(p, { t: 'err', text: 'Log in to play Ranked. Your rank is saved to your account.' });
      for (const r of rooms.values()) if (!r.isPrivate && !!r.ranked === ranked && r.players.size < MAX_PLAYERS && (!best || r.players.size > best.players.size)) best = r;
      if (!best) { best = createRoom(false); best.ranked = ranked; }
      joinRoom(p, best); break;
    }
    case 'turkey': { // Turkey Launcher: your turkey bodyguard is out for 8 seconds
      if (!playing || p.dead || isCoop(room) && false || now - (p.lastTurkey || 0) < 2000 || !Array.isArray(m.p)) return;
      p.lastTurkey = now; p.turkeyUntil = now + 8500;
      broadcast(room, { t: 'turkey', id: p.id, p: m.p.slice(0, 3).map(v => num(v, -60, 60) || 0) }, p); break;
    }
    case 'emote': if (playing && !p.dead) broadcast(room, { t: 'emote', id: p.id, e: int(m.e, 0, 3) }, p); break;
    case 'create': joinRoom(p, createRoom(true)); break;
    case 'join': {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return send(p, { t: 'err', text: 'No room with that code. Check it and try again.' });
      joinRoom(p, r); break;
    }
    case 'leave': leaveRoom(p); break;
    case 'lb': send(p, { t: 'lb', top: lbTop(), ranked: rankedCache }); break;
    case 'hub': { // your position in the shared hub
      p.hub = { x: num(m.x, -12, 12) || 0, y: num(m.y, 0, 4) || 0, z: num(m.z, -66, 9) || 0, f: r2(Number(m.f) || 0), g: /^[a-z]{2,10}$/.test(String(m.g || '')) ? m.g : 'ar', t: now }; break;
    }
    case 'hubleave': p.hub = null; break;
    case 'hchat': { // hub chat: everyone on the main menu sees it
      if (!inHub(p) || now - (p.lastHubChat || 0) < 1000) return;
      const text = cleanText(m.text); if (!text) return;
      p.lastHubChat = now; const msg = JSON.stringify({ t: 'hchat', id: p.id, name: p.name, color: p.color, rank: p.account ? p.rank : '', text });
      for (const q of players.values()) if (inHub(q) && q.ws.readyState === 1) q.ws.send(msg);
      break;
    }
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
      const B = boundOf(room) + 5, x = num(m.x, -B, B), y = num(m.y, -5, 110), z = num(m.z, -B, B);
      if (x === null || y === null || z === null) return;
      p.x = x; p.y = y; p.z = z; p.yaw = num(m.yaw, -1e4, 1e4) || 0; p.pitch = num(m.pitch, -2, 2) || 0;
      p.w = int(m.w, 0, BUILD_SLOT); break;
    }
    case 'spawn': {
      if (!playing || !p.dead || (p.diedAt && now - p.diedAt < RESPAWN_DELAY)) return;
      if (room.br && (p.out || p.spawnedOnce)) return;   // Battle Royale: one life
      if (room.br) p.spawnedOnce = true;
      if (isCoop(room) && p.out) return;
      const B = boundOf(room), x = num(m.x, -B, B), y = num(m.y, 0, 110), z = num(m.z, -B, B);
      if (x === null || y === null || z === null) return;
      p.x = x; p.y = y; p.z = z; p.dead = false; p.hp = p.maxHp || 100; p.spawnAt = now; p.turkeyUntil = 0; p.dmgBy.clear();
      broadcast(room, { t: 'spawn', id: p.id, x, y, z });
      broadcast(room, { t: 'hp', id: p.id, hp: p.hp }); break;
    }
    case 'shot': {
      if (!playing || p.dead || !Array.isArray(m.a) || !Array.isArray(m.b)) return;
      const a = m.a.slice(0, 3).map(v => num(v, -300, 300) || 0);
      const b = m.b.slice(0, 9).filter(Array.isArray).map(e => e.slice(0, 3).map(v => num(v, -300, 300) || 0));
      broadcast(room, { t: 'shot', id: p.id, a, b }, p); break;
    }
    case 'zhit': { // a player hit zombies: { w, list: [{ z, dmg, head }] }
      if (!playing || !room.sim || p.dead || !Array.isArray(m.list)) return;
      const w = int(m.w, 0, WEAPONS.length - 1), spec = WEAPONS[w];
      if (now - (p.lastZ || [])[w] < spec.rate * 1000 * 0.5) return;
      (p.lastZ = p.lastZ || [])[w] = now;
      room.zdmg = room.zdmg || new Map();
      for (const h of m.list.slice(0, 12)) {
        const zid = int(h && h.z, 0, 1e9);
        const res = room.sim && room.sim.damage(zid, num(h.dmg, 0, spec.max) || 0);
        if (!res) continue;
        let set = room.zdmg.get(zid); if (!set) { set = new Set(); room.zdmg.set(zid, set); } set.add(p.id);
        if (res.killed) {
          p.kills++;
          const as = [...set].filter(id => id !== p.id && room.players.has(id)); as.forEach(id => { const q = room.players.get(id); q.assists = (q.assists || 0) + 1; });
          room.zdmg.delete(zid);
          broadcast(room, { t: 'zkill', z: zid, k: p.id, type: res.type, head: !!h.head, as, w });
        }
      }
      break;
    }
    case 'heal': { // green ammo crates give +5 HP
      if (!playing || p.dead || now - (p.lastHeal || 0) < 4000) return;
      p.lastHeal = now; p.hp = Math.min(p.maxHp || 100, p.hp + 5); broadcast(room, { t: 'hp', id: p.id, hp: Math.round(p.hp) }); break;
    }
    case 'dev': if (p.dev) p.devGod = !!m.god; break;
    case 'gift': { // developer only: send Clash Crystals to a friend
      if (!p.dev) return;
      const q = byUid.get(String(m.code)), amount = int(m.amount, 1, 100000);
      if (!q) return send(p, { t: 'ferr', text: "That friend isn't online right now." });
      giftToAccount(q, amount).then(acct => send(q, { t: 'gift', from: p.name, amount, acct })).catch(() => send(q, { t: 'gift', from: p.name, amount }));
      send(p, { t: 'fsent', name: q.name + ' (' + amount + ' crystals sent)' }); break;
    }
    case 'selfdmg': { // your own Halloween RPG blast, or a long fall
      if (!playing || p.dead || p.devGod || now - p.spawnAt < SPAWN_SHIELD) return;
      const dmg = num(m.dmg, 0, 160); if (!dmg) return;
      p.hp -= dmg;
      if (p.hp <= 0) {
        if (isCoop(room)) zombieDeath(room, p, m.cause === 'fall' ? 'fall' : 'self');
        else { p.hp = 0; p.dead = true; p.diedAt = now; p.deaths++; broadcast(room, { t: 'kill', k: p.id, v: p.id, self: true, cause: m.cause === 'fall' ? 'fall' : 'boom', ts: room.teamScores }); }
      } else broadcast(room, { t: 'hp', id: p.id, hp: Math.round(p.hp) });
      break;
    }
    case 'pt': { // portal placed (visual for others)
      if (!playing || p.dead || !Array.isArray(m.p) || !Array.isArray(m.n)) return;
      broadcast(room, { t: 'pt', id: p.id, i: int(m.i, 0, 1), p: m.p.slice(0, 3).map(v => num(v, -300, 300) || 0), n: m.n.slice(0, 3).map(v => num(v, -1, 1) || 0) }, p); break;
    }
    case 'loot': { // Battle Royale pickup: { id, slot }
      if (!playing || !room.br || p.dead) return;
      const i = room.br.loot.findIndex(l => l.id === m.id); if (i < 0) return;
      const l = room.br.loot[i]; if (Math.hypot(l.x - p.x, l.z - p.z) > 3.5) return;
      room.br.loot.splice(i, 1);
      if (l.w === 'hp') { p.hp = Math.min(p.maxHp || 100, p.hp + 100); broadcast(room, { t: 'hp', id: p.id, hp: Math.round(p.hp) }); }
      else { if (p.inv.length < 4) p.inv.push(l.w); else p.inv[int(m.slot, 0, 3)] = l.w; }
      send(p, { t: 'lootget', w: l.w }); broadcast(room, { t: 'lootgone', id: l.id, by: p.id }); break;
    }
    case 'cmap': { // the host of a private room picks a custom map made in the Map Editor
      if (!room || !room.isPrivate || room.hostId !== p.id || room.state !== 'waiting') return;
      if (!m.map) { room.customMap = null; sysChat(room, 'The host switched back to normal maps'); sendRoom(room); break; }
      const blocks = Array.isArray(m.map.blocks) ? m.map.blocks.slice(0, MAX_CUSTOM_BLOCKS).filter(Array.isArray).map(b => [num(b[0], -40, 40) || 0, num(b[1], 0, 40) || 0, num(b[2], -40, 40) || 0, num(b[3], .5, 8) || 1, num(b[4], .25, 16) || 1, num(b[5], .5, 8) || 1, int(b[6], 0, 0xffffff)]) : [];
      room.customMap = { name: cleanText(m.map.name).slice(0, 24) || 'Custom map', theme: CUSTOM_THEMES.includes(m.map.theme) ? m.map.theme : 'blockyard', blocks };
      sysChat(room, 'The host picked a custom map: ' + room.customMap.name + ' (' + blocks.length + ' blocks)'); sendRoom(room); break;
    }
    case 'signup': case 'login': case 'resume': case 'logout': case 'save': case 'earn': case 'buy': case 'unlock':
      accountMsg(p, m).catch(e => { console.error('account', e.message); send(p, { t: 'autherr', text: 'Something went wrong. Try again.' }); }); break;
    case 'fstatus': if (Array.isArray(m.codes)) send(p, { t: 'fstatus', list: m.codes.slice(0, 50).map(c => friendStatus(String(c))) }); break;
    case 'freq': { const q = byUid.get(String(m.code)); if (!q || q === p) return send(p, { t: 'ferr', text: "That player isn't online right now. Friend requests only work while both of you are online." }); send(q, { t: 'freq', from: p.uid, name: p.name }); send(p, { t: 'fsent', name: q.name }); break; }
    case 'facc': { const q = byUid.get(String(m.code)); if (q) send(q, { t: 'facc', from: p.uid, name: p.name }); break; }
    case 'finvite': { const q = byUid.get(String(m.code)); if (q && room) send(q, { t: 'finvite', from: p.uid, name: p.name, room: room.code }); break; }
    case 'fjoin': {
      const q = byUid.get(String(m.code));
      if (!q || !q.room) return send(p, { t: 'ferr', text: 'Your friend is not in a lobby right now.' });
      if (q.room.ranked) return send(p, { t: 'ferr', text: "Your friend is in a Ranked match. You can't join that one." });
      joinRoom(p, q.room); break;
    }
    case 'mine': { // a land mine was placed (others see it)
      if (!playing || p.dead || !Array.isArray(m.p) || now - (p.lastMine || 0) < 600) return;
      p.lastMine = now;
      broadcast(room, { t: 'mine', id: p.id, mid: int(m.mid, 0, 1e9), p: m.p.slice(0, 3).map(v => num(v, -60, 80) || 0) }, p); break;
    }
    case 'mineboom': if (playing) broadcast(room, { t: 'mineboom', mid: int(m.mid, 0, 1e9) }, p); break;
    case 'gr': {
      if (!playing || p.dead || !Array.isArray(m.a) || !Array.isArray(m.v) || now - (p.lastNade || 0) < 700) return;
      p.lastNade = now;
      broadcast(room, { t: 'gr', id: p.id, a: m.a.slice(0, 3).map(v => num(v, -300, 300) || 0), v: m.v.slice(0, 3).map(v => num(v, -60, 60) || 0) }, p); break;
    }
    case 'rk': {
      if (!playing || p.dead || !Array.isArray(m.a) || !Array.isArray(m.v)) return;
      broadcast(room, { t: 'rk', id: p.id, k: m.k === 'p' || m.k === 't' ? m.k : 'r', a: m.a.slice(0, 3).map(v => num(v, -300, 300) || 0), v: m.v.slice(0, 3).map(v => num(v, -100, 100) || 0) }, p); break;
    }
    case 'hit': { // one message per shot, listing every player it hit
      if (!playing || p.dead || !Array.isArray(m.list)) return;
      const w = int(m.w, 0, WEAPONS.length - 1), spec = WEAPONS[w];
      if (isCoop(room) || !weaponAllowed(room, w, p) || now - p.lastShot[w] < spec.rate * 1000 * 0.5) return;
      p.lastShot[w] = now;
      for (const h of m.list.slice(0, 8)) {
        if (room.state !== 'playing') break;
        const target = room.players.get(h && h.id);
        if (!target || target === p || target.dead || now - target.spawnAt < SPAWN_SHIELD) continue;
        if (isTeams(room) && target.team === p.team) continue;
        let dmg = num(h.dmg, 0, spec.max);
        if (target.turkeyUntil > now) dmg *= 0.75;   // a turkey bodyguard soaks up 25% of the damage
        if (w === 13 && !(p.turkeyUntil > now - 500)) dmg = 0;   // pecks only count while your turkey is out
        if (dmg) applyDamage(room, p, target, dmg, h.head, w);
      }
      break;
    }
    case 'build': {
      if (!playing || p.dead || isCoop(room) || now - (p.lastBuild || 0) < 90 || room.structs.size > 800) return;
      const kind = m.kind; if (!(kind in PIECES)) return;
      const B = boundOf(room), x = num(m.x, -B, B), z = num(m.z, -B, B), level = num(m.level, 0, 40);
      const dx = Math.sign(num(m.dx, -1, 1) || 0), dz = Math.sign(num(m.dz, -1, 1) || 0);
      if (x === null || z === null || level === null || level % 4 !== 0 || Math.abs(dx) + Math.abs(dz) !== 1) return;
      const key = kind[0] + x + ',' + z + ',' + level;
      if (room.structs.has(key)) return;
      p.lastBuild = now;
      const s = { key, kind, x, z, level, dir: { x: dx, z: dz }, hp: PIECES[kind], grounded: !!m.grounded };
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
        if (s.hp <= 0) {
          room.structs.delete(s.key); broadcast(room, { t: 'sgone', key: s.key });
          const fell = collapseStructs(room); if (fell.length) broadcast(room, { t: 'collapse', keys: fell, from: s.key });
        }
        else broadcast(room, { t: 'shp', key: s.key, hp: Math.round(s.hp) });
      }
      break;
    }
  }
}

wss.on('connection', (ws) => {
  const p = { id: nextId++, ws, name: 'Player', color: 0, hat: 'none', effect: 'sparks', gunSkin: 'classic', mythic: {}, team: 0, room: null, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, w: 0 };
  resetPlayer(p); players.set(p.id, p);
  send(p, { t: 'welcome', accounts: !!accounts, id: p.id, online: players.size });
  send(p, { t: 'lb', top: lbTop(), ranked: rankedCache });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m && typeof m.t === 'string') { try { handle(p, m); } catch (e) { console.error(e); } }
  });
  ws.on('close', () => { leaveRoom(p); players.delete(p.id); if (p.uid && byUid.get(p.uid) === p) byUid.delete(p.uid); });
});

const PORT = process.env.PORT || 3000;
initDB();
server.listen(PORT, () => console.log('Arena Clash server running on port ' + PORT));
