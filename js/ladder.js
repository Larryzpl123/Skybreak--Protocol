// js/ladder.js: the AI Ladder. A 1v1 against an AI pilot, first to CFG.ladder.killsToWin; winning unlocks the next
// level, losing just means trying the same level again. Every level the AI flies better: it aims and leads better,
// reacts faster, turns harder, dodges when you hold it in your sights, drops flares against your missiles, fires
// missiles of its own and works its way onto your tail. Past CFG.ladder.skillCap its skill stops growing and only its
// hull and gun damage keep going up, so the ladder never ends.
//
// The AI is an Enemy (enemies.js), so your cannon, missiles, lock-on and lead marker work on it unchanged.
// Its own physics are the enemies' simple steering model (turn toward a direction at a limited rate), not the
// player's flight model: that keeps it predictable to tune, and the skill numbers below are what make it harder.

import * as THREE from 'three';
import { CFG } from './config.js';
import { Enemy } from './enemies.js';
import { interceptPoint } from './weapons.js';
import { buildBlueprintMesh } from './partMesh.js';
import { PRESETS } from './blueprint.js';
import { BIOME_KEYS, spawnAltitude } from './terrain.js';
import { Weather } from './weather.js';

const L = () => CFG.ladder;
const lerp = (a, b, t) => a + (b - a) * t;
const _up = new THREE.Vector3(0, 1, 0);

// the rank and plane the AI flies at each level (three levels per tier, the last one from level 28 on)
const TIERS = [
  ['Rookie', 'Prop Trainer'], ['Cadet', 'Biplane'], ['Wingman', 'Stock Fighter'], ['Pilot', 'Gunship'],
  ['Veteran', 'Interceptor'], ['Ace', 'Long-Wing Scout'], ['Top Gun', 'Missile Boat'], ['Elite', 'Strike Fighter'],
  ['Legend', 'Flying Fortress'], ['Phantom', 'Delta Dart'],
];

// how far along its skill the AI is at a level (CFG.ladder.skillAt: straight lines between the listed levels)
export function skillAt(lv) {
  const pts = L().skillAt;
  if (lv >= pts[pts.length - 1][0]) return 1;
  for (let i = 1; i < pts.length; i++) {
    const [l1, t1] = pts[i];
    if (lv <= l1) { const [l0, t0] = pts[i - 1]; return t0 + (t1 - t0) * (lv - l0) / (l1 - l0); }
  }
  return 1;
}

// Everything about the AI at a level. t goes 0 (level 1) -> 1 (skillCap).
export function aiSkill(level) {
  const C = L();
  const lv = Math.max(1, Math.floor(level));
  const t = skillAt(lv);
  const over = Math.max(0, lv - C.skillCap);
  const f = Math.min(1, Math.max(0, (lv - 3) / 22));          // flares: level 3 -> 25                 // past the cap: only hull and damage grow
  const [rank, plane] = TIERS[Math.min(TIERS.length - 1, Math.floor((lv - 1) / 3))];
  return {
    level: lv, rank, plane,
    hp: Math.round(lerp(C.hp[0], C.hp[1], t) * (1 + over * C.hpPerLevel)),
    speed: lerp(C.speed[0], C.speed[1], t),
    turn: lerp(C.turn[0], C.turn[1], t),  // steering rate (fighter 1.1, ace 1.9)
    react: lerp(C.react[0], C.react[1], t),            // seconds to settle on a new heading (slow = drifts behind your moves)
    tail: t,                              // 0 = flies straight at you, 1 = works its way behind your tail
    defend: lerp(0.25, 1, t),             // with you on its tail: how hard it breaks (0 = ignores you)
    breakDist: 220,                       // closer than this: break away instead of ramming
    fireCone: lerp(0.10, 0.22, t),        // only shoots with you this close to its nose (radians)
    accuracy: lerp(0.35, 0.95, t),        // how well it leads its shots (1 = perfect)
    circleAim: lerp(0.4, 1, t),           // how well it leads a target that is turning (see Duelist.leadPoint)
    weaveAim: lerp(0.2, 0.8, t),          // ... and one that zigzags
    gunEvery: lerp(C.gunEvery[0], C.gunEvery[1], t),   // seconds between shots while lined up (a cannon stream, like yours)
    gunDmg: lerp(C.gunDmg[0], C.gunDmg[1], t) * (1 + over * C.dmgPerLevel),
    gunSpeed: lerp(600, 850, t), range: lerp(900, 1300, t),
    // dodges when you hold it in your sights (from level 4)
    jink: lv >= 4 ? { cone: lerp(0.12, 0.2, t), cd: lerp(6, 2, t), time: lerp(0.7, 1.0, t), strength: lerp(0.8, 1.4, t) } : null,
    // flares: the chance to shake off each of your missiles (from level 3). Stronger since missiles lead their
    // target (2026-10-04): with the old flares the test bot won about 5 levels further up the ladder than before.
    // (playtest 2026-10-06: at 0.9 a person, who only gets a lock every 5 to 10 s up there, lost almost every salvo)
    flare: lv >= 3 ? lerp(0.25, 0.6, f) : 0, flareCd: lerp(5, 4, f),
    // its own homing missiles (from level 7)
    missile: lv >= 7 ? { cd: lerp(14, 7, t), dmg: lerp(30, 45, t) } : null,
  };
}

