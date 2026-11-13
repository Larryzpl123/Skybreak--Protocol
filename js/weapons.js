// js/weapons.js: cannon / missiles / enemy projectiles + aim assist
// Whether 3D shooting is fun comes down, 90% of the time, to three things in this file:
//   1) the lead indicator (tells the player where to shoot)
//   2) slight bullet magnetism (turns near misses into hits; currently off, see gun.assistTurn in config.js)
//   3) hit spheres larger than the models (forgiveness)
// Without these, 3D air combat is constant missing and feels terrible.

import * as THREE from 'three';
import { CFG } from './config.js';
import { heightAt, hitsTree } from './terrain.js';
import { rand } from './rand.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/* ================= Lead calculation =================
   Solve |targetPos + targetVel*t - shooterPos| = bulletSpeed*t
   for the intercept time t, then compute the point to aim at. Hitting moving targets depends on it. */
export function interceptPoint(shooterPos, bulletSpeed, targetPos, targetVel) {
  const rel = _v.copy(targetPos).sub(shooterPos);
  const a = targetVel.lengthSq() - bulletSpeed * bulletSpeed;
  const b = 2 * rel.dot(targetVel);
  const c = rel.lengthSq();

  let t;
  if (Math.abs(a) < 1e-4) {
    t = c > 1e-6 ? -c / b : 0;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;             // can't catch it
    const sq = Math.sqrt(disc);
    const t1 = (-b + sq) / (2 * a);
    const t2 = (-b - sq) / (2 * a);
    t = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
    if (!isFinite(t)) return null;
  }
  if (t < 0) return null;
  return new THREE.Vector3().copy(targetVel).multiplyScalar(t).add(targetPos);
}

/* the nearest enemy within the crosshair cone. Shared by the indicator and missile lock */
export function pickTarget(pos, fwd, enemies, maxRange, cone) {
  let best = null, bestScore = Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = _v.copy(e.pos).sub(pos);
    const dist = d.length();
    if (dist > maxRange || dist < 1) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, d.dot(fwd) / dist)));
    if (ang > cone) continue;
    // angle first, then distance
    const score = ang * 900 + dist * 0.35;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}

// What one missile does to a boss: CFG.missile.damage x bossMul, and (bossScale) growing with the boss level the
// way its hull does, so every boss takes about the same number of missiles (cannons keep up through their numbers).
export function bossMissileDamage(boss) {
  const M = CFG.missile, level = boss.level || 1;
  return M.damage * (M.bossMul ?? 1) * (M.bossScale ? 1 + (level - 1) * CFG.enemy.boss.levelHp : 1);
}

/* Missile lock: the best target in the missile cone that is not already done for. An enemy whose incoming missiles
   will kill it is skipped, so holding F spreads a salvo over several enemies instead of sending three missiles at one
   (missile builds were wasting most of their missiles that way). null if every target is already taken care of. */
export function pickMissileTarget(pos, fwd, enemies, maxRange, cone, missiles = []) {
  const incoming = new Map();
  for (const m of missiles) {
    if (!m.target || !m.target.alive) continue;
    const d = m.target.type === 'boss' ? bossMissileDamage(m.target) : m.dmg;
    incoming.set(m.target, (incoming.get(m.target) || 0) + d);
  }
  return pickTarget(pos, fwd, enemies.filter(e => !((incoming.get(e) || 0) >= e.hp)), maxRange, cone);
}

/* ================= Projectile pools ================= */
export class Weapons {
  constructor(scene) {
    this.scene = scene;
    this.bullets = [];       // player cannon
    this.missiles = [];
    this.enemyShots = [];    // enemy projectiles (in versus: other players' bullets, which only I check against my plane)
    this.pvpMissiles = [];   // versus: other players' missiles (homing on me, or just shown homing on someone else)
    this.missileMul = 1;     // missile damage multiplier for the current wave (set by main.js; bosses ignore it)
    this.shotsFired = 0;     // accuracy stats (for diagnostics)
    this.shotsHit = 0;

    this.bulletGeo = new THREE.SphereGeometry(CFG.gun.radius, 6, 4);
    this.bulletMat = new THREE.MeshBasicMaterial({ color: 0xfff08a });
    this.enemyMat = new THREE.MeshBasicMaterial({ color: 0xff6a5a });
    this.missileGeo = new THREE.ConeGeometry(2.6, 12, 6);
    this.missileMat = new THREE.MeshBasicMaterial({ color: 0xe8f4ff });
  }

