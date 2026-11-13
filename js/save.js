// js/save.js: saving. save.txt (written by the local server) + browser storage (fallback).
//
// A web page can't write to disk directly, so:
//   running locally (start.command): POST /save -> server.py writes save.txt in the game folder
//   static hosting like itch.io: no /save to write to -> browser storage only, the game works the same
// A copy is always written to browser storage as a backup.
//
// save.txt is indented JSON: human-readable, easy to back up, and you can send it to a friend to share your planes.

import { deserialize, cloneBP } from './blueprint.js';

const FILE = 'save.txt';
const POST_URL = 'save';
const LS_KEY = 'skybreak_save';
const LEGACY_BEST = 'skybreak_best';           // the two keys from older versions, migrated when found
const LEGACY_BP = 'skybreak_blueprint';
export const MAX_PLANES = 30;
export const RECENT = 20;
export const RECENT_MIN_TIME = 30;
export const CAUSE = { 'ENEMY FIRE': 'enemy fire', TERRAIN: 'the ground', BUILDING: 'a building', TREE: 'a tree', COLLISION: 'a collision', DRONE: 'a kamikaze drone' };
export const fmtTime = t => (t >= 60 ? `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s` : `${t}s`);   // runs shorter than this (seconds) are throwaway test crashes, not kept in `recent`

const blank = () => ({
  version: 1,
  bestScore: 0,
  bestWave: 0,
  runs: 0,
  totalKills: 0,
  lastPlane: null,        // the plane last edited in the hangar
  planes: [],             // planes the player saved [{name, parts:[[type,x,y,z]...]}]
  byPlane: {},            // per-plane results { name: {runs, bestWave, bestScore} }, used to judge which planes are strong
  tutorialDone: false,    // finished or skipped the first-flight training
  hangarTipsDone: false,  // saw (or skipped) the one-time hangar tips
  installTipDone: false,  // phones: saw the "add to Home Screen" steps once
  controls: { mode: 'stick', invertY: false },   // touch controls: 'stick' or 'tilt'
  creative: false,        // hangar Creative mode (no load limit; planes over the budget go on the Creative board only)
  lb: null,               // online leaderboard identity { id, token, callsign }, see leaderboard.js
  recent: [],             // the last RECENT runs: { plane, parts, wave, score, build, time, acc, cause, dmg:{fire,ram,drone,terrain} }
  ladderLevel: 0,         // AI Ladder: the highest level cleared on this device
  planeTests: {},         // AI Test results by plane layout { key: { v, wave, waveGrade, share, duelGrade, at } }, at most MAX_TESTS
  quality: 'auto',        // graphics: 'auto' | 'high' | 'low' (quality.js)
  sound: true,            // sound on / off (sound.js)
  qualityAuto: null,      // what Auto settled on for this device: null (not measured too slow yet) | 'low'
});
const MAX_TESTS = 40;
const GRADE_RE = /^(F|D|C|B|A|S|SS|SSS)$/;

const toSaved = bp => ({ name: bp.name, parts: bp.parts.map(p => [p.type, p.x, p.y, p.z]) });
const fromSaved = o => deserialize(JSON.stringify({ v: 1, name: o && o.name, parts: o && o.parts }));
const num = v => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

const str = v => (typeof v === 'string' ? v.slice(0, 40) : '');
const int = v => (Number.isInteger(v) ? v : 0);
const cleanParts = a => (Array.isArray(a) ? a : [])
  .filter(p => Array.isArray(p) && typeof p[0] === 'string')
  .slice(0, 200)
  .map(p => [p[0].slice(0, 12), int(p[1]), int(p[2]), int(p[3])]);
const cleanRun = r => {
  const g = r.dmg && typeof r.dmg === 'object' ? r.dmg : {};
  return {
    plane: str(r.plane), map: str(r.map), parts: cleanParts(r.parts), wave: num(r.wave), score: num(r.score), build: str(r.build),
    time: num(r.time), acc: num(r.acc), cause: str(r.cause),
    dmg: { fire: num(g.fire), ram: num(g.ram), drone: num(g.drone), terrain: num(g.terrain) },
  };
};

