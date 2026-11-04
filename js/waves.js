// js/waves.js: wave progression + drops
// Endless waves: count and hp climb with each wave, and a UFO boss arrives every bossEvery waves.

import * as THREE from 'three';
import { CFG } from './config.js';
import { Enemy } from './enemies.js';
import { heightAt } from './terrain.js';
import { POWERUPS, pickDropType } from './powerups.js';
import { rand } from './rand.js';

/* ================= Drops ================= */

export class Drops {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this.nextId = 0;
    this.geo = new THREE.OctahedronGeometry(11);
    this.mats = new Map();                     // one material per power-up type, shared (see enemies.js TEMPLATES)
  }
  mat(type) {
    if (!this.mats.has(type)) this.mats.set(type, new THREE.MeshBasicMaterial({ color: (POWERUPS[type] || POWERUPS.heal).color }));
    return this.mats.get(type);
  }
  clear() { for (const d of this.list) this.scene.remove(d.mesh); this.list.length = 0; }

  // forceType: always drop that type (the boss half-health supply). always: always drop, random type (bombers).
  // Otherwise: drop with CFG.drop.chance, type picked by CFG.drop.weights.
  spawn(pos, forceType = null, always = false) {
    if (!forceType && !always && rand() > CFG.drop.chance) return;
    const type = forceType || pickDropType();
    const mesh = new THREE.Mesh(this.geo, this.mat(type));
    mesh.position.copy(pos);
    this.scene.add(mesh);
    const d = { id: ++this.nextId, mesh, pos: pos.clone(), type, life: CFG.drop.life };
    this.list.push(d);
    return d;
  }
  // co-op: remove a drop that a teammate picked up (the host decides; returns its type or null)
  take(id) {
    const i = this.list.findIndex(d => d.id === id);
    if (i < 0) return null;
    const d = this.list[i];
    this.scene.remove(d.mesh);
    this.list.splice(i, 1);
    return d.type;
  }

  // returns an array of the types picked up this frame
  update(dt, plane) {
    const got = [];
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      d.life -= dt;
      const D = CFG.drop;

      // stop falling at a safe flying height, never near the crash line
      const floor = heightAt(d.pos.x, d.pos.z) + D.hoverAboveGround;
      if (d.pos.y > floor) {
        d.pos.y = Math.max(floor, d.pos.y - D.fallSpeed * dt);
      } else {
        d.pos.y = floor + Math.sin(d.life * 2.2) * 6;   // gentle bobbing while hovering
      }

      // magnet: drifts toward the player when close, no precise aiming needed
      if (plane.alive) {
        const toP = plane.pos.clone().sub(d.pos);
        const dist = toP.length();
        if (dist < D.magnetRange && dist > 1) {
          const pull = (1 - dist / D.magnetRange) * D.magnetSpeed * dt;
          d.pos.addScaledVector(toP.multiplyScalar(1 / dist), pull);
        }
      }

      d.mesh.position.copy(d.pos);
      d.mesh.rotation.y += 2.2 * dt;
      d.mesh.rotation.x += 1.1 * dt;

      let dead = d.life <= 0;
      if (!dead && plane.alive) {
        const r = CFG.drop.pickupRadius;
        if (d.pos.distanceToSquared(plane.pos) < r * r) { got.push(d.type); dead = true; }
      }
      if (dead) { this.scene.remove(d.mesh); this.list.splice(i, 1); }
    }
    return got;
  }
}

/* ================= Waves ================= */
// Which enemies make up regular wave w with `total` enemies. Specials replace fighters (so the wave size curve
// is unchanged) and each type ramps in slowly from its `from` wave. There is always at least one fighter;
// if the specials don't fit, drones are trimmed first, then aces, bombers, carriers.
export function composeWave(w, total) {
  const E = CFG.enemy;
  const ramp = (T, every, max) => (w >= T.from ? Math.min(max, 1 + Math.floor((w - T.from) / every)) : 0);
  const n = {
    drone: ramp(E.drone, 2, 4),
    bomber: ramp(E.bomber, 6, 2),
    ace: ramp(E.ace, 4, 3),
    carrier: ramp(E.carrier, 6, 2),
  };
  for (const k of ['drone', 'ace', 'bomber', 'carrier']) {
    while (n[k] > 0 && n.drone + n.bomber + n.ace + n.carrier > total - 1) n[k]--;
  }
  const list = [];
  for (const k of ['carrier', 'bomber', 'ace', 'drone']) for (let i = 0; i < n[k]; i++) list.push(k);
  while (list.length < total) list.push('fighter');
  return list;
}

export class Waves {
  constructor(scene) {
    this.scene = scene;
    this.enemies = [];
    this.reset();
  }

  // Co-op: every player the enemies can go after (defaults to just the local plane), and how many there are.
  // Each enemy chases the nearest living one; with n players there are n times the enemies and attackers.
  setTargets(list) { this.targets = list; }
  aliveTargets(plane) {
    const t = (this.targets || [plane]).filter(p => p && p.alive);
    return t.length ? t : [plane];
  }
  nearestTarget(e, plane) {
    let best = null, bd = Infinity;
    for (const p of this.aliveTargets(plane)) { const d = p.pos.distanceToSquared(e.pos); if (d < bd) { bd = d; best = p; } }
    return best || plane;
  }
  get players() { return Math.max(1, this.playerCount || 1); }

