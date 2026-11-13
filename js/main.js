// js/main.js: wiring and the main loop
// Architecture: update(dt) is separate from render(). All game logic is in update
// and never touches three.js rendering APIs, so it can run headless in tests (see test/headless.mjs).

import * as THREE from 'three';
import { CFG } from './config.js';
import { heightAt, updateTrees, restoreTrees, setMap, BIOMES, getTrees } from './terrain.js';
import { Weather, WEATHER } from './weather.js';
import { TRAINING_MAP, mapLabel } from './maps.js';
import { Plane } from './plane.js';
import { Weapons, pickTarget, pickMissileTarget, interceptPoint } from './weapons.js';
import { Waves, Drops } from './waves.js';
import { HUD } from './hud.js';
import { Hangar } from './hangar.js';
import { computeStats, outsideArea } from './parts.js';
import { specFromStats } from './spec.js';
import { buildBlueprintMesh } from './partMesh.js';
import { randomPreset, cloneBP, DEFAULT_BLUEPRINT } from './blueprint.js';
import { Save } from './save.js';
import { applyPowerup, PowerFX } from './powerups.js';
import { ENEMY_INFO } from './enemies.js';
import { Training, HangarTips } from './tutorial.js';
import { Leaderboard } from './leaderboard.js';
import { partsToText } from './share.js';
import { Quality } from './quality.js';
import { Sound } from './sound.js';
import { Effects } from './effects.js';
import { Sky } from './sky.js';
import { TouchControls, isTouch } from './touch.js';
import { Net } from './net.js';
import { Coop } from './coop.js';
import { Lobby } from './lobby.js';
import { View, installTurnedScroll } from './view.js';
import { standings } from './versus.js';
import { Duelist, Ladder, ladderMap } from './ladder.js';

// Load the save first (save.txt or browser storage); the best score and the last hangar plane come from here
await Save.load();

/* ================= Scene ================= */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fc6e8);
scene.fog = new THREE.Fog(0x8fc6e8, CFG.world.fogNear, CFG.world.fogFar);

const TOUCH = isTouch();
View.update(TOUCH);                     // a portrait-locked phone gets the game drawn sideways (js/view.js)
if (TOUCH) installTurnedScroll();        // ...and then its lists scroll in the game's directions
const camera = new THREE.PerspectiveCamera(CFG.camera.fov, View.w / View.h, 1, 12000);

const renderer = new THREE.WebGLRenderer({ antialias: true, canvas: document.getElementById('gl') });
// phones and tablets: touch controls, and a lower render resolution (their screens are tiny but very dense)
if (TOUCH) document.body.classList.add('touch');
renderer.setPixelRatio(Math.min(devicePixelRatio, TOUCH ? 1.5 : 2));
renderer.setSize(View.w, View.h);

const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x3a4a33, 0.95);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
sun.position.set(600, 1200, 400);
scene.add(sun);
// high graphics quality: gradient sky, clouds and the sun (sky.js); low keeps the plain sky colour
const skyDome = new Sky(scene, sun);
skyDome.setEnabled(Quality.high);
Quality.onChange(() => skyDome.setEnabled(Quality.high));

// mix two 0xRRGGBB colors (t = 0 -> a, 1 -> b)
const mixHex = (a, b, t) => {
  const ch = (v, s) => (v >> s) & 255;
  const m = s => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t) << s;
  return m(16) | m(8) | m(0);
};

// Load a map: ground, trees, water, weather, sky, fog and light
let flightMap = TRAINING_MAP;
const flashEl = document.getElementById('flash');
function applyMap(map) {
  setMap(scene, map);
  Weather.set(scene, map.weather, map.seed);
  const W = WEATHER[map.weather] || WEATHER.clear, B = BIOMES[map.biome] || BIOMES.forest;
  const sky = W.tint != null ? mixHex(B.sky, W.tint, 0.7) : B.sky;
  scene.background = new THREE.Color(sky);
  scene.fog = new THREE.Fog(sky, W.fog[0], W.fog[1]);
  skyDome.setLook(sky, map.weather);
  const dim = 1 - (W.dark || 0);
  hemi.intensity = 0.95 * dim;
  sun.intensity = 1.15 * dim;
  flightMap = map;
  document.getElementById('mapName').textContent = mapLabel(map);
}
applyMap(TRAINING_MAP);

/* ================= Systems ================= */
const plane = new Plane(scene);
const weapons = new Weapons(scene);
const waves = new Waves(scene);
const drops = new Drops(scene);
const fx = new PowerFX(scene);
const effects = new Effects(scene);            // explosions, missile trails, muzzle flashes (effects.js)
weapons.onFire = (p, mounts) => { Sound.shot(mounts.length); effects.muzzle(p, mounts); };
weapons.onLaunch = () => Sound.launch();
// an explosion seen and heard from the local plane: louder and with a little shake when close
function boomAt(pos, size = 1, vel = null) {
  effects.boom(pos, size, vel);
  const d = pos.distanceTo(camera.position);
  const toward = pos.clone().sub(camera.position);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  Sound.boom(size, d, d > 1 ? toward.dot(right) / d : 0);
  if (d < 150 * size) shakeT = Math.max(shakeT, 0.06 * size);
}
// browsers allow sound only after a click, tap or key press
for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, () => Sound.unlock(), { capture: true, passive: true });
const hud = new HUD();

let score = 0;
let best = Save.data.bestScore;
let kills = 0;                  // kills this run (added to the saved total)
let planeName = 'Stock Fighter';
let gameOver = false;
let shakeT = 0;
let mode = 'hangar';            // 'hangar' | 'flight'. The game starts in the hangar.
let snapCamera = true;          // right after a sortie, snap the camera into place instead of swinging it over from its old position
let training = null;            // the first-flight tutorial while it runs (no waves, no game over)
let tips = null;                // one-time hangar tips while they are shown
let testFlight = false;         // free flight from the hangar: no enemies, crashes just respawn, nothing recorded
let flightParts = [];           // the blueprint being flown, saved with the run for balancing
let unranked = false;           // a Creative-mode plane over the normal load budget: not on the normal boards (only the Creative board)
let flightLoad = 0;             // the plane's load (shown on the Creative board)

// Death diagnostics: the bot can't tell what players really die to, so the game records it itself.
const diag = { bullet: 0, ram: 0, drone: 0, terrain: 0, t: 0 };
function resetDiag(){ diag.bullet = 0; diag.ram = 0; diag.drone = 0; diag.terrain = 0; diag.t = 0; }

/* ================= Input ================= */
const keys = Object.create(null);
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (mode === 'hangar') { hangar.onKey(e); return; }   // the hangar has its own shortcuts
  if (paused) {                               // paused: Esc / P resume, nothing else reaches the game
    if (k === 'escape' || k === 'p') resumeGame();
    return;
  }
  if ((k === 'escape' || k === 'p') && canPause()) { pauseGame(); return; }
  if (coop.active) {                          // co-op: Esc twice leaves; after a team wipe R = play again (host), H = leave
    if (k === 'escape' || (k === 'h' && gameOver)) { askLeaveCoop(k === 'h'); return; }
    if (k === 'r' && gameOver && coop.isHost) { coop.start(flightMap); return; }
    if (k === 'r' || k === 'n' || k === 'h') { keys[k] = true; return; }
  }
  if (testFlight && k === 'h') { enterHangar(); return; }
  if (ladder.active && gameOver && (k === 'r' || k === 'n')) { if (k === 'r') ladderAgain(); return; }
  keys[k] = true;
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  if (k === 'r' && gameOver) restart();
  if (k === 'h' && gameOver) enterHangar();
  if (k === 'n' && gameOver) sortie(randomPreset(planeName));   // fly again in a different random sample plane
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
// the game area changed size or was turned (window resized, phone rotated, Flip screen)
function onViewChange() {
  camera.aspect = View.w / View.h;
  camera.updateProjectionMatrix();
  renderer.setSize(View.w, View.h);
  if (!started) return;                  // hangar and touch are created further down
  hangar.resize();
  document.getElementById('hgFlip').style.display = View.rot && !View.sensor ? '' : 'none';
  if (touch) touch.refresh();
}
let started = false;
View.onChange = onViewChange;
addEventListener('resize', () => { if (!View.update(TOUCH)) onViewChange(); });
// iPhone Safari: no pinch zooming the page (the hangar has its own pinch zoom)
if (typeof document.addEventListener === 'function') document.addEventListener('gesturestart', e => e.preventDefault());

function readInput() {
  const k = {
    pitchUp: keys['w'] || keys['arrowup'],
    pitchDown: keys['s'] || keys['arrowdown'],
    rollLeft: keys['a'] || keys['arrowleft'],
    rollRight: keys['d'] || keys['arrowright'],
    yawLeft: keys['q'],
    yawRight: keys['e'],
    throttleUp: keys['shift'],
    throttleDown: keys['control'] || keys['ctrl'],
    fire: keys[' '],
    missile: keys['f'],
  };
  if (!touch) return k;
  // touch values are 0..1 (analog stick / tilt) or true/false (buttons); keep whichever is stronger
  const t = touch.input();
  const out = {};
  for (const name in k) {
    const a = k[name] === true ? 1 : (+k[name] || 0), b = t[name] === true ? 1 : (+t[name] || 0);
    out[name] = Math.max(a, b);
  }
  return out;
}