// each level has its own map (the map types in turn), always in clear weather: the fight is the point
export function ladderMap(level) {
  const lv = Math.max(1, Math.floor(level));
  return { biome: BIOME_KEYS[(lv - 1) % BIOME_KEYS.length], seed: 7000 + lv, weather: 'clear', daily: false, day: null, ladder: lv };
}

/* ---------- The AI pilot ---------- */
let flareGeo = null, flareMat = null;
const FLARE_RADIUS = 700;
export class Duelist extends Enemy {
  constructor(scene, level, pos) {
    super(scene, 'ace', pos);
    scene.remove(this.mesh);
    if (this.bubble) { scene.remove(this.bubble); this.bubble = null; }
    const S = this.skill = aiSkill(level);
    const preset = PRESETS.find(p => p.name === S.plane) || PRESETS[0];
    this.mesh = buildBlueprintMesh(preset.parts).group;
    this.mesh.position.copy(this.pos);
    scene.add(this.mesh);
    this.type = 'duelist';
    this.hp = this.maxHp = S.hp;
    this.radius = 16;
    this.speed = S.speed;
    this.score = 0;
    this.ramDamage = L().ramDamage;
    this.want = new THREE.Vector3(0, 0, 1);    // the heading it is settling on (reaction time)
    this.breakT = 0; this.breakDir = null;
    this.gunT = 1.0;                            // a moment before the first shot
    this.missCd = S.missile ? S.missile.cd * 0.6 : 0;
    this.flareCd = 0;
    this.flares = [];
    this.onFlare = null;                        // main.js: say it on screen
  }

  face(dir) {                                   // point the nose along dir (spawning)
    this.want.copy(dir).normalize();
    this.mesh.position.copy(this.pos);
    this.quat.setFromUnitVectors(new THREE.Vector3(0, 0, -1), this.want);
    this.mesh.quaternion.copy(this.quat);
    this.vel.copy(this.want).multiplyScalar(this.speed);
  }

  remove() {
    super.remove();
    for (const f of this.flares) this.scene.remove(f.m);
    this.flares.length = 0;
  }

