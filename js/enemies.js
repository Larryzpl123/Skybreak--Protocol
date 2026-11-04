// js/enemies.js: enemy AI + models. Fighter, kamikaze drone, heavy bomber, ace, shield carrier, and the UFO boss.
// Fighters use three behaviors: chase, lead-and-shoot, break away when too close. Enough, and they don't get stuck circling forever.
// (Lesson learned: first confirm it can physically make the turn, then suspect the AI logic.)
// Every attacking type goes through the attacker-slot system in waves.js, so more enemy types never means more bullets at once.

import * as THREE from 'three';
import { CFG } from './config.js';
import { buildPlaneMesh } from './plane.js';
import { interceptPoint } from './weapons.js';
import { heightAt } from './terrain.js';
import { Weather } from './weather.js';
import { rand } from './rand.js';

const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _nose = new THREE.Vector3(0, 0, -1);

// Name + one-line tip, shown the first time a type appears in a run
export const ENEMY_INFO = {
  drone:   { name: 'KAMIKAZE DRONES', tip: 'a blinking marker is diving at you: shoot it or break hard' },
  bomber:  { name: 'HEAVY BOMBER', tip: 'tough, but always drops a power-up' },
  ace:     { name: 'ACE', tip: 'dodges when you aim at it; lead your shots' },
  carrier: { name: 'SHIELD CARRIER', tip: 'shields nearby enemies; kill it first' },
};

/* ---------- Models for the special enemies ---------- */
function buildDroneMesh() {
  const g = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ color: 0x2a2a30 });
  const glow = new THREE.MeshBasicMaterial({ color: 0xff3b3b });
  const dart = new THREE.Mesh(new THREE.ConeGeometry(3.6, 18, 6), body);
  dart.rotation.x = -Math.PI / 2;                 // tip toward -z (forward)
  g.add(dart);
  const fins = new THREE.Mesh(new THREE.BoxGeometry(14, 0.8, 4), body);
  fins.position.z = 5;
  g.add(fins);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 6), glow);   // red warhead light
  eye.position.z = -8;
  g.add(eye);
  const tail = new THREE.Mesh(new THREE.SphereGeometry(1.8, 6, 5), glow);
  tail.position.z = 9;
  g.add(tail);
  return g;
}

function buildCarrierMesh() {
  const g = new THREE.Group();
  const hull = new THREE.MeshLambertMaterial({ color: 0x3b4a5c });
  const glow = new THREE.MeshBasicMaterial({ color: 0x66ccff });
  g.add(new THREE.Mesh(new THREE.OctahedronGeometry(11), hull));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(19, 1.8, 6, 24), glow);
  ring.rotation.x = Math.PI / 2;
  ring.name = 'ring';
  g.add(ring);
  const core = new THREE.Mesh(new THREE.SphereGeometry(5, 10, 8), glow);
  g.add(core);
  return g;
}

function buildEnemyMeshNew(type) {
  if (type === 'drone') return buildDroneMesh();
  if (type === 'carrier') return buildCarrierMesh();
  if (type === 'ace') return buildPlaneMesh(0x2b2b33, 0xf5f5f5);
  if (type === 'bomber') {
    const m = buildPlaneMesh(0x5d6b4a, 0x2f3a28);
    m.scale.setScalar(2.3);
    return m;
  }
  return buildPlaneMesh(0xffb3a7, 0x8c2f2f);
}

/* ---------- UFO boss model: a tribute to the original UFO ---------- */
function buildUfoMesh() {
  const g = new THREE.Group();
  const hull = new THREE.MeshLambertMaterial({ color: 0x8a93a8 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x66ffcc });

  const disc = new THREE.Mesh(new THREE.CylinderGeometry(70, 46, 16, 20), hull);
  g.add(disc);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(64, 5, 8, 24), hull);
  rim.rotation.x = Math.PI / 2;
  g.add(rim);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(28, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), glow);
  dome.position.y = 8;
  g.add(dome);
  // ring of lights underneath
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const l = new THREE.Mesh(new THREE.SphereGeometry(4, 6, 5), glow);
    l.position.set(Math.cos(a) * 52, -8, Math.sin(a) * 52);
    g.add(l);
  }
  return g;
}