  clear() {
    for (const a of [this.bullets, this.missiles, this.enemyShots, this.pvpMissiles])
      for (const b of a) this.scene.remove(b.mesh);
    this.bullets.length = 0; this.missiles.length = 0; this.enemyShots.length = 0; this.pvpMissiles.length = 0;
    this.shotsFired = 0; this.shotsHit = 0;
    this.missileMul = 1;                // a new run (or a test flight) starts at wave-1 missile damage
  }

  /* ---------- Player cannon ---------- */
  fireGun(plane, enemies) {
    if (plane.gunCd > 0) return;
    plane.gunCd = CFG.gun.cooldown * (plane.rapidT > 0 ? CFG.power.rapidMul : 1);   // rapid fire power-up

    const fwd = plane.forward();
    const rgt = plane.right();

    // muzzle positions: a hangar-built plane has one muzzle per cannon (plane-local coordinates);
    // without a blueprint (the test path) it falls back to the original single muzzle, 16 ahead of the nose.
    const mounts = plane.P && plane.P.cannonMounts
      ? plane.P.cannonMounts
      : [{ x: 0, y: 0, z: -16 }];
    if (!mounts.length) return;                    // missile-only plane: no cannon

    // twin cannon drop: one shot to each side of every muzzle
    const twin = plane.doubleT > 0;
    const spread = twin ? (mounts.length > 1 ? [-3.5, 3.5] : [-7, 7]) : [0];

    for (const m of mounts) {
      const base = new THREE.Vector3(m.x, m.y, m.z).applyQuaternion(plane.quat).add(plane.pos);
      for (const off of spread) {
        const dir = fwd.clone();
        dir.x += (rand() - 0.5) * CFG.gun.spread;
        dir.y += (rand() - 0.5) * CFG.gun.spread;
        dir.z += (rand() - 0.5) * CFG.gun.spread;
        dir.normalize();

        const p = base.clone().addScaledVector(rgt, off);
        const mesh = new THREE.Mesh(this.bulletGeo, this.bulletMat);
        mesh.position.copy(p);
        this.scene.add(mesh);
        // with several cannons each shot's damage is scaled down sublinearly (see gunDamageMul in spec.js); 1 for a single cannon / the test path
        const dmg = CFG.gun.damage * ((plane.P && plane.P.gunDamageMul) || 1);
        this.bullets.push({ mesh, pos: p, dir, life: CFG.gun.life, dmg });
        this.shotsFired++;
      }
    }
    if (this.onFire) this.onFire(plane, mounts);         // the game: sound and muzzle flashes (none in the AI Test)
  }

  // co-op host: a teammate's bullet, simulated here so hits are decided in one place
  addRemoteBullet(p, d, dmg) {
    const mesh = new THREE.Mesh(this.bulletGeo, this.bulletMat);
    const pos = new THREE.Vector3(p[0], p[1], p[2]);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.bullets.push({ mesh, pos, dir: new THREE.Vector3(d[0], d[1], d[2]).normalize(), life: CFG.gun.life, dmg, remote: true });
  }

