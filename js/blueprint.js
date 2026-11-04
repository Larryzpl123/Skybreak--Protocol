// js/blueprint.js: blueprints. Stock plane, samples, place/remove/mirror, save and load.
// A blueprint is { name, parts: [{type, x, y, z}] }. Every operation returns a new object and never mutates the input (makes undo easy later).

import { PARTS, cellKey, inBounds, computeStats, CREATIVE_MAX_PARTS } from './parts.js';

const P = (type, x, y, z) => ({ type, x, y, z });

// Only the right half (x>0) and the centerline (x=0) are written; the left half is mirrored automatically.
function sym(list) {
  const out = [];
  for (const p of list) {
    out.push(p);
    if (p.x !== 0) out.push(P(p.type, -p.x, p.y, p.z));
  }
  return out;
}

/* ---------- Stock Fighter: its stats are defined as the 100% baseline ----------
   spec.js normalizes against it, so it maps to exactly the flight values tuned in config.js,
   and none of the earlier handling and difficulty tuning is lost. */
export const DEFAULT_BLUEPRINT = {
  name: 'Stock Fighter',
  parts: sym([
    P('core', 0, 0, 0),
    P('structure', 0, 0, -1), P('structure', 0, 0, -2),
    P('structure', 0, 0, 1),  P('structure', 0, 0, 2),
    P('cannon', 0, 0, -3),
    P('jet', 0, 0, 3),
    P('wing', 1, 0, 0), P('wing', 2, 0, 0), P('wing', 3, 0, 0),   // main wing
    P('wing', 1, 0, 2),                                          // tailplane
    P('pylon', 2, -1, 0),                                        // under-wing pylon
  ]),
};

/* ---------- Sample planes: showing how different the system can make things ---------- */
const INTERCEPTOR = {
  name: 'Interceptor',
  parts: sym([
    P('core', 0, 0, 0),
    P('structure', 0, 0, -1), P('structure', 0, 0, 1), P('structure', 0, 0, 2),
    P('cannon', 0, 0, -2),
    P('jet', 1, 0, 1),                                           // twin jets
    P('wing', 1, 0, 0), P('wing', 2, 0, 0),                      // short wings
    P('wing', 1, 0, 2),
  ]),
};

const GUNSHIP = {
  name: 'Gunship',
  parts: sym([
    P('core', 0, 0, 0),
    P('structure', 0, 0, -1), P('structure', 0, 0, -2),
    P('structure', 0, 0, 1),  P('structure', 0, 0, 2),
    P('cannon', 0, 0, -3), P('cannon', 1, 0, -2),                // three cannons
    P('jet', 0, 0, 3),
    P('wing', 1, 0, 0), P('wing', 2, 0, 0), P('wing', 3, 0, 0),
    P('wing', 1, 0, 2),
    P('armor', 1, 0, 1),                                         // two armor blocks: heavy, hard-hitting, turns wide
  ]),
};

const TRAINER = {
  name: 'Prop Trainer',
  parts: sym([
    P('core', 0, 0, 0),
    P('prop', 0, 0, -1),                                         // nose propeller
    P('structure', 0, 0, 1), P('structure', 0, 0, 2),
    P('cannon', 1, 0, -1),                                       // two wing-root cannons
    P('wing', 1, 0, 0), P('wing', 2, 0, 0), P('wing', 3, 0, 0), P('wing', 4, 0, 0),
    P('wing', 1, 0, 2),
  ]),
};

const BIPLANE = {
  name: 'Biplane',
  parts: sym([
    P('core', 0, 0, 0), P('prop', 0, 0, -1),
    P('structure', 0, 0, 1), P('structure', 0, 0, 2),
    P('wing', 1, 0, 0), P('wing', 2, 0, 0), P('wing', 3, 0, 0),                    // lower wing
    P('wing', 1, 1, 0), P('wing', 2, 1, 0), P('wing', 3, 1, 0), P('wing', 4, 1, 0), // upper wing (struts between the wings are generated automatically)
    P('cannon', 1, 1, -1),                                                          // two cannons on the upper wing's leading edge
    P('wing', 1, 0, 2),
  ]),
};