/* Every enemy of a type shares one set of geometries and materials. Building new ones for each enemy (and never
   freeing them) leaked GPU memory all run long: by wave 30 several thousand buffers, and phones (iPhone Safari above
   all) closed the game ("it keeps crashing"). Now each type is built once; enemies get a copy that shares it. */
const TEMPLATES = new Map();
function shareClone(src) {
  const o = src.geometry ? new THREE.Mesh(src.geometry, src.material) : new THREE.Group();
  o.position.copy(src.position);
  o.scale.copy(src.scale);
  o.rotation.x = src.rotation.x; o.rotation.y = src.rotation.y; o.rotation.z = src.rotation.z;
  o.name = src.name || '';
  for (const c of src.children) o.add(shareClone(c));
  return o;
}
function buildEnemyMesh(type) {
  if (!TEMPLATES.has(type)) TEMPLATES.set(type, type === 'boss' ? buildUfoMesh() : buildEnemyMeshNew(type));
  const m = shareClone(TEMPLATES.get(type));
  if (type === 'carrier') m.userData.ring = m.children.find(c => c.name === 'ring');
  return m;
}
let bubbleGeo = null, bubbleMat = null;     // the carrier shield bubble, shared by every enemy

export class Enemy {
  constructor(scene, type, pos, hpScale = 1, level = 1) {
    this.id = ++Enemy.nextId;                    // co-op: how the host and the guests refer to the same enemy
    this.type = type;
    this.alive = true;
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.shootCd = 1 + rand() * 1.5;
    this.t = 0;
    this.canAttack = true;                       // assigned by waves.js every frame
    this.orbitDir = rand() < 0.5 ? 1 : -1; // orbit direction while idle
    this.shielded = false;                       // set by waves.js every frame (near a shield carrier)

    if (type === 'boss') {
      const B = CFG.enemy.boss;
      this.mesh = buildEnemyMesh('boss');
      this.hp = this.maxHp = Math.round(B.hp * hpScale);
      this.radius = B.radius;
      this.speed = B.speed;
      this.score = B.score;
      this.cdVolley = 1.5; this.cdRing = 3; this.cdHoming = 4;
      this.fireRate = 1 + (level - 1) * B.levelFire;   // later bosses fire faster
      this.level = level;                               // (missiles hit it harder at higher levels, see bossMissileDamage)
    } else {
      const T = CFG.enemy[type];
      this.mesh = buildEnemyMesh(type);
      this.hp = this.maxHp = Math.round(T.hp * hpScale);
      this.radius = T.radius;
      this.speed = T.speed;
      this.score = T.score;
    }
    // solid: ramming it pushes you off instead of trading planes (a 170 hp bomber must not die to a 14 damage bump)
    this.solid = type === 'boss' || type === 'bomber';
    this.blastRadius = type === 'drone' ? CFG.enemy.drone.blastRadius : 0;   // proximity fuse
    this.ramDamage = type === 'drone' ? CFG.enemy.drone.ramDamage
      : this.solid ? CFG.plane.bossRamDamage : CFG.plane.ramDamage;
    this.alwaysDrops = type === 'bomber';
    this.attacks = type !== 'carrier';           // carriers never take an attacker slot
    this.burstLeft = 0; this.burstGapT = 0; this.burstCd = 1.5;   // bomber turret
    this.jinkT = 0; this.jinkCd = 0; this.jinkDir = null;          // ace evasion

    this.mesh.position.copy(this.pos);
    scene.add(this.mesh);
    // shield bubble, visible while a carrier is protecting this enemy
    if (type !== 'boss' && type !== 'carrier') {
      if (!bubbleGeo) {
        bubbleGeo = new THREE.SphereGeometry(1, 14, 10);
        bubbleMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.28, depthWrite: false });
      }
      this.bubble = new THREE.Mesh(bubbleGeo, bubbleMat);
      this.bubble.scale.setScalar(this.radius * 1.8);
      this.bubble.visible = false;
      scene.add(this.bubble);
    }
    this.scene = scene;
  }

  remove() {
    this.scene.remove(this.mesh);
    if (this.bubble) this.scene.remove(this.bubble);
  }

  // Returns true if this hit killed it. Something already dead can't die again,
  // otherwise the ramming path would score twice and drop loot twice.
  hurt(d) {
    if (!this.alive) return false;
    if (this.shielded) d *= CFG.enemy.carrier.shieldFactor;
    this.hp -= d;
    if (this.hp <= 0) { this.hp = 0; this.alive = false; return true; }
    return false;
  }

  update(dt, plane, weapons, all = []) {
    if (!this.alive) return;
    this.t += dt;
    if (this.type === 'boss') this.updateBoss(dt, plane, weapons);
    else if (this.type === 'drone') this.updateDrone(dt, plane);
    else if (this.type === 'bomber') this.updateBomber(dt, plane, weapons);
    else if (this.type === 'carrier') this.updateCarrier(dt, plane, all);
    else this.updateFighter(dt, plane, weapons);     // fighter and ace
    this.mesh.position.copy(this.pos);
    if (this.bubble) {
      this.bubble.visible = this.shielded;
      if (this.shielded) this.bubble.position.copy(this.pos);
    }
  }

  /* ---------- shared movement helpers ---------- */
  // idle slot: circle around the player at `ring`, stay visible but don't deal damage
  orbitDesired(plane, ring, height = 60) {
    const radial = this.pos.clone().sub(plane.pos);
    radial.y = 0;
    const rlen = radial.length() || 1;
    radial.multiplyScalar(1 / rlen);
    const tangent = new THREE.Vector3(-radial.z, 0, radial.x).multiplyScalar(this.orbitDir);
    const pull = (rlen - ring) / ring;       // positive = too far, move in; negative = too close, back off
    const desired = tangent.addScaledVector(radial, -pull * 1.2).normalize();
    desired.y = (plane.pos.y + height - this.pos.y) * 0.004;
    return desired;
  }

  // turn toward `desired` at `turnRate` (rate limited), fly forward, and stay off the ground
  steer(dt, desired, turnRate, speed = this.speed) {
    // keep altitude so it doesn't fly straight into a mountain
    const gh = heightAt(this.pos.x, this.pos.z);
    if (this.pos.y - gh < 120) desired.y += 0.7;
    desired.normalize();

    const fwd = _v.set(0, 0, -1).applyQuaternion(this.quat);
    fwd.lerp(desired, Math.min(1, turnRate * dt)).normalize();
    this.quat.setFromUnitVectors(_nose, fwd);
    this.mesh.quaternion.copy(this.quat);

    this.vel.copy(fwd).multiplyScalar(speed);
    this.pos.addScaledVector(this.vel, dt);

    // floor guard
    const g2 = heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < g2 + 60) this.pos.y = g2 + 60;
  }

  // one aimed shot with lead; accuracy 0..1 (1 = perfect lead)
  shootAt(plane, weapons, from, speed, damage, accuracy) {
    const pv = plane.forward().multiplyScalar(plane.speed);
    const aim = interceptPoint(from, speed, plane.pos, pv);
    const dir = (aim ? aim.clone() : plane.pos.clone()).sub(from).normalize();
    // add error
    const err = 1 - accuracy;
    dir.x += (rand() - 0.5) * err * 0.5;
    dir.y += (rand() - 0.5) * err * 0.5;
    dir.z += (rand() - 0.5) * err * 0.5;
    weapons.fireEnemy(from.clone(), dir.normalize(), speed, damage);
  }

  /* ---------- Regular fighters (and the ace, which is a sharper fighter that dodges) ---------- */
  updateFighter(dt, plane, weapons) {
    const F = CFG.enemy[this.type];
    const toP = plane.pos.clone().sub(this.pos);
    const dist = toP.length();

    // desired direction: chase when far, break away when too close
    // canAttack is assigned by waves.js every frame (only a few may attack).
    // Otherwise N enemies = N times the bullets, and linear stacking simply drowns the player.
    let desired;
    if (!this.canAttack) {
      desired = this.orbitDesired(plane, CFG.enemy.fighter.standoffDist);
    } else if (dist < CFG.enemy.fighter.breakOffDist) {
      desired = this.pos.clone().sub(plane.pos).normalize();
      desired.y += 0.25;                       // pull up and break away, don't dive into the ground
    } else {
      desired = toP.clone().normalize();
    }

    // Ace: when the player holds it near the nose, roll hard to one side for a moment
    let speed = this.speed;
    if (this.type === 'ace') {
      if (this.jinkCd > 0) this.jinkCd -= dt;
      if (this.jinkT > 0) {
        this.jinkT -= dt;
        desired = desired.multiplyScalar(0.3).add(this.jinkDir);
        speed *= 1.15;
      } else if (this.jinkCd <= 0 && plane.alive && dist < F.jinkRange && dist > 1) {
        const pf = plane.forward();
        const cosA = -toP.dot(pf) / dist;         // angle between the player's nose and the direction to the ace
        if (cosA > Math.cos(F.jinkCone)) {
          this.jinkT = F.jinkTime;
          this.jinkCd = F.jinkCooldown;
          const side = pf.clone().cross(_up).normalize().multiplyScalar(rand() < 0.5 ? 1 : -1);
          side.y = (rand() - 0.3) * 0.6;
          this.jinkDir = side.normalize().multiplyScalar(F.jinkStrength);
        }
      }
    }

    this.steer(dt, desired, F.turnRate, speed);

    // Fire with lead, but deliberately imperfect (leadAccuracy), otherwise the player gets hit constantly
    // only enemies that hold an attacker slot fire
    this.shootCd -= dt;
    if (this.canAttack && this.shootCd <= 0 && dist < F.gunRange * Weather.vis && plane.alive) {   // fog/storms shorten the range
      this.shootCd = F.gunCooldown * (0.7 + rand() * 0.6);
      this.shootAt(plane, weapons, this.pos, F.gunSpeed, F.gunDamage, F.leadAccuracy);
    }
  }

  /* ---------- Kamikaze drone: dives at the player; commits in the last commitDist units so a late hard turn dodges it ---------- */
  updateDrone(dt, plane) {
    const D = CFG.enemy.drone;
    let desired, turn = D.turnRate;
    if (this.canAttack && plane.alive) {
      const dist = this.pos.distanceTo(plane.pos);
      const pv = plane.forward().multiplyScalar(plane.speed);
      const aim = interceptPoint(this.pos, this.speed, plane.pos, pv);
      desired = (aim ? aim.clone() : plane.pos.clone()).sub(this.pos).normalize();
      if (dist < D.commitDist) turn = D.commitTurn;   // committed: barely steers any more
    } else {
      desired = this.orbitDesired(plane, CFG.enemy.fighter.standoffDist + 120, 90);
    }
    this.steer(dt, desired, turn);
  }

  /* ---------- Heavy bomber: wide slow circles, tail turret fires short bursts ---------- */
  updateBomber(dt, plane, weapons) {
    const B = CFG.enemy.bomber;
    this.steer(dt, this.orbitDesired(plane, B.orbitDist, 120), B.turnRate);

    if (!plane.alive || !this.canAttack) { this.burstLeft = 0; return; }
    const dist = this.pos.distanceTo(plane.pos);
    if (this.burstLeft > 0) {
      this.burstGapT -= dt;
      if (this.burstGapT <= 0) {
        const tail = this.pos.clone().addScaledVector(this.vel.clone().normalize(), -this.radius * 0.8);
        this.shootAt(plane, weapons, tail, B.gunSpeed, B.gunDamage, 0.6);
        this.burstLeft--;
        this.burstGapT = B.burstGap;
      }
    } else {
      this.burstCd -= dt;
      if (this.burstCd <= 0 && dist < B.gunRange * Weather.vis) {
        this.burstLeft = B.burst;
        this.burstGapT = 0;
        this.burstCd = B.burstCooldown;
      }
    }
  }

  /* ---------- Shield carrier: hangs back near its allies, far from the player; never shoots ---------- */
  updateCarrier(dt, plane, all) {
    const C = CFG.enemy.carrier;
    const c = new THREE.Vector3();
    let n = 0;
    for (const e of all) {
      if (e === this || !e.alive || e.type === 'carrier' || e.type === 'boss') continue;
      c.add(e.pos); n++;
    }
    let desired;
    const away = this.pos.clone().sub(plane.pos);
    const dP = away.length() || 1;
    if (dP < C.standoffDist * 0.7) {
      desired = away.multiplyScalar(1 / dP);        // too close to the player: back off
      desired.y = 0.1;
    } else if (n) {
      c.multiplyScalar(1 / n);
      // stay on the far side of its allies, as seen from the player
      const behind = c.clone().sub(plane.pos);
      behind.y = 0;
      const bl = behind.length() || 1;
      const goal = c.clone().addScaledVector(behind, 200 / bl);
      goal.y = Math.max(goal.y, plane.pos.y + 80);
      desired = goal.sub(this.pos);
      if (desired.lengthSq() < 60 * 60) desired = this.orbitDesired(plane, C.standoffDist, 80);
      else desired.normalize();
    } else {
      desired = this.orbitDesired(plane, C.standoffDist, 80);
    }
    this.steer(dt, desired, C.turnRate);
    if (this.mesh.userData && this.mesh.userData.ring) this.mesh.userData.ring.rotation.z += 1.5 * dt;
  }

  /* ---------- UFO boss: three attack patterns, matching the original's bullets / rockets / blades ---------- */
  updateBoss(dt, plane, weapons) {
    const B = CFG.enemy.boss;

    // Keep turret distance: move in when too far, back off when too close.
    // It used to close all the way in to 260, putting a 70-radius disc in your face and forcing you to fight while scraping it.
    // It is a hovering turret, not a dogfighter; it should suppress from range.
    const gh = heightAt(this.pos.x, this.pos.z);
    const want = B.standoffDist;
    const flat = _v.copy(this.pos).sub(plane.pos);
    flat.y = 0;
    const d = flat.length() || 1;
    flat.multiplyScalar(1 / d);
    const err = d - want;                       // positive = too far, negative = too close
    const move = Math.sign(err) * Math.min(Math.abs(err), this.speed * dt);
    this.pos.addScaledVector(flat, -move);      // adjust radially toward the target distance
    // altitude is controlled separately
    const wantY = Math.max(gh + 300, B.hoverHeight);
    this.pos.y += Math.sign(wantY - this.pos.y) * Math.min(Math.abs(wantY - this.pos.y), this.speed * dt);
    this.mesh.rotation.y += 0.6 * dt;     // slow spin

    if (!plane.alive) return;
    const dirToP = () => _v.copy(plane.pos).sub(this.pos).normalize().clone();

    // 1) volley: a small cluster aimed at the player
    this.cdVolley -= dt;
    if (this.cdVolley <= 0) {
      this.cdVolley = B.volleyCooldown / this.fireRate;
      const base = dirToP();
      for (let i = -1; i <= 1; i++) {
        const d2 = base.clone();
        d2.x += i * 0.06; d2.y += i * 0.02;
        weapons.fireEnemy(this.pos.clone(), d2.normalize(), B.bulletSpeed, B.bulletDamage);
      }
    }

    // 2) ring: a horizontal ring of bullets that forces the player to keep distance
    this.cdRing -= dt;
    if (this.cdRing <= 0) {
      this.cdRing = B.ringCooldown / this.fireRate;
      const N = 16;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const d2 = new THREE.Vector3(Math.cos(a), -0.12, Math.sin(a)).normalize();
        weapons.fireEnemy(this.pos.clone(), d2, B.bulletSpeed * 0.8, B.bulletDamage);
      }
    }

    // 3) heavy leading shot
    this.cdHoming -= dt;
    if (this.cdHoming <= 0) {
      this.cdHoming = B.homingCooldown / this.fireRate;
      const pv = plane.forward().multiplyScalar(plane.speed);
      const aim = interceptPoint(this.pos, B.bulletSpeed * 1.3, plane.pos, pv);
      const d2 = (aim ? aim.clone() : plane.pos.clone()).sub(this.pos).normalize();
      weapons.fireEnemy(this.pos.clone(), d2, B.bulletSpeed * 1.3, B.bulletDamage * 1.6);
    }
  }
}
Enemy.nextId = 0;
