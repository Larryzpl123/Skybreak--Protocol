// js/parts.js: the part catalog, and stats derived from how the parts are placed.
// Pure functions with no three.js dependency, so it can be tested headlessly.
//
// Design (after Crossout, Trailmakers and SimplePlanes, see README):
//   Layer 1, load budget: the core provides a total and every part uses some. Stops endless growth.
//   Layer 2, geometry decides the stats: nothing is picked from a menu, it is all computed from the shape you build:
//       thrust-to-weight = total thrust / total mass   -> speed, acceleration
//       wing loading = total mass / total wing area    -> turning, stall speed (the single most important number)
//       center of mass vs center of lift               -> pitch stability (too far back pitches up, too far forward pitches down)
//       lateral center of mass                         -> an unbalanced plane keeps leaning toward its heavy side
//       roll inertia sum m(x^2+y^2)                    -> the further out heavy parts hang, the slower it rolls
//
// Coordinates match the plane body: x right, y up, z back (nose points to -z). One cell = CELL world units.

export const CELL = 5;
export const BOUNDS = { x: [-6, 6], y: [-3, 3], z: [-8, 8] };

export const PARTS = {
  core: {
    name: 'Core', key: '',
    desc: 'Cockpit and power core. Sets your load budget. Every plane needs exactly one.',
    load: 0, mass: 10, hp: 40, drag: 1.0, budget: 120, color: 0xffd84d,
  },
  structure: {
    name: 'Frame', key: '1',
    desc: 'Light structure. Connects parts together and adds a little hull.',
    load: 3, mass: 4, hp: 12, drag: 0.6, color: 0xb8c7d9,
  },
  wing: {
    name: 'Wing', key: '2',
    desc: 'Adds wing area. More area per weight = tighter turns and a lower stall speed.',
    load: 4, mass: 3, hp: 5, drag: 0.5, area: 1, color: 0x3d7bd9,
  },
  prop: {
    name: 'Propeller', key: '3',
    desc: 'Cheap, light thrust. Strong at low speed but runs out of push as you go faster.',
    load: 8, mass: 6, hp: 8, drag: 0.8, thrust: 80, engine: 'prop', color: 0xc9a86a,
  },
  jet: {
    name: 'Jet Engine', key: '4',
    desc: 'Heavy and load-hungry, but keeps pushing at high speed.',
    load: 16, mass: 12, hp: 10, drag: 0.7, thrust: 110, engine: 'jet', color: 0x8a93a8,
  },
  cannon: {
    name: 'Cannon', key: '5',
    desc: 'One more gun barrel. Extra cannons add firepower with diminishing returns (they share one ammo feed).',
    // load 10 -> 14: measured that stacking cannons was a degenerate strategy (a 3-cannon plane survived 89% more waves than stock); sublinear firepower alone wasn't enough
    load: 14, mass: 6, hp: 6, drag: 0.4, gun: 1, color: 0x4a4f5c,
  },
  pylon: {
    name: 'Missile Pylon', key: '6',
    desc: '+4 missile capacity, and reloads missiles over time (each pylon: one every 15 s).',
    load: 8, mass: 6, hp: 3, drag: 0.6, missiles: 4, color: 0xe8f4ff,
  },
  armor: {
    name: 'Armor', key: '7',
    desc: 'Lots of hull, lots of weight. Heavy planes turn wide and climb slowly.',
    load: 6, mass: 14, hp: 40, drag: 0.8, color: 0x5b6472,
  },
};

export const PLACEABLE = ['structure', 'wing', 'prop', 'jet', 'cannon', 'pylon', 'armor'];

// takeoff limits and stability band
export const LIMITS = {
  minTWR: 0.55,          // below this thrust-to-weight it can't fly
  maxWingLoading: 22,    // above this wing loading the wings can't carry the weight
  minWings: 2,
  stableBand: [0, 0.8],  // static margin (cells): the center of mass should sit slightly ahead of the center of lift
  lateralDeadzone: 0.05, // a lateral offset below this doesn't count as unbalanced
};