// everything read in is untrusted: drop anything with the wrong type, so a bad save can't lock up the game
function sanitize(o) {
  const d = blank();
  if (!o || typeof o !== 'object') return d;
  d.bestScore = num(o.bestScore);
  d.bestWave = num(o.bestWave);
  d.runs = num(o.runs);
  d.totalKills = num(o.totalKills);
  d.tutorialDone = o.tutorialDone === true;
  d.hangarTipsDone = o.hangarTipsDone === true;
  d.installTipDone = o.installTipDone === true;
  d.creative = o.creative === true;
  if (o.controls && typeof o.controls === 'object') {
    d.controls = { mode: o.controls.mode === 'tilt' ? 'tilt' : 'stick', invertY: o.controls.invertY === true };
  }
  if (o.lb && Number.isInteger(o.lb.id) && o.lb.id > 0 && typeof o.lb.token === 'string' && /^[0-9a-f]{16,100}$/.test(o.lb.token)) {
    d.lb = { id: o.lb.id, token: o.lb.token, callsign: str(o.lb.callsign), locked: o.lb.locked === true };
  }
  if (Array.isArray(o.recent)) d.recent = o.recent.filter(r => r && typeof r === 'object').map(cleanRun).slice(-RECENT);
  if (o.lastPlane && Array.isArray(o.lastPlane.parts)) d.lastPlane = o.lastPlane;
  if (Array.isArray(o.planes)) {
    d.planes = o.planes
      .filter(p => p && typeof p.name === 'string' && Array.isArray(p.parts))
      .slice(0, MAX_PLANES);
  }
  d.ladderLevel = num(o.ladderLevel);
  d.quality = ['high', 'low'].includes(o.quality) ? o.quality : 'auto';
  d.sound = o.sound !== false;
  d.qualityAuto = o.qualityAuto === 'low' ? 'low' : null;
  if (o.planeTests && typeof o.planeTests === 'object') {
    for (const [k, v] of Object.entries(o.planeTests).slice(-MAX_TESTS)) {
      if (/^[0-9a-f]{8}$/.test(k) && v && GRADE_RE.test(v.waveGrade) && GRADE_RE.test(v.duelGrade)) {
        d.planeTests[k] = { v: num(v.v), wave: Number(v.wave) || 0, waveGrade: v.waveGrade, share: Number(v.share) || 0, duelGrade: v.duelGrade, at: num(v.at) };
      }
    }
  }
  if (o.byPlane && typeof o.byPlane === 'object') {
    for (const [k, v] of Object.entries(o.byPlane)) {
      if (v && typeof v === 'object') d.byPlane[k] = { runs: num(v.runs), bestWave: num(v.bestWave), bestScore: num(v.bestScore) };
    }
  }
  return d;
}