  update(dt, plane, weapons) {
    this.updateFlares(dt);
    if (!this.alive) return;
    this.t += dt;
    const S = this.skill;
    const toP = plane.pos.clone().sub(this.pos);
    const dist = toP.length() || 1;
    const pv = plane.forward().multiplyScalar(plane.speed);
    const lead = this.leadPoint(plane, dt);
    const circling = plane.alive && this.circling();

    // where it wants to go
    const pf = plane.forward();
    const fwd0 = this.vel.lengthSq() > 1 ? this.vel.clone().normalize() : this.want.clone();
    const threat = plane.alive && dist < 1000 && -toP.dot(pf) / dist > Math.cos(0.45);   // your nose is on it
    const headOn = threat && fwd0.dot(toP) / dist > 0.5;                                 // ...and its nose is on you
    let goal;
    if (!plane.alive) {
      goal = this.orbitDesired(plane, 600, 120);
    } else if (this.breakT > 0) {
      this.breakT -= dt;
      goal = this.breakDir.clone();
    } else if (threat && !headOn) {
      // you are behind it: break turn across your nose and in toward your tail, so you overshoot
      // (better pilots break harder and earlier; a rookie mostly keeps flying where it was going)
      const rgt = plane.right();
      const side = Math.sign(this.pos.clone().sub(plane.pos).dot(rgt)) || 1;
      const def = rgt.multiplyScalar(side).addScaledVector(pf, -0.6).add(new THREE.Vector3(0, 0.15, 0)).normalize();
      const off = lead.clone().sub(this.pos).normalize();
      goal = off.lerp(def, S.defend).normalize();
    } else if (headOn && dist < S.breakDist) {
      // too close: break off to one side and up, then come round again (no head-on ramming)
      this.breakT = 1.2;
      const side = toP.clone().cross(_up).normalize().multiplyScalar(Math.random() < 0.5 ? 1 : -1);
      this.breakDir = toP.clone().multiplyScalar(-1 / dist).add(side).add(new THREE.Vector3(0, 0.45, 0)).normalize();
      goal = this.breakDir.clone();
    } else {
      // far off: head for a point behind your tail (better pilots more so); within gun range: the lead point
      const behind = plane.pos.clone().addScaledVector(plane.forward(), -320);
      const chase = plane.pos.clone().lerp(behind, S.tail);
      // a target flying in circles: cut across the circle to where it will be (following behind it never catches up)
      const k = circling ? 0 : Math.min(1, Math.max(0, (dist - 500) / 600));   // 500 -> all lead, 1100+ -> all chase
      goal = lead.clone().lerp(chase, k).sub(this.pos).normalize();
    }

    // on your tail: match your speed and sit about 350 behind, instead of overshooting into a break-off
    let speed = this.speed;
    const ahead = this.vel.lengthSq() > 1 && toP.dot(this.vel) / (dist * this.vel.length()) > 0.7;
    if (plane.alive && ahead && dist < 900 && this.breakT <= 0) {
      speed = Math.max(this.speed * 0.6, Math.min(this.speed, plane.speed + (dist - 350) * 0.6));
    }

    // dodge: you hold it near your nose -> a hard sidestep for a moment
    if (S.jink && plane.alive) {
      if (this.jinkCd > 0) this.jinkCd -= dt;
      if (this.jinkT > 0) {
        this.jinkT -= dt;
        goal = goal.multiplyScalar(0.3).add(this.jinkDir).normalize();
        speed *= 1.12;
      } else if (this.jinkCd <= 0 && dist < 1000) {
        const pf = plane.forward();
        if (-toP.dot(pf) / dist > Math.cos(S.jink.cone)) {
          this.jinkT = S.jink.time;
          this.jinkCd = S.jink.cd;
          const side = pf.clone().cross(_up).normalize().multiplyScalar(Math.random() < 0.5 ? 1 : -1);
          side.y = (Math.random() - 0.3) * 0.6;
          this.jinkDir = side.normalize().multiplyScalar(S.jink.strength);
        }
      }
    }

    // reaction time: the heading it flies settles on the goal over S.react seconds
    this.want.lerp(goal, Math.min(1, dt / S.react)).normalize();
    this.steer(dt, this.want.clone(), S.turn, speed);
    this.mesh.position.copy(this.pos);

    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
    const toLead = lead.clone().sub(this.pos).normalize();
    // a circling target swings across its nose faster than it can turn, so it snap-shoots from further off its nose
    const lined = fwd.dot(toLead) > Math.cos(S.fireCone + (circling ? 0.7 * S.circleAim : 0));

    // cannon: a stream while you are near its nose and in range
    if (this.gunT > 0) this.gunT -= dt;
    if (this.gunT <= 0 && plane.alive && lined && dist < S.range * Weather.vis) {
      this.gunT = S.gunEvery;
      this.shootAt(plane, weapons, this.pos.clone().addScaledVector(fwd, 18), S.gunSpeed, S.gunDmg, S.accuracy);
    }

    // its own missiles (homing on you; a hard turn can shake them off)
    if (S.missile) {
      if (this.missCd > 0) this.missCd -= dt;
      if (this.missCd <= 0 && plane.alive && dist < CFG.missile.lockRange * Weather.vis && fwd.dot(toP) / dist > Math.cos(CFG.missile.lockCone)) {
        this.missCd = S.missile.cd;
        weapons.addPvpMissile({ pos: this.pos.clone().addScaledVector(fwd, 20), dir: fwd, target: plane, dmg: S.missile.dmg, owner: 'ai', mine: true });
      }
    }

    // flares: when one of your missiles gets close (and its flares are ready), one roll of the dice. A flare decoys
    // EVERY missile chasing it within FLARE_RADIUS, like real flares: a salvo all at once is wasted, missiles spread
    // out or sent while the flares reload (S.flareCd) get through. (It used to decoy one missile every 2 s, so
    // holding F on a rack of 30 missiles beat level 37 easily.)
    if (this.flareCd > 0) this.flareCd -= dt;
    if (this.flareT > 0) {                       // the flares still burning: anything chasing it close by is decoyed too
      this.flareT -= dt;
      for (const o of weapons.missiles) if (o.target === this && o.pos.distanceToSquared(this.pos) < FLARE_RADIUS * FLARE_RADIUS) o.target = null;
    }
    if (S.flare > 0 && this.flareCd <= 0) {
      for (const m of weapons.missiles) {
        if (m.target !== this || m.flareRolled) continue;
        if (m.pos.distanceToSquared(this.pos) > 380 * 380) continue;
        m.flareRolled = true;
        if (Math.random() >= S.flare) continue;  // too late this time
        for (const o of weapons.missiles) {
          if (o.target === this && o.pos.distanceToSquared(this.pos) < FLARE_RADIUS * FLARE_RADIUS) o.target = null;   // they fly on straight and miss
        }
        this.flareCd = S.flareCd;
        this.flareT = L().flareBurn;
        this.dropFlare();
        break;
      }
    }
  }