/* ================= Event callbacks ================= */
// a power-up picked up: its effect, plus the sound
const pickUp = (type, ctx) => { Sound.pickup(); return applyPowerup(type, ctx); };
function onEnemyHit(e, dmg, at) {
  const died = e.hurt(dmg);

  // Boss at half health -> supply drop. Gives this long fight a comeback moment,
  // and gives positive feedback for pressing on instead of a pure health race.
  if (e.type === 'boss' && e.alive && !e.halfSupply &&
      CFG.enemy.boss.halfHealthSupply && e.hp <= e.maxHp * 0.5) {
    e.halfSupply = true;
    drops.spawn(e.pos.clone().add(new THREE.Vector3(60, -40, 0)), 'heal');
    drops.spawn(e.pos.clone().add(new THREE.Vector3(-60, -40, 0)), 'missile');
    hud.message('BOSS AT 50% · SUPPLY DROP', 2.2);
  }

  if (died) boomAt(e.pos, e.type === 'boss' ? 3 : e.type === 'bomber' ? 2 : 1, e.vel);
  if (died && !training) {
    score += e.score;
    kills++;
    if (score > best && !unranked) best = score;          // written to disk in endGame (never for unranked Creative planes)
    drops.spawn(e.pos.clone(), null, e.alwaysDrops);    // bombers always drop something
    if (e.type === 'boss') { hud.message('BOSS DOWN!', 2.5); shakeT = 0.6; }
  }
}
function onPlayerHit(dmg, cause = 'ENEMY FIRE', src = null) {
  if (coop.active && coop.versus) coop.vs.onHit(src);     // versus: remember who hit me (kill credit)
  const before = plane.hp;
  if (plane.hurt(dmg, cause)) {
    Sound.hurt();
    const dealt = before - plane.hp;
    if (cause === 'COLLISION') diag.ram += dealt;
    else if (cause === 'DRONE') diag.drone += dealt;
    else if (cause === 'LIGHTNING') diag.terrain += dealt;          // shown as "Terrain / weather"
    else diag.bullet += dealt;
    shakeT = 0.25;
    if (!plane.alive) planeDown();
  }
}
// the local plane went down: in co-op the team plays on (back next wave), otherwise the run is over
function planeDown() {
  if (ladder.active) { ladderPoint(ladder.playerDown(), 'ai'); return; }
  if (!coop.active) { endGame(); return; }
  shakeT = 0.5;                          // the "YOU ARE DOWN" box (updateCoopDown) says the rest
}
// co-op, while I am down: who I am watching, how many enemies are left, and how to leave (a player waited
// 10 minutes watching a teammate without knowing Esc twice leaves)
let coopDownText = null;
function updateCoopDown() {
  const show = coop.active && !plane.alive && !gameOver;
  const box = document.getElementById('coopDown');
  if (!show) { if (coopDownText !== null) { box.style.display = 'none'; coopDownText = null; } return; }
  if (performance.now() - leaveBtnT > 3000) document.getElementById('coopDownLeave').textContent = coop.versus ? 'Leave' : 'Leave co-op';
  if (coop.versus) {
    const vs = coop.vs, t = Math.max(1, Math.ceil(vs.respawnT));
    const title = vs.killedBy ? `SHOT DOWN BY ${vs.name(vs.killedBy).toUpperCase()}` : 'YOU WENT DOWN';
    const text = title + '|' + `Back in the air in ${t} s.`;
    if (text !== coopDownText) {
      document.getElementById('coopDownT').textContent = title;
      document.getElementById('coopDownSub').textContent = `Back in the air in ${t} s.`;
      coopDownText = text;
    }
    box.style.display = 'block';
    return;
  }
  document.getElementById('coopDownT').textContent = 'YOU ARE DOWN';
  const mate = coop.spectateTarget();
  const left = coop.enemyList().filter(e => e.alive).length;
  const text = `Back in the fight when the next wave starts${left ? ` (${left} enem${left === 1 ? 'y' : 'ies'} left in this one)` : ''}.` +
    (mate ? ` Watching ${mate.name}.` : '');
  if (text !== coopDownText) { document.getElementById('coopDownSub').textContent = text; coopDownText = text; }
  box.style.display = 'block';
}
function endGame() {
  if (testFlight) {                          // test flight: crashing costs nothing, just fly again
    plane.reset();
    snapCamera = true;
    hud.message('CRASHED · TRY AGAIN', 1.6);
    return;
  }
  if (training) {                            // crashing during training: no game over, just try again
    training.respawn();
    snapCamera = true;
    hud.message('CRASHED · TRY AGAIN', 2);
    return;
  }
  if (gameOver) return;
  gameOver = true;
  const acc = recordRunNow();
  const $ = id => document.getElementById(id);
  $('finalPlane').textContent = planeName;
  const rec = Save.planeRecord(planeName);
  $('finalPlaneBest').textContent = rec ? `(best with it: wave ${rec.bestWave})` : '';
  if (unranked) submitCreative($('finalRank'));
  else submitToLeaderboard($('finalRank'));
  showOver(acc);
}
// save this run (local stats; never for unranked Creative planes) -> accuracy %
function recordRunNow() {
  const acc = weapons.shotsFired ? (weapons.shotsHit / weapons.shotsFired * 100) : 0;
  if (!unranked) Save.recordRun({
    score, wave: waves.wave, kills, plane: planeName,
    // per-run detail, kept for the last 20 runs so balance can be tuned on real games instead of the test bot
    detail: {
      parts: flightParts,
      map: mapLabel(flightMap),
      build: CFG.build, time: Math.round(diag.t), acc: Math.round(acc), cause: plane.deathCause || 'ENEMY FIRE',
      dmg: { fire: Math.round(diag.bullet), ram: Math.round(diag.ram), drone: Math.round(diag.drone), terrain: Math.round(diag.terrain) },
    },
  });
  best = Save.data.bestScore;
  return acc;
}
function showOver(acc) {
  const $ = id => document.getElementById(id);
  $('over').style.display = 'flex';
  $('finalScore').textContent = score;
  $('finalWave').textContent = waves.wave;
  $('finalBest').textContent = best;

  // ---- cause of death and damage sources ----
  const causeTxt = { ENDED: 'YOU ENDED THE RUN', TERRAIN: 'CRASHED INTO THE GROUND', BUILDING: 'FLEW INTO A BUILDING', TREE: 'FLEW INTO A TREE', COLLISION: 'MID-AIR COLLISION', DRONE: 'BLOWN UP BY A KAMIKAZE DRONE', LIGHTNING: 'STRUCK BY LIGHTNING' };
  $('finalCause').textContent = causeTxt[plane.deathCause] || 'SHOT DOWN BY ENEMY FIRE';

  const tot = diag.bullet + diag.ram + diag.drone + diag.terrain || 1;
  const pct = v => Math.round(v / tot * 100) + '%';
  $('dmgBullet').textContent = pct(diag.bullet);
  $('dmgRam').textContent = pct(diag.ram);
  $('dmgDrone').textContent = pct(diag.drone);
  $('dmgTerrain').textContent = pct(diag.terrain);
  $('finalCrashes').textContent = plane.treeHits || 0;
  $('finalTime').textContent = diag.t.toFixed(0) + 's';
  $('finalAcc').textContent = acc.toFixed(0) + '%';
}
// Online leaderboard: only runs on today's map, 30 s or more with at least one kill (same 30 s rule as the local stats),
// never training or test flights. Every other map is for fun.
// Take-off ticket: asked for when a run on today's map starts; the server only takes a score that comes with it,
// and only once as much real time has passed as the run claims (so a run can't be made up and sent by hand).
let runTicket = null, runSeq = 0, lastSubmit = null;
function takeOff() {
  const n = ++runSeq;
  runTicket = null;
  // after this tick: co-op, test flights and training mark themselves right after launch()
  Promise.resolve().then(async () => {
    if (n !== runSeq || testFlight || training || coop.role || !(flightMap.daily || ladder.active) || !Leaderboard.enabled()) return;   // Creative runs too (their own board)
    if (lastSubmit) await lastSubmit.catch(() => {});      // the last run's score goes first (it uses the previous ticket)
    const t = await Leaderboard.runStart();
    if (n === runSeq) runTicket = t;
  });
}

// Creative plane (over the load budget or the build area): never on the normal boards or in the local stats, but a run
// on today's map goes on the Creative board (just for fun, with the plane's load)
function submitCreative(el) {
  el.textContent = 'Creative plane: not on the normal boards, not saved';
  if (!Leaderboard.enabled() || diag.t < 30 || score <= 0) return null;
  if (!flightMap.daily) { el.textContent = "Creative plane: only today's map counts for the Creative board"; return null; }
  const ticket = runTicket;
  runTicket = null;
  if (!ticket) { el.textContent = 'Creative board: the game was offline at take-off, so this run is not on it'; return null; }
  el.textContent = 'Creative board: sending...';
  const acc = weapons.shotsFired ? weapons.shotsHit / weapons.shotsFired * 100 : undefined;
  return lastSubmit = Leaderboard.creativeSubmit({ score, wave: waves.wave, time: diag.t, load: flightLoad, day: flightMap.day, ticket, acc }).then(r => {
    if (r.error) el.textContent = `Creative board: ${r.error === 'offline' ? 'offline' : r.error}`;
    else if (!r.rank) el.textContent = 'Creative board: run saved. Lock in your callsign to be listed';
    else el.textContent = `Creative board (load ${flightLoad}): ${r.newBest ? 'new best! ' : ''}#${r.rank} of ${r.total}`;
    return r;
  });
}

