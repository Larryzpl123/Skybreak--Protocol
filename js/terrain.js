// js/terrain.js: heightmap terrain + trees
// Key design: terrain is a pure function heightAt(x,z), so checking for a terrain hit is one O(1) evaluation
// with no mesh collision or BVH at all. The single biggest time-saver in the project.

import * as THREE from 'three';
import { CFG } from './config.js';

/* ---------- Dependency-free deterministic noise (value noise + fbm) ---------- */
function hash2(x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return h - Math.floor(h);
}
function smooth(t) { return t * t * (3 - 2 * t); }

function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  const u = smooth(xf), v = smooth(yf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x, y) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < 5; i++) {
    sum += valueNoise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5; freq *= 2.03;
  }
  return sum / norm;
}

/* ---------- Biomes ----------
   A map is { biome, seed }. The seed shifts the noise, so every seed is a different map of the same kind;
   forest with seed 0 is exactly the original map. colors = [low, mid, high] vertex colors. */
export const BIOMES = {
  forest:  { name: 'Forest',     sky: 0x8fc6e8, colors: [0x2f5d3a, 0x6b6552, 0xdfe6ef], top: 420,
             trees: { count: 900, trunk: 0x4a3524, leaf: 0x1f6b35 } },
  desert:  { name: 'Desert',     sky: 0xe3cb98, colors: [0xd6b273, 0xc28f55, 0xe8d3a0], top: 190,
             trees: { count: 110, trunk: 0x6b5a3a, leaf: 0x7c8a3c } },
  snow:    { name: 'Snow Peaks', sky: 0xc7d6e4, colors: [0xe6edf4, 0x8b909a, 0xffffff], top: 640,
             trees: { count: 420, trunk: 0x3b2f25, leaf: 0x1b3f2c } },
  islands: { name: 'Islands',    sky: 0x9fd0ee, colors: [0xc2a86e, 0x3d7a3e, 0x6b6552], top: 360, water: 0x2a6f9e,
             trees: { count: 380, trunk: 0x5a4330, leaf: 0x2e8a3e } },
  canyon:  { name: 'Canyon',     sky: 0xeec39a, colors: [0x9c4f2e, 0xc7753f, 0xe2a86e], top: 290,
             trees: { count: 160, trunk: 0x4a3524, leaf: 0x5b6b2a } },
  // City (2026-10-07): streets and blocks of buildings, skyscrapers downtown. The buildings are part of the ground
  // height (heightAt), so flying into one is a crash, bullets stop on them and everything else steers over them.
  city:    { name: 'City',       sky: 0xa9c0d6, colors: [0x55595f, 0x6a6e74, 0x80858b], top: 40,
             trees: { count: 260, trunk: 0x4a3524, leaf: 0x2f6b3a } },
};
// the map types before the city existed (the daily maps of earlier days are worked out with these)
export const OLD_BIOME_KEYS = ['forest', 'desert', 'snow', 'islands', 'canyon'];
export const BIOME_KEYS = Object.keys(BIOMES);

let MAP = { biome: 'forest', seed: 0 };
let OX = 0, OZ = 0;                       // noise offset from the seed (0 for seed 0)
export function currentMap() { return MAP; }

// Start high enough to clear everything near the spawn point (tall snow peaks can stand right outside the basin).
// 340 on every map where that is already safe, so the original map and all the flight tests are unchanged.
let spawnAlt = null;
export function spawnAltitude() {
  if (spawnAlt === null) {
    let m = 0;
    for (let x = -1500; x <= 1500; x += 60) for (let z = -1500; z <= 1500; z += 60) {
      if (Math.hypot(x, z) <= 1500) m = Math.max(m, heightAt(x, z));
    }
    spawnAlt = Math.max(340, Math.round(m + 90));
  }
  return spawnAlt;
}

function seedOffset(seed) {
  if (!seed) return [0, 0];
  const a = Math.sin(seed * 12.9898) * 43758.5453, b = Math.sin(seed * 78.233) * 12345.6789;
  return [(a - Math.floor(a)) * 90000 + 1000, (b - Math.floor(b)) * 90000 + 1000];
}