  // versus: another player's bullet (owner = their peer id); it can only hurt the local plane
  addPvpShot(p, d, dmg, owner) {
    const mesh = new THREE.Mesh(this.bulletGeo, this.enemyMat);
    const pos = new THREE.Vector3(p[0], p[1], p[2]);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.enemyShots.push({ mesh, pos, dir: new THREE.Vector3(d[0], d[1], d[2]).normalize(), life: CFG.gun.life, dmg, speed: CFG.gun.speed, owner });
  }
  // versus: another player's missile. mine = it is homing on the local plane (only then can it do damage)
  addPvpMissile({ pos, dir, target, dmg, owner, mine, vid = null }) {
    const mesh = new THREE.Mesh(this.missileGeo, this.enemyMat);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.pvpMissiles.push({ mesh, pos: pos.clone(), dir: dir.clone().normalize(), life: CFG.missile.life, dmg, target, owner, mine, vid });
  }

  /* ---------- Player missiles (lock-on) ---------- */
  // free = the second missile of a pair (Missile Pairs power-up): no ammo, no cooldown, launched from the other side
  fireMissile(plane, target, free = false) {
    if (!free) {
      if (plane.missCd > 0 || plane.missiles <= 0) return false;
      // Rapid Missiles (Rapid Fire picked up by a missile plane, see powerups.js) halves the time between missiles.
      // No faster reloading: a rack of 6 to 8 pylons already has more missiles than it can fire.
      plane.missCd = CFG.missile.cooldown * (plane.mRapidT > 0 ? CFG.power.rapidMul : 1);
      plane.missiles--;
    }

    const fwd = plane.forward();
    const p = plane.pos.clone().addScaledVector(fwd, 14);
    if (free && plane.right) p.addScaledVector(plane.right(), 8);
    const mesh = new THREE.Mesh(this.missileGeo, this.missileMat);
    mesh.position.copy(p);
    this.scene.add(mesh);
    this.missiles.push({
      mesh, pos: p, dir: fwd.clone(), life: CFG.missile.life,
      dmg: CFG.missile.damage * this.missileMul, target,
    });
    if (this.onLaunch) this.onLaunch(p, plane);
    return true;
  }

  // Missile Pairs: every other missile launch is a pair (the second one is free). Called right after a launch.
  pairDue(plane) {
    if (!(plane.pairT > 0)) return false;
    plane.pairN = (plane.pairN || 0) + 1;
    return plane.pairN % 2 === 0;
  }

  /* ---------- Enemy projectiles ---------- */
  fireEnemy(pos, dir, speed, dmg) {
    if (this.onEnemyFire) this.onEnemyFire(pos, dir, speed, dmg);   // co-op host: tell the guests
    const mesh = new THREE.Mesh(this.bulletGeo, this.enemyMat);
    mesh.scale.setScalar(1.5);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.enemyShots.push({ mesh, pos: pos.clone(), dir: dir.clone().normalize(), life: 4.5, dmg, speed });
  }

  /* ================= Per-frame update ================= */
  update(dt, ctx) {
    const { enemies, plane, onEnemyHit, onPlayerHit } = ctx;

    // --- player cannon ---
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;

      // Magnetism: only corrects direction in a very short window right after firing (disabled while assistTurn is 0).
      // Good aim assist must be invisible. Correcting the whole flight makes bullets curve visibly in midair (obviously fake);
      // limited to the moment they leave the nose, the correction happens close to the player and just looks like good aim.
      // After that bullets always fly straight; the real forgiveness comes from the invisible hitPad.
      const age = CFG.gun.life - b.life;
      if (CFG.gun.assistTurn > 0 && age < CFG.gun.assistWindow) {
        const t = pickTarget(b.pos, b.dir, enemies, CFG.gun.assistRange, CFG.gun.assistCone);
        if (t) {
          _v.copy(t.pos).sub(b.pos).normalize();
          b.dir.lerp(_v, Math.min(1, CFG.gun.assistTurn * dt)).normalize();
        }
      }

      b.pos.addScaledVector(b.dir, CFG.gun.speed * dt);
      b.mesh.position.copy(b.pos);

      let dead = b.life <= 0;
      if (!dead) {
        for (const e of enemies) {
          if (!e.alive) continue;
          const rr = e.radius + CFG.gun.radius + CFG.gun.hitPad;
          if (_v.copy(e.pos).sub(b.pos).lengthSq() < rr * rr) {
            onEnemyHit(e, b.dmg, b.pos);
            if (!b.remote) this.shotsHit++;
            dead = true; break;
          }
        }
      }
      if (!dead && b.pos.y < heightAt(b.pos.x, b.pos.z)) dead = true;
      if (dead) { this.scene.remove(b.mesh); this.bullets.splice(i, 1); }
    }