function submitToLeaderboard(el) {
  el.textContent = '';
  if (!Leaderboard.enabled() || diag.t < 30 || score <= 0) return null;
  if (!flightMap.daily) { el.textContent = "Only today's map counts for the leaderboard"; return null; }
  const ticket = runTicket;
  runTicket = null;
  if (!ticket) { el.textContent = 'Leaderboard: the game was offline at take-off, so this run is not ranked'; return null; }
  el.textContent = 'Leaderboard: sending...';
  const acc = weapons.shotsFired ? weapons.shotsHit / weapons.shotsFired * 100 : undefined;
  const run = { score, wave: waves.wave, time: diag.t, plane: planeName, day: flightMap.day, acc, ticket, parts: partsToText(flightParts) };
  return lastSubmit = Leaderboard.submit(run).then(r => {
    if (r.error) { el.textContent = r.error === 'offline' ? 'Leaderboard offline' : `Leaderboard: ${r.error}`; return r; }
    // into the top 3 with several warning signs at once (say, a huge jump scored at a superhuman rate): kept off the board
    if (r.held) { el.textContent = 'This run looked too good to be true, so it was kept off the board. If it was real, ask the admin.'; return r; }
    hangar.ranks = { all: { rank: r.rank, total: r.total }, daily: r.daily ? { rank: r.daily.rank, total: r.daily.total } : null };
    if (r.rank === null) {             // not locked in yet: the run is kept and appears once the callsign is locked
      el.textContent = 'Run saved. Lock in your callsign in the hangar to appear on the leaderboard';
      return r;
    }
    const d = r.daily;
    const today = d ? `Today's map: ${d.newBest ? 'new best! ' : ''}rank #${d.rank} of ${d.total}` : '';
    const all = `all time #${r.rank} of ${r.total}`;
    el.textContent = today ? `${today} · ${all}` : `Leaderboard: ${all}`;
    return r;
  });
}

function restart() {
  hidePause();
  gameOver = false;
  document.getElementById('over').style.display = 'none';
  score = 0;
  kills = 0;
  resetDiag();
  plane.reset();
  weapons.clear();
  drops.clear();
  fx.clear();
  waves.reset();
  restoreTrees();                 // stand up the trees knocked over last run
  takeOff();
  snapCamera = true;
  hud.message(`${planeName.toUpperCase()} · TAKE OFF`, 1.8);
}

/* ================= Hangar <-> flight ================= */
// Sortie: blueprint -> derived stats -> flight params + model, swapped onto the player plane
function inRoom() {
  if (!coop.role || coop.started) return false;
  hangar.toast('You are in a multiplayer room: start it or leave it first');
  lobby.open();
  return true;
}
function sortie(bp) {
  if (mode === 'hangar' && inRoom()) return;
  if (coop.role) leaveCoop(false);          // "Random plane" after a co-op game: that is a solo run
  hangar.bp = bp; hangar.save();          // a random sortie plane is also remembered as the last plane, so it's still there back in the hangar
  launch(bp, hangar.selectedMap());
}

function launch(bp, map = flightMap) {
  endLadder();                            // any other flight leaves the AI Ladder (startLadder turns it back on)
  applyMap(map);                          // before restart(): the spawn height depends on the map
  planeName = bp.name || 'Custom';
  flightParts = bp.parts.map(p => [p.type, p.x, p.y, p.z]);
  testFlight = false;
  const st = computeStats(bp.parts);
  unranked = st.load > st.budget || outsideArea(bp.parts) > 0;
  flightLoad = Math.round(st.load);
  // a Creative plane: never on the normal boards; on today's map it goes on the Creative board
  setTag(!unranked ? '' : flightMap.daily ? 'CREATIVE PLANE &nbsp;·&nbsp; CREATIVE BOARD' : "CREATIVE PLANE &nbsp;·&nbsp; JUST FOR FUN (CREATIVE BOARD: TODAY'S MAP ONLY)");
  if (tips) { document.getElementById('hgTip').style.display = 'none'; tips = null; }   // shown again next time
  document.getElementById('planeName').textContent = planeName;
  const spec = specFromStats(computeStats(bp.parts));
  const { group, propellers } = buildBlueprintMesh(bp.parts);
  plane.applySpec(spec, group, propellers);
  hangar.exit();
  mode = 'flight';
  for (const k in keys) keys[k] = false;     // don't carry keys held in the hangar into combat
  document.getElementById('hud').style.display = '';
  if (touch) { touch.show(true); document.getElementById('tExit').style.display = 'none'; document.getElementById('tPause').style.display = ''; }
  overButtons();
  restart();
}

/* ================= Co-op ================= */
// called by coop.js when the host starts: my plane from the hangar on the host's map, side by side with the others
function coopLaunch(map, slot, n) {
  lobby.close();
  launch(cloneBP(hangar.bp), map);
  unranked = true;                         // co-op and versus runs are never recorded on the score boards
  document.body.classList.toggle('vs', coop.versus);
  if (coop.versus) {
    const V = CFG.versus;
    setTag(TOUCH ? '' : `VERSUS &nbsp;·&nbsp; FIRST TO ${V.killsToWin} &nbsp;·&nbsp; ESC TWICE: LEAVE`);
    if (touch) { const x = document.getElementById('tExit'); x.textContent = 'Leave'; x.style.display = ''; document.getElementById('tPause').style.display = 'none'; }
    vsBoardHtml = null;
    hud.message(`VERSUS · ${n} PILOTS`, 3, `First to ${V.killsToWin} kills, or the most kills in ${Math.round(V.timeLimit / 60)} minutes. ` +
      (coop.vs.ranked ? 'Rated match (Elo).' : `Not rated: ${coop.vs.why}.`));
    return;
  }
  setTag(`CO-OP &nbsp;·&nbsp; ${n} PLAYERS &nbsp;·&nbsp; ` + (TOUCH ? 'NOT RANKED' : 'ESC TWICE: LEAVE'));
  if (touch) { const x = document.getElementById('tExit'); x.textContent = 'Leave'; x.style.display = ''; document.getElementById('tPause').style.display = 'none'; }
  plane.pos.x += (slot - (n - 1) / 2) * 90;
  plane.syncMesh();
  hud.message(`CO-OP · ${n} PLAYERS`, 2.5, 'Enemies scale with the team. If you go down, you are back next wave.');
}
// back in the fight at the start of a wave, next to a teammate who is still flying
function coopRespawn() {
  const mate = coop.spectateTarget();
  plane.reset();
  if (mate) {
    plane.pos.copy(mate.pos).add(new THREE.Vector3(0, 40, 0)).addScaledVector(mate.up().cross(mate.forward()), 70);
    plane.pos.y = Math.max(plane.pos.y, heightAt(plane.pos.x, plane.pos.z) + 200);
    plane.quat.copy(mate.quat);
    plane.syncMesh();
  }
  snapCamera = true;
}
// the whole team is down (the host decides and tells everyone)
function coopOver(m) {
  gameOver = true;
  const $ = id => document.getElementById(id);
  $('over').style.display = 'flex';
  $('finalCause').textContent = 'THE WHOLE TEAM IS DOWN';
  $('finalScore').textContent = m.score;
  $('finalWave').textContent = m.wave;
  $('finalBest').textContent = best;
  $('finalPlane').textContent = planeName;
  $('finalPlaneBest').textContent = '';
  $('finalRank').textContent = coop.isHost ? 'Co-op runs are not ranked' : 'Co-op runs are not ranked · waiting for the host to start again';
  overButtons();
  const tot = diag.bullet + diag.ram + diag.drone + diag.terrain || 1;
  const pct = v => Math.round(v / tot * 100) + '%';
  $('dmgBullet').textContent = pct(diag.bullet); $('dmgRam').textContent = pct(diag.ram);
  $('dmgDrone').textContent = pct(diag.drone); $('dmgTerrain').textContent = pct(diag.terrain);
  $('finalCrashes').textContent = plane.treeHits || 0;
  $('finalTime').textContent = diag.t.toFixed(0) + 's';
  const acc = weapons.shotsFired ? weapons.shotsHit / weapons.shotsFired * 100 : 0;
  $('finalAcc').textContent = acc.toFixed(0) + '%';
}
// death panel buttons: solo = Fly again / Random plane / Hangar; co-op = Play again (host only) / Leave co-op
function overButtons() {
  const $ = id => document.getElementById(id);
  const co = coop.active;
  const vs = co && coop.versus;
  $('overR').textContent = vs ? 'Rematch' : co ? 'Play again (same team)' : 'Fly again';
  $('overR').style.display = co && !coop.isHost ? 'none' : '';
  $('overN').style.display = co ? 'none' : '';
  $('overH').textContent = vs ? 'Leave' : co ? 'Leave co-op' : 'Hangar';
  $('overKeys').innerHTML = !co ? SOLO_KEYS : coop.isHost ? `<b>R</b> ${vs ? 'rematch' : 'play again with the same team'} &nbsp;·&nbsp; <b>H</b> leave` : '<b>H</b> leave';
  if (!vs) { $('over').classList.remove('vs'); $('overTitle').textContent = 'SHOT DOWN'; $('overTitle').style.color = ''; }
  if (ladder.active) {
    const won = ladder.result === 'won';
    $('overR').textContent = won ? `Level ${ladder.level + 1}` : 'Try again';
    $('overN').style.display = 'none';
    $('overH').textContent = 'Hangar';
    $('overKeys').innerHTML = `<b>R</b> ${won ? 'next level' : 'try this level again'} &nbsp;·&nbsp; <b>H</b> hangar`;
  }
}
const SOLO_KEYS = document.getElementById('overKeys').innerHTML;
let leaveAskT = 0;
// Leaving: co-op and unrated versus leave on the second press. A rated versus match can't really be locked
// (a tab can always be closed), so leaving one counts as a loss, and the warning says so.
function askLeaveCoop(now = false) {
  if (now || gameOver || performance.now() - leaveAskT < 2500) { leaveCoop(); return; }
  leaveAskT = performance.now();
  if (coop.versus && coop.vs.leavingLoses) hud.message('LEAVING NOW COUNTS AS A LOSS', 2.5, 'You would be placed last and lose rating. Press Esc again to leave anyway.');
  else hud.message(coop.versus ? 'PRESS ESC AGAIN TO LEAVE THE MATCH' : 'PRESS ESC AGAIN TO LEAVE CO-OP', 2.5);
}
// the Leave button in the "down" box: in a rated match the first tap only warns
let leaveBtnT = 0;
function leaveButton() {
  const b = document.getElementById('coopDownLeave');
  if (coop.versus && coop.vs.leavingLoses && performance.now() - leaveBtnT > 3000) {
    leaveBtnT = performance.now();
    b.textContent = 'Tap again: counts as a loss';
    return;
  }
  leaveCoop();
}
function leaveCoop(toHangar = true) {
  coop.end();
  document.body.classList.remove('vs');
  if (touch) document.getElementById('tExit').textContent = 'Hangar';
  if (toHangar) enterHangar();
}
function coopToast(text) {
  if (mode === 'hangar') { hangar.toast(text, true); lobby.render(); }
  else hud.message(text.toUpperCase(), 2.5);
}