const MISSILE_BOAT = {
  name: 'Missile Boat',
  parts: sym([
    P('core', 0, 0, 0),
    P('structure', 0, 0, -1), P('structure', 0, 0, -2),
    P('structure', 0, 0, 1),  P('structure', 0, 0, 2),
    P('cannon', 0, 0, -3), P('jet', 0, 0, 3),
    P('wing', 1, 0, 0), P('wing', 2, 0, 0), P('wing', 3, 0, 0), P('wing', 1, 0, 2),
    P('pylon', 1, -1, 0), P('pylon', 3, -1, 0),                  // four pylons = 20 missiles
  ]),
};

const FORTRESS = {
  name: 'Flying Fortress',
  parts: sym([
    P('core', 0, 0, 0),
    P('structure', 0, 0, -1), P('structure', 0, 0, 1), P('structure', 0, 0, 2),
    P('cannon', 0, 0, -2),
    P('prop', 2, 0, -1),                                         // twin propellers on the wings, like a bomber
    P('wing', 1, 0, 0), P('wing', 2, 0, 0), P('wing', 3, 0, 0), P('wing', 4, 0, 0),
    P('wing', 1, 0, 2),
    P('armor', 1, 0, 1), P('armor', 1, 0, -1), P('armor', 0, 1, 0),   // five armor blocks
  ]),
};

const STRIKE = {
  name: 'Strike Fighter',
  parts: sym([
    P('core', 0, 0, 0),
    P('structure', 0, 0, -1), P('structure', 0, 0, 1), P('structure', 0, 0, 2),
    P('cannon', 0, 0, -2), P('cannon', 0, 1, -1),                // nose gun + spine gun
    P('wing', 1, 0, 0), P('wing', 2, 0, 0), P('wing', 3, 0, 0), P('wing', 1, 0, 2),
    P('jet', 2, -1, 0),                                          // twin jets in under-wing pods
  ]),
};

const SCOUT = {
  name: 'Long-Wing Scout',
  parts: sym([
    P('core', 0, 0, 0),
    P('structure', 0, 0, -1), P('cannon', 1, 0, -1),
    P('structure', 0, 0, 1), P('structure', 0, 0, 2), P('jet', 0, 0, 3),
    // the longest wings in the hangar: the tightest-turning jet, but the far wingtips make it roll slowly.
    // v2 after playtesting (it was clearly the weakest plane, for humans and the bot alike):
    // span 5 -> 4 (smaller hitbox, less roll inertia), wider root for area, twin wing-root guns instead of one nose gun.
    P('wing', 1, 0, 1), P('wing', 2, 0, 1), P('wing', 3, 0, 1), P('wing', 4, 0, 1),
    P('wing', 1, 0, 2), P('wing', 2, 0, 2), P('wing', 3, 0, 2),
  ]),
};

const DELTA = {
  name: 'Delta Dart',
  parts: sym([
    P('core', 0, 0, 0),
    P('structure', 0, 0, -1), P('structure', 0, 0, 1), P('structure', 0, 0, 2),
    P('cannon', 1, 0, -1), P('jet', 0, 0, 3),
    // delta wing: wider toward the back
    P('wing', 1, 0, 0),
    P('wing', 1, 0, 1), P('wing', 2, 0, 1),
    P('wing', 1, 0, 2), P('wing', 2, 0, 2), P('wing', 3, 0, 2),
  ]),
};

export const PRESETS = [
  DEFAULT_BLUEPRINT, INTERCEPTOR, GUNSHIP, TRAINER, BIPLANE,
  MISSILE_BOAT, FORTRESS, STRIKE, SCOUT, DELTA,
];

// Pick a random sample plane (for the Random Sample Plane button and the N key). `exclude` avoids drawing the same plane twice in a row.
export function randomPreset(exclude = null) {
  const pool = PRESETS.filter(p => p.name !== exclude);
  return cloneBP(pool[Math.floor(Math.random() * pool.length)]);
}