// Raw ground height (for islands this goes below the sea; see heightAt for what you can crash into)
export function groundAt(x, z) {
  const s = 0.00055;                     // terrain scale
  const X = x + OX, Z = z + OZ;
  let h;
  switch (MAP.biome) {
    case 'desert': {
      const base = Math.pow(fbm(X * s * 0.5, Z * s * 0.5), 1.3) * 140;
      const dune = Math.pow(1 - Math.abs(Math.sin((X * 0.9 + Z * 0.4) * 0.012 + fbm(X * s, Z * s) * 8)), 2) * 45;
      h = base + dune;
      break;
    }
    case 'snow':
      h = Math.pow(fbm(X * s * 0.9, Z * s * 0.9), 1.55) * 640;
      break;
    case 'islands':
      h = Math.pow(fbm(X * s * 1.2, Z * s * 1.2), 1.4) * 560 - 200;
      break;
    case 'city':                         // nearly flat streets
      h = 6 + fbm(X * s * 0.6, Z * s * 0.6) * 22;
      break;
    case 'canyon': {
      // high plateau cut by winding canyons: the canyon is where a second noise field crosses 0.5
      const ridge = Math.abs(fbm(X * s * 1.4 + 31.7, Z * s * 1.4 - 12.3) - 0.5);
      const wall = smooth(Math.min(1, Math.max(0, (ridge - 0.03) / 0.06)));
      h = 30 + wall * (200 + fbm(X * s * 0.7, Z * s * 0.7) * 60);
      break;
    }
    default:                             // forest (the original terrain)
      h = Math.pow(fbm(X * s, Z * s), 1.9);   // exaggerate the height range: sharper peaks, flatter valleys
      h *= CFG.world.maxHeight;
  }

  // flatten the spawn area into a basin so you don't start stuck in a mountain
  const d = Math.hypot(x, z);
  const r = CFG.world.spawnClearRadius;
  if (d < r) {
    const t = smooth(d / r);             // 0 (center) -> 1 (edge)
    h *= t;
  }
  return h;
}

/* ---------- City buildings ---------- */
// The city is a grid of blocks with streets between them. Each block has one building (or is a park), sized and
// coloured from the seed, so everyone gets the same city. Downtown (away from the spawn plaza) has the skyscrapers.
export const CITY = { block: 220, street: 70, downtown: [2600, -1800], plaza: 900 };
function cityHash(cx, cz) {
  let h = Math.imul(cx * 73856093 ^ cz * 19349663 ^ (MAP.seed * 83492791), 0x5bd1e995) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0; h = Math.imul(h, 0x5bd1e995) >>> 0; h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}
// the building on the block at (cx, cz): { x0, x1, z0, z1, top, hue } or null (a park, or the spawn plaza)
export function cityBuilding(cx, cz) {
  const B = CITY.block, half = (B - CITY.street) / 2;
  const mx = (cx + 0.5) * B, mz = (cz + 0.5) * B;
  if (Math.hypot(mx, mz) < CITY.plaza) return null;
  const r = cityHash(cx, cz);
  if (r < 0.14) return null;                                        // a park
  const r2 = cityHash(cx + 9173, cz - 3311), r3 = cityHash(cx - 777, cz + 4242);
  const down = Math.max(0, 1 - Math.hypot(mx - CITY.downtown[0], mz - CITY.downtown[1]) / 3200);
  const top = 30 + r2 * 80 + down * down * (180 + r3 * 360);          // 30-110 m out of town, up to about 650 downtown
  const w = half * (0.7 + r3 * 0.3), d = half * (0.7 + r2 * 0.3);
  return { x0: mx - w, x1: mx + w, z0: mz - d, z1: mz + d, top, hue: r3 };
}
function buildingTopAt(x, z) {
  const b = cityBuilding(Math.floor(x / CITY.block), Math.floor(z / CITY.block));
  return b && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 ? b.top : 0;
}