// small label at the top of the screen during test flights and unranked Creative runs ('' hides it)
function setTag(html) {
  const t = document.getElementById('testTag');
  t.innerHTML = html;
  t.style.display = html ? 'block' : 'none';
}

// Test flight: try how a build handles, with no enemies. Esc or H goes back to the hangar.
function startTestFlight(bp) {
  if (inRoom()) return;
  launch(bp, hangar.selectedMap());
  testFlight = true;
  setTag(TOUCH ? 'TEST FLIGHT &nbsp;·&nbsp; NO ENEMIES' : 'TEST FLIGHT &nbsp;·&nbsp; NO ENEMIES &nbsp;·&nbsp; H: HANGAR &nbsp;·&nbsp; ESC: MENU');
  if (touch) document.getElementById('tExit').style.display = '';
  hud.message('TEST FLIGHT', 2, 'No enemies · crashing is free · H: back to the hangar · Esc: menu');
}

// Training always uses the Stock Fighter and does not touch the plane saved in the hangar
function startTraining() {
  if (coop.role && inRoom()) return;
  launch(cloneBP(DEFAULT_BLUEPRINT), TRAINING_MAP);
  training = new Training({ plane, waves, drops, weapons, scene, touch: TOUCH });
  hud.message('TRAINING', 2);
}
function endTraining() {
  if (!training) return;
  training.close();
  training = null;
  Save.setFlag('tutorialDone');
  enterHangar();
}

function enterHangar() {
  hidePause();
  endLadder();
  mode = 'hangar';
  testFlight = false;
  setTag('');
  gameOver = false;
  document.getElementById('over').style.display = 'none';
  document.getElementById('hud').style.display = 'none';
  if (touch) touch.show(false);
  weapons.clear(); drops.clear(); fx.clear(); effects.clear(); waves.reset();   // the battlefield is clean when you come back
  hangar.enter();
  if (!Save.data.hangarTipsDone && !tips) {
    tips = new HangarTips(() => { tips = null; Save.setFlag('hangarTipsDone'); afterTips(); }, TOUCH);
  } else if (!tips) {
    afterTips();
  }
  hangar.refreshRanks();                // "Today's map: #3 of 12 · All time: #7 of 40" on the hangar card
}

// after the hangar tips: on a phone in the browser, once, how to add the game to the Home Screen; then the callsign
function afterTips() {
  if (TOUCH && !STANDALONE && !Save.data.installTipDone) { showInstall(); return; }
  hangar.maybeAskCallsign();          // pick a callsign before your runs can appear on the leaderboard
}
function showInstall() {
  document.getElementById('hgInstallBox').style.display = 'block';
}
// started from the Home Screen icon (no browser bars)?
const STANDALONE = (typeof matchMedia === 'function' &&
  (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches)) ||
  (typeof navigator !== 'undefined' && navigator.standalone === true);

/* ================= Pause (solo flights only) =================
   Esc, P or the phone's pause button. Co-op and versus can't pause: the others are still playing.
   A run resumes after a 3-2-1 countdown (3 s: time to get your bearings, and pausing can't be used to study a dodge
   frame by frame); test flights and training resume at once. Ending or
   restarting a run takes two clicks and counts like being shot down: the score is saved and sent to the leaderboard. */
let paused = null;                        // null | { count: null (menu open) or seconds left of the 3-2-1 countdown }
// a 3-2-1 countdown (one second each) to get your bearings again before the fight goes on
const RESUME_COUNT = 3;
const canPause = () => mode === 'flight' && !gameOver && !coop.active;
const realRun = () => !testFlight && !training;
const armed = {};                         // button id -> time of the first click (the second one within 3 s confirms)
function pauseGame() {
  if (!canPause()) return;
  if (!paused) paused = { count: null };
  paused.count = null;
  for (const k in keys) keys[k] = false;
  if (touch) touch.release();
  showPauseMenu();
}
function showPauseMenu() {
  const $ = id => document.getElementById(id);
  $('pauseBox').style.display = 'flex';
  $('pauseMenu').style.display = '';
  $('pauseCount').style.display = 'none';
  const real = realRun();
  for (const id of ['pauseRestart', 'pauseEnd']) { $(id).style.display = real ? '' : 'none'; disarm(id); }
  $('pauseHangar').style.display = real ? 'none' : '';
  $('pauseHangar').textContent = training ? 'Skip training' : 'Back to the hangar';
  $('pauseInfo').textContent = ladder.active ? `AI Ladder · level ${ladder.level} · you ${ladder.me} - ${ladder.ai} AI`
    : real ? `Wave ${waves.wave} · score ${score}` + (flightMap.daily && !unranked ? " · today's map (ranked)" : '')
    : testFlight ? 'Test flight' : 'Training';
  $('pausePerf').textContent = Quality.readout();
  $('pauseSound').textContent = `Sound: ${Sound.on() ? 'ON' : 'OFF'}`;
  $('pauseNote').textContent = ladder.active ? 'Restart starts this level over. End run goes back to the hangar (your ladder progress is kept).'
    : real ? 'Restart and End run need two clicks. Both count like being shot down: this run\'s score is saved.' : '';
}
function hidePause() { paused = null; document.getElementById('pauseBox').style.display = 'none'; }
function resumeGame() {
  if (!paused || paused.count !== null) return;
  if (!realRun()) { hidePause(); return; }
  paused.count = RESUME_COUNT;
  document.getElementById('pauseMenu').style.display = 'none';
  document.getElementById('pauseCount').style.display = '';
}
const LABELS = { pauseRestart: 'Restart', pauseEnd: 'End run' };
function disarm(id) { armed[id] = 0; document.getElementById(id).textContent = LABELS[id]; document.getElementById(id).classList.remove('armed'); }
// first click arms the button ("Click again to ..."), a second click within 3 s does it
function confirmClick(id, action) {
  const now = performance.now();
  if (armed[id] && now - armed[id] < 3000) { disarm(id); action(); return; }
  armed[id] = now;
  const b = document.getElementById(id);
  b.textContent = id === 'pauseRestart' ? 'Click again to restart' : 'Click again to end the run';
  b.classList.add('armed');
}
function pauseRestart() {
  hidePause();
  if (ladder.active) { startLadder(ladder.level); return; }
  if (!unranked) { recordRunNow(); submitToLeaderboard({ textContent: '' }); } else submitCreative({ textContent: '' });
  const had = score;
  restart();
  if (had > 0 && !unranked) hud.message(`LAST RUN SAVED · ${had}`, 1.8, `${planeName.toUpperCase()} · TAKE OFF`);
}
function pauseEnd() {
  hidePause();
  if (ladder.active) { enterHangar(); return; }
  plane.deathCause = 'ENDED';
  endGame();
}
// the tab went into the background (or the phone was locked): come back to the pause menu, not mid-dogfight
if (typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });
}

