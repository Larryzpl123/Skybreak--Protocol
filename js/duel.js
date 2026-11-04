// js/duel.js: two plane designs fight 1v1, both flown by the same computer pilot (autopilot.js), with the real
// flight model and the versus rules for damage (cannon x CFG.versus.gunMul, missiles CFG.versus.missileDamage).
// The pilot is the same on both sides, so what decides it is the designs. Used by the AI Test (dogfight grade) and
// the Design Duel window. Nothing is drawn unless a scene that is drawn is passed in.

import * as THREE from 'three';
import { CFG } from './config.js';
import { Plane } from './plane.js';
import { Weapons, pickMissileTarget } from './weapons.js';
import { Autopilot } from './autopilot.js';
import { spawnAltitude } from './terrain.js';

const V = () => CFG.versus;
export const DUEL_TIME = 120;          // one life each; still both flying after this long = a draw

// What the other side's pilot and guns see of a plane: where it is, how it moves, how big it is
function targetOf(plane) {
  return {
    type: 'plane', plane,
    get pos() { return plane.pos; },
    get vel() { return plane.forward().multiplyScalar(plane.speed); },
    get alive() { return plane.alive; },
    get radius() { return plane.P.radius; },
    get hp() { return plane.hp; },
  };
}

// One duel. specA / specB: plane specs (spec.js). side: 0 or 1 (who starts where). rand: random source.
// -> { step(frames) -> true when over, winner: 'a' | 'b' | null (draw), t, a, b (the planes), dispose() }
export function makeDuel(scene, specA, specB, { side = 0, rand = Math.random, meshes = null } = {}) {
  const a = new Plane(scene), b = new Plane(scene);
  a.applySpec(specA, meshes && meshes.a ? meshes.a.group : null, meshes && meshes.a ? meshes.a.propellers : []);
  b.applySpec(specB, meshes && meshes.b ? meshes.b.group : null, meshes && meshes.b ? meshes.b.propellers : []);
  // side by side, 900 apart, both flying the same way (the AI Ladder's neutral start)
  const alt = spawnAltitude();
  const sa = side ? 450 : -450;
  a.pos.set(sa, alt, 0); b.pos.set(-sa, alt, 0);
  a.syncMesh(); b.syncMesh();
  const wa = new Weapons(scene), wb = new Weapons(scene);
  const pa = new Autopilot(a, rand), pb = new Autopilot(b, rand);
  const ta = targetOf(a), tb = targetOf(b);
  const hitBy = victim => (e, d) => { if (victim.alive) victim.hurt(d >= 60 ? V().missileDamage : d * V().gunMul, d >= 60 ? 'MISSILE' : 'ENEMY FIRE'); };
  const duel = { winner: null, t: 0, a, b, over: false };
  const DT = 1 / 60;
  const fly = (p, pilot, w, foe) => {
    const list = foe.alive ? [foe] : [];
    const inp = pilot.update(DT, list);
    if (!p.alive) return;
    p.update(DT, inp);
    if (!p.alive) return;
    if (inp.fire) w.fireGun(p, list);
    if (inp.missile) { const mt = pickMissileTarget(p.pos, p.forward(), list, CFG.missile.lockRange, CFG.missile.lockCone, w.missiles); if (mt) w.fireMissile(p, mt); }
  };
  duel.step = n => {
    for (let i = 0; i < n; i++) {
      if (duel.over) return true;
      duel.t += DT;
      fly(a, pa, wa, tb);
      fly(b, pb, wb, ta);
      wa.update(DT, { enemies: tb.alive ? [tb] : [], plane: a, onEnemyHit: hitBy(b), onPlayerHit: () => {} });
      wb.update(DT, { enemies: ta.alive ? [ta] : [], plane: b, onEnemyHit: hitBy(a), onPlayerHit: () => {} });
      // a mid-air collision hurts both
      if (a.alive && b.alive && a.pos.distanceTo(b.pos) < a.P.radius + b.P.radius && !(a.ramCd > 0)) {
        a.hurt(V().ramDamage, 'COLLISION'); b.hurt(V().ramDamage, 'COLLISION'); a.ramCd = b.ramCd = CFG.plane.ramCooldown;
      }
      if (a.ramCd > 0) a.ramCd -= DT;
      if (b.ramCd > 0) b.ramCd -= DT;
      if (!a.alive || !b.alive || duel.t >= DUEL_TIME) {
        duel.over = true;
        duel.winner = a.alive && !b.alive ? 'a' : b.alive && !a.alive ? 'b' : null;
        return true;
      }
    }
    return false;
  };
  duel.dispose = () => { wa.clear(); wb.clear(); scene.remove(a.mesh); scene.remove(b.mesh); };
  return duel;
}