/* ---------- Terrain height: the one source of truth for the ground ---------- */
// What you can crash into: the ground, the sea surface (height 0) on the islands map, or a building in the city
export function heightAt(x, z) {
  const h = groundAt(x, z);
  if (MAP.biome === 'city') return Math.max(h, buildingTopAt(x, z));
  return MAP.biome === 'islands' ? Math.max(0, h) : h;
}
export const isBuilding = (x, z) => MAP.biome === 'city' && buildingTopAt(x, z) > groundAt(x, z);

/* ---------- Build the terrain mesh ---------- */
let terrainMesh = null, waterMesh = null;

function vertexColor(c, h, B, cols) {
  if (MAP.biome === 'islands') {
    if (h < 0) return c.copy(cols[0]).lerp(cols[2], Math.min(1, -h / 200) * 0.6);   // sea floor
    if (h < 14) return c.copy(cols[0]);                                            // beach
    return c.copy(cols[1]).lerp(cols[2], Math.min(1, (h - 14) / (B.top - 14)));
  }
  const t = Math.max(0, h / B.top);
  if (t < 0.45) return c.copy(cols[0]).lerp(cols[1], t / 0.45);
  return c.copy(cols[1]).lerp(cols[2], Math.min(1, (t - 0.45) / 0.55));
}

let cityMesh = null;
// the buildings: one box shape for all of them, each placed, sized and coloured (one draw call)
function buildCity(scene) {
  const half = CFG.world.size / 2, B = CITY.block;
  const list = [];
  for (let cx = Math.floor(-half / B); cx < Math.ceil(half / B); cx++) {
    for (let cz = Math.floor(-half / B); cz < Math.ceil(half / B); cz++) { const b = cityBuilding(cx, cz); if (b) list.push(b); }
  }
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  cityMesh = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
  const tones = [0x8a9099, 0x9c8f80, 0x6f7f8f, 0xb4b8bd, 0x5f6a73];
  list.forEach((b, i) => {
    const base = groundAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) - 4;
    p.set((b.x0 + b.x1) / 2, (base + b.top) / 2, (b.z0 + b.z1) / 2);
    sc.set(b.x1 - b.x0, b.top - base, b.z1 - b.z0);
    m.compose(p, q, sc);
    cityMesh.setMatrixAt(i, m);
    if (cityMesh.setColorAt) cityMesh.setColorAt(i, col.setHex(tones[Math.floor(b.hue * tones.length) % tones.length]));
  });
  cityMesh.instanceMatrix.needsUpdate = true;
  if (cityMesh.instanceColor) cityMesh.instanceColor.needsUpdate = true;
  scene.add(cityMesh);
  return list.length;
}

export function buildTerrain(scene) {
  const { size, segments } = CFG.world;
  const B = BIOMES[MAP.biome];
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);             // lay it flat on the XZ plane

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cols = B.colors.map(v => new THREE.Color(v));
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = groundAt(x, z);
    pos.setY(i, h);
    vertexColor(c, h, B, cols);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  terrainMesh = new THREE.Mesh(geo, mat);
  terrainMesh.receiveShadow = false;
  scene.add(terrainMesh);

  if (MAP.biome === 'city') buildCity(scene);
  if (B.water) {
    // 32 x 32 cells, not one quad: depth across two huge triangles (15 km, mostly off screen) is imprecise, and the
    // shoreline shimmered when turning (reported on the islands map). Measured with 23 small turns: pixels that kept
    // switching between water and land went from 11000 to 2800 (with no water sheet at all: 1700).
    const wg = new THREE.PlaneGeometry(size * 1.5, size * 1.5, 32, 32);
    wg.rotateX(-Math.PI / 2);
    waterMesh = new THREE.Mesh(wg, new THREE.MeshLambertMaterial({ color: B.water, transparent: true, opacity: 0.88 }));
    waterMesh.position.y = 0.5;
    scene.add(waterMesh);
  }
  return terrainMesh;
}

const disposeMesh = (scene, m) => {
  if (!m) return;
  scene.remove(m);
  if (m.geometry && m.geometry.dispose) m.geometry.dispose();
  if (m.material && m.material.dispose) m.material.dispose();
};