/* ================= AI Ladder =================
   1v1 against an AI pilot (js/ladder.js), first to CFG.ladder.killsToWin. Winning unlocks the next level; losing just
   means trying the same level again. Each kill ends a round and both planes start fresh. The server keeps each pilot's
   highest level (AI Ladder board); a level counts there only with the take-off ticket, like a ranked run. */
const ladder = new Ladder();
let duelist = null;
let ladderShots = 0, ladderHits = 0;
// AI Ladder levels counted on the board today (at most perDay a day); past that, levels are practice until 00:00 UTC
let ladderToday = { n: 0, perDay: 15, level: 0 };
const ladderPractice = () => ladderToday.n >= ladderToday.perDay;   // cannon shots and hits over the whole level (weapons.clear() resets each round)

function dropDuelist() {
  if (!duelist) return;
  duelist.remove();
  const i = waves.enemies.indexOf(duelist);
  if (i >= 0) waves.enemies.splice(i, 1);
  duelist = null;
}
function spawnDuelist() {
  dropDuelist();
  duelist = new Duelist(scene, ladder.level, ladder.aiStart(plane.pos));
  duelist.face(ladder.aiFacing());
  duelist.onFlare = () => hud.message('FLARES · YOUR MISSILE WAS DECOYED', 1.2);
  waves.enemies.push(duelist);        // so the cannon, missiles, lock-on, lead marker and radar all see it
}
function startLadder(level) {
  if (mode === 'hangar' && inRoom()) return;
  if (coop.role) leaveCoop(false);
  const bp = cloneBP(hangar.bp);
  const st = computeStats(bp.parts);
  if (st.load > st.budget || outsideArea(bp.parts) > 0) {
    if (mode !== 'hangar') enterHangar();
    hangar.toast('A Creative plane over the load budget or the build area cannot fly the AI Ladder');
    return;
  }
  launch(bp, ladderMap(level));
  // the ladder keeps its own missile reload (its levels were tuned with it, see CFG.ladder.reloadPerPylon)
  if (plane.P.missileReload > 0) plane.P.missileReload *= CFG.ladder.reloadPerPylon / CFG.missile.reloadPerPylon;
  ladder.begin(level);
  ladderShots = 0; ladderHits = 0;
  weapons.missileMul = CFG.ladder.missileMul;
  spawnDuelist();
  document.body.classList.add('vs');  // the score box makes way for the ladder board
  const S = ladder.skill;
  hud.message(`AI LADDER · LEVEL ${ladder.level}`, 3, ladderPractice()
    ? `PRACTICE: ${ladderToday.perDay} levels already counted today, this one is not ranked (counts again from 00:00 UTC)`
    : `${S.rank} in a ${S.plane} · first to ${CFG.ladder.killsToWin} kills`);
}
function endLadder() {
  if (!ladder.active) return;
  ladder.end();
  dropDuelist();
  document.body.classList.toggle('vs', !!(coop.active && coop.versus));
}
// the hangar's AI Ladder button: carry on from the highest level cleared (the server's record if it has one)
async function openLadder() {
  if (inRoom()) return;
  let done = Save.data.ladderLevel || 0;
  if (Leaderboard.enabled() && Leaderboard.me()) {
    const r = await Leaderboard.top('ladder');
    if (r && !r.error && r.me && Number.isInteger(r.me.level)) {
      done = r.me.level; Save.setLadder(done);
      ladderToday = { n: r.me.today || 0, perDay: r.me.perDay || 15, level: r.me.level };
    }
  }
  if (mode === 'hangar') startLadder(done + 1);
}
function ladderAgain() { startLadder(ladder.result === 'won' ? ladder.level + 1 : ladder.level); }

function updateLadder(dt) {
  const input = readInput();
  flyPlane(dt, input);
  updateTrees(dt);
  const foes = waves.enemies;
  aim(foes);
  if (plane.alive && input.fire) weapons.fireGun(plane, foes);
  if (plane.alive && input.missile && missileTarget) launchMissiles(foes, missileTarget);
  weapons.update(dt, { enemies: foes, plane, onEnemyHit: ladderHit, onPlayerHit });
  if (duelist) duelist.update(dt, plane, weapons);
  if (plane.ramCd > 0) plane.ramCd -= dt;
  if (duelist && duelist.alive && plane.alive && plane.ramCd <= 0) {
    const rr = duelist.radius + plane.P.radius;
    if (duelist.pos.distanceToSquared(plane.pos) < rr * rr) {
      plane.ramCd = CFG.plane.ramCooldown;
      shakeT = 0.3;
      ladderHit(duelist, CFG.ladder.ramDamage);
      onPlayerHit(CFG.ladder.ramDamage, 'COLLISION');
    }
  }
  if (gameOver) return;
  const ev = ladder.tick(dt, plane.alive ? plane.hp / plane.P.hp : 0, duelist && duelist.alive ? duelist.hp / duelist.maxHp : 0);
  if (ev === 'time') {
    hud.message('TIME · DRAW', 2.2, 'Only a kill wins a round: this one is flown again');
    if (ladder.result) { ladderOver(); return; }
  }
  if (ev === 'round') newLadderRound();
  fx.update(dt, plane);
  Weather.update(dt, { plane, camera, enemies: foes, onPlayerHit, onEnemyHit: ladderHit });
  diag.t += dt;
}
function ladderHit(e, dmg) {
  if (e !== duelist || !e.hurt(dmg)) return;
  e.mesh.visible = false;
  boomAt(e.pos, 2, e.vel);
  hud.message('AI SHOT DOWN', 1.8);
  ladderPoint(ladder.aiDown(), 'me');
}
// a round is over (who = 'me' when the AI went down, 'ai' when I did)
function ladderPoint(result, who) {
  if (who === 'ai') { hud.message('SHOT DOWN', 1.8, result ? '' : 'Next round in a moment'); shakeT = 0.5; }
  if (result && !gameOver) ladderOver();
}
function newLadderRound() {
  // missiles: whoever went down starts the next round with a fresh rack; a round you won, you keep what you have
  // left (the pylons keep reloading), so a whole level can't be won by emptying a full rack every round
  const keep = ladder.lastPoint === 'me' ? plane.missiles : null;
  plane.reset();
  if (keep !== null) plane.missiles = keep;
  ladderShots += weapons.shotsFired; ladderHits += weapons.shotsHit;
  weapons.clear();
  weapons.missileMul = CFG.ladder.missileMul;
  snapCamera = true;
  spawnDuelist();
  hud.message(`ROUND ${ladder.round}`, 1.5, `You ${ladder.me} - ${ladder.ai} AI`);
}
function ladderOver() {
  gameOver = true;
  const $ = id => document.getElementById(id);
  const won = ladder.result === 'won', lv = ladder.level, S = ladder.skill;
  overButtons();
  $('over').classList.add('vs');
  $('over').style.display = 'flex';
  $('overTitle').textContent = won ? `LEVEL ${lv} CLEARED` : `LEVEL ${lv} LOST`;
  $('overTitle').style.color = won ? 'var(--gold)' : '';
  $('finalCause').textContent = `AI Ladder · ${S.rank} in a ${S.plane}`;
  $('vsTable').innerHTML = '<tr><th>Pilot</th><th>Kills</th></tr>' +
    `<tr class="me"><td>You</td><td>${ladder.me}</td></tr><tr><td>AI ${escHtml(S.rank)}</td><td>${ladder.ai}</td></tr>`;
  $('vsWait').textContent = won ? '' : 'Your progress is kept: try this level as often as you like.';
  const el = $('vsElo');
  el.textContent = '';
  if (!won) return;
  if (lv > (Save.data.ladderLevel || 0)) Save.setLadder(lv);
  const ticket = runTicket;
  runTicket = null;
  if (!Leaderboard.enabled()) { el.textContent = `Level ${lv + 1} unlocked`; return; }
  if (!ticket) { el.textContent = `Level ${lv + 1} unlocked on this device (the game was offline at take-off, so the AI Ladder board did not get it)`; return; }
  el.textContent = `Level ${lv + 1} unlocked · AI Ladder board: sending...`;
  const shots = ladderShots + weapons.shotsFired, hits = ladderHits + weapons.shotsHit;
  lastSubmit = Leaderboard.ladderClear({ level: lv, time: diag.t, kills: ladder.me, deaths: ladder.ai, ticket, shots, acc: shots ? hits / shots * 100 : undefined }).then(r => {
    if (r.capped) {
      ladderToday = { ...ladderToday, n: ladderToday.perDay, level: r.level };
      el.textContent = `Practice, not ranked: ${ladderToday.perDay} levels already counted today. From 00:00 UTC the AI Ladder board goes on from level ${r.level + 1}.`;
    } else if (r.status === 409 && Number.isInteger(r.level)) {
      el.textContent = `Practice, not ranked: the AI Ladder board has you at level ${r.level}, so it goes on from level ${r.level + 1}.`;
    } else if (r.error) el.textContent = `Level ${lv + 1} unlocked · AI Ladder board: ${r.error === 'offline' ? 'offline' : r.error}`;
    else {
      ladderToday = { ...ladderToday, n: ladderToday.n + 1, level: r.level };
      Save.setLadder(Math.max(r.level, Save.data.ladderLevel || 0));
      el.textContent = `Level ${lv + 1} unlocked · ` + (r.rank ? `AI Ladder #${r.rank} of ${r.total}` : 'lock in your callsign to be listed on the AI Ladder board');
    }
    return r;
  });
}
// the small board at the top: level, round, clock, kills, the AI's hull
function updateLadderBoard(el) {
  const S = ladder.skill, t = Math.ceil(ladder.timeLeft());
  const hull = duelist && duelist.alive ? Math.round(duelist.hp / duelist.maxHp * 100) : 0;
  const html = `<div class="vsTime">${ladderPractice() ? 'PRACTICE · ' : ''}LEVEL ${ladder.level} · ROUND ${ladder.round} · ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} · first to ${CFG.ladder.killsToWin}</div>` +
    `<div class="vsRow me"><span></span>You<b>${ladder.me}</b></div>` +
    `<div class="vsRow"><span></span>AI ${escHtml(S.rank)} (${escHtml(S.plane)})<b>${ladder.ai}</b></div>` +
    `<div class="vsFeed">AI hull ${hull}%</div>`;
  el.style.display = 'block';
  if (html !== vsBoardHtml) { el.innerHTML = html; vsBoardHtml = html; }
}