  // Where to aim: a target flying straight is led in a straight line (interceptPoint); a target holding a turn
  // (2026-10-06: full throttle and a steady bank in circles, the AI never hit it and lost every round on time) is led
  // along its circle. Better pilots use more of the circle (S.circleAim).
  leadPoint(plane, dt) {
    const S = this.skill, v = plane.speed, pf = plane.forward();
    if (this.prevPF && dt > 0) {
      const ax = this.prevPF.clone().cross(pf);
      const s = Math.min(1, ax.length());
      const w = Math.asin(s) / dt;                                        // the target's turn rate, rad/s
      this.turnW = (this.turnW || 0) + (w - (this.turnW || 0)) * Math.min(1, dt * 4);
      if (s > 1e-5) this.turnAxis = ax.multiplyScalar(1 / s);
      // how long it has been holding a hard, steady turn (dogfighting turns come and go; the circling trick doesn't)
      this.circleT = w > 0.8 && Math.abs(w - this.turnW) < 0.4 ? (this.circleT || 0) + dt : 0;
    }
    this.prevPF = pf.clone();
    // against weaving (left, right, left...): lead with the average of the last second or so, which runs straight down
    // the middle of the zigzag, instead of the way it is pointing this instant
    const vNow = pf.clone().multiplyScalar(v);
    this.vAvg = this.vAvg ? this.vAvg.lerp(vNow, Math.min(1, dt / 1.2)) : vNow.clone();
    const vAim = vNow.clone().lerp(this.vAvg, S.weaveAim);
    const straight = interceptPoint(this.pos, S.gunSpeed, plane.pos, vAim) || plane.pos.clone();
    const w = this.turnW || 0;
    if (!this.circling() || !this.turnAxis || !(S.circleAim > 0)) return straight;
    const r = this.turnAxis.clone().cross(pf);                          // the way it is turning
    const at = tau => plane.pos.clone().addScaledVector(pf, (v / w) * Math.sin(w * tau)).addScaledVector(r, (v / w) * (1 - Math.cos(w * tau)));
    let tau = plane.pos.distanceTo(this.pos) / S.gunSpeed, p = at(tau);
    for (let i = 0; i < 3; i++) { tau = p.distanceTo(this.pos) / S.gunSpeed; p = at(tau); }
    return straight.lerp(p, S.circleAim);
  }