// Switch to another map: rebuild the ground, the water and the trees (nothing happens if it is already loaded)
export function setMap(scene, map) {
  const next = { biome: BIOMES[map.biome] ? map.biome : 'forest', seed: map.seed | 0 };
  if (terrainMesh && next.biome === MAP.biome && next.seed === MAP.seed) return false;
  disposeMesh(scene, terrainMesh); terrainMesh = null;
  disposeMesh(scene, waterMesh); waterMesh = null;
  disposeMesh(scene, trunkMesh); trunkMesh = null;
  disposeMesh(scene, leafMesh); leafMesh = null;
  disposeMesh(scene, cityMesh); cityMesh = null;
  MAP = next;
  [OX, OZ] = seedOffset(next.seed);
  spawnAlt = null;
  buildTerrain(scene);
  buildTrees(scene);
  return true;
}

/* ---------- Trees: instancing + spatial grid, so collision queries are O(1) too ----------
   Hitting a tree isn't hitting a wall: the plane loses hull, slows down and keeps flying; the tree is knocked away
   (and removed from the collision grid). It used to teleport the plane back up, which was unrealistic and jarring. */
const CELL = 240;                         // spatial grid cell size
const treeGrid = new Map();               // "cx,cz" -> [tree]
const key = (cx, cz) => cx + ',' + cz;
let allTrees = [];                        // each tree: { idx, x, z, h, s, r, top, dead }
let trunkMesh = null, leafMesh = null;
const falling = [];                       // trees currently falling

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _sc = new THREE.Vector3();
const _p = new THREE.Vector3();
const _off = new THREE.Vector3();

function addTreeToGrid(t) {
  const cx = Math.floor(t.x / CELL), cz = Math.floor(t.z / CELL);
  const k = key(cx, cz);
  if (!treeGrid.has(k)) treeGrid.set(k, []);
  treeGrid.get(k).push(t);
}

// pivot at the tree base: rotate by q, slide the base by slide, uniform scale
function writeTree(t, q, slideX = 0, slideZ = 0, scale = 1) {
  const s = t.s * scale;
  _sc.set(s, s, s);
  // trunk: centered 13s above the base
  _off.set(0, 13 * t.s * scale, 0).applyQuaternion(q);
  _p.set(t.x + slideX + _off.x, t.h + _off.y, t.z + slideZ + _off.z);
  _m.compose(_p, q, _sc); trunkMesh.setMatrixAt(t.idx, _m);
  // canopy: centered 46s above the base
  _off.set(0, 46 * t.s * scale, 0).applyQuaternion(q);
  _p.set(t.x + slideX + _off.x, t.h + _off.y, t.z + slideZ + _off.z);
  _m.compose(_p, q, _sc); leafMesh.setMatrixAt(t.idx, _m);
}

// where a tree may grow on each map (h = raw ground height)
const TREE_OK = {
  forest: h => h > 4 && h < CFG.world.maxHeight * 0.55,     // not above the snow line, not in the spawn basin
  desert: h => h > 4,
  snow: h => h > 4 && h < 640 * 0.35,
  islands: h => h > 14 && h < 220,                           // on land, above the beach
  canyon: h => h > 4 && h < 70,                              // only on the canyon floor
  city: h => h > 0,                                          // in the parks and the plaza (not on buildings: see buildTrees)
};