/* ================= Main loop ================= */
let target = null, leadPoint = null, missileTarget = null;

// fly the local plane one step (shared by solo, co-op host and co-op guest). Returns false if it went down just now.
function flyPlane(dt, input) {
  if (!plane.alive) return false;
  const hpBefore = plane.hp;
  const treeBefore = plane.treeHits;
  plane.update(dt, input);
  if (plane.alive) plane.pos.addScaledVector(Weather.wind, dt);   // wind drift (0 in clear weather)
  if (plane.treeHits > treeBefore || plane.deathCause === 'TERRAIN' || plane.deathCause === 'BUILDING') diag.terrain += hpBefore - plane.hp;
  if (!plane.alive) { planeDown(); return false; }
  return true;
}
// locking and lead (the cannon uses a narrower cone, missiles a wider one)
function aim(enemies) {
  target = plane.alive ? pickTarget(plane.pos, plane.forward(), enemies, CFG.missile.lockRange * Weather.vis, CFG.missile.lockCone) : null;
  // where a missile would go: the nearest target that the missiles already in the air won't kill anyway
  missileTarget = plane.alive ? pickMissileTarget(plane.pos, plane.forward(), enemies, CFG.missile.lockRange * Weather.vis, CFG.missile.lockCone, weapons.missiles) : null;
  leadPoint = null;
  if (target) {
    const tv = target.vel ? target.vel.clone() : new THREE.Vector3();
    leadPoint = interceptPoint(plane.pos, CFG.gun.speed, target.pos, tv);
  }
}

// fire a missile at `first`; with Twin Cannon every other launch adds a free second missile, aimed at the next target
// the salvo has not taken care of yet (or the same one). onFired(target) runs for each missile that left.
function launchMissiles(enemies, first, onFired = null) {
  if (!weapons.fireMissile(plane, first)) return;
  if (onFired) onFired(first);
  if (!weapons.pairDue(plane)) return;
  const second = pickMissileTarget(plane.pos, plane.forward(), enemies, CFG.missile.lockRange * Weather.vis, CFG.missile.lockCone, weapons.missiles) || first;
  weapons.fireMissile(plane, second, true);
  if (onFired) onFired(second);
}

function update(dt) {
  if (gameOver) return;
  if (ladder.active) { updateLadder(dt); return; }
  if (coop.active && coop.versus) { updateVersus(dt); return; }
  if (coop.active && coop.isGuest) { updateGuest(dt); return; }
  const input = readInput();

  const flying = flyPlane(dt, input);
  updateTrees(dt);                                            // falling animation for knocked-over trees
  if (!flying && !coop.active) return;                        // solo: the run just ended

  aim(waves.enemies);
  if (plane.alive && input.fire) weapons.fireGun(plane, waves.enemies);
  if (plane.alive && input.missile && missileTarget) launchMissiles(waves.enemies, missileTarget);

  weapons.update(dt, { enemies: waves.enemies, plane, onEnemyHit, onPlayerHit });

  const prevWave = waves.wave;
  let ev = null;
  if (training) {
    if (training.update(dt)) { endTraining(); return; }
  } else if (!testFlight) {
    ev = waves.update(dt, plane, weapons);
    weapons.missileMul = 1 + Math.max(0, waves.wave - 1) * CFG.missile.damagePerWave;   // missiles keep up with enemy hp
  }
  if (ev === 'wave-start' && coop.active && !plane.alive) {
    coopRespawn();                                  // co-op host: back in the fight
    hud.message('BACK IN THE FIGHT', 2);
  } else if (ev === 'wave-start' && prevWave > 0) {
    // heal a bit after each cleared wave: the only reliable healing, and it gives the waves a rhythm
    const before = plane.hp;
    plane.heal(CFG.wave.clearHeal);
    if (plane.hp > before) hud.message(`WAVE CLEAR  +${Math.round(plane.hp - before)} HP`, 1.6);
  }
  if (ev === 'wave-start') {
    Sound.wave();
    // the first time a new enemy type shows up in a run, say what it is and how to deal with it
    const intro = waves.newTypes.map(t => ENEMY_INFO[t]).filter(Boolean);
    let text, sub = '';
    if (intro.length) {
      text = `WAVE ${waves.wave} · NEW: ${intro.map(i => i.name).join(' + ')}`;
      sub = intro.map(i => i.tip[0].toUpperCase() + i.tip.slice(1)).join(' · ');
      hud.message(text, 4.5, sub);
    } else {
      text = waves.bossWave ? `WAVE ${waves.wave} · BOSS INCOMING` : `WAVE ${waves.wave}`;
      hud.message(text, 2.2);
    }
    if (coop.active) coop.hostWave(waves.wave, text, sub);   // guests: respawn or heal, and the same banner
  }

  // --- ramming ---
  // Note: collision damage needs a cooldown AND must push the player out.
  // Small enemies explode on impact, so they only count once; but the boss doesn't disappear,
  // so while you are inside its radius it deals damage EVERY FRAME: 30 damage x 60fps = 1800 DPS, instant death.
  if (plane.ramCd > 0) plane.ramCd -= dt;
  for (const e of waves.enemies) {
    if (!e.alive || !plane.alive) continue;
    const rr = Math.max(e.blastRadius || 0, e.radius + plane.P.radius);   // bigger builds hit things more easily; drones use a proximity fuse
    const d2 = e.pos.distanceToSquared(plane.pos);
    if (d2 >= rr * rr) continue;

    if (e.solid) {
      // boss and bomber: push the player out first so they don't stay stuck inside scraping
      const n = plane.pos.clone().sub(e.pos);
      if (n.lengthSq() < 1e-6) n.set(0, 1, 0);
      n.normalize();
      plane.pos.copy(e.pos).addScaledVector(n, rr + 6);
      if (plane.ramCd <= 0) {
        onPlayerHit(e.ramDamage, 'COLLISION');
        plane.ramCd = CFG.plane.ramCooldown;
        shakeT = 0.3;
      }
    } else {
      // a kamikaze drone always explodes on you, even inside the ram cooldown (that is its whole job)
      if (plane.ramCd <= 0 || e.type === 'drone') {
        onPlayerHit(e.ramDamage, e.type === 'drone' ? 'DRONE' : 'COLLISION');
        plane.ramCd = CFG.plane.ramCooldown;
        if (e.type === 'drone') shakeT = 0.35;
      }
      onEnemyHit(e, 9999, e.pos);   // small enemies trade with you (counted once)
    }
  }

  // drop pickup
  for (const type of drops.update(dt, plane)) {
    const txt = pickUp(type, { plane, weapons, enemies: waves.enemies, onEnemyHit, fx });
    hud.message(txt, 1.6);
    if (type === 'emp' && coop.active) net.broadcast({ t: 'emp', p: [plane.pos.x, plane.pos.y, plane.pos.z] }, true);
  }
  fx.update(dt, plane);

  const targets = coop.active ? [plane, ...coop.teammates()] : null;
  Weather.update(dt, { plane, camera, enemies: waves.enemies, onPlayerHit, onEnemyHit, targets });
  if (!plane.alive && !coop.active) { endGame(); return; }
  if (coop.active) {
    coop.hostTick(dt);
    if (coop.checkTeamOver()) return;
  }

  diag.t += dt;
}

