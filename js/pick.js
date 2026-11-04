// js/pick.js: ray-to-cell picking (pure math, no three.js Raycaster)
//
// Why hand-written: part models include cylinders (cannons, nozzles). When three's raycaster hits a cylinder's side
// it returns a slanted radial normal, and using that to decide which face to attach to places parts crooked.
// Here every cell is treated as an axis-aligned cube with a slab test, so the normal is always one of +-x/+-y/+-z and placement always lands in the right cell.

import { CELL } from './parts.js';

// origin / dir: {x,y,z} (dir need not be normalized); cells: [{x,y,z}] in grid coordinates
// returns the nearest hit { cell, t, normal:{x,y,z} } or null
export function pickCell(origin, dir, cells, size = CELL) {
  const h = size / 2;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  let best = null;

  for (const c of cells) {
    const ctr = [c.x * size, c.y * size, c.z * size];
    let tmin = -Infinity, tmax = Infinity, axis = -1, sign = 0;
    let miss = false;

    for (let a = 0; a < 3; a++) {
      const lo = ctr[a] - h, hi = ctr[a] + h;
      if (Math.abs(d[a]) < 1e-12) {
        if (o[a] < lo || o[a] > hi) { miss = true; break; }
        continue;
      }
      let t1 = (lo - o[a]) / d[a];
      let t2 = (hi - o[a]) / d[a];
      const near = Math.min(t1, t2), far = Math.max(t1, t2);
      if (near > tmin) {
        tmin = near; axis = a;
        sign = d[a] > 0 ? -1 : 1;     // moving in the positive direction -> entered through the low face -> normal points negative; otherwise positive
      }
      if (far < tmax) tmax = far;
      if (tmin > tmax) { miss = true; break; }
    }

    if (miss || tmax < 0 || tmin < 0 || axis < 0) continue;   // box is behind the ray, or the ray starts inside the box
    if (!best || tmin < best.t) {
      const normal = { x: 0, y: 0, z: 0 };
      normal[['x', 'y', 'z'][axis]] = sign;
      best = { cell: c, t: tmin, normal };
    }
  }
  return best;
}
