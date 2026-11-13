// js/plane.js: the player plane. Arcade flight model + body model (pure geometry, zero art assets).
// No real aerodynamics: velocity follows the nose, input sets angular rates directly.
// The one thing that makes it feel like a plane: bank-to-turn coupling. Banking automatically yaws.

import * as THREE from 'three';
import { CFG } from './config.js';
import { heightAt, hitsTree, knockTree, spawnAltitude, isBuilding } from './terrain.js';

/* ---------- Build a plane out of basic shapes ---------- */
export function buildPlaneMesh(color = 0x9fd2ff, accent = 0x2b6cb0) {
  const g = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color });
  const trim = new THREE.MeshLambertMaterial({ color: accent });

  // fuselage
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 2.0, 26, 8), body);
  fus.rotation.x = Math.PI / 2;
  g.add(fus);
  // nose
  const nose = new THREE.Mesh(new THREE.ConeGeometry(3.2, 9, 8), body);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -17.5;
  g.add(nose);
  // main wing
  const wing = new THREE.Mesh(new THREE.BoxGeometry(34, 1.1, 7), trim);
  wing.position.z = -1;
  g.add(wing);
  // tailplane
  const tail = new THREE.Mesh(new THREE.BoxGeometry(13, 1, 4), trim);
  tail.position.z = 11;
  g.add(tail);
  // fin
  const fin = new THREE.Mesh(new THREE.BoxGeometry(1, 7, 5), trim);
  fin.position.set(0, 3.5, 11);
  g.add(fin);
  // cockpit
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 6), new THREE.MeshLambertMaterial({ color: 0x0d1b2a }));
  canopy.position.set(0, 2.2, -4);
  canopy.scale.set(1, 0.7, 1.8);
  g.add(canopy);

  return g;
}

const _tip = new THREE.Vector3();

export class Plane {
  // spec comes from the hangar blueprint (spec.js); if omitted, the stock values from config are used (that's the test path)
  constructor(scene, spec = null) {
    this.scene = scene;
    this.P = { ...CFG.plane, ...(spec || {}) };
    this.propellers = [];
    this.mesh = buildPlaneMesh();
    scene.add(this.mesh);
    this.reset();
  }

  // before a sortie, swap in the plane built in the hangar: params and model together
  applySpec(spec, mesh = null, propellers = []) {
    this.P = { ...CFG.plane, ...(spec || {}) };
    if (mesh) {
      this.scene.remove(this.mesh);
      this.mesh = mesh;
      this.scene.add(this.mesh);
      this.propellers = propellers;
    }
    this.reset();
  }

  get maxHp() { return this.P.hp; }

  reset() {
    const P = this.P;
    this.pos = new THREE.Vector3(0, spawnAltitude(), 0);
    this.quat = new THREE.Quaternion();
    this.speed = P.speedBase;
    this.hp = P.hp;
    this.alive = true;
    this.invuln = P.respawnInvuln;
    this.roll = 0;                 // track the roll angle, used for bank-to-turn and the camera
    this.doubleT = 0;              // twin cannon time remaining
    this.rapidT = 0;               // rapid fire time remaining
    this.pairT = 0;                // missile pairs (the missile version of Twin Cannon) time remaining
    this.mRapidT = 0;              // rapid missiles (the missile version of Rapid Fire) time remaining
    this.burnT = 0;                // afterburner time remaining
    this.shieldT = 0;              // shield time remaining
    this.shieldHp = 0;             // damage the shield can still absorb
    this.missiles = P.missileStart ?? CFG.missile.startAmmo;
    this.reloadT = 0;              // time towards the next reloaded missile (pylons)
    this.gunCd = 0;
    this.missCd = 0;
    this.treeHits = 0;
    this.ramCd = 0;
    this.deathCause = '';
    this.syncMesh();
  }

  // body axes (three.js treats -Z as forward by default)
  forward(out = new THREE.Vector3()) { return out.set(0, 0, -1).applyQuaternion(this.quat); }
  up(out = new THREE.Vector3()) { return out.set(0, 1, 0).applyQuaternion(this.quat); }
  right(out = new THREE.Vector3()) { return out.set(1, 0, 0).applyQuaternion(this.quat); }