// versus (host and guests alike): my plane, my shots, the other players; versus.js keeps the rules
function updateVersus(dt) {
  // paused (someone's game is in the background): nothing moves, but we keep talking so we know when they are back
  if (coop.vs.paused) {
    if (coop.isHost) coop.hostTick(dt); else coop.guestTick(dt, weapons.bullets.length);
    if (!coop.vs.paused) return;
    updatePauseBox();
    return;
  }
  updatePauseBox();
  const input = readInput();
  flyPlane(dt, input);
  updateTrees(dt);
  const foes = coop.teammates().filter(r => r.alive);
  aim(foes);
  const nb = weapons.bullets.length;
  if (plane.alive && input.fire) weapons.fireGun(plane, foes);
  if (plane.alive && input.missile && target) launchMissiles(foes, target, t => coop.vs.missileFired(t));
  coop.vs.tick(dt, nb);
  // my bullets vanish when they reach another plane here too, but only that player's game counts the hit
  weapons.update(dt, { enemies: foes, plane, onEnemyHit: (e, dmg) => coop.vs.landed(e, dmg), onPlayerHit });
  if (coop.isHost) {
    for (const type of drops.update(dt, plane)) hud.message(pickUp(type, { plane, weapons, enemies: [], onEnemyHit: () => {}, fx }), 1.6);
    coop.hostTick(dt);
  } else {
    coop.guestTick(dt, weapons.bullets.length);
  }
  fx.update(dt, plane);
  Weather.update(dt, { plane, camera, enemies: [], onPlayerHit, onEnemyHit: () => {}, targets: coop.isHost ? [plane, ...coop.teammates()] : null });
  diag.t += dt;
}

// versus: "PAUSED · X's game is in the background · 23 s to come back"
function updatePauseBox() {
  const p = coop.active && coop.versus ? coop.vs.paused : null;
  const el = document.getElementById('vsPause');
  if (!p) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const who = p.peer === coop.vs.me ? 'Your game' : `${escHtml(p.name)}'s game`;
  el.innerHTML = `<b>PAUSED</b><div>${who} is in the background.</div><div>${Math.ceil(p.left)} s to come back, or it counts as leaving (a loss).</div>`;
}

// the small scoreboard at the top in versus: clock, then every pilot's kills / deaths
let vsBoardHtml = null;
function updateVsBoard() {
  const el = document.getElementById('vsBoard');
  if (ladder.active) { updateLadderBoard(el); return; }
  const on = coop.active && coop.versus;
  el.style.display = on ? 'block' : 'none';
  if (!on) return;
  const vs = coop.vs, t = Math.ceil(vs.timeLeft), me = vs.me;
  const rows = standings(vs.rows.map(r => ({ ...r })));
  const feed = vs.feed && vs.clock - vs.feed.t < 4 ? `<div class="vsFeed">${escHtml(vs.feed.text)}</div>` : '';
  const html = `<div class="vsTime">${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} &nbsp;·&nbsp; first to ${CFG.versus.killsToWin}</div>` +
    rows.map(r => `<div class="vsRow${r.peer === me ? ' me' : ''}"><span>${r.place}</span>${escHtml(r.name)}${r.left ? ' <span class="vsLeft">left</span>' : ''}<b>${r.kills}</b><i>${r.deaths}</i></div>`).join('') + feed;
  if (html !== vsBoardHtml) { el.innerHTML = html; vsBoardHtml = html; }
}
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// versus: someone went down (host told everyone); say it big if it was me or my kill
function onVersusScore(m) {
  const me = coop.vs.me;
  if (m.k === me) hud.message(`YOU SHOT DOWN ${coop.vs.name(m.v).toUpperCase()}`, 2.2);   // (when I go down, the box says it)
}

