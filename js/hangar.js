// js/hangar.js: the hangar, where you build planes
// View: drag to rotate / wheel to zoom / left-click to place / right-click to remove / mirror mode.
// All the rules live in parts.js / blueprint.js / spec.js (pure functions, tested).
// This file only handles visuals and input and makes no numeric decisions, so there is one source of truth for the rules.

import { View } from './view.js';
import { planeLink, planeToCode, codeToPlane, partsTextToCode } from './share.js';
import * as THREE from 'three';
import { CELL, PARTS, PLACEABLE, computeStats, validate, connectedSet, cellKey, CREATIVE_MAX_PARTS } from './parts.js';
import { DEFAULT_BLUEPRINT, PRESETS, cloneBP, canPlace, place, remove, cleared, randomPreset } from './blueprint.js';
import { Save, CAUSE, fmtTime } from './save.js';
import { specFromStats } from './spec.js';
import { buildBlueprintMesh } from './partMesh.js';
import { pickCell } from './pick.js';
import { CFG } from './config.js';
import { Leaderboard } from './leaderboard.js';
import { BIOMES, BIOME_KEYS } from './terrain.js';
import { mapForDay, randomMap, mapLabel, dayString } from './maps.js';
import { testPlane, duelSeries, sliced, mulberry32, planeKey, TEST_VERSION } from './planetest.js';

const hex = c => '#' + c.toString(16).padStart(6, '0');

/* ---------- Stats view (Copy stats) ---------- */
const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DMG = [['fire', 'Enemy fire', '#ff6a5a'], ['ram', 'Collisions', '#ffb35a'], ['drone', 'Drones', '#c77dff'], ['terrain', 'Terrain', '#8bd46a']];

export function runsHtml(s) {
  const head = `<div class="rsCards">
      <div><b>${s.bestScore}</b><span>best score</span></div>
      <div><b>${s.bestWave}</b><span>best wave</span></div>
      <div><b>${s.runs}</b><span>runs</span></div>
    </div>`;
  if (!s.recent.length) return head + '<div class="rsEmpty">No runs yet. Every run longer than 30 seconds shows up here.</div>';
  const legend = '<div class="rsLegend">' + DMG.map(([, label, c]) => `<span><i style="background:${c}"></i>${label}</span>`).join('') + '</div>';
  const rows = s.recent.slice().reverse().map(r => {
    const g = r.dmg || {};
    const tot = DMG.reduce((a, [k]) => a + (g[k] || 0), 0) || 1;
    const bar = DMG.map(([k, label, c]) => (g[k] ? `<i style="width:${(g[k] / tot * 100).toFixed(1)}%;background:${c}" title="${label} ${g[k]}"></i>` : '')).join('');
    return `<tr><td class="rsN">${r.n}</td><td>${esc(r.plane)} <span class="rsP">P${r.layout}</span></td><td class="rsNum">${r.wave}</td>
      <td class="rsNum">${r.score}</td><td class="rsNum">${fmtTime(r.time)}</td><td class="rsNum">${r.acc}%</td>
      <td>${esc(CAUSE[r.cause] || 'enemy fire')}</td><td><div class="rsBar">${bar}</div></td></tr>`;
  }).join('');
  const planes = s.planes.map(p => `<span class="rsChip">${esc(p.name)} <b>wave ${p.bestWave}</b> <em>${p.runs} run${p.runs === 1 ? '' : 's'}</em></span>`).join('');
  return head + `<table class="rsTable"><thead><tr><th>#</th><th>Plane</th><th>Wave</th><th>Score</th><th>Time</th><th>Acc</th><th>Died to</th><th>Damage taken</th></tr></thead>
    <tbody>${rows}</tbody></table>${legend}<div class="hgHead" style="margin-top:12px">BEST WAVE PER PLANE</div><div class="rsChips">${planes}</div>`;
}

/* ---------- Online leaderboard view ---------- */
const fmtDay = day => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtDate = ms => {
  const d = new Date(ms);
  const same = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', same ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
};
// a pilot who hasn't locked in a callsign yet may still change it: say so, so nobody gets confused
// the pilot's backup code: number + secret token (the server only keeps a hash of the token)
export const backupCode = me => `SKYP-${me.id}-${me.token}`;
const pilotName = r => `${r.callsign} #${r.id}`;
const pilot = r => `${esc(r.callsign)} <span class="rsP">#${r.id}</span>` +
  (r.locked === 0 ? '<span class="rsU" title="This pilot can still change their callsign">not locked</span>' : '');
// Copy: load the plane that run was flown in (the server keeps its parts, never a name)
const copyBtn = r => (r.hp ? ` <button class="rsCopy" data-id="${Number(r.id)}" data-day="${esc(r.day || '')}" data-who="${esc(pilotName(r))}" title="Load this plane into your hangar">Copy</button>` : '');
const boardRow = (r, mine) => `<tr${mine ? ' class="rsMe"' : ''}><td class="rsN">${r.rank}</td><td>${pilot(r)}</td>
  <td class="rsNum">${r.score}</td><td class="rsNum">${r.wave}</td><td class="rsPlane">${esc(r.plane)}${copyBtn(r)}</td>
  <td class="rsNum">${fmtTime(r.time)}</td><td>${r.day ? fmtDay(r.day) : fmtDate(r.at)}</td></tr>`;
// (week / month / year rows carry the map's day, a UTC date: shown as is, so an evening run in America on the
// Oct 1 map says Oct 1 and not Sep 30, which looked like it did not belong on the October board)

// The server leaves some pilots out of everyone else's tables (see the shadow note in leaderboard/worker.js) but still
// gives them their own place in `me`: put them back into their own view of the table, where their rank says
const placeMe = (rows, me) => {
  if (!me || !me.rank || me.rank > rows.length + 1 || rows.some(r => r.id === me.id)) return rows;
  const out = rows.map(r => (r.rank >= me.rank ? { ...r, rank: r.rank + 1 } : r));
  out.splice(me.rank - 1, 0, me);
  return out;
};

// versus board: Elo rating, matches, wins
const pvpRow = (r, mine) => `<tr${mine ? ' class="rsMe"' : ''}><td class="rsN">${r.rank || '-'}</td><td>${pilot(r)}</td>
  <td class="rsNum">${r.elo}</td><td class="rsNum">${r.games}</td><td class="rsNum">${r.wins}</td></tr>`;