export const cellKey = (x, y, z) => x + ',' + y + ',' + z;

// Creative mode has no real build area: this limit is only a sanity cap (300 parts can never fill it)
export const CREATIVE_BOUNDS = { x: [-150, 150], y: [-150, 150], z: [-150, 150] };
export function inBounds(x, y, z, creative = false) {
  const B = creative ? CREATIVE_BOUNDS : BOUNDS;
  return x >= B.x[0] && x <= B.x[1] &&
         y >= B.y[0] && y <= B.y[1] &&
         z >= B.z[0] && z <= B.z[1];
}
// parts outside the normal build area (only possible in Creative mode; such planes only go on the Creative board)
export const outsideArea = parts => parts.filter(p => !inBounds(p.x, p.y, p.z)).length;

const NEIGHBORS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

/* BFS from the core: returns every cell connected to it. Unconnected parts are floating in midair and don't count. */
export function connectedSet(parts) {
  const occ = new Map();
  for (const p of parts) occ.set(cellKey(p.x, p.y, p.z), p);
  const core = parts.find(p => p.type === 'core');
  const seen = new Set();
  if (!core) return seen;
  const q = [core];
  seen.add(cellKey(core.x, core.y, core.z));
  while (q.length) {
    const c = q.shift();
    for (const [dx, dy, dz] of NEIGHBORS) {
      const k = cellKey(c.x + dx, c.y + dy, c.z + dz);
      if (!seen.has(k) && occ.has(k)) { seen.add(k); q.push(occ.get(k)); }
    }
  }
  return seen;
}

/* The core function: derive every stat from the placement. */
export function computeStats(parts) {
  let mass = 0, hp = 0, load = 0, drag = 0, wingArea = 0, thrust = 0, budget = 0;
  let mx = 0, my = 0, mz = 0;          // mass moments (for the center of mass)
  let ax = 0, az = 0;                  // area moments (for the center of lift)
  let rollInertia = 20;                // base term, avoids dividing by zero
  let r2 = 0;
  const cannons = [], engines = [];
  let pylons = 0, cores = 0, wings = 0;
  // the outermost parts (wing tips, nose, tail, belly): where the plane touches the ground first
  const tip = { right: null, left: null, nose: null, tail: null, low: null };

  for (const p of parts) {
    const d = PARTS[p.type];
    if (!d) continue;
    mass += d.mass; hp += d.hp; load += d.load; drag += d.drag;
    mx += d.mass * p.x; my += d.mass * p.y; mz += d.mass * p.z;
    rollInertia += d.mass * (p.x * p.x + p.y * p.y);   // moment of inertia about the longitudinal (z) axis
    r2 += p.x * p.x + p.y * p.y + p.z * p.z;
    if (d.area) { wingArea += d.area; ax += d.area * p.x; az += d.area * p.z; wings++; }
    if (d.thrust) { thrust += d.thrust; engines.push({ type: d.engine, thrust: d.thrust }); }
    if (d.gun) cannons.push({ x: p.x, y: p.y, z: p.z });
    if (d.missiles) pylons++;
    if (d.budget) { budget += d.budget; cores++; }
    if (!tip.right || p.x > tip.right.x) tip.right = p;
    if (!tip.left || p.x < tip.left.x) tip.left = p;
    if (!tip.nose || p.z < tip.nose.z) tip.nose = p;
    if (!tip.tail || p.z > tip.tail.z) tip.tail = p;
    if (!tip.low || p.y < tip.low.y) tip.low = p;
  }

  const n = parts.length || 1;
  const M = mass || 1;
  const cg = { x: mx / M, y: my / M, z: mz / M };
  const col = wingArea > 0 ? { x: ax / wingArea, z: az / wingArea } : null;

  // static margin: how many cells the center of lift sits behind the center of mass (nose is -z, hence col.z - cg.z)
  // positive = mass forward = stable; negative = mass behind = pitches up
  const margin = col ? col.z - cg.z : 0;

  return {
    count: parts.length,
    mass, hp, load, budget, drag, wingArea, thrust,
    twr: thrust / M,
    wingLoading: wingArea > 0 ? M / wingArea : Infinity,
    rollInertia,
    extent: Math.sqrt(r2 / n),
    cg, col, margin,
    cgX: cg.x,
    cannons, engines, pylons, cores, wings,
    // plane-local points (in cells) at the outer edge of those parts
    tips: tip.right ? [
      { x: tip.right.x + 0.5, y: tip.right.y, z: tip.right.z }, { x: tip.left.x - 0.5, y: tip.left.y, z: tip.left.z },
      { x: tip.nose.x, y: tip.nose.y, z: tip.nose.z - 0.5 }, { x: tip.tail.x, y: tip.tail.y, z: tip.tail.z + 0.5 },
      { x: tip.low.x, y: tip.low.y - 0.5, z: tip.low.z },
    ] : [],
  };
}

