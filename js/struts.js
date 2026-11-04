// js/struts.js: auto-struts, so parts hang from their neighbors instead of floating
// Pure functions with no three.js dependency, so it can be tested headlessly. partMesh.js draws the struts computed here.
//
// Problem: a wing is a very thin plate in the middle of its cell (so it joins the wings on either side into one piece),
// so anything hung above or below a wing (missile pylons, under-wing engines, belly cannons) sits 2 to 4 units away in thin air.
// Players called it maglev. The same happens when a small part sits next to a big one (e.g. a cannon beside a frame).
//
// Approach: for each pair of neighboring parts, compute the real gap from both parts' half sizes along that axis;
// if the gap exceeds a normal seam (cells leave about 0.4), generate a strut to fill it.
// each pair is handled once, in the positive direction only, to avoid duplicates.

import { CELL, cellKey } from './parts.js';

export const S = CELL * 0.92;

// each part's half size along x / y / z. MUST stay in sync with the geometry in partMesh.js
export const HALF = {
  core:      [S * 0.5,  S * 0.5,  S * 0.5],
  structure: [S * 0.5,  S * 0.5,  S * 0.5],
  armor:     [S * 0.52, S * 0.52, S * 0.52],
  wing:      [CELL * 0.5, S * 0.09, CELL * 0.45],   // thin plate: only 0.41 in y
  prop:      [S * 0.4,  S * 0.4,  S * 0.5],
  jet:       [S * 0.48, S * 0.48, S * 0.5],
  cannon:    [S * 0.275, S * 0.275, S * 0.35],
  pylon:     [S * 0.16, S * 0.16, S * 0.55],        // missile body
};

export const SEAM = CELL - S;          // normal seam of about 0.4, no strut needed
export const STRUT_MIN_GAP = 0.9;      // only add a strut above this

const DIRS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];   // positive direction only: each pair handled once

/* Returns a list of struts: { owner:{x,y,z}, axis, local:[x,y,z], size:[sx,sy,sz], kind, gap }
   local is relative to the owner part's cell center (partMesh hangs the strut inside the owner's group) */
export function computeStruts(parts) {
  const occ = new Map();
  for (const p of parts) occ.set(cellKey(p.x, p.y, p.z), p);
  const out = [];

  for (const a of parts) {
    const ha = HALF[a.type];
    if (!ha) continue;
    for (let axis = 0; axis < 3; axis++) {
      const [dx, dy, dz] = DIRS[axis];
      const b = occ.get(cellKey(a.x + dx, a.y + dy, a.z + dz));
      if (!b) continue;
      const hb = HALF[b.type];
      if (!hb) continue;

      const gap = CELL - ha[axis] - hb[axis];
      if (gap <= STRUT_MIN_GAP) continue;

      const pylon = a.type === 'pylon' || b.type === 'pylon';
      const bothWings = a.type === 'wing' && b.type === 'wing';
      // pylon: a blade stretched along the fuselage; regular strut: thin square post; biplane interplane strut: thinner still
      let thin = 0.7, long = 0.7;
      if (pylon) { thin = 0.45; long = S * 0.75; }
      else if (bothWings) { thin = 0.45; long = 0.45; }

      const size = [0, 0, 0];
      size[axis] = gap;
      const others = [0, 1, 2].filter(i => i !== axis);
      // the long dimension goes on z (along the fuselage) first, so an under-wing pylon is a fore-aft blade, like a real one
      if (others.includes(2)) {
        size[2] = long;
        size[others.find(i => i !== 2)] = thin;
      } else {
        size[others[0]] = thin; size[others[1]] = long;
      }

      const local = [0, 0, 0];
      local[axis] = ha[axis] + gap / 2;       // extends from a's surface out to b's surface

      out.push({
        owner: { x: a.x, y: a.y, z: a.z },
        other: { x: b.x, y: b.y, z: b.z },
        axis, local, size, gap,
        kind: pylon ? 'pylon' : bothWings ? 'biplane' : 'strut',
      });
    }
  }
  return out;
}