export const Save = {
  data: blank(),
  where: 'browser',       // 'file' = written to save.txt; 'browser' = browser only
  _timer: null,
  _fetch: (...a) => globalThis.fetch(...a),

  async load() {
    let file = null, ls = null;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const r = await this._fetch(FILE, { cache: 'no-store', signal: ctl.signal });
      clearTimeout(t);
      // Only trust save.txt when it comes from our own server.py (it sends X-Skybreak-Server: 1).
      // On a static host a save.txt uploaded by mistake would otherwise override every visitor's progress.
      const ours = r.headers && typeof r.headers.get === 'function' && r.headers.get('X-Skybreak-Server') === '1';
      if (r.ok && ours) file = JSON.parse(await r.text());
    } catch { /* no file / no server: the normal case */ }
    try { const s = localStorage.getItem(LS_KEY); if (s) ls = JSON.parse(s); } catch {}

    // the file wins; browser storage fills gaps; best score is the max across all sources (a high score is never lost)
    const a = sanitize(ls), b = sanitize(file);
    const d = file ? b : a;
    d.bestScore = Math.max(a.bestScore, b.bestScore);
    d.bestWave = Math.max(a.bestWave, b.bestWave);
    d.tutorialDone = a.tutorialDone || b.tutorialDone;
    d.hangarTipsDone = a.hangarTipsDone || b.hangarTipsDone;
    d.installTipDone = a.installTipDone || b.installTipDone;
    d.lb = d.lb || a.lb || b.lb;

    // migrate keys from older versions
    try {
      d.bestScore = Math.max(d.bestScore, num(Number(localStorage.getItem(LEGACY_BEST))));
      const old = localStorage.getItem(LEGACY_BP);
      if (!d.lastPlane && old) d.lastPlane = toSaved(deserialize(old));
    } catch {}

    this.data = d;
    this.where = file ? 'file' : 'browser';
    return d;
  },

  // debounced writes: clicking to place parts rapidly in the hangar doesn't write the file every time
  commit(delay = 300) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.write(), delay);
  },

  async write() {
    const json = JSON.stringify(this.data);
    try { localStorage.setItem(LS_KEY, json); } catch {}
    try {
      const r = await this._fetch(POST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Skybreak': '1' },
        body: json,
      });
      this.where = r.ok ? 'file' : 'browser';
    } catch {
      this.where = 'browser';
    }
    if (this.onStatus) this.onStatus(this.where);
    return this.where;
  },

  setCreative(on) { this.data.creative = !!on; this.write(); },

  // online leaderboard identity; null forgets it (a new one is registered next time)
  setLeaderboard(lb) {
    this.data.lb = lb ? { id: lb.id, token: lb.token, callsign: lb.callsign, locked: lb.locked === true } : null;
    this.write();
  },

  // AI Test results, by plane layout (see planetest.js); the oldest go once there are more than MAX_TESTS
  setPlaneTest(key, r) {
    this.data.planeTests[key] = r;
    const keys = Object.keys(this.data.planeTests);
    if (keys.length > MAX_TESTS) {
      keys.sort((x, y) => this.data.planeTests[x].at - this.data.planeTests[y].at);
      for (const k of keys.slice(0, keys.length - MAX_TESTS)) delete this.data.planeTests[k];
    }
    this.write();
  },

  // AI Ladder: the highest level cleared (the server's record wins when there is one)
  setLadder(level) { this.data.ladderLevel = Math.max(0, Math.floor(level) || 0); this.write(); },

  // one-way flags such as tutorialDone; written right away
  setFlag(name) {
    if (this.data[name] === true) return;
    this.data[name] = true;
    this.write();
  },

  /* ---------- Run results ---------- */
  recordRun({ score, wave, kills, plane, detail = {} }) {
    const d = this.data;
    const newBest = score > d.bestScore;
    d.runs++;
    d.totalKills += num(kills);
    d.bestScore = Math.max(d.bestScore, num(score));
    d.bestWave = Math.max(d.bestWave, num(wave));
    if (plane) {
      const s = d.byPlane[plane] || (d.byPlane[plane] = { runs: 0, bestWave: 0, bestScore: 0 });
      s.runs++;
      s.bestWave = Math.max(s.bestWave, num(wave));
      s.bestScore = Math.max(s.bestScore, num(score));
    }
    if (!Array.isArray(d.recent)) d.recent = [];
    const tooShort = Number.isFinite(detail.time) && detail.time < RECENT_MIN_TIME;
    if (!tooShort) {
      d.recent.push(cleanRun({ ...detail, plane, wave, score }));
      if (d.recent.length > RECENT) d.recent.splice(0, d.recent.length - RECENT);
    }
    this.write();                       // written immediately when a run ends, no debounce
    return { newBest };
  },

  planeRecord(name) { return this.data.byPlane[name] || null; },

  // Recent runs with a layout id per distinct plane layout (P1, P2...), for the stats view and the copied text
  statsData() {
    const d = this.data;
    const layouts = [];
    const runs = (d.recent || []).map((r, i) => {
      const key = JSON.stringify(r.parts || []);
      let id = layouts.findIndex(l => l.key === key);
      if (id < 0) { layouts.push({ key, name: r.plane, parts: r.parts || [] }); id = layouts.length - 1; }
      return { ...r, n: i + 1, layout: id + 1 };
    });
    const planes = Object.entries(d.byPlane).map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.bestWave - a.bestWave || b.runs - a.runs);
    return { bestScore: d.bestScore, bestWave: d.bestWave, runs: d.runs, recent: runs, planes, layouts };
  },

  // Plain text for pasting into a chat: two short lines per run, readable without any table formatting
  statsText(build = '') {
    const s = this.statsData();
    const L = [];
    L.push(`Skybreak Protocol stats${build ? ` · build ${build}` : ''}`);
    L.push(`Best score ${s.bestScore} · best wave ${s.bestWave} · ${s.runs} runs`);
    L.push('');
    L.push(`Recent runs, oldest first (${s.recent.length}; runs under ${RECENT_MIN_TIME} s are left out)`);
    if (!s.recent.length) L.push('  none yet');
    for (const r of s.recent) {
      const g = r.dmg || {};
      L.push(`#${r.n} ${r.plane} [P${r.layout}]${r.map ? ` · ${r.map}` : ''} · wave ${r.wave} · ${r.score} pts · ${fmtTime(r.time)} · accuracy ${r.acc}% · died to ${CAUSE[r.cause] || 'enemy fire'}${r.build ? ` · ${r.build}` : ''}`);
      L.push(`    damage taken: enemy fire ${g.fire} · collisions ${g.ram} · drones ${g.drone} · terrain ${g.terrain}`);
    }
    L.push('');
    L.push('Per plane: ' + (s.planes.map(p => `${p.name} ${p.runs} run${p.runs === 1 ? '' : 's'} (best wave ${p.bestWave})`).join(' · ') || 'none'));
    if (s.layouts.length) {
      L.push('');
      L.push('Layouts (part x,y,z)');
      s.layouts.forEach((l, i) => L.push(`P${i + 1} ${l.name}: ` + (l.parts.length ? l.parts.map(p => `${p[0]} ${p[1]},${p[2]},${p[3]}`).join(' · ') : 'unknown')));
    }
    return L.join('\n');
  },

  /* ---------- Planes ---------- */
  getLastPlane() { return this.data.lastPlane ? fromSaved(this.data.lastPlane) : null; },
  setLastPlane(bp) { this.data.lastPlane = toSaved(bp); this.commit(); },

  listPlanes() { return this.data.planes.map(p => ({ name: p.name, bp: fromSaved(p) })); },

  savePlane(bp, name) {
    name = String(name || '').trim().slice(0, 32);
    if (!name) return { ok: false, reason: 'Give your plane a name.' };
    const i = this.data.planes.findIndex(p => p.name === name);
    if (i < 0 && this.data.planes.length >= MAX_PLANES) return { ok: false, reason: `You can keep up to ${MAX_PLANES} planes.` };
    const entry = toSaved({ ...cloneBP(bp), name });
    if (i >= 0) this.data.planes[i] = entry; else this.data.planes.push(entry);
    this.write();
    return { ok: true, replaced: i >= 0 };
  },

  deletePlane(name) {
    const before = this.data.planes.length;
    this.data.planes = this.data.planes.filter(p => p.name !== name);
    if (this.data.planes.length !== before) this.write();
    return this.data.planes.length !== before;
  },
};