/* ---------- Queries and edits ---------- */
export function cloneBP(bp) {
  return { name: bp.name, parts: bp.parts.map(p => ({ ...p })) };
}

export function partAt(bp, x, y, z) {
  return bp.parts.find(p => p.x === x && p.y === y && p.z === z) || null;
}

// Place a part (in mirror mode, also at the mirrored cell). Returns { ok, reason, cells }.
// creative: no load budget (Creative mode), only a cap on the number of parts
export function canPlace(bp, type, x, y, z, mirror = false, creative = false) {
  if (!PARTS[type] || type === 'core') return { ok: false, reason: 'Pick a part first.' };
  if (!inBounds(x, y, z, creative)) return { ok: false, reason: creative ? 'Too far out.' : 'Outside the build area. Creative mode has no limit.' };
  if (partAt(bp, x, y, z)) return { ok: false, reason: 'That spot is taken.' };

  const cells = [{ x, y, z }];
  if (mirror && x !== 0 && inBounds(-x, y, z, creative) && !partAt(bp, -x, y, z)) cells.push({ x: -x, y, z });

  if (creative) {
    if (bp.parts.length + cells.length > CREATIVE_MAX_PARTS) return { ok: false, reason: `Creative mode allows ${CREATIVE_MAX_PARTS} parts.`, cells };
    return { ok: true, cells };
  }
  const s = computeStats(bp.parts);
  const add = PARTS[type].load * cells.length;
  if (s.load + add > s.budget) {
    return { ok: false, reason: `Over load budget (${s.load} + ${add} > ${s.budget}).`, cells };
  }
  return { ok: true, cells };
}

export function place(bp, type, x, y, z, mirror = false, creative = false) {
  const chk = canPlace(bp, type, x, y, z, mirror, creative);
  if (!chk.ok) return { bp, ...chk };
  const next = cloneBP(bp);
  for (const c of chk.cells) next.parts.push(P(type, c.x, c.y, c.z));
  next.name = 'Custom';
  return { bp: next, ...chk };
}

// Remove a part. The core can't be removed. In mirror mode, a matching part at the mirrored cell is removed too.
export function remove(bp, x, y, z, mirror = false) {
  const target = partAt(bp, x, y, z);
  if (!target) return { bp, ok: false, reason: 'Nothing there.' };
  if (target.type === 'core') return { bp, ok: false, reason: 'The Core cannot be removed.' };

  const kill = new Set([`${x},${y},${z}`]);
  if (mirror && x !== 0) {
    const m = partAt(bp, -x, y, z);
    if (m && m.type === target.type) kill.add(`${-x},${y},${z}`);
  }
  const next = cloneBP(bp);
  next.parts = next.parts.filter(p => !kill.has(`${p.x},${p.y},${p.z}`));
  next.name = 'Custom';
  return { bp: next, ok: true, removed: kill.size };
}

// Reset to just the core.
export function cleared() {
  return { name: 'Custom', parts: [P('core', 0, 0, 0)] };
}

/* ---------- Save and load (bad data always falls back to the Stock Fighter so it can never lock up the game) ---------- */
export function serialize(bp) {
  return JSON.stringify({ v: 1, name: bp.name, parts: bp.parts.map(p => [p.type, p.x, p.y, p.z]) });
}

export function deserialize(str) {
  try {
    const o = JSON.parse(str);
    if (!o || !Array.isArray(o.parts)) throw 0;
    const parts = [];
    const seen = new Set();
    for (const a of o.parts) {
      const [type, x, y, z] = a;
      if (!PARTS[type] || ![x, y, z].every(Number.isInteger) || !inBounds(x, y, z, true)) continue;   // Creative planes can be bigger than the normal area
      const k = cellKey(x, y, z);
      if (seen.has(k)) continue;
      seen.add(k);
      parts.push(P(type, x, y, z));
    }
    if (parts.filter(p => p.type === 'core').length !== 1) throw 0;
    return { name: typeof o.name === 'string' ? o.name : 'Custom', parts };
  } catch {
    return cloneBP(DEFAULT_BLUEPRINT);
  }
}
