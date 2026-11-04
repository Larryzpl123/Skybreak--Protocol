// js/planetest.js: the hangar's AI Test. The autopilot (autopilot.js) flies the plane being built through the normal
// waves, and in 1v1 duels against the 10 sample planes (the same pilot flying both: duel.js), with nothing drawn.
// The results become two grades (F, D, C, B, A, S, SS, SSS). (The AI Ladder was tried first as the second test, but
// the computer pilot found the ladder AI's weak spots: slow tight-turning planes "beat" level 80, which says more
// about the ladder AI than about the plane. Two designs flown by the same pilot is a fair comparison.)
// Local only: nothing is sent anywhere and nothing counts on any board.
//
// The same seed every time, so a plane always gets the same grade (the simulation's random source, rand.js, is swapped
// for a seeded one while a slice of the test runs, and put back between slices so the rest of the game is untouched).
// Always on the training map (the original forest) in clear weather, so planes compare like with like.

import * as THREE from 'three';
import { CFG } from './config.js';
import { Plane } from './plane.js';
import { Weapons, pickMissileTarget } from './weapons.js';
import { Waves, Drops } from './waves.js';
import { applyPowerup } from './powerups.js';
import { Autopilot } from './autopilot.js';
import { makeDuel } from './duel.js';
import { PRESETS } from './blueprint.js';
import { computeStats } from './parts.js';
import { specFromStats } from './spec.js';
import { restoreTrees } from './terrain.js';
import { setRand } from './rand.js';

export const GRADES = ['F', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];
// bump when the test changes (pilot, rules, grades), so old saved grades are not shown as current
export const TEST_VERSION = 5;            // 5: missiles rebalanced (reload, bosses, versus damage)
                                          // 4: own random source (three.js was eating into the seeded one); past
                                          //    wave 32 each wave adds a minute to the 15
                                          // 3: parts in a fixed order (the grade depended on their order); the forest
                                          //    is restored before every wave run and duel
                                          // (2: bigger world, ceiling, wing tips touch the ground)