  reset() {
    for (const e of this.enemies) e.remove();
    this.enemies.length = 0;
    this.wave = 0;
    this.breakT = 1.2;      // a little prep time at the start
    this.inWave = false;
    this.bossWave = false;
    this.seen = new Set();  // enemy types already introduced this run
    this.newTypes = [];     // types that appeared for the first time in the current wave
  }

  get aliveCount() { return this.enemies.filter(e => e.alive).length; }

  isBossWave(n) { return n % CFG.wave.bossEvery === 0; }

  spawnWave(plane) {
    this.wave++;
    const W = CFG.wave;
    this.bossWave = this.isBossWave(this.wave);
    const hpScale = 1 + (this.wave - 1) * W.hpScale;

    if (this.bossWave) {
      // the boss appears far ahead of the player
      const fwd = plane.forward();
      const p = plane.pos.clone().addScaledVector(fwd, W.spawnDist);
      p.y = Math.max(heightAt(p.x, p.z) + 300, CFG.enemy.boss.hoverHeight);
      const level = Math.round(this.wave / W.bossEvery);            // 1st, 2nd, 3rd boss...
      this.enemies.push(new Enemy(this.scene, 'boss', p, (1 + (level - 1) * CFG.enemy.boss.levelHp) * this.players, level));
      // boss waves get a few escorts
      const guards = Math.min(4, 1 + Math.floor(this.wave / W.bossEvery));
      for (let i = 0; i < guards; i++) this.spawnFighter(plane, hpScale);
    } else {
      const n = Math.min(W.maxCount, Math.round(W.baseCount + (this.wave - 1) * W.countPerWave));
      // co-op: n players = n copies of the wave, each spawned around a different player
      const ts = this.aliveTargets(plane);
      for (let k = 0; k < this.players; k++) {
        for (const type of composeWave(this.wave, n)) this.spawnFighter(ts[k % ts.length], hpScale, type);
      }
    }
    this.newTypes = [];
    for (const e of this.enemies) {
      if (e.type !== 'fighter' && e.type !== 'boss' && !this.seen.has(e.type)) { this.seen.add(e.type); this.newTypes.push(e.type); }
    }
    this.inWave = true;
  }

  // each frame, the nearest N become attackers and the rest wait. The boss always counts as an attacker.
  maxAttackers() {
    const W = CFG.wave;
    return Math.min(W.maxAttackersCap, W.maxAttackers + Math.floor((this.wave - 1) / W.attackerEveryWaves)) * this.players;
  }

  assignAttackers(plane) {
    const fighters = [];
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.type === 'boss') { e.canAttack = true; continue; }
      e.canAttack = false;
      if (e.attacks) fighters.push(e);     // shield carriers never attack
    }
    if (!fighters.length) return;
    const dist = e => e.pos.distanceToSquared(this.nearestTarget(e, plane).pos);
    fighters.sort((a, b) => dist(a) - dist(b));
    const n = this.maxAttackers();
    for (let i = 0; i < Math.min(n, fighters.length); i++) fighters[i].canAttack = true;
  }

  // every enemy within a live carrier's range is shielded this frame (carriers don't shield each other or the boss)
  assignShields() {
    const carriers = this.enemies.filter(e => e.alive && e.type === 'carrier');
    const r2 = CFG.enemy.carrier.shieldRange ** 2;
    for (const e of this.enemies) {
      e.shielded = e.alive && e.type !== 'carrier' && e.type !== 'boss' &&
        carriers.some(c => c.pos.distanceToSquared(e.pos) < r2);
    }
  }

  spawnFighter(plane, hpScale, type = 'fighter') {
    const W = CFG.wave;
    const a = rand() * Math.PI * 2;
    const d = W.spawnDist * (0.7 + rand() * 0.6);
    const p = new THREE.Vector3(
      plane.pos.x + Math.cos(a) * d,
      0,
      plane.pos.z + Math.sin(a) * d
    );
    const half = CFG.world.size / 2 - 200;
    p.x = Math.max(-half, Math.min(half, p.x));
    p.z = Math.max(-half, Math.min(half, p.z));
    p.y = Math.max(heightAt(p.x, p.z) + 180, plane.pos.y + (rand() - 0.3) * 200);
    this.enemies.push(new Enemy(this.scene, type, p, hpScale));
  }

  // returns 'wave-start' / null, for the HUD message
  update(dt, plane, weapons) {
    let event = null;

    // ---- assign attacker slots ----
    // The standard action-game approach: there can be many enemies on the field, but only a few fire at once,
    // the rest circle outside. Otherwise enemy count = bullet multiplier, and linear stacking inevitably drowns the player.
    this.assignAttackers(plane);
    this.assignShields();

    for (const e of this.enemies) e.update(dt, this.targets ? this.nearestTarget(e, plane) : plane, weapons, this.enemies);

    // clear out the dead
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (!this.enemies[i].alive) { this.enemies[i].remove(); this.enemies.splice(i, 1); }
    }

    if (this.inWave && this.enemies.length === 0) {
      this.inWave = false;
      this.breakT = CFG.wave.breakTime;
    }
    if (!this.inWave) {
      this.breakT -= dt;
      if (this.breakT <= 0) { this.spawnWave(plane); event = 'wave-start'; }
    }
    return event;
  }
}