// small seeded random generator, so everyone gets the same trees on the same map
function rng(seed) {
  let a = (seed | 0) + 0x9e3779b9;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function buildTrees(scene) {
  treeGrid.clear();
  allTrees = [];
  falling.length = 0;
  const { size } = CFG.world;
  const B = BIOMES[MAP.biome];
  // counts are for a 6000 map: scaled with the area, so the forest stays as thick on a bigger map
  const treeCount = Math.round((MAP.biome === 'forest' ? CFG.world.treeCount : B.trees.count) * (size / 6000) ** 2);
  const ok = TREE_OK[MAP.biome];
  const rand = rng(MAP.seed * 7919 + BIOME_KEYS.indexOf(MAP.biome));
  const half = size / 2 - 60;

  const trunkGeo = new THREE.CylinderGeometry(3, 4.5, 26, 5);
  const leafGeo = new THREE.ConeGeometry(16, 46, 6);
  trunkMesh = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: B.trees.trunk }), treeCount);
  leafMesh = new THREE.InstancedMesh(leafGeo, new THREE.MeshLambertMaterial({ color: B.trees.leaf }), treeCount);

  let placed = 0, tries = 0;
  while (placed < treeCount && tries < treeCount * 12) {
    tries++;
    const x = (rand() * 2 - 1) * half;
    const z = (rand() * 2 - 1) * half;
    const h = groundAt(x, z);
    if (!ok(h) || isBuilding(x, z) || (MAP.biome === 'city' && isBuilding(x + 20, z) + isBuilding(x - 20, z) + isBuilding(x, z + 20) + isBuilding(x, z - 20))) continue;

    const s = 0.8 + rand() * 1.3;
    const t = { idx: placed, x, z, h, s, r: 15 * s, top: h + 50 * s, dead: false };
    allTrees.push(t);
    writeTree(t, _q.identity());
    addTreeToGrid(t);
    placed++;
  }
  trunkMesh.count = placed; leafMesh.count = placed;
  trunkMesh.instanceMatrix.needsUpdate = true;
  leafMesh.instanceMatrix.needsUpdate = true;
  scene.add(trunkMesh); scene.add(leafMesh);
  return { trunks: trunkMesh, leaves: leafMesh, count: placed };
}

export function getTrees() { return allTrees; }

// only check the tree's own cell and its neighbors, so a query costs constant time no matter how many trees exist.
// returns the tree that was hit (null if none); knocked-over trees no longer collide.
export function hitsTree(x, y, z, r) {
  const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const arr = treeGrid.get(key(cx + i, cz + j));
      if (!arr) continue;
      for (const t of arr) {
        if (t.dead || y > t.top) continue;
        const dx = x - t.x, dz = z - t.z;
        if (dx * dx + dz * dz < (t.r + r) * (t.r + r)) return t;
      }
    }
  }
  return null;
}

// knock a tree over: it falls in the plane's direction of travel, gets pushed along, then shrinks away
export function knockTree(t, dir, speed) {
  if (!t || t.dead) return;
  t.dead = true;
  let dx = dir.x, dz = dir.z;
  const l = Math.hypot(dx, dz) || 1;
  dx /= l; dz /= l;
  falling.push({ t, age: 0, dx, dz, push: Math.min(speed, 320) * 0.45 });
}

const FALL_TIME = 0.9, FADE_TIME = 0.45;
export function updateTrees(dt) {
  if (!falling.length || !trunkMesh) return;
  const axis = new THREE.Vector3();
  for (let i = falling.length - 1; i >= 0; i--) {
    const f = falling[i];
    f.age += dt;
    const k = Math.min(1, f.age / FALL_TIME);
    const ease = 1 - (1 - k) * (1 - k);
    // fall in the direction of travel: rotate about the horizontal axis (up x dir)
    axis.set(f.dz, 0, -f.dx);              // (0,1,0) × (dx,0,dz) = (dz, 0, -dx)
    _q.setFromAxisAngle(axis, ease * 1.65);
    const slide = f.push * ease;
    const fade = f.age > FALL_TIME ? Math.max(0, 1 - (f.age - FALL_TIME) / FADE_TIME) : 1;
    writeTree(f.t, _q, f.dx * slide, f.dz * slide, fade);
    if (fade <= 0) falling.splice(i, 1);
  }
  trunkMesh.instanceMatrix.needsUpdate = true;
  leafMesh.instanceMatrix.needsUpdate = true;
}

// stand all the trees back up when a new run starts
export function restoreTrees() {
  if (!trunkMesh) return;
  falling.length = 0;
  _q.identity();
  for (const t of allTrees) {
    if (!t.dead) continue;
    t.dead = false;
    writeTree(t, _q);
  }
  trunkMesh.instanceMatrix.needsUpdate = true;
  leafMesh.instanceMatrix.needsUpdate = true;
}

// main entry point for ground (and tree) collision
export function hitsGround(x, y, z, r, clearance = 0) {
  if (y - clearance < heightAt(x, z) + r) return true;
  return !!hitsTree(x, y, z, r);
}