const partId = p => `${p.type},${p.x},${p.y},${p.z}`;
// the parts in one fixed order (the order planeKey uses)
export const canonicalParts = parts => parts.slice().sort((a, b) => (partId(a) < partId(b) ? -1 : partId(a) > partId(b) ? 1 : 0));
// a short key for a plane layout (the same parts in any order = the same key)
export function planeKey(parts) {
  const s = parts.map(partId).sort().join(';');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
// What a grade needs (the lowest value for D, C, B, ...), set from the sample planes (test/planetest.mjs prints them):
// the stock fighter is about a B / C, the best sample planes a B or A, the strongest player designs S and up.
export const GRADE_AT = {
  wave: [5, 9, 13, 17, 22, 27, 33],          // average wave reached (in the browser: stock fighter 15.7 = B, Gunship 18 = A, Truth 22.7 = S)
  duel: [0.1, 0.25, 0.45, 0.6, 0.75, 0.88, 0.97],   // share of duels won against the 10 sample planes, a draw = half (stock 41 % = C; SSS = beats them all)
};
export const gradeOf = (value, steps) => GRADES[steps.filter(s => value >= s).length];

const RUNS = 3, RUN_TIME = 900, MAX_WAVE = 45;           // waves: 3 runs of 15 minutes...
// ...but a plane still flying at wave EXTRA_FROM or later is not stopped by the clock: each wave past it adds
// EXTRA_PER_WAVE seconds (the strongest planes used to be cut off at about wave 32 while still healthy, so SSS at
// 33 was out of reach; a strong human run of 35 waves takes about 24 minutes)
const EXTRA_FROM = 32, EXTRA_PER_WAVE = 60;
const timeUp = (t, wave) => t > RUN_TIME + EXTRA_PER_WAVE * Math.max(0, wave - EXTRA_FROM);
const DUELS = 4;                                          // against each sample plane, 2 from each side
const DT = 1 / 60;

function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// parts -> { waves: { wave, score, grade }, duel: { share, grade, vs: [{ name, share }] } }
// onProgress(0..1); yields to the browser every few thousand frames so the page stays responsive
export async function testPlane(parts, { onProgress = () => {}, seed = 12345, sliceFrames = 6000, waveRuns = RUNS } = {}) {
  // The same layout must get the same grade whatever order its parts are listed in (a saved plane, a share code and
  // a copy from the board can list them differently). The stats are float sums in part order, the last digits differ,
  // and 15 minutes of flight blow that up: one plane measured 21.3 to 25.3 waves (A or S) by order alone.
  // So the parts are put in the same order planeKey uses before anything is computed.
  parts = canonicalParts(parts);
  const spec = specFromStats(computeStats(parts));
  const rng = mulberry32(seed);
  const scene = new THREE.Scene();               // never drawn: nothing reaches the GPU
  const totalWork = waveRuns + PRESETS.length;
  let done = 0;
  const slices = sliced(rng, sliceFrames);

  // ---- the normal waves ----
  let waveSum = 0, scoreSum = 0;
  for (let run = 0; run < waveRuns; run++) {
    restoreTrees();                        // every run starts on the same intact forest, so the grade cannot
                                           // depend on how many trees were knocked over before the test
    const sim = waveRun(scene, spec, rng);
    await slices(n => sim.step(n));
    waveSum += sim.wave; scoreSum += sim.score;
    sim.dispose();
    onProgress(++done / totalWork);
  }
  restoreTrees();
  const wave = Math.round(waveSum / waveRuns * 10) / 10;

  // ---- duels against the 10 sample planes ----
  const vs = [];
  for (const preset of PRESETS) {
    const r = await duelSeries(scene, spec, specFromStats(computeStats(preset.parts)), DUELS, rng, slices);
    vs.push({ name: preset.name, share: r.share });
    onProgress(++done / totalWork);
  }
  const share = Math.round(vs.reduce((t, v) => t + v.share, 0) / vs.length * 1000) / 1000;
  onProgress(1);
  return { waves: { wave, score: Math.round(scoreSum / waveRuns), grade: gradeOf(wave, GRADE_AT.wave) }, duel: { share, grade: gradeOf(share, GRADE_AT.duel), vs } };
}

// run fn in slices of `frames` frames with the seeded random swapped in; fn(frames) returns true when finished
export function sliced(rng, frames = 6000) {
  return async fn => {
    for (;;) {
      const real = setRand(rng);           // the simulation's own random source (three.js keeps Math.random, see rand.js)
      let finished;
      try { finished = fn(frames); } finally { setRand(real); }
      if (finished) return;
      await new Promise(r => setTimeout(r, 0));
    }
  };
}

// n duels of design A against design B (sides alternate) -> { wins, draws, losses, share (of A), duels: [...] }
export async function duelSeries(scene, specA, specB, n, rng, slices = sliced(rng), onDuel = () => {}) {
  let wins = 0, draws = 0, losses = 0;
  for (let k = 0; k < n; k++) {
    restoreTrees();                        // the same intact forest for every duel too (a plane that clips a tree knocks it over)
    const d = makeDuel(scene, specA, specB, { side: k % 2, rand: rng });
    await slices(f => d.step(f));
    if (d.winner === 'a') wins++; else if (d.winner === 'b') losses++; else draws++;
    d.dispose();
    onDuel(k + 1, n);
  }
  return { wins, draws, losses, share: (wins + draws / 2) / n };
}

export { mulberry32 };

// one run through the waves, like a solo run (the same rules as main.js update, without the drawing)
function waveRun(scene, spec, rng) {
  const plane = new Plane(scene);
  plane.applySpec(spec);
  const weapons = new Weapons(scene), waves = new Waves(scene), drops = new Drops(scene);
  const pilot = new Autopilot(plane, rng);
  const sim = { wave: 0, score: 0, t: 0 };
  const onEnemyHit = (e, d) => { if (e.hurt(d)) { sim.score += e.score; drops.spawn(e.pos.clone(), null, e.alwaysDrops); } };
  const onPlayerHit = d => plane.hurt(d);
  sim.step = n => {
    for (let i = 0; i < n; i++) {
      if (!plane.alive || timeUp(sim.t, waves.wave) || waves.wave > MAX_WAVE) return true;
      sim.t += DT;
      const inp = pilot.update(DT, waves.enemies);
      plane.update(DT, inp);
      if (!plane.alive) return true;
      if (inp.fire) weapons.fireGun(plane, waves.enemies);
      if (inp.missile) { const mt = pickMissileTarget(plane.pos, plane.forward(), waves.enemies, CFG.missile.lockRange, CFG.missile.lockCone, weapons.missiles); if (mt) weapons.fireMissile(plane, mt); }
      weapons.update(DT, { enemies: waves.enemies, plane, onEnemyHit, onPlayerHit });
      const prev = waves.wave;
      const ev = waves.update(DT, plane, weapons);
      weapons.missileMul = 1 + Math.max(0, waves.wave - 1) * CFG.missile.damagePerWave;
      if (ev === 'wave-start' && prev > 0) plane.heal(CFG.wave.clearHeal);
      if (plane.ramCd > 0) plane.ramCd -= DT;
      for (const e of waves.enemies) {
        if (!e.alive || !plane.alive) continue;
        const rr = Math.max(e.blastRadius || 0, e.radius + plane.P.radius);
        if (e.pos.distanceToSquared(plane.pos) >= rr * rr) continue;
        if (e.solid) {
          const nrm = plane.pos.clone().sub(e.pos).normalize();
          plane.pos.copy(e.pos).addScaledVector(nrm, rr + 6);
          if (plane.ramCd <= 0) { onPlayerHit(e.ramDamage); plane.ramCd = CFG.plane.ramCooldown; }
        } else {
          if (plane.ramCd <= 0 || e.type === 'drone') { onPlayerHit(e.ramDamage); plane.ramCd = CFG.plane.ramCooldown; }
          onEnemyHit(e, 9999);
        }
      }
      for (const type of drops.update(DT, plane)) applyPowerup(type, { plane, weapons, enemies: waves.enemies, onEnemyHit });
      sim.wave = waves.wave;
    }
    return false;
  };
  sim.dispose = () => { waves.reset(); weapons.clear(); drops.clear(); scene.remove(plane.mesh); };
  return sim;
}
