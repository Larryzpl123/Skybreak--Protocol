// js/autopilot.js: a computer pilot that flies a real plane (the player's flight model: the same pitch, roll,
// bank-to-turn, throttle and speed a person gets from that design), for the hangar's AI Test and the design duels.
// It gives the same inputs a keyboard would (pitchUp, rollLeft, fire...), so what it gets out of a plane is decided
// by the plane: how fast it turns, rolls and flies, its guns, missiles and hull.
//
// It is not a person: it re-decides a few times a second, aims with a little error and never panics. It also never
// dodges on purpose, so agile planes are worth a bit more in human hands than in its.

import * as THREE from 'three';
import { CFG } from './config.js';
import { interceptPoint, pickTarget, pickMissileTarget } from './weapons.js';
import { heightAt } from './terrain.js';

const NONE = { pitchUp: 0, pitchDown: 0, rollLeft: 0, rollRight: 0, yawLeft: 0, yawRight: 0, throttleUp: 0, throttleDown: 0, fire: 0, missile: 0 };
const _d = new THREE.Vector3();

export class Autopilot {
  // rand: a random source (the AI Test uses a seeded one so a plane always gets the same grade)
  constructor(plane, rand = Math.random, { decide = 0.25, aimNoise = 0.15 } = {}) {
    this.plane = plane;
    this.rand = rand;
    this.decide = decide;
    this.aimNoise = aimNoise;

    this.t = 0;
    this.inp = { ...NONE };
    this.target = null;
  }

  // enemies: what it may shoot at. -> the inputs for this frame (also fire / missile wishes)
  update(dt, enemies) {
    const p = this.plane;
    if (!p.alive) return { ...NONE };
    const alive = enemies.filter(e => e.alive);
    const fwd = p.forward();
    this.t -= dt;
    if (this.t <= 0) {
      // re-decide a few times a second: which target, and a new small aiming error
      this.t = this.decide;
      let tgt = pickTarget(p.pos, fwd, alive, 2500, 0.6);
      if (!tgt) { let bd = Infinity; for (const e of alive) { const d = e.pos.distanceToSquared(p.pos); if (d < bd) { bd = d; tgt = e; } } }
      this.target = tgt;
      const n = this.aimNoise;
      this.noise = new THREE.Vector3((this.rand() - 0.5) * n, (this.rand() - 0.5) * n, (this.rand() - 0.5) * n);
    }
    const inp = { ...NONE };
    const tgt = this.target && this.target.alive ? this.target : null;
    let aimDot = -1, dist = Infinity, missFor = 0;
    if (tgt) {
      const lead = interceptPoint(p.pos, CFG.gun.speed, tgt.pos, tgt.vel || new THREE.Vector3()) || tgt.pos;
      const to = _d.copy(lead).sub(p.pos);
      dist = to.length();
      to.normalize();
      aimDot = to.dot(fwd);
      missFor = tgt.radius + CFG.gun.radius + CFG.gun.hitPad;            // a bullet this close counts as a hit
      to.add(this.noise || new THREE.Vector3()).normalize();
      // turning: bank toward its heading (the plane turns by banking), pull toward it in the plane's own "up"
      const hf = Math.atan2(-fwd.x, -fwd.z), ht = Math.atan2(-to.x, -to.z);
      let yawErr = ht - hf;                                            // + = it is to the left
      while (yawErr > Math.PI) yawErr -= 2 * Math.PI;
      while (yawErr < -Math.PI) yawErr += 2 * Math.PI;
      const roll = Math.max(-1, Math.min(1, yawErr * 2.5));
      if (roll > 0) inp.rollLeft = roll; else inp.rollRight = -roll;
      const pull = to.dot(p.up()) * 5 + (to.dot(fwd) < 0 ? 1 : 0);
      if (pull > 0) inp.pitchUp = Math.min(1, pull); else inp.pitchDown = Math.min(1, -pull);
      if (dist > 800) inp.throttleUp = 1; else if (dist < 250 && aimDot > 0.9) inp.throttleDown = 1;
    }
    // the ground: wings level and pull up, before anything else
    const gh = heightAt(p.pos.x, p.pos.z);
    const ahead2 = heightAt(p.pos.x + fwd.x * p.speed * 2, p.pos.z + fwd.z * p.speed * 2);
    if (p.pos.y - gh < 170 || p.pos.y + fwd.y * p.speed * 2 - ahead2 < 120) {
      inp.pitchDown = 0; inp.pitchUp = 1; inp.rollLeft = 0; inp.rollRight = 0;
    }
    // shoot when the lead point is close enough to the nose that the bullets pass within the hit distance
    inp.fire = tgt && aimDot > 0 && dist < 1100 && dist * Math.sqrt(Math.max(0, 1 - aimDot * aimDot)) < missFor * 0.8 ? 1 : 0;
    inp.missile = !!pickMissileTarget(p.pos, fwd, alive, CFG.missile.lockRange, CFG.missile.lockCone, []);
    this.aimDot = aimDot; this.dist = dist;
    return inp;
  }
}