// versus: the match is over. Final table, and the rating change if it was a rated match
function onVersusOver(m) {
  gameOver = true;
  const $ = id => document.getElementById(id);
  const me = coop.vs.me, mine = m.rows.find(r => r.peer === me);
  $('over').classList.add('vs');
  $('over').style.display = 'flex';
  const won = mine && mine.place === 1;
  $('overTitle').textContent = won ? 'VICTORY' : 'MATCH OVER';
  $('overTitle').style.color = won ? 'var(--gold)' : '';
  const quitters = m.rows.filter(r => r.left && r.peer !== me).map(r => r.name);
  if (mine && mine.left) m = { ...m, reason: 'away' };           // I am the one who was taken out
  const why = { kills: `${m.rows[0].name} reached ${CFG.versus.killsToWin} kills`, time: 'Time is up',
    left: quitters.length ? `${quitters.join(' and ')} left the match (counts as a loss)` : 'Everyone else left',
    away: `Your game was in the background for over ${CFG.versus.awayLimit} s: that counts as leaving (a loss)` }[m.reason] || '';
  $('finalCause').textContent = why;
  $('vsTable').innerHTML = '<tr><th>#</th><th>Pilot</th><th>Kills</th><th>Deaths</th></tr>' + m.rows.map(r =>
    `<tr class="${r.peer === me ? 'me' : ''}"><td>${r.place}</td><td>${escHtml(r.name)}${r.left ? ' <span class="vsLeft">left</span>' : ''}</td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('');
  const elo = $('vsElo');
  const result = coop.vs.result();
  if (!m.ranked) elo.textContent = `Not rated: ${m.why || 'unrated match'}`;
  else if (!result || !Leaderboard.me()) elo.textContent = 'Not rated: missing pilot number';
  else {
    elo.textContent = 'Rating: sending the result...';
    Leaderboard.pvpReport(m.match, result, undefined, undefined, coop.vs.dealtTable()).then(r => {
      if (r.error) elo.textContent = r.error === 'offline' ? 'Rating: leaderboard offline' : `Rating: ${r.error}`;
      else if (r.status === 'applied' && r.suspect) elo.textContent = 'Not rated: a pilot took far more hits than a plane can survive';
      else if (r.status === 'applied' && r.capped) elo.textContent = 'Not rated: this group already played 10 rated matches today';
      else if (r.status === 'applied') elo.textContent = `Rating ${r.rating} (${r.delta >= 0 ? '+' : ''}${Math.round(r.delta)}) · ${r.wins} win${r.wins === 1 ? '' : 's'} in ${r.games} match${r.games === 1 ? '' : 'es'}`;
      else elo.textContent = 'Rating: waiting for another pilot\'s game to confirm the result (it counts once two agree)';
    });
  }
  $('vsWait').textContent = coop.isHost ? '' : 'Waiting for the host to start a rematch';
  overButtons();
}

// co-op guest: my plane flies here; the enemies, drops and score come from the host
function updateGuest(dt) {
  const input = readInput();
  flyPlane(dt, input);
  updateTrees(dt);
  const enemies = coop.enemyList();
  aim(enemies);
  const nb = weapons.bullets.length;
  if (plane.alive && input.fire) weapons.fireGun(plane, enemies);
  if (plane.alive && input.missile && missileTarget) launchMissiles(enemies, missileTarget, t => net.send('h', { t: 'ms', id: t.id }, true));
  coop.guestTick(dt, nb);                   // before weapons.update, which removes spent bullets
  // my bullets vanish on the host's enemies here too, but only the host decides the damage
  weapons.update(dt, { enemies, plane, onEnemyHit: () => {}, onPlayerHit });
  fx.update(dt, plane);
  Weather.update(dt, { plane, camera, enemies, onPlayerHit, onEnemyHit: () => {} });
  diag.t += dt;
}

function render(dt) {
  const C = CFG.camera;
  flashEl.style.opacity = String(Weather.flash * 0.3);    // lightning flash (0.75 before: a whole-screen bright flash is a photosensitivity risk)
  // co-op: while I am down the camera follows a teammate who is still flying
  const subj = (!plane.alive && coop.active && coop.spectateTarget()) || plane;
  const fwd = subj.forward();
  const up = subj.up();

  // the camera follows only part of the roll. Full follow is nauseating; this is the key anti-motion-sickness setting
  const camUp = new THREE.Vector3(0, 1, 0).lerp(up, C.rollFollow).normalize();
  const want = subj.pos.clone()
    .addScaledVector(fwd, -C.dist)
    .addScaledVector(camUp, C.height);

  if (snapCamera) { camera.position.copy(want); snapCamera = false; }
  else camera.position.lerp(want, Math.min(1, C.lerp * dt));
  const look = subj.pos.clone().addScaledVector(fwd, C.lookAhead);
  camera.up.copy(camUp);
  camera.lookAt(look);

  // (counted down here where it is used, not in update(): update stops at game over, and a shake started by the
  // hit that ended the run used to stay on for good, the plane jittering behind the results)
  if (shakeT > 0) {
    const s = shakeT * 6;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
    shakeT = Math.max(0, shakeT - dt);
  }

  // sense of speed: faster = wider field of view
  const t = (subj.speed - plane.P.speedMin) / Math.max(1, plane.P.speedMax - plane.P.speedMin);
  camera.fov += ((C.fov + t * C.fovSpeedGain) - camera.fov) * Math.min(1, 4 * dt);
  camera.updateProjectionMatrix();

  skyDome.update(dt, camera);
  renderer.render(scene, camera);
}

let last = performance.now();
// Planes going down, mine or other players' (co-op / versus): they explode where they fell. Mine also disappears, so
// it does not sit behind the results screen (it used to sit there shaking, see the camera shake in render()).
let meAlive = false;
const othersAlive = new Map();
function watchDowns() {
  if (meAlive && !plane.alive && plane.deathCause !== 'ENDED') {
    boomAt(plane.pos, 1.5, plane.forward().multiplyScalar(plane.speed));   // (1.5: the camera is close)
    plane.mesh.visible = false;
  }
  meAlive = plane.alive;
  if (!coop.active) { othersAlive.clear(); return; }
  for (const r of coop.teammates()) {
    const was = othersAlive.get(r);
    if (was && !r.alive && r.pos) boomAt(r.pos, 2);
    othersAlive.set(r, !!r.alive);
  }
}

function loop(now) {
  View.check();                          // the page size changed without a resize event (iOS): fit the game again
  if (mode === 'flight' && !paused && document.visibilityState !== 'hidden') Quality.sample(now - last);   // (quality.js)
  const dt = Math.min((now - last) / 1000, 0.05);   // clamp, so switching tabs doesn't cause one huge frame step
  last = now;
  if (mode === 'hangar') {
    Sound.engine(false);
    hangar.update(dt);
    // a window (leaderboard, stats, ...) covers the plane: stop drawing it, so scrolling the window stays smooth on
    // phones (the screen keeps the last picture)
    if (!hangar.modalOpen()) renderer.render(hangar.scene, hangar.camera);
  } else {
    if (paused) {
      if (paused.count !== null) {                  // 3-2-1, then go
        paused.count -= dt;
        document.getElementById('pauseCount').textContent = Math.max(1, Math.ceil(paused.count / (RESUME_COUNT / 3)));
        if (paused.count <= 0) hidePause();
      }
    } else update(dt);
    const guest = coop.active && coop.isGuest, vs = coop.active && coop.versus;
    const foes = vs ? coop.teammates().filter(r => r.alive) : null;
    // versus: other players' missiles homing on me (not the AI Ladder's: its difficulty was tuned without a warning)
    const incoming = vs ? weapons.pvpMissiles.filter(m => m.mine && m.target === plane && m.owner !== 'ai') : debugIncoming;
    if (!paused) {
      effects.update(dt, weapons);
      watchDowns();
      if (incoming.length) Sound.warn(Math.min(...incoming.map(m => m.pos.distanceTo(plane.pos))));
    }
    const P = plane.P || {};
    Sound.engine(!paused && plane.alive && !gameOver, plane.speed,
      P.speedMax > P.speedMin ? (plane.speed - P.speedMin) / (P.speedMax - P.speedMin) * 2 - 1 : 0, P.jetShare || 0);
    hud.update(dt, {
      plane, enemies: vs ? foes : coop.active ? coop.enemyList() : waves.enemies, camera, target: missileTarget || target, leadPoint,
      score: vs ? (coop.vs.row(coop.vs.me) || { kills: 0 }).kills : guest ? coop.score : score, best, wave: vs || ladder.active ? '-' : guest ? coop.wave : waves.wave,
      drops: coop.active ? coop.dropList() : drops.list, mates: coop.active && !vs ? coop.teammates() : [], foes: foes || [],
      incoming,
    });
    updateCoopDown();
    updateVsBoard();
    render(dt);
  }
  requestAnimationFrame(loop);
}

const hangar = new Hangar(renderer, sortie, startTraining, startTestFlight);
hangar.prepareTest = () => applyMap(TRAINING_MAP);   // the AI Test and Design Duel fly on the training map, clear weather

const net = new Net();
const coop = new Coop({
  scene, plane, weapons, waves, drops, fx, hud, net, Weather, onEnemyHit, onPlayerHit,
  applyPowerup: (t, c) => (c.plane === plane ? pickUp(t, c) : applyPowerup(t, c)),   // (my own pickups make the sound)
  launch: coopLaunch, leave: () => leaveCoop(), toast: coopToast, score: () => score, respawn: coopRespawn,
});
coop.onOver = coopOver;
const lobby = new Lobby(hangar, coop, () => hangar.selectedMap());
coop.vs.onScore = onVersusScore;
coop.vs.onOver = onVersusOver;
coop.vs.onBegin = () => { if (coop.vs.ranked && Leaderboard.me()) Leaderboard.pvpStart(coop.vs.match); };
coop.vs.onRespawn = () => { snapCamera = true; hud.message('BACK IN THE AIR', 1.5); };

window.__BUILD = CFG.build;        // for the cache self-check in index.html

// Anti-cheat (a player set an impossible score from the browser console): the released game exposes nothing to the
// console and its settings can't be changed while it runs. Tests (and debugging) opt in by setting
// window.__sbDebug = true before the game loads; then __sb is the handle into the running game (__sb.plane.P shows
// the plane's actual flight params). This only raises the bar: the leaderboard server checks every score anyway.
const DEBUG = window.__sbDebug === true;
const debugIncoming = [];                      // (tests: missiles shown as homing on you outside versus)
if (!DEBUG) deepFreeze(CFG);
function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
}
if (DEBUG) window.__sb = {
  get mode() { return mode; },
  get gameOver() { return gameOver; },
  get score() { return score; },
  get planeName() { return planeName; },
  save: Save,
  plane, waves, weapons, hangar, drops, fx,
  get training() { return training; },
  get testFlight() { return testFlight; },
  get touch() { return touch; },
  readInput,
  get map() { return flightMap; },
  applyMap,
  get tips() { return tips; },
  get paused() { return paused; },
  View,
  coop, net, lobby, ladder, startLadder, ladderHit, openLadder,
  get glInfo() { return renderer.info; },      // GPU memory: geometries and textures alive (leak checks)
  debugIncoming, camera, Quality, Sound, effects, getTrees,
  get duelist() { return duelist; },
  forceDeath() { plane.hp = 0; plane.alive = false; endGame(); },
  hit: (d, cause) => onPlayerHit(d, cause),
};

// Buttons for everything that has a key (a phone has no keyboard)
const touch = TOUCH ? new TouchControls() : null;
if (touch) {
  touch.onMessage = t => hud.message(t, 2.5);
  document.getElementById('tExit').onclick = () => { if (training) endTraining(); else if (testFlight) enterHangar(); else if (coop.active) askLeaveCoop(); };
}
document.getElementById('hgInstall').style.display = TOUCH && !STANDALONE ? '' : 'none';
document.getElementById('hgInstall').onclick = showInstall;
document.getElementById('hgInstallClose').onclick = () => {
  document.getElementById('hgInstallBox').style.display = 'none';
  if (!Save.data.installTipDone) { Save.setFlag('installTipDone'); hangar.maybeAskCallsign(); }
};
document.getElementById('coopDownLeave').onclick = () => { if (coop.active) leaveButton(); };
// closing the tab in the middle of a rated match: the browser asks first (desktop browsers; phones may not)
addEventListener('beforeunload', e => { if (coop.active && coop.versus && coop.vs.leavingLoses) { e.preventDefault(); e.returnValue = ''; } });
document.getElementById('hgFlip').onclick = () => { if (touch) touch.flipScreen(); else View.flip(TOUCH); };
started = true;
onViewChange();
document.getElementById('pauseResume').onclick = () => resumeGame();
document.getElementById('pauseSound').onclick = () => { Sound.toggle(); document.getElementById('pauseSound').textContent = `Sound: ${Sound.on() ? 'ON' : 'OFF'}`; document.getElementById('hgSound').textContent = `Sound: ${Sound.on() ? 'ON' : 'OFF'}`; };
document.getElementById('pauseRestart').onclick = () => confirmClick('pauseRestart', pauseRestart);
document.getElementById('pauseEnd').onclick = () => confirmClick('pauseEnd', pauseEnd);
document.getElementById('pauseHangar').onclick = () => { hidePause(); if (training) endTraining(); else enterHangar(); };
document.getElementById('tPause').onclick = () => pauseGame();
document.getElementById('overR').onclick = () => { if (!gameOver) return; if (ladder.active) ladderAgain(); else if (coop.active) { if (coop.isHost) coop.start(flightMap); } else restart(); };
document.getElementById('overN').onclick = () => { if (gameOver && !coop.active && !ladder.active) sortie(randomPreset(planeName)); };
document.getElementById('hgLadder').onclick = () => openLadder();
document.getElementById('overH').onclick = () => { if (!gameOver) return; if (coop.active) leaveCoop(); else enterHangar(); };
document.getElementById('tutSkip').onclick = () => endTraining();

// opened from a shared plane link (#plane=SKY1...): put that plane in the hangar, then tidy the address
if (typeof location !== 'undefined' && /#(plane|p)=/.test(location.hash || '')) {
  const shared = decodeURIComponent(location.hash);
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
  // (just a message, no window: a first-time visitor also gets the callsign window, and two windows would overlap)
  hangar.loadShared(shared).then(ok => { if (!ok) hangar.toast(document.getElementById('hgShareMsg').textContent); });
}
document.getElementById('loading').style.display = 'none';
// First time ever (nothing saved yet): start with the flight training. Esc skips it; the hangar has a Training button.
if (!Save.data.tutorialDone && Save.data.runs === 0) startTraining();
else enterHangar();
requestAnimationFrame(loop);
