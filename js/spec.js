// js/spec.js: map the geometry-derived stats onto flight parameters.
//
// Key design choice: everything is mapped as a RATIO against the Stock Fighter, not as an absolute formula.
//   The stock plane's ratios are always 1, so it maps to exactly the numbers tuned in config.js.
// All the earlier tuning (turn direction, bank limit, attacker slots, boss hp, ...) is preserved;
// the building system only shifts things up or down from that baseline.

import { CFG } from './config.js';
import { CELL, computeStats, LIMITS } from './parts.js';
import { DEFAULT_BLUEPRINT } from './blueprint.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- Top speed: solve thrust(v) = drag(v) ----------
   Propeller thrust falls off linearly with speed (it can't push at high speed); jets get slightly stronger at speed.
   So for the same thrust, props accelerate fine but top out low while jets go faster. That difference emerges; it isn't hard-coded. */
const DRAG_K = 1.08e-4;
const PROP_FADE = 420;

function thrustAt(engines, v) {
  let t = 0;
  for (const e of engines) {
    if (e.type === 'prop') t += e.thrust * Math.max(0, 1 - v / PROP_FADE);
    else t += e.thrust * (0.7 + 0.3 * Math.min(1, v / 350));
  }
  return t;
}

export function topSpeed(stats) {
  if (!stats.engines.length) return 0;
  let lo = 0, hi = 1500;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (thrustAt(stats.engines, mid) > DRAG_K * stats.drag * mid * mid) lo = mid; else hi = mid;
  }
  return lo;
}

/* ---------- Stock baseline (computed lazily, once) ---------- */
let REF = null;
export function reference() {
  if (!REF) {
    const s = computeStats(DEFAULT_BLUEPRINT.parts);
    REF = {
      stats: s,
      twr: s.twr,
      wl: s.wingLoading,
      inertia: s.rollInertia,
      vTop: topSpeed(s),
      extent: s.extent,
    };
  }
  return REF;
}

/* ---------- Stability -> continuous attitude drift ----------
   Exactly zero inside the stable band (the stock plane is inside it). Outside the band it starts to drift,
   capped so the player can always correct it. */
export function stabilityEffects(stats) {
  let pitchDrift = 0;                        // rad/s, positive = the nose rises on its own
  if (stats.col) {
    const [lo, hi] = LIMITS.stableBand;
    if (stats.margin < lo) pitchDrift = clamp((lo - stats.margin) * 0.6, 0, 0.9);    // mass too far back -> pitches up
    else if (stats.margin > hi) pitchDrift = -clamp((stats.margin - hi) * 0.6, 0, 0.9); // mass too far forward -> pitches down
  }
  // lateral imbalance -> target bank is biased toward the heavy side (roll>0 is left bank; heavy on the right -> right bank -> negative)
  let rollBias = 0;
  if (Math.abs(stats.cgX) > LIMITS.lateralDeadzone) rollBias = clamp(-stats.cgX * 0.6, -0.6, 0.6);
  return { pitchDrift, rollBias };
}

/* ---------- Soft cap: diminishing returns past the knee, but always increasing ----------
   This used to be a hard clamp at 480, so twin jets (443) and three jets (525) looked almost the same in the panel
   and the third engine's gain was swallowed by the clamp. Players would wonder why it did nothing.
   The soft cap guarantees every extra engine helps; each one is just worth less. */
function softcap(r, knee = 1.25, slope = 0.45) {
  return r <= knee ? r : knee + (r - knee) * slope;
}

/* ---------- Main mapping ---------- */
export function specFromStats(s) {
  const R = reference();
  const B = CFG.plane;

  const speedMax   = clamp(B.speedMax * softcap(topSpeed(s) / R.vTop), 140, 560);
  const speedBase  = B.speedBase * speedMax / B.speedMax;
  const turnMul    = clamp(Math.pow(R.wl / s.wingLoading, 0.55), 0.45, 1.6);   // wing loading -> turning
  const rollMul    = clamp(Math.pow(R.inertia / s.rollInertia, 0.35), 0.5, 1.4); // inertia -> roll
  const accelMul   = clamp(s.twr / R.twr, 0.4, 2.2);                             // thrust-to-weight -> acceleration
  const speedMin   = Math.min(
    clamp(B.speedMin * Math.sqrt(s.wingLoading / R.wl), 60, 190),                // wing loading -> stall speed
    speedBase * 0.85);
  const radius     = clamp(B.radius * Math.pow(s.extent / R.extent, 0.8), 7, 32); // bigger is easier to hit

  const { pitchDrift, rollBias } = stabilityEffects(s);
  const missileMax = 4 + 4 * s.pylons;

  // Sublinear firepower: n cannons = n^0.7 times the total (1 -> 1.0, 2 -> 1.62, 3 -> 2.16).
  // With linear stacking, the presets ranked almost exactly by cannon count: stacking guns was the only right answer.
  // Each cannon still fires its own stream (you still see 3 tracer lines); each bullet's damage is just scaled down.
  const nGuns = s.cannons.length;
  const firepower = nGuns ? Math.pow(nGuns, 0.7) : 0;
  const gunDamageMul = nGuns ? firepower / nGuns : 1;

  return {
    hp: s.hp,
    speedMax, speedMin, speedBase,
    throttleAccel: B.throttleAccel * accelMul,
    pitchRate: B.pitchRate * turnMul,
    bankTurn: B.bankTurn * turnMul,
    rollRate: B.rollRate * rollMul,
    radius,
    pitchDrift, rollBias,
    // muzzle positions in plane-local coordinates (cell center, nudged forward to act as the muzzle)
    cannonMounts: s.cannons.map(c => ({ x: c.x * CELL, y: c.y * CELL, z: c.z * CELL - CELL * 0.8 })),
    // the plane's outer points (wing tips, nose, tail, belly), plane-local: these touching the ground is a crash too
    // (reported: a long-winged plane skimming the ground with its wings in the ground; only the middle counted)
    tips: (s.tips || []).map(t => ({ x: t.x * CELL, y: t.y * CELL, z: t.z * CELL })),
    missileMax,
    missileStart: Math.round(missileMax / 3),
    missileReload: s.pylons ? CFG.missile.reloadPerPylon / s.pylons : 0,   // seconds per missile, 0 = no reload
    firepower, gunDamageMul,
    // multipliers for the hangar UI (relative to stock)
    mul: { speed: speedMax / B.speedMax, turn: turnMul, roll: rollMul, accel: accelMul },
  };
}

export function specFromBlueprint(bp) {
  return specFromStats(computeStats(bp.parts));
}