  syncMesh() {
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);
    // blinking while invulnerable: 2 times a second (it was 6; flashing faster than 3 times a second can trigger
    // photosensitive epilepsy)
    this.mesh.visible = this.alive && !(this.invuln > 0 && Math.floor(this.invuln * 4) % 2 === 0);
  }

  update(dt, input) {
    if (!this.alive) return;
    const P = this.P;
    if (this.invuln > 0) this.invuln -= dt;
    if (this.doubleT > 0) this.doubleT -= dt;
    if (this.rapidT > 0) this.rapidT -= dt;
    if (this.pairT > 0) this.pairT -= dt;
    if (this.mRapidT > 0) this.mRapidT -= dt;
    if (this.burnT > 0) this.burnT -= dt;
    if (this.shieldT > 0) { this.shieldT -= dt; if (this.shieldT <= 0) this.shieldHp = 0; }

    // afterburner power-up: top speed, cruise speed and turn rates all scaled up while it lasts
    const boost = this.burnT > 0 ? CFG.power.burnMul : 1;
    const maxSpeed = P.speedMax * boost, cruise = P.speedBase * boost;
    if (this.gunCd > 0) this.gunCd -= dt;
    if (this.missCd > 0) this.missCd -= dt;
    // pylons reload missiles over time, up to the rack's capacity
    const cap = P.missileMax ?? CFG.missile.maxAmmo;
    if (P.missileReload > 0 && this.missiles < cap) {
      this.reloadT += dt;
      if (this.reloadT >= P.missileReload) { this.reloadT = 0; this.missiles++; }
    } else this.reloadT = 0;

    // --- throttle ---
    let target = this.speed;
    if (input.throttleUp) target += P.throttleAccel * dt;
    else if (input.throttleDown) target -= P.throttleAccel * dt;
    else {
      // released: return to cruise speed
      const d = cruise - this.speed;
      target += Math.sign(d) * Math.min(Math.abs(d), P.throttleDrag * dt);
    }
    // above top speed (the afterburner just ran out): bleed speed off smoothly instead of snapping down
    if (target > maxSpeed) target = Math.max(maxSpeed, this.speed - 2 * P.throttleDrag * dt);
    this.speed = Math.max(P.speedMin, target);

    // --- angular rate input ---
    // harder to turn at low speed (a small low-speed penalty, but no stall)
    const agility = (0.65 + 0.35 * Math.min(1, this.speed / P.speedMax)) * boost;

    // keys give true/false, the touch stick and tilt give 0..1 (a half push is a gentler turn)
    const amt = v => (v === true ? 1 : Math.max(0, Math.min(1, +v || 0)));
    const pitch = amt(input.pitchUp) - amt(input.pitchDown);
    const rollIn = amt(input.rollLeft) - amt(input.rollRight);
    const yawIn = amt(input.yawLeft) - amt(input.yawRight);

    const dq = new THREE.Quaternion();
    const e = new THREE.Euler();

    // pitch (about body X): pull back to raise the nose
    if (pitch !== 0) {
      e.set(pitch * P.pitchRate * agility * dt, 0, 0, 'XYZ');
      dq.setFromEuler(e); this.quat.multiply(dq);
    }
    // CG drift (only if the hangar build is unbalanced): tail-heavy -> nose rises on its own, nose-heavy -> nose drops.
    // Capped below the stick rate, so the player can always hold it, but you clearly feel the plane is unbalanced.
    if (P.pitchDrift) {
      e.set(P.pitchDrift * dt, 0, 0, 'XYZ');
      dq.setFromEuler(e); this.quat.multiply(dq);
    }
    // --- roll: target-bank model, not continuous rolling ---
    // Holding A doesn't keep rolling; it smoothly banks to maxBank and holds there. Releasing levels out automatically.
    // This is what makes hold-to-turn stable. Continuous rolling makes sin(roll) swing between positive and negative,
    // so the turn cancels itself out, and you roll past inverted (the cause of the plane flipping whenever you turned).
    {
      const rgt0 = this.right(), up0 = this.up();
      const curBank = Math.atan2(rgt0.y, up0.y);        // positive = left bank
      // lateral imbalance biases the target bank toward the heavy side: released, the plane doesn't level out but drifts into a slow turn
      const bias = P.rollBias || 0;
      const targetBank = Math.max(-P.maxBank, Math.min(P.maxBank, rollIn * P.maxBank + bias));
      let d = targetBank - curBank;
      const step = Math.sign(d) * Math.min(Math.abs(d), P.rollRate * boost * dt);
      if (Math.abs(step) > 1e-6) {
        e.set(0, 0, step, 'XYZ');
        dq.setFromEuler(e); this.quat.multiply(dq);
      }
    }

    // direct yaw (weak, for fine trim)
    if (yawIn !== 0) {
      e.set(0, yawIn * P.yawRate * dt, 0, 'XYZ');
      dq.setFromEuler(e); this.quat.multiply(dq);
    }

    // --- bank-to-turn coupling: the core of the handling ---
    // Compute the current roll angle and yaw about the WORLD Y axis accordingly.
    // Sign convention (derived; do not flip it again):
    //   roll = atan2(rgt.y, upv.y) -> rolling left (A) raises the right wing, rgt.y>0, so roll>0 means LEFT bank
    //   a positive rotation about world +Y makes forward(0,0,-1) get a negative x -> nose swings to -X = LEFT turn
    //   so left bank -> left turn requires bankYaw to have the same sign as roll, i.e. +sin(roll).
    const rgt = this.right();
    const upv = this.up();
    this.roll = Math.atan2(rgt.y, upv.y);          // positive = left bank
    const bankYaw = Math.sin(this.roll) * P.bankTurn * agility * dt;
    if (Math.abs(bankYaw) > 1e-6) {
      const wq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), bankYaw);
      this.quat.premultiply(wq);                    // world axis -> premultiply
    }

    // leveling out is already handled by the target-bank model above (targetBank=0 on release), no separate autoLevel needed

    this.quat.normalize();

    // --- movement: velocity always along the nose ---
    const fwd = this.forward();
    this.pos.addScaledVector(fwd, this.speed * dt);

    // --- world boundary: soft push back ---
    const half = CFG.world.size / 2 - 120;
    for (const ax of ['x', 'z']) {
      if (this.pos[ax] > half) this.pos[ax] = half;
      if (this.pos[ax] < -half) this.pos[ax] = -half;
    }
    // ceiling: climbing gets weaker over the last ceilingSoft, then it stops (it used to stop dead at 1500)
    const W = CFG.world, soft = W.ceiling - W.ceilingSoft;
    if (this.pos.y > soft && fwd.y > 0) this.pos.y -= fwd.y * this.speed * dt * Math.min(1, (this.pos.y - soft) / W.ceilingSoft);
    if (this.pos.y > W.ceiling) this.pos.y = W.ceiling;

    // --- ground: fatal ---
    // Hitting the ground is a crash. It was once changed to lose hull + bounce back up, based on a wrong assumption (that players were dying to terrain);
    // the death panel showed zero ground hits, and bouncing back into the air broke immersion. The PULL UP warning does the warning.
    const gh = heightAt(this.pos.x, this.pos.z);
    let tipDown = false;
    if (P.tips) for (const t of P.tips) {
      _tip.set(t.x, t.y, t.z).applyQuaternion(this.quat).add(this.pos);
      if (_tip.y < heightAt(_tip.x, _tip.z)) { tipDown = true; break; }
    }
    if (this.pos.y - P.groundClearance < gh || tipDown) {
      this.crash();
      if (isBuilding(this.pos.x, this.pos.z) || (tipDown && isBuilding(_tip.x, _tip.z))) this.deathCause = 'BUILDING';
      this.syncMesh();
      return;
    }

    // --- trees: lose hull + slow down + knock the tree over, and keep flying (no teleport) ---
    const tree = hitsTree(this.pos.x, this.pos.y, this.pos.z, P.radius);
    if (tree) {
      knockTree(tree, fwd, this.speed);      // a knocked-over tree no longer collides, so each tree only hurts once
      this.treeHits++;
      this.speed = Math.max(P.speedMin, this.speed * P.treeSlow);
      this.hurt(P.treeDamage, 'TREE');
      if (!this.alive) { this.syncMesh(); return; }
    }

    // spin the propellers (speed follows airspeed)
    for (const g of this.propellers) g.rotation.z += (20 + this.speed * 0.12) * dt;

    this.syncMesh();
  }

  hurt(dmg, cause = 'ENEMY FIRE') {
    if (!this.alive || this.invuln > 0) return false;
    // shield power-up soaks damage first (crashing into the ground bypasses it, see crash())
    if (this.shieldT > 0 && this.shieldHp > 0) {
      const soak = Math.min(this.shieldHp, dmg);
      this.shieldHp -= soak;
      dmg -= soak;
      if (dmg <= 0) return true;
    }
    this.hp -= dmg;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; this.deathCause = cause; }
    return true;
  }

  // Ground = crash. Invulnerability doesn't save you (it protects from bullets, not from the ground)
  crash() {
    if (!this.alive) return;
    this.hp = 0;
    this.alive = false;
    this.deathCause = 'TERRAIN';
  }

  heal(n) { this.hp = Math.min(this.P.hp, this.hp + n); }
}