  circling() { return (this.circleT || 0) > 3; }       // the same hard turn for over 3 s: flying circles

  dropFlare() {
    for (let i = 0; i < 4; i++) {
      if (!flareGeo) { flareGeo = new THREE.SphereGeometry(3, 6, 4); flareMat = new THREE.MeshBasicMaterial({ color: 0xffd27a }); }
      const m = new THREE.Mesh(flareGeo, flareMat);           // (shared: nothing new on the GPU per flare)
      m.position.copy(this.pos);
      this.scene.add(m);
      const v = this.vel.clone().multiplyScalar(-0.2).add(new THREE.Vector3((Math.random() - 0.5) * 60, -40 - Math.random() * 30, (Math.random() - 0.5) * 60));
      this.flares.push({ m, v, t: 1.6 });
    }
    if (this.onFlare) this.onFlare();
  }
  updateFlares(dt) {
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.t -= dt;
      f.m.position.addScaledVector(f.v, dt);
      if (f.t <= 0) { this.scene.remove(f.m); this.flares.splice(i, 1); }
    }
  }
}

/* ---------- The rules of one level: rounds, kills, win / loss ---------- */
export class Ladder {
  constructor() { this.level = 0; this.active = false; }

  begin(level) {
    this.level = Math.max(1, Math.floor(level));
    this.skill = aiSkill(this.level);
    this.me = 0; this.ai = 0;
    this.result = null;            // null while playing, then 'won' or 'lost'
    this.roundT = 0;               // > 0: counting down to the next round
    this.round = 1;
    this.clock = 0;                // time in the current round
    this.active = true;
  }
  end() { this.active = false; }

  // a kill: the round is over. Returns the result once someone has enough kills.
  aiDown() { return this.point('me'); }
  playerDown() { return this.point('ai'); }
  timeLeft() { return Math.max(0, L().roundTime - this.clock); }
  point(who) {
    if (this.result || this.roundT > 0) return this.result;      // one point per round
    this[who]++;
    this.lastPoint = who;                                       // who won the round (main.js: missiles for the next one)
    if (this[who] >= L().killsToWin) this.result = who === 'me' ? 'won' : 'lost';
    else this.roundT = L().roundDelay;
    return this.result;
  }
  // -> 'round' when the next round should start, 'time' when this round just ran out of time.
  // A round that runs out of time goes to whoever has more of their hull left (as a share of the full hull; a tie: you).
  tick(dt, myHull = 1, aiHull = 1) {
    if (this.result) return null;
    if (this.roundT <= 0) {
      this.clock += dt;
      if (this.clock < L().roundTime) return null;
      // Out of time: a draw, the round is flown again. (It used to go to whoever had more hull left, and a player
      // who hit the AI once and then flew in circles won every round on time.)
      this.timeWin = null;
      this.lastPoint = null;
      this.draws = (this.draws || 0) + 1;
      this.roundT = L().roundDelay;
      return 'time';
    }
    this.roundT -= dt;
    if (this.roundT <= 0) { this.roundT = 0; this.round++; this.clock = 0; this.timeWin = null; return 'round'; }
    return null;
  }

  // where the AI starts each round: ahead of the player, a little to the side, facing them
  // Each round starts side by side, flying the same way, about startDist apart (a neutral start). It used to start
  // nose to nose, and the head-on pass gave a free volley (2026-10-06: hit it head-on, then dodge until time ran out).
  aiStart(playerPos) {
    const side = this.round % 2 ? 1 : -1;
    return new THREE.Vector3(playerPos.x + side * L().startDist, Math.max(playerPos.y, spawnAltitude()) + 40, playerPos.z - 150);
  }
  aiFacing() { return new THREE.Vector3(0, 0, -1); }      // the way the player starts flying

  tag() {
    const s = this.skill;
    return `AI LADDER · LEVEL ${this.level} · ${s.rank.toUpperCase()} (${s.plane.toUpperCase()}) · YOU ${this.me} - ${this.ai} AI · FIRST TO ${L().killsToWin}`;
  }
}