    // --- missiles ---
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.life -= dt;

      if (m.target && m.target.alive) {
        // Lead pursuit: steer for where the target will be, not where it is. Chasing its current position (the old
        // way) made missiles swing in behind a crossing enemy and miss: test/missile_sim.mjs measured 40 to 65 %
        // hits on fighters, about 90 to 100 % now (a jinking ace up close still gets away sometimes).
        const lead = m.target.vel ? interceptPoint(m.pos, CFG.missile.speed, m.target.pos, m.target.vel) : null;
        _v.copy(lead || m.target.pos).sub(m.pos).normalize();
        m.dir.lerp(_v, Math.min(1, CFG.missile.turnRate * dt)).normalize();
      }
      m.pos.addScaledVector(m.dir, CFG.missile.speed * dt);
      m.mesh.position.copy(m.pos);
      // point the missile body along its flight direction
      m.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), m.dir);

      let dead = m.life <= 0;
      if (!dead) {
        for (const e of enemies) {
          if (!e.alive) continue;
          const rr = e.radius + CFG.missile.radius + CFG.missile.hitPad;
          if (_v.copy(e.pos).sub(m.pos).lengthSq() < rr * rr) {
            onEnemyHit(e, e.type === 'boss' ? bossMissileDamage(e) : m.dmg, m.pos);
            dead = true; break;
          }
        }
      }
      if (!dead && m.pos.y < heightAt(m.pos.x, m.pos.z)) dead = true;
      if (dead) { this.scene.remove(m.mesh); this.missiles.splice(i, 1); }
    }

    // --- enemy projectiles ---
    for (let i = this.enemyShots.length - 1; i >= 0; i--) {
      const s = this.enemyShots[i];
      s.life -= dt;
      s.pos.addScaledVector(s.dir, s.speed * dt);
      s.mesh.position.copy(s.pos);

      let dead = s.life <= 0;
      if (!dead && plane.alive) {
        const rr = (plane.P ? plane.P.radius : CFG.plane.radius) + 8;   // bigger planes are easier to hit
        if (_v.copy(plane.pos).sub(s.pos).lengthSq() < rr * rr) {
          onPlayerHit(s.dmg, undefined, s);        // s.owner says which player fired it (versus)
          dead = true;
        }
      }
      if (!dead && s.pos.y < heightAt(s.pos.x, s.pos.z)) dead = true;
      if (dead) { this.scene.remove(s.mesh); this.enemyShots.splice(i, 1); }
    }

    // --- versus: other players' missiles ---
    for (let i = this.pvpMissiles.length - 1; i >= 0; i--) {
      const m = this.pvpMissiles[i];
      m.life -= dt;
      const t = m.target;
      if (t && t.alive) {
        _v.copy(t.pos).sub(m.pos).normalize();
        m.dir.lerp(_v, Math.min(1, CFG.missile.turnRate * CFG.versus.missileTurnMul * dt)).normalize();
      }
      m.pos.addScaledVector(m.dir, CFG.missile.speed * dt);
      m.mesh.position.copy(m.pos);
      m.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), m.dir);
      let dead = m.life <= 0 || m.pos.y < heightAt(m.pos.x, m.pos.z);
      if (!dead && t && t.alive) {
        const rr = (t.P ? t.P.radius : CFG.plane.radius) + CFG.missile.radius + 4;
        if (t.pos.distanceToSquared(m.pos) < rr * rr) {
          if (m.mine) onPlayerHit(m.dmg, 'MISSILE', m);
          dead = true;
        }
      }
      if (dead) { this.scene.remove(m.mesh); this.pvpMissiles.splice(i, 1); }
    }
  }
}