function pvpBoardHtml(res, myId) {
  const me = res.me;
  let you = '<div class="rsYou">Play a rated Versus match (Multiplayer, 2 to 4 pilots) to get a rating. Everyone starts at 1000.</div>';
  if (me && me.games) you = `<div class="rsYou">You are <b>${pilot(me)}</b> · rating <b>${me.elo}</b> after ${me.games} match${me.games === 1 ? '' : 'es'}` +
    (me.rank ? ` · rank <b>#${me.rank}</b> of ${res.total}` : ' · lock in your callsign to be listed') + '</div>';
  if (!res.rows.length) return you + '<div class="rsEmpty">No rated matches yet.</div>';
  let rows = placeMe(res.rows, me).map(r => pvpRow(r, r.id === myId)).join('');
  if (me && me.rank && me.rank > res.rows.length + 1) rows += `<tr class="rsGap"><td colspan="5">...</td></tr>` + pvpRow(me, true);
  return you + `<table class="rsTable"><thead><tr><th>#</th><th>Pilot</th><th>Rating</th><th>Matches</th><th>Wins</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// Creative board: best run in a plane over the normal limits, with the load it carried
const creativeRow = (r, mine) => `<tr${mine ? ' class="rsMe"' : ''}><td class="rsN">${r.rank || '-'}</td><td>${pilot(r)}</td>
  <td class="rsNum">${r.score}</td><td class="rsNum">${r.wave}</td><td class="rsNum">${r.load}</td>
  <td class="rsNum">${fmtTime(r.time)}</td><td>${r.day ? fmtDay(r.day) : fmtDate(r.at)}</td></tr>`;
function creativeBoardHtml(res, myId) {
  const me = res.me;
  let you = '<div class="rsYou">Just for fun: runs on today\'s map in a Creative plane (over the load budget of 120 or the build area). Load = how much the plane carried.</div>';
  if (me && me.score !== null) you = `<div class="rsYou">You are <b>${pilot(me)}</b> · best Creative run <b>${me.score}</b> with load ${me.load}` +
    (me.rank ? ` · rank <b>#${me.rank}</b> of ${res.total}` : ' · lock in your callsign to be listed') + '</div>';
  if (!res.rows.length) return you + '<div class="rsEmpty">No Creative runs yet.</div>';
  let rows = placeMe(res.rows, me).map(r => creativeRow(r, r.id === myId)).join('');
  if (me && me.rank && me.rank > res.rows.length + 1) rows += `<tr class="rsGap"><td colspan="7">...</td></tr>` + creativeRow(me, true);
  return you + `<table class="rsTable"><thead><tr><th>#</th><th>Pilot</th><th>Score</th><th>Wave</th><th>Load</th><th>Survived</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// AI Ladder board: the highest level each pilot has cleared
const ladderRow = (r, mine) => `<tr${mine ? ' class="rsMe"' : ''}><td class="rsN">${r.rank || '-'}</td><td>${pilot(r)}</td>
  <td class="rsNum">${r.level}</td><td class="rsNum">${fmtTime(r.time)}</td><td>${fmtDate(r.at)}</td></tr>`;
function ladderBoardHtml(res, myId) {
  const me = res.me;
  let you = '<div class="rsYou">AI Ladder (button next to Multiplayer): beat an AI pilot that gets better every level. A loss just means trying that level again.</div>';
  if (me && me.level) you = `<div class="rsYou">You are <b>${pilot(me)}</b> · cleared level <b>${me.level}</b>` +
    (me.rank ? ` · rank <b>#${me.rank}</b> of ${res.total}` : ' · lock in your callsign to be listed') +
    (me.perDay ? ` · ${Math.min(me.today || 0, me.perDay)} of ${me.perDay} levels counted today` +
      (me.today >= me.perDay ? ' (more today are practice, not ranked, until 00:00 UTC)' : '') : '') + '</div>';
  if (!res.rows.length) return you + '<div class="rsEmpty">Nobody has cleared a level yet.</div>';
  let rows = placeMe(res.rows, me).map(r => ladderRow(r, r.id === myId)).join('');
  if (me && me.rank && me.rank > res.rows.length + 1) rows += `<tr class="rsGap"><td colspan="5">...</td></tr>` + ladderRow(me, true);
  return you + `<table class="rsTable"><thead><tr><th>#</th><th>Pilot</th><th>Level</th><th>Last level took</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// res = the /top response, myId = this browser's player id (or null)
export function boardHtml(res, myId) {
  if (!res || res.error) {
    return `<div class="rsEmpty">Leaderboard offline (${esc(res ? res.error : 'no data')}). Try again later.</div>`;
  }
  if (res.board === 'pvp') return pvpBoardHtml(res, myId);
  if (res.board === 'ladder') return ladderBoardHtml(res, myId);
  if (res.board === 'creative') return creativeBoardHtml(res, myId);

  const me = res.me;
  const daily = res.board === 'daily';
  const span = res.from ? ` (${fmtDay(res.from)} to ${fmtDay(res.to)})` : '';
  const what = daily ? `today's map (${esc(res.day || '')}, UTC)`
    : res.board === 'week' ? `this week's board${span}` : res.board === 'month' ? `this month's board${span}`
    : res.board === 'year' ? `this year's board${span}` : 'the all-time board';
  let you = `<div class="rsYou">Fly a run of at least 30 seconds on today's map to get your pilot number and a place on the board.</div>`;
  if (me) {
    you = `<div class="rsYou">You are <b>${pilot(me)}</b> · ` +
      (me.rank ? `rank <b>#${me.rank}</b> of ${res.total} on ${what} with ${me.score}` : `not on ${what} yet`) +
      (me.locked === 0 ? '<br><span class="rsU" style="margin:0">Reroll your callsign as often as you like, then lock it in. Once locked it never changes.</span>' : '') +
      '</div>';
  }
  if (!res.rows.length) return you + `<div class="rsEmpty">Nobody on ${what} yet. Be the first!</div>`;
  const withDay = r => (daily && res.day ? { ...r, day: res.day } : r);       // today's board: the map's day too
  let rows = placeMe(res.rows, me).map(r => boardRow(withDay(r), r.id === myId)).join('');
  if (me && me.rank && me.rank > res.rows.length + 1) rows += `<tr class="rsGap"><td colspan="7">...</td></tr>` + boardRow(withDay(me), true);
  return you + `<table class="rsTable"><thead><tr><th>#</th><th>Pilot</th><th>Score</th><th>Wave</th><th>Plane</th><th>Survived</th><th>Date</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// Say what actually went wrong instead of always "offline"
// ('not found' = the server is an older version without that feature)
const lbError = e => (e === 'offline' ? 'Leaderboard offline'
  : e === 'not found' ? 'The leaderboard server is out of date'
  : e === 'slow down' ? 'Slow down a little'
  : e === 'callsign locked' ? 'Your callsign is locked'
  : `Leaderboard: ${e}`);

export class Hangar {
  constructor(renderer, onSortie, onTraining = null, onTest = null) {
    this.renderer = renderer;
    this.canvas = renderer.domElement;
    this.onSortie = onSortie;
    this.onTraining = onTraining;
    this.onTest = onTest;
    this.active = false;

    /* ---------- Scene ---------- */
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x121a24);
    this.camera = new THREE.PerspectiveCamera(48, (View.w || innerWidth) / (View.h || innerHeight), 1, 3000);
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x28303c, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(80, 140, 60);
    this.scene.add(key);
    const grid = new THREE.GridHelper(CELL * 26, 26, 0x3a4a60, 0x1f2a38);
    grid.position.y = -CELL * 3.5;
    this.scene.add(grid);

    // placement preview (main cell + mirrored cell)
    const boxG = new THREE.BoxGeometry(CELL, CELL, CELL);
    const mkGhost = () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(boxG, new THREE.MeshBasicMaterial({ color: 0x66ffcc, transparent: true, opacity: 0.28, depthWrite: false })));
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(boxG), new THREE.LineBasicMaterial({ color: 0x66ffcc })));
      g.visible = false;
      this.scene.add(g);
      return g;
    };
    this.ghost = mkGhost();
    this.ghostMirror = mkGhost();
    // the block a right-click would remove: white outline
    this.hoverBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(CELL * 1.04, CELL * 1.04, CELL * 1.04)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
    this.hoverBox.visible = false;
    this.scene.add(this.hoverBox);

    // center of mass (gold dot) / center of lift (cyan ring)
    this.cgMarker = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd84d, depthTest: false }));
    this.cgMarker.renderOrder = 10;
    this.colMarker = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.45, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0x66e0ff, depthTest: false }));
    this.colMarker.rotation.x = Math.PI / 2;
    this.colMarker.renderOrder = 10;
    this.scene.add(this.cgMarker, this.colMarker);

    this.badGroup = new THREE.Group();          // red overlay on parts not connected to the core
    this.scene.add(this.badGroup);
    this.badMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.45, depthWrite: false });
    this.badGeo = new THREE.BoxGeometry(CELL * 1.08, CELL * 1.08, CELL * 1.08);

    /* ---------- State ---------- */
    this.orbit = { theta: 2.35, phi: 1.0, r: 115 };
    this.selected = 'wing';
    this.mirror = true;
    this.bp = this.load();
    this.buildGroup = null;
    this.propellers = [];
    this.hover = null;          // part under the cursor
    this.target = null;         // cell a left-click would place into
    this.pointer = null;        // last pointer position
    this.down = null;
    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();

    this.buildDom();
    this.bindPointer();
    this.rebuild();
  }

  /* ================= Save and load ================= */
  // Saving goes through save.js (save.txt / browser storage); the hangar never touches storage directly
  load() { return Save.getLastPlane() || cloneBP(DEFAULT_BLUEPRINT); }
  save() { Save.setLastPlane(this.bp); }

  /* ================= Enter and exit ================= */
  enter() {
    this.active = true;
    this.$('hangar').classList.add('show');
    this.resize();
    this.refreshUI();
    this.refreshBoardCard();
    this.refreshMapSel();      // today's map may have changed since last time (it rolls over at midnight UTC)
  }
  exit() {
    this.active = false;
    this.$('hangar').classList.remove('show');
    this.ghost.visible = this.ghostMirror.visible = this.hoverBox.visible = false;
  }

  resize() {
    this.camera.aspect = (View.w || innerWidth) / (View.h || innerHeight);
    this.camera.updateProjectionMatrix();
  }

  /* ================= Per frame ================= */
  update(dt) {
    const o = this.orbit;
    const s = Math.sin(o.phi);
    this.camera.position.set(o.r * s * Math.sin(o.theta), o.r * Math.cos(o.phi), o.r * s * Math.cos(o.theta));
    this.camera.lookAt(0, 0, 0);
    for (const p of this.propellers) p.rotation.z += 6 * dt;     // propellers spin slowly in the hangar too
  }

  /* ================= Blueprint changes ================= */
  setBP(bp) {
    this.bp = bp;
    this.save();
    this.rebuild();
    this.refreshUI();
    if (this.pointer) this.updateHover(this.pointer.x, this.pointer.y);
  }

  rebuild() {
    if (this.buildGroup) this.scene.remove(this.buildGroup);
    const { group, propellers } = buildBlueprintMesh(this.bp.parts);
    this.buildGroup = group;
    this.propellers = propellers;
    this.scene.add(group);

    // mark disconnected parts red
    this.badGroup.clear();
    const conn = connectedSet(this.bp.parts);
    for (const p of this.bp.parts) {
      if (conn.has(cellKey(p.x, p.y, p.z))) continue;
      const m = new THREE.Mesh(this.badGeo, this.badMat);
      m.position.set(p.x * CELL, p.y * CELL, p.z * CELL);
      this.badGroup.add(m);
    }

    const s = computeStats(this.bp.parts);
    this.cgMarker.position.set(s.cg.x * CELL, s.cg.y * CELL, s.cg.z * CELL);
    this.colMarker.visible = !!s.col;
    if (s.col) this.colMarker.position.set(s.col.x * CELL, 0, s.col.z * CELL);
  }

  /* ================= Input ================= */
  bindPointer() {
    const c = this.canvas;
    const pt = e => View.toView(e.clientX, e.clientY);     // screen -> game coordinates (the game may be drawn turned)
    c.addEventListener('contextmenu', e => { if (this.active) e.preventDefault(); });

    // two fingers on the canvas = pinch to zoom (phones have no mouse wheel)
    this.touches = new Map();
    const pinchDist = () => { const [a, b] = [...this.touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    c.addEventListener('pointerdown', e => {
      if (!this.active) return;
      this.touches.set(e.pointerId, { x: pt(e).x, y: pt(e).y });
      if (this.touches.size === 2) { this.down = null; this.pinch = { d: pinchDist(), r: this.orbit.r }; return; }
      this.down = { x: pt(e).x, y: pt(e).y, lx: pt(e).x, ly: pt(e).y, button: e.button, moved: false, touch: e.pointerType === 'touch' };
      if (c.setPointerCapture) c.setPointerCapture(e.pointerId);
    });
    const lift = e => {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
    };
    c.addEventListener('pointercancel', e => { lift(e); this.down = null; });

    c.addEventListener('pointermove', e => {
      if (!this.active) return;
      if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x: pt(e).x, y: pt(e).y });
      if (this.pinch && this.touches.size === 2) {
        this.orbit.r = Math.max(40, Math.min(this.maxZoom, this.pinch.r * this.pinch.d / Math.max(1, pinchDist())));
        return;
      }
      this.pointer = { x: pt(e).x, y: pt(e).y };
      const d = this.down;
      if (d) {
        // a finger wobbles more than a mouse: be more forgiving before a tap turns into a drag
        if (Math.hypot(pt(e).x - d.x, pt(e).y - d.y) > (d.touch ? 12 : 5)) d.moved = true;
        if (d.moved) {
          // drag to rotate the view
          this.orbit.theta -= (pt(e).x - d.lx) * 0.008;
          this.orbit.phi = Math.max(0.18, Math.min(Math.PI - 0.18, this.orbit.phi - (pt(e).y - d.ly) * 0.008));
          d.lx = pt(e).x; d.ly = pt(e).y;
          this.ghost.visible = this.ghostMirror.visible = this.hoverBox.visible = false;
          return;
        }
      }
      this.updateHover(pt(e).x, pt(e).y);
    });

    c.addEventListener('pointerup', e => {
      lift(e);
      if (!this.active || !this.down) return;
      const d = this.down;
      this.down = null;
      if (d.moved) { this.updateHover(pt(e).x, pt(e).y); return; }
      this.updateHover(pt(e).x, pt(e).y);
      // Remove mode (for touch, where there is no right click) turns a tap into a removal
      if (d.button === 0) { if (this.removeMode) this.doRemove(); else this.doPlace(); }
      else if (d.button === 2) this.doRemove();
    });

    c.addEventListener('wheel', e => {
      if (!this.active) return;
      e.preventDefault();
      this.orbit.r = Math.max(40, Math.min(this.maxZoom, this.orbit.r * (1 + e.deltaY * 0.001)));
    }, { passive: false });
  }

  // one of the hangar's windows is open (main.js stops drawing the 3D plane behind it)
  modalOpen() {
    return ['hgRunsBox', 'hgBoardBox', 'hgPilotBox', 'hgCoopBox', 'hgInstallBox', 'hgShareBox', 'hgDuelBox', 'hgBackupBox'].some(id => this.$(id).style.display === 'block');
  }

  onKey(e) {
    const k = e.key.toLowerCase();
    // while the stats box is open, keys belong to it (Cmd+C must not pick parts or start a flight); Esc closes it
    for (const box of ['hgRunsBox', 'hgBoardBox', 'hgPilotBox', 'hgCoopBox', 'hgInstallBox', 'hgShareBox', 'hgDuelBox', 'hgBackupBox']) {
      if (this.$(box).style.display === 'block') {
        if (k === 'escape') this.$(box).style.display = 'none';
        return;
      }
    }
    const idx = '1234567'.indexOf(k);
    if (idx >= 0) { this.select(PLACEABLE[idx]); return; }
    if (k === 'm') { this.toggleMirror(); return; }
    if (k === 'enter') { this.trySortie(); return; }
    if (k === 't') { this.tryTest(); return; }
  }

  updateHover(cx, cy) {
    const rect = View.rot ? { left: 0, top: 0, width: View.w, height: View.h } : this.canvas.getBoundingClientRect();
    this.ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = pickCell(this.raycaster.ray.origin, this.raycaster.ray.direction, this.bp.parts);
    this.hover = hit;

    if (!hit) {
      this.target = null;
      this.ghost.visible = this.ghostMirror.visible = this.hoverBox.visible = false;
      return;
    }
    this.hoverBox.visible = hit.cell.type !== 'core';
    this.hoverBox.position.set(hit.cell.x * CELL, hit.cell.y * CELL, hit.cell.z * CELL);

    const t = { x: hit.cell.x + hit.normal.x, y: hit.cell.y + hit.normal.y, z: hit.cell.z + hit.normal.z };
    this.target = t;
    const chk = canPlace(this.bp, this.selected, t.x, t.y, t.z, this.mirror, this.creative);
    const color = chk.ok ? 0x66ffcc : 0xff5a5a;
    for (const g of [this.ghost, this.ghostMirror]) {
      g.children[0].material.color.setHex(color);
      g.children[1].material.color.setHex(color);
    }
    this.ghost.position.set(t.x * CELL, t.y * CELL, t.z * CELL);
    this.ghost.visible = true;
    const showMirror = chk.cells && chk.cells.length > 1;
    this.ghostMirror.visible = !!showMirror;
    if (showMirror) this.ghostMirror.position.set(-t.x * CELL, t.y * CELL, t.z * CELL);
  }

  doPlace() {
    if (!this.target) return;
    const t = this.target;
    const r = place(this.bp, this.selected, t.x, t.y, t.z, this.mirror, this.creative);
    if (r.ok) this.setBP(r.bp); else this.toast(r.reason);
  }

  doRemove() {
    if (!this.hover) return;
    const c = this.hover.cell;
    const r = remove(this.bp, c.x, c.y, c.z, this.mirror);
    if (r.ok) this.setBP(r.bp); else this.toast(r.reason);
  }

  select(type) {
    this.selected = type;
    this.refreshPalette();
    if (this.pointer) this.updateHover(this.pointer.x, this.pointer.y);
  }

  toggleMirror() {
    this.mirror = !this.mirror;
    const b = this.$('hgMirror');
    b.textContent = 'Mirror: ' + (this.mirror ? 'ON' : 'OFF');
    b.classList.toggle('on', this.mirror);
    if (this.pointer) this.updateHover(this.pointer.x, this.pointer.y);
  }

  toggleRemove() {
    this.removeMode = !this.removeMode;
    const b = this.$('hgRemove');
    b.textContent = this.removeMode ? 'Remove: ON' : 'Remove: OFF';
    b.classList.toggle('on', this.removeMode);
    this.toast(this.removeMode ? 'Tap parts to remove them' : 'Tap faces to add parts', true);
  }

  get creative() { return Save.data.creative === true; }
  get maxZoom() { return this.creative ? 1400 : 280; }        // Creative planes can be much bigger
  toggleCreative() {
    Save.setCreative(!this.creative);
    this.toast(this.creative
      ? `Creative mode ON: no load limit and no build area limit (up to ${CREATIVE_MAX_PARTS} parts). Planes over ${PARTS.core.budget} load or outside the normal area go on the Creative board instead of the normal ones.`
      : 'Creative mode OFF', true);
    this.refreshUI();
  }

  trySortie() {
    const v = validate(this.bp.parts, undefined, { creative: this.creative });
    if (!v.ok) { this.toast(v.errors[0]); return; }
    this.onSortie(cloneBP(this.bp));
  }

  // Test flight: same checks as a sortie, but no enemies and nothing is recorded
  tryTest() {
    const v = validate(this.bp.parts, undefined, { creative: this.creative });
    if (!v.ok) { this.toast(v.errors[0]); return; }
    if (this.onTest) this.onTest(cloneBP(this.bp));
  }

  /* ---------- AI Test and Design Duel (planetest.js, duel.js): local only, nothing is sent or ranked ---------- */
  // the grades of the plane in the hangar, if it was tested (by layout: the same parts = the same grades)
  refreshAiTest() {
    const key = planeKey(this.bp.parts);
    const r = Save.data.planeTests[key];
    const cur = r && r.v === TEST_VERSION ? r : null;
    const cls = g => (g === 'S' || g === 'SS' || g === 'SSS' ? 'grade g-top' : g === 'A' || g === 'B' ? 'grade g-good' : g === '-' ? 'grade' : 'grade g-low');
    for (const [id, g] of [['hgGradeW', cur ? cur.waveGrade : '-'], ['hgGradeD', cur ? cur.duelGrade : '-']]) { this.$(id).textContent = g; this.$(id).className = cls(g); }
    const btn = this.$('hgAiTestBtn');
    const flies = validate(this.bp.parts, undefined, { creative: true }).ok;
    if (this.testing) return;
    btn.disabled = !flies || !!cur;                     // (the same layout always gets the same grades)
    btn.textContent = cur ? 'Tested' : 'AI test';
    // The explanation lives in tooltips (and appears under the grades when you click them), so the panel stays short
    // and the rest of it (the leaderboard) is not pushed out of sight.
    const about = 'The computer pilot flies it: waves, and duels against the 10 sample planes. A few seconds, local only.';
    const detail = cur ? `Waves: reaches wave ${cur.wave} on average · Duels: wins ${Math.round(cur.share * 100)}% of its duels against the 10 sample planes` : about;
    btn.title = about;
    this.$('hgAiGrades').title = detail + ' (click to show or hide)';
    this.$('hgAiNote').textContent = !flies ? 'Fix the plane first (it has to be able to fly).' : this.aiNoteOpen ? detail : '';
  }
  async runAiTest() {
    if (this.testing) return;
    const parts = this.bp.parts.map(p => ({ ...p }));
    if (!validate(parts, undefined, { creative: true }).ok) return;
    const key = planeKey(parts);
    const btn = this.$('hgAiTestBtn');
    this.testing = { key };
    btn.disabled = true;
    if (this.prepareTest) this.prepareTest();          // main.js: the training map, clear weather
    try {
      const r = await testPlane(parts, { onProgress: f => { btn.textContent = `Testing ${Math.round(f * 100)}%`; this.$('hgAiNote').textContent = 'The computer pilot is flying it...'; } });
      Save.setPlaneTest(key, { v: TEST_VERSION, wave: r.waves.wave, waveGrade: r.waves.grade, share: r.duel.share, duelGrade: r.duel.grade, at: Date.now() });
    } finally {
      this.testing = null;
      this.refreshAiTest();
    }
  }

  // the Design Duel window: A and B from this plane, the saved planes, the 10 sample planes, or a plane code
  openDuel() {
    // the versus numbers, read from the config so the text never falls behind a balance change
    this.$('hgDuelRules').textContent = `cannon ${Math.round(CFG.versus.gunMul * 100)} %, missiles ${CFG.versus.missileDamage}`;
    const fill = (sel, def) => {
      sel.innerHTML = '';
      const add = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; sel.appendChild(o); };
      add('cur', `This plane (${this.bp.name || 'Custom'})`);
      for (const p of Save.listPlanes()) add('save:' + p.name, `Saved: ${p.name}`);
      PRESETS.forEach((p, i) => add('preset:' + i, `Sample: ${p.name}`));
      sel.value = def;
    };
    fill(this.$('hgDuelA'), 'cur');
    fill(this.$('hgDuelB'), 'preset:0');
    this.$('hgDuelOut').innerHTML = '';
    this.$('hgDuelBox').style.display = 'block';
  }
  // -> { name, parts } or { error }
  async duelPick(selId, codeId) {
    const code = this.$(codeId).value.trim();
    if (code) {
      let text = code;
      const short = (code.match(/#p=([A-Za-z]{6})\b/) || [])[1] || (/^[A-Za-z]{6}$/.test(code) ? code : null);
      if (short && !/SKY1\./.test(code)) {
        const g = await Leaderboard.getPlane(short.toUpperCase());
        if (g.error) return { error: `No plane with the code ${short.toUpperCase()}` };
        text = g.data;
      }
      const r = codeToPlane(text);
      return r.ok ? { name: r.bp.name, parts: r.bp.parts } : { error: r.reason };
    }
    const v = this.$(selId).value;
    if (v === 'cur') return { name: this.bp.name || 'This plane', parts: this.bp.parts };
    if (v.startsWith('save:')) { const hit = Save.listPlanes().find(p => p.name === v.slice(5)); return hit ? { name: hit.name, parts: hit.bp.parts } : { error: 'That saved plane is gone' }; }
    const p = PRESETS[Number(v.slice(7))];
    return { name: p.name, parts: p.parts };
  }
  async runDuel(n = 20) {
    if (this.dueling) return;
    const out = this.$('hgDuelOut');
    const A = await this.duelPick('hgDuelA', 'hgDuelCodeA'), B = await this.duelPick('hgDuelB', 'hgDuelCodeB');
    if (A.error || B.error) { out.textContent = A.error || B.error; return; }
    for (const P of [A, B]) if (!validate(P.parts, undefined, { creative: true }).ok) { out.textContent = `${P.name} can't fly (fix it in the hangar first)`; return; }
    this.dueling = true;
    const btn = this.$('hgDuelRun');
    btn.disabled = true;
    if (this.prepareTest) this.prepareTest();
    try {
      const rng = mulberry32(777);
      const spec = parts => specFromStats(computeStats(parts));
      const r = await duelSeries(new THREE.Scene(), spec(A.parts), spec(B.parts), n, rng, sliced(rng), k => { btn.textContent = `Fighting ${k}/${n}`; });
      const pct = x => Math.round(x / n * 100);
      out.innerHTML = `<div id="hgDuelBar"><i style="width:${pct(r.wins)}%;background:var(--accent)"></i><i style="width:${pct(r.draws)}%;background:#6b7a8c"></i><i style="width:${pct(r.losses)}%;background:#ffb35a"></i></div>` +
        `<b style="color:var(--accent)">A ${esc(A.name)}</b>: ${r.wins} win${r.wins === 1 ? '' : 's'} · ${r.draws} draw${r.draws === 1 ? '' : 's'} · ` +
        `<b style="color:#ffb35a">B ${esc(B.name)}</b>: ${r.losses} win${r.losses === 1 ? '' : 's'}<br>` +
        (r.wins === r.losses ? 'Even.' : `${r.wins > r.losses ? esc(A.name) : esc(B.name)} is the better design here (${Math.round(Math.max(r.share, 1 - r.share) * 100)}%, a draw counting half).`);
    } finally {
      this.dueling = false;
      btn.disabled = false;
      btn.textContent = 'Fight';
    }
  }

  /* ---------- sharing planes ---------- */
  shareBase() { return typeof location !== 'undefined' ? location.origin + location.pathname : ''; }
  async openShare() {
    // the long link works offline; the server then gives a 6-letter code and a short link
    this.$('hgShareText').value = planeLink(this.bp, this.shareBase());
    this.$('hgShareCode').textContent = '......';
    this.$('hgShareIn').value = '';
    this.shareMsg('');
    this.$('hgShareBox').style.display = 'block';
    const r = await Leaderboard.sharePlane(planeToCode(this.bp));
    if (r.code) {
      this.$('hgShareCode').textContent = r.code;
      this.$('hgShareText').value = `${this.shareBase()}#p=${r.code}`;
    } else {
      this.$('hgShareCode').textContent = '-';
      this.shareMsg('No short code right now (offline). The link below still works.');
    }
  }
  shareMsg(text, bad = false) { const m = this.$('hgShareMsg'); m.textContent = text; m.className = bad ? 'bad' : ''; }
  copyShare(what = 'link') {
    const code = this.$('hgShareCode').textContent;
    const text = what === 'code' && /^[A-Z]{6}$/.test(code) ? code : this.$('hgShareText').value;
    const clip = typeof navigator !== 'undefined' && navigator.clipboard;
    const manual = () => { const t = this.$('hgShareText'); if (t.focus) { t.focus(); t.select(); } this.shareMsg('Select the link and copy it (Cmd+C / Ctrl+C)'); };
    if (clip && clip.writeText) clip.writeText(text).then(() => this.shareMsg(`${text.length === 6 ? 'Code' : 'Link'} copied. Send it to a friend.`), manual);
    else manual();
  }
  // a pasted link or code (or the #plane=... a shared link opened the game with) -> into the hangar
  async loadShared(text) {
    // a 6-letter code (typed, or in a #p=... link): ask the server for the plane first
    const raw = String(text || '');
    const short = (raw.match(/#p=([A-Za-z]{6})\b/) || [])[1] || (/^\s*[A-Za-z]{6}\s*$/.test(raw) ? raw.trim() : null);
    if (short && !/SKY1\./.test(raw)) {
      this.shareMsg('Looking up the code...');
      const g = await Leaderboard.getPlane(short.toUpperCase());
      if (g.error) { this.shareMsg(g.error === 'no plane with that code' ? 'No plane with that code (it may be an old one).' : `Could not look it up (${g.error}).`, true); return false; }
      text = g.data;
    }
    const r = codeToPlane(text);
    if (!r.ok) { this.shareMsg(r.reason, true); return false; }
    this.setBP(r.bp);
    const v = validate(r.bp.parts, undefined, { creative: this.creative });
    const note = v.ok ? '' : (!this.creative && validate(r.bp.parts, undefined, { creative: true }).ok
      ? ' It is a Creative plane: turn on Creative mode to fly it (Creative board).' : ` It needs fixing first: ${v.errors[0]}`);
    this.shareMsg(`Loaded: ${r.bp.name}.${note} Save it with Save as... to keep it.`);
    this.toast(`Loaded shared plane: ${r.bp.name}.${note} Save as... keeps it.`, true);
    return true;
  }

  // "Copy stats": the recent runs as text, to paste into a chat for balancing
  openRuns() {
    this.$('hgRunsText').value = Save.statsText(CFG.build);
    this.$('hgRunsText').style.display = 'none';
    this.$('hgRunsView').innerHTML = runsHtml(Save.statsData());
    this.$('hgRunsBox').style.display = 'block';
    this.copyRuns();
  }
  copyRuns() {
    const text = this.$('hgRunsText').value;
    const clip = typeof navigator !== 'undefined' && navigator.clipboard;
    if (clip && clip.writeText) {
      clip.writeText(text).then(() => this.toast('Stats copied. Paste them anywhere.', true),
        () => this.selectRuns());
    } else this.selectRuns();
  }
  // clipboard blocked: show the plain text so it can be copied by hand
  selectRuns() {
    const t = this.$('hgRunsText');
    t.style.display = 'block';
    if (t.focus) { t.focus(); t.select(); }
    this.toast('Select all and copy (Cmd+C / Ctrl+C)', true);
  }

  /* ---------- map choice ---------- */
  // 'today' (the daily map, the only ranked one), 'random', or a map type (random seed and weather of that type)
  refreshMapSel() {
    const sel = this.$('hgMapSel');
    if (!this.mapChoice) this.mapChoice = 'today';
    if (!this.mapTodayOpt) {                      // options are built once; only today's label changes
      const add = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; sel.appendChild(o); return o; };
      this.mapTodayOpt = add('today', '');
      add('random', 'Random map');
      for (const k of BIOME_KEYS) add(k, `${BIOMES[k].name} (random weather)`);
    }
    this.mapTodayOpt.textContent = `Today: ${mapLabel(mapForDay(dayString()))}`;
    sel.value = this.mapChoice;
    const note = this.$('hgMapNote');
    const ranked = this.mapChoice === 'today';
    note.textContent = ranked ? 'ranked' : 'just for fun, not ranked';
    note.className = ranked ? 'ranked' : 'fun';
  }
  selectedMap() {
    const c = this.mapChoice || 'today';
    if (c === 'today') return mapForDay(dayString());
    return randomMap(c === 'random' ? null : c);
  }

  /* ---------- online leaderboard ---------- */
  refreshBoardCard() {
    const on = Leaderboard.enabled();
    this.$('hgBoardCard').style.display = on ? 'block' : 'none';
    if (!on) return;
    const me = Leaderboard.me();
    // always both boards, each labelled, so it is clear which rank is which
    const R = this.ranks || {};
    const fmt = x => (x && x.rank ? `<b>#${x.rank}</b> of ${x.total}` : '-');
    const ranks = me && me.locked && (R.daily || R.all)
      ? `<br>Today's map: ${fmt(R.daily)} · All time: ${fmt(R.all)}` : '';
    this.$('hgBoardMe').innerHTML = me
      ? `You are <b>${esc(me.callsign)} #${me.id}</b>` + ranks +
        (me.locked ? '' : '<br><span style="color:var(--dim)">Callsign not locked in yet: open the leaderboard to change or lock it. Only locked-in pilots are listed.</span>')
      : 'Survive 30 s in a run on today\'s map to join the board.';
  }
  // ask the server for my rank on both boards (on entering the hangar)
  async refreshRanks() {
    const me = Leaderboard.me();
    if (!Leaderboard.enabled() || !me) return;
    const [d, a] = await Promise.all([Leaderboard.top('daily'), Leaderboard.top('all')]);
    const pick = r => (r && !r.error && r.me ? { rank: r.me.rank, total: r.total } : null);
    this.ranks = { daily: pick(d), all: pick(a) };
    this.refreshBoardCard();
  }
  async openBoard(tab = this.boardTab || 'daily') {
    this.boardTab = tab;
    this.$('hgBoardBox').style.display = 'block';
    this.$('hgBoardDaily').classList.toggle('on', tab === 'daily');
    this.$('hgBoardAll').classList.toggle('on', tab === 'all');
    for (const [id, t] of [['hgBoardWeek', 'week'], ['hgBoardMonth', 'month'], ['hgBoardYear', 'year']]) this.$(id).classList.toggle('on', tab === t);
    this.$('hgBoardPvp').classList.toggle('on', tab === 'pvp');
    this.$('hgBoardLadder').classList.toggle('on', tab === 'ladder');
    this.$('hgBoardCreative').classList.toggle('on', tab === 'creative');
    this.$('hgBoardView').innerHTML = '<div class="rsEmpty">Loading...</div>';
    this.refreshLockButtons();
    const res = await Leaderboard.top(tab);
    if (res && !res.error && res.me) {
      this.ranks = this.ranks || {};
      this.ranks[tab] = { rank: res.me.rank, total: res.total };
    }
    const me = Leaderboard.me();
    // the server is the truth for the callsign and the lock (the admin may have changed either)
    if (me && res && res.me && res.me.callsign) Save.setLeaderboard({ ...me, callsign: res.me.callsign, locked: res.me.locked === 1 });
    this.refreshLockButtons();
    this.$('hgBoardView').innerHTML = boardHtml(res, me ? me.id : null);
    this.refreshBoardCard();
    return res;
  }
  // load the plane a board run was flown in, named after its pilot (callsigns come from the server, never typed)
  async copyFlown(id, day, who, btn = null) {
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    const r = await Leaderboard.flownPlane(id, day);
    if (r.error || typeof r.parts !== 'string') {
      if (btn) { btn.disabled = false; btn.textContent = 'Copy'; }
      this.toast(r.error === 'offline' ? 'Leaderboard offline: could not copy the plane.' : 'That plane is not on file any more.', true);
      return false;
    }
    const got = codeToPlane(partsTextToCode(r.parts, `${who}'s plane`));
    if (!got.ok) { if (btn) { btn.disabled = false; btn.textContent = 'Copy'; } this.toast('That plane could not be loaded.', true); return false; }
    this.$('hgBoardBox').style.display = 'none';
    this.setBP(got.bp);
    this.toast(`Copied ${got.bp.name}. Save as... keeps it.`, true);
    return true;
  }
  /* ---------- pilot backup code: the same pilot on another browser or device ---------- */
  openBackup() {
    this.$('hgBoardBox').style.display = 'none';
    this.$('hgBackupBox').style.display = 'block';
    this.$('hgBackupIn').value = '';
    this.backupArmed = null;
    this.$('hgBackupRestore').classList.remove('armed');
    this.$('hgBackupRestore').textContent = 'Restore';
    this.backupMsg('');
    this.showBackup();
  }
  showBackup() {
    const me = Leaderboard.me();
    this.$('hgBackupWho').textContent = me ? `This browser's pilot: ${me.callsign} #${me.id}` : 'This browser has no pilot yet (fly a run on today\'s map, or restore one below).';
    this.$('hgBackupCode').value = me ? backupCode(me) : '';
    this.$('hgBackupCopy').disabled = !me;
  }
  backupMsg(text, bad = false) { const m = this.$('hgBackupMsg'); m.textContent = text; m.className = bad ? 'bad' : ''; }
  copyBackup() {
    const t = this.$('hgBackupCode'), text = t.value;
    if (!text) return;
    const clip = typeof navigator !== 'undefined' && navigator.clipboard;
    const manual = () => { if (t.focus) { t.focus(); t.select(); } this.backupMsg('Select the code and copy it (Cmd+C / Ctrl+C)'); };
    if (clip && clip.writeText) clip.writeText(text).then(() => this.backupMsg('Copied. Keep it somewhere safe and private.'), manual);
    else manual();
  }
  // paste a code -> checked with the server -> this browser's pilot (asks twice if it replaces another one)
  async restoreBackup(text) {
    const m = String(text || '').match(/SKYP-(\d{1,9})-([0-9a-f]{48})/i);
    if (!m) { this.backupMsg('That is not a backup code (it starts with SKYP-).', true); return false; }
    const id = Number(m[1]), token = m[2].toLowerCase();
    const cur = Leaderboard.me();
    if (cur && cur.id === id && cur.token === token) { this.backupMsg('That is already this browser\'s pilot.'); return false; }
    this.backupMsg('Checking the code...');
    const r = await Leaderboard.whoami(id, token);
    if (r.error) {
      this.backupMsg(r.status === 401 ? 'That code does not match any pilot (check you copied all of it).' : `Could not check it now (${r.error}). Try again later.`, true);
      return false;
    }
    if (cur && this.backupArmed !== id) {
      this.backupArmed = id;
      this.$('hgBackupRestore').classList.add('armed');
      this.$('hgBackupRestore').textContent = 'Replace?';
      this.backupMsg(`This replaces this browser's pilot ${cur.callsign} #${cur.id} with ${r.callsign} #${r.id}. Copy the code above first if you want to keep ${cur.callsign}. Press Replace? to go ahead.`, true);
      return false;
    }
    Save.setLeaderboard({ id: r.id, token, callsign: r.callsign, locked: r.locked === 1 });
    this.backupArmed = null;
    this.$('hgBackupRestore').classList.remove('armed');
    this.$('hgBackupRestore').textContent = 'Restore';
    this.$('hgBackupIn').value = '';
    this.ranks = {};
    this.showBackup();
    this.refreshBoardCard();
    if (this.refreshRanks) this.refreshRanks();
    this.backupMsg(`Welcome back, ${r.callsign} #${r.id}.`);
    this.toast(`Pilot restored: ${r.callsign} #${r.id}`, true);
    return true;
  }

  async rerollCallsign() {
    const r = await Leaderboard.reroll();
    if (r.error) {
      this.toast(lbError(r.error));
      this.refreshLockButtons();
      return r;
    }
    this.toast(`You are now ${r.callsign}`, true);
    await this.openBoard();
    return r;
  }
  /* ---------- first-time callsign picker ---------- */
  // Shown once per session in the hangar until the player locks in a callsign (only locked-in pilots are listed)
  async maybeAskCallsign() {
    if (!Leaderboard.enabled() || this.askedCallsign) return false;
    const known = Leaderboard.me();
    if (known && known.locked) return false;
    this.askedCallsign = true;
    const me = await Leaderboard.ensureId();
    if (!me || me.locked) return false;
    this.showPilot();
    this.$('hgPilotBox').style.display = 'block';
    return true;
  }
  showPilot() {
    const me = Leaderboard.me();
    if (me) this.$('hgPilotName').innerHTML = `${esc(me.callsign)} <span>#${me.id}</span>`;
    const btn = this.$('hgPilotLock');
    btn.textContent = 'Lock it in';
    btn.classList.remove('armed');
    this.lockArmedAt = 0;
  }
  async pilotReroll() {
    const r = await Leaderboard.reroll();
    if (r.error) this.toast(lbError(r.error));
    this.showPilot();
    return r;
  }

  // two clicks within 5 s, because locking can't be undone (same for the picker and the leaderboard window)
  async lockCallsign(now = Date.now(), btnId = 'hgBoardLock') {
    const btn = this.$(btnId);
    if (!this.lockArmedAt || now - this.lockArmedAt > 5000) {
      this.lockArmedAt = now;
      btn.textContent = 'Click again to lock it forever';
      btn.classList.add('armed');
      return null;
    }
    this.lockArmedAt = 0;
    const r = await Leaderboard.lock();
    if (r.error) { this.toast(lbError(r.error)); this.refreshLockButtons(); return r; }
    this.toast(`${r.callsign} is yours for good`, true);
    if (btnId === 'hgPilotLock') { this.$('hgPilotBox').style.display = 'none'; this.refreshBoardCard(); }
    else await this.openBoard();
    return r;
  }
  refreshLockButtons() {
    const me = Leaderboard.me();
    const open = !!me && !me.locked;
    this.$('hgBoardReroll').style.display = open ? '' : 'none';
    const btn = this.$('hgBoardLock');
    btn.style.display = open ? '' : 'none';
    btn.textContent = 'Lock in callsign';
    btn.classList.remove('armed');
    this.lockArmedAt = 0;
    this.refreshBoardCard();
  }

  // Random sample plane: load one of the 10 sample planes (never the current one) into the hangar.
  // It does NOT take off: you can look at it or modify it first, then press SORTIE (PLAY).
  randomSample() {
    this.setBP(randomPreset(this.bp.name));
    this.toast(`Loaded: ${this.bp.name}. Modify it or press SORTIE (PLAY).`, true);
  }

  /* ================= DOM ================= */
  $(id) { return document.getElementById(id); }

  buildDom() {
    // Sample plane dropdown: 10 planes; picking one loads it into the hangar (to look at, modify, or learn from)
    const sel = this.$('hgPresetSel');
    const ph = document.createElement('option');
    ph.value = ''; ph.textContent = `Sample planes (${PRESETS.length}) ▾`;
    sel.appendChild(ph);
    PRESETS.forEach((p, i) => {
      const o = document.createElement('option');
      o.value = String(i); o.textContent = p.name;
      sel.appendChild(o);
    });
    sel.onchange = () => {
      const i = Number(sel.value);
      if (sel.value !== '' && PRESETS[i]) {
        this.setBP(cloneBP(PRESETS[i]));
        this.toast(`Loaded: ${PRESETS[i].name}`, true);
      }
      sel.value = '';
    };

    this.$('hgMirror').onclick = () => this.toggleMirror();
    this.$('hgClear').onclick = () => this.setBP(cleared());
    this.$('hgSortie').onclick = () => this.trySortie();
    this.$('hgTest').onclick = () => this.tryTest();
    this.$('hgRunsBtn').onclick = () => this.openRuns();
    this.$('hgShareBtn').onclick = () => this.openShare();
    this.$('hgShareCopy').onclick = () => this.copyShare('link');
    this.$('hgShareCopyCode').onclick = () => this.copyShare('code');
    this.$('hgShareIn').onkeydown = e => { if (e.key === 'Enter') this.loadShared(this.$('hgShareIn').value); };
    this.$('hgShareLoad').onclick = () => this.loadShared(this.$('hgShareIn').value);
    this.$('hgShareClose').onclick = () => { this.$('hgShareBox').style.display = 'none'; };
    this.$('hgRemove').onclick = () => this.toggleRemove();
    this.$('hgCreative').onclick = () => this.toggleCreative();
    this.$('hgAiTestBtn').onclick = () => this.runAiTest();
    this.$('hgDuelBtn').onclick = () => this.openDuel();
    this.$('hgDuelRun').onclick = () => this.runDuel();
    this.$('hgDuelClose').onclick = () => { this.$('hgDuelBox').style.display = 'none'; };
    this.$('hgBoardBtn').onclick = () => this.openBoard();
    // a Copy button on a board row (all time, today, week, month, year)
    this.$('hgBoardView').onclick = e => {
      const b = e.target && e.target.closest ? e.target.closest('.rsCopy') : null;
      if (b) this.copyFlown(Number(b.dataset.id), b.dataset.day || '', b.dataset.who || 'Pilot', b);
    };
    this.$('hgAiGrades').onclick = () => { this.aiNoteOpen = !this.aiNoteOpen; this.refreshAiTest(); };
    this.$('hgMapSel').onchange = () => { this.mapChoice = this.$('hgMapSel').value; this.refreshMapSel(); };
    this.$('hgBoardClose').onclick = () => { this.$('hgBoardBox').style.display = 'none'; };
    this.$('hgBoardDaily').onclick = () => this.openBoard('daily');
    this.$('hgBoardPvp').onclick = () => this.openBoard('pvp');
    this.$('hgBoardLadder').onclick = () => this.openBoard('ladder');
    this.$('hgBoardCreative').onclick = () => this.openBoard('creative');
    this.$('hgBoardWeek').onclick = () => this.openBoard('week');
    this.$('hgBoardMonth').onclick = () => this.openBoard('month');
    this.$('hgBoardYear').onclick = () => this.openBoard('year');
    this.$('hgBoardAll').onclick = () => this.openBoard('all');
    this.$('hgBoardReroll').onclick = () => this.rerollCallsign();
    this.$('hgBoardLock').onclick = () => this.lockCallsign();
    this.$('hgBoardBackup').onclick = () => this.openBackup();
    this.$('hgBackupCopy').onclick = () => this.copyBackup();
    this.$('hgBackupRestore').onclick = () => this.restoreBackup(this.$('hgBackupIn').value);
    this.$('hgBackupIn').onkeydown = e => { if (e.key === 'Enter') this.restoreBackup(this.$('hgBackupIn').value); };
    this.$('hgBackupClose').onclick = () => { this.$('hgBackupBox').style.display = 'none'; };
    this.$('hgPilotLock').onclick = () => this.lockCallsign(Date.now(), 'hgPilotLock');
    this.$('hgPilotReroll').onclick = () => this.pilotReroll();
    this.$('hgPilotLater').onclick = () => { this.$('hgPilotBox').style.display = 'none'; };
    this.$('hgRunsCopy').onclick = () => this.copyRuns();
    this.$('hgRunsClose').onclick = () => { this.$('hgRunsBox').style.display = 'none'; };
    this.$('hgRandom').onclick = () => this.randomSample();
    this.$('hgTraining').onclick = () => { if (this.onTraining) this.onTraining(); };

    // My planes
    this.$('hgSaveMine').onclick = () => {
      const suggest = this.bp.name && this.bp.name !== 'Custom' ? this.bp.name : 'My Plane';
      const name = (typeof prompt === 'function') ? prompt('Name this plane:', suggest) : suggest;
      if (name === null) return;
      const r = Save.savePlane(this.bp, name);
      if (!r.ok) { this.toast(r.reason); return; }
      this.bp = { ...this.bp, name: String(name).trim().slice(0, 32) };
      this.save();
      this.refreshMine(this.bp.name);
      this.refreshUI();
      this.toast(r.replaced ? `Updated: ${this.bp.name}` : `Saved: ${this.bp.name}`, true);
    };
    this.$('hgLoadMine').onclick = () => {
      const name = this.$('hgMineSel').value;
      const hit = Save.listPlanes().find(p => p.name === name);
      if (!hit) { this.toast('No saved plane selected.'); return; }
      this.setBP(hit.bp);
      this.toast(`Loaded: ${hit.name}`, true);
    };
    this.$('hgDelMine').onclick = () => {
      const name = this.$('hgMineSel').value;
      if (!name) { this.toast('No saved plane selected.'); return; }
      if (typeof confirm === 'function' && !confirm(`Delete "${name}"?`)) return;
      Save.deletePlane(name);
      this.refreshMine();
      this.toast(`Deleted: ${name}`, true);
    };
    Save.onStatus = () => this.refreshSaveWhere();
    this.refreshMine();
    this.refreshSaveWhere();

    // part palette
    const list = this.$('hgParts');
    this.partEls = {};
    PLACEABLE.forEach((type, i) => {
      const d = PARTS[type];
      const row = document.createElement('div');
      row.className = 'hgPart';
      row.innerHTML = `<span class="hgKey">${i + 1}</span>
        <span class="hgSwatch" style="background:${hex(d.color)}"></span>
        <span class="hgPName">${d.name}</span><span class="hgCost">${d.load}<i> load</i></span>`;
      row.onclick = () => this.select(type);
      list.appendChild(row);
      this.partEls[type] = row;
    });

    // stat rows (values filled in by refreshUI)
    this.statKeys = [
      ['weight', 'WEIGHT'], ['twr', 'THRUST / WEIGHT'], ['wl', 'WING LOADING'],
      ['speed', 'TOP SPEED'], ['turn', 'TURN'], ['roll', 'ROLL'], ['accel', 'ACCELERATION'],
      ['hull', 'HULL'], ['guns', 'CANNONS'], ['msl', 'MISSILES'], ['size', 'HITBOX'], ['bal', 'BALANCE'],
      ['best', 'YOUR BEST'],
    ];
    const rows = this.$('hgStatRows');
    this.statEls = {};
    for (const [k, label] of this.statKeys) {
      const r = document.createElement('div');
      r.className = 'hgRow';
      r.innerHTML = `<span>${label}</span><b></b>`;
      rows.appendChild(r);
      this.statEls[k] = r.querySelector('b');
    }
    // the right panel: while some rows are hidden under the pinned leaderboard card (a short window), the card casts
    // a shadow over them (class "more")
    const stats = this.$('hgStats');
    // Checked on the next frame, not inside the ResizeObserver callback: changing the page inside the callback
    // made Chrome report "ResizeObserver loop completed with undelivered notifications" (shown as an ERROR by the banner).
    let queued = false;
    const check = () => {
      queued = false;
      const hidden = stats.scrollHeight - stats.clientHeight - stats.scrollTop > 6;
      if (stats.classList && stats.classList.contains('more') !== hidden) stats.classList.toggle('more', hidden);
    };
    this.statsMore = () => {
      if (queued) return;
      if (typeof requestAnimationFrame === 'function') { queued = true; requestAnimationFrame(check); } else check();
    };
    if (stats.addEventListener) stats.addEventListener('scroll', this.statsMore, { passive: true });
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', this.statsMore);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(this.statsMore);
      ro.observe(stats);
      for (const c of stats.children) ro.observe(c);
    }
  }

  refreshPalette() {
    for (const [type, el] of Object.entries(this.partEls)) el.classList.toggle('sel', type === this.selected);
    const d = PARTS[this.selected];
    const extra = [
      d.area ? `+${d.area} wing area` : '',
      d.thrust ? `${d.thrust} thrust` : '',
      d.gun ? '+1 gun' : '',
      d.missiles ? `+${d.missiles} missiles` : '',
    ].filter(Boolean).join(' · ');
    this.$('hgPartInfo').innerHTML =
      `<b>${d.name}</b><br>${d.desc}<br>
       <span style="opacity:.85">Load ${d.load} · Weight ${d.mass} · Hull ${d.hp}${extra ? ' · ' + extra : ''}</span>`;
  }

  refreshUI() {
    this.refreshPalette();
    const s = computeStats(this.bp.parts);
    const v = validate(this.bp.parts, s, { creative: this.creative });
    const canFly = s.engines.length && s.wings > 0 && isFinite(s.wingLoading);
    const sp = canFly ? specFromStats(s) : null;

    // load bar
    const frac = s.budget ? s.load / s.budget : 0;
    const fill = this.$('hgLoadFill');
    const cBtn = this.$('hgCreative');
    cBtn.textContent = this.creative ? 'Creative mode: ON' : 'Creative mode: OFF';
    cBtn.classList.toggle('on', this.creative);
    if (this.creative) {
      // no budget: show the load, and whether this plane would still be ranked
      this.$('hgLoad').innerHTML = s.load <= s.budget ? `${s.load} <span class="up">(ranked)</span>` : `${s.load} <span class="down">(Creative board)</span>`;
      fill.style.width = Math.min(100, frac * 100) + '%';
      fill.style.background = frac > 1 ? '#c77dff' : 'var(--accent)';
    } else {
      this.$('hgLoad').textContent = `${s.load} / ${s.budget}`;
      fill.style.width = Math.min(100, frac * 100) + '%';
      fill.style.background = frac > 1 ? 'var(--warn)' : frac > 0.9 ? '#ffd84d' : 'var(--accent)';
    }

    const pct = (m) => {
      if (m == null) return '<span class="bad">-</span>';
      const p = Math.round(m * 100);
      const cls = p > 102 ? 'up' : p < 98 ? 'down' : '';
      return `<span class="${cls}">${p}%</span>`;
    };
    const E = this.statEls;
    E.weight.textContent = s.mass;
    E.twr.innerHTML = s.engines.length ? s.twr.toFixed(2) : '<span class="bad">no engine</span>';
    E.wl.innerHTML = isFinite(s.wingLoading) ? s.wingLoading.toFixed(1) : '<span class="bad">no wings</span>';
    E.speed.innerHTML = sp ? `${Math.round(sp.speedMax)} &nbsp;${pct(sp.mul.speed)}` : pct(null);
    E.turn.innerHTML = sp ? pct(sp.mul.turn) : pct(null);
    E.roll.innerHTML = sp ? pct(sp.mul.roll) : pct(null);
    E.accel.innerHTML = sp ? pct(sp.mul.accel) : pct(null);
    E.hull.textContent = s.hp;
    // Show the real firepower multiplier instead of the cannon count, so whether another cannon is worth it is readable at a glance
    E.guns.innerHTML = s.cannons.length
      ? `×${s.cannons.length} <span style="opacity:.7">(firepower ×${Math.pow(s.cannons.length, 0.7).toFixed(2)})</span>`
      : '<span class="bad">none</span>';
    // what you start with / what the rack holds (it used to show the rack as if you started with it: "4" but 1 at the start)
    E.msl.textContent = sp ? `${sp.missileStart} / ${sp.missileMax}` + (s.pylons ? ` (+1 / ${(CFG.missile.reloadPerPylon / s.pylons).toFixed(1)} s)` : '') : '-';
    E.size.textContent = sp ? sp.radius.toFixed(1) : '-';

    let bal = '<span class="up">Balanced</span>';
    if (v.warnings.some(w => w.startsWith('Tail'))) bal = '<span class="down">Tail-heavy</span>';
    else if (v.warnings.some(w => w.startsWith('Nose'))) bal = '<span class="down">Nose-heavy</span>';
    if (v.warnings.some(w => w.startsWith('Lopsided'))) bal += ' <span class="down">· Lopsided</span>';
    E.bal.innerHTML = bal;

    // best result for this plane (by name), for comparing which planes fly best
    const rec = Save.planeRecord(this.bp.name);
    E.best.innerHTML = rec
      ? `wave ${rec.bestWave} · ${rec.bestScore} <span style="opacity:.6">(${rec.runs} run${rec.runs > 1 ? 's' : ''})</span>`
      : '<span style="opacity:.6">not flown yet</span>';

    // issue list + sortie buttons
    this.$('hgIssues').innerHTML =
      v.errors.map(e => `<div class="err">✕ ${e}</div>`).join('') +
      v.warnings.map(w => `<div class="warn">⚠ ${w}</div>`).join('');
    this.$('hgSortie').disabled = !v.ok;
    this.refreshAiTest();
  }

  refreshMine(selectName = null) {
    const sel = this.$('hgMineSel');
    const list = Save.listPlanes();
    sel.innerHTML = '';
    if (!list.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(none saved yet)';
      sel.appendChild(o);
    }
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.name; o.textContent = p.name;
      sel.appendChild(o);
    }
    if (selectName) sel.value = selectName;
  }

  refreshSaveWhere() {
    const host = typeof location !== 'undefined' ? location.hostname : '';
    const local = host === 'localhost' || host === '127.0.0.1' || host === '';
    this.$('hgSaveWhere').innerHTML = Save.where === 'file'
      ? '&#128190; Saving to <b>save.txt</b> in the game folder'
      : local
        ? '&#9888;&#65039; Saving in this browser only (no local server; run start.command to save to save.txt)'
        : '&#128190; Progress is saved in this browser';
  }

  toast(msg, good = false) {
    const t = this.$('hgToast');
    t.textContent = msg;
    t.style.background = good ? 'rgba(102,255,204,.9)' : 'rgba(255,106,90,.9)';
    t.style.color = good ? '#06221a' : '#fff';
    t.style.opacity = '1';
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.style.opacity = '0'; }, 1600);
  }
}