/* Can it take off? Returns errors (block the sortie) and warnings (flyable but flawed). */
// Creative mode lifts the load budget (so you can build with many more parts) but not the physics:
// the plane still needs enough thrust and wing area to fly. Planes over the normal budget are never ranked.
export const CREATIVE_MAX_PARTS = 300;   // keeps the frame rate sane: every part is several meshes

export function validate(parts, stats = computeStats(parts), { creative = false } = {}) {
  const errors = [], warnings = [];

  if (stats.cores !== 1) errors.push('Needs exactly one Core.');
  if (!creative && stats.load > stats.budget) {
    errors.push(`Over load budget: ${stats.load} / ${stats.budget}. Turn on Creative mode to go past it (Creative board).`);
  }
  const out = outsideArea(parts);
  if (!creative && out) errors.push(`${out} part${out > 1 ? 's are' : ' is'} outside the normal build area. Turn on Creative mode to fly it (Creative board).`);
  if (creative && parts.length > CREATIVE_MAX_PARTS) errors.push(`Too many parts: ${parts.length} (Creative mode allows ${CREATIVE_MAX_PARTS}).`);
  if (!stats.engines.length) errors.push('Needs at least one engine (Propeller or Jet).');
  if (stats.wings < LIMITS.minWings) errors.push(`Needs at least ${LIMITS.minWings} Wing panels to fly.`);

  const conn = connectedSet(parts);
  const loose = parts.filter(p => !conn.has(cellKey(p.x, p.y, p.z))).length;
  if (loose) errors.push(`${loose} part${loose > 1 ? 's are' : ' is'} not connected to the Core (shown in red).`);

  if (stats.engines.length && stats.twr < LIMITS.minTWR)
    errors.push(`Too heavy for its engines: thrust/weight ${stats.twr.toFixed(2)} (needs ${LIMITS.minTWR}+).`);
  if (stats.wings >= LIMITS.minWings && stats.wingLoading > LIMITS.maxWingLoading)
    errors.push(`Wings too small for this weight: wing loading ${stats.wingLoading.toFixed(1)} (max ${LIMITS.maxWingLoading}).`);
  if (!stats.cannons.length && !stats.pylons)
    errors.push('No weapons. Add a Cannon or a Missile Pylon.');

  if (stats.col) {
    if (stats.margin < LIMITS.stableBand[0])
      warnings.push('Tail-heavy: the nose will keep rising. Move weight forward or add tail wings.');
    else if (stats.margin > LIMITS.stableBand[1])
      warnings.push('Nose-heavy: the nose will keep dropping. Move weight back or add wings further forward.');
  }
  if (Math.abs(stats.cgX) > LIMITS.lateralDeadzone)
    warnings.push(`Lopsided: heavier on the ${stats.cgX > 0 ? 'right' : 'left'}, the plane will drift that way. Try Mirror mode.`);

  return { errors, warnings, ok: errors.length === 0 };
}
