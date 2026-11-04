// js/powerups.js: power-up drops. What each one looks like, how often it drops, and what it does.
// Pure logic plus a little visual effect code; the drop objects themselves live in waves.js (Drops).

import * as THREE from 'three';
import { CFG } from './config.js';
import { rand as simRand } from './rand.js';

// color = the spinning drop in the world, css = HUD chips and radar dots
export const POWERUPS = {
  heal:        { name: 'REPAIR',      color: 0x7dff9a, css: '#7dff9a', tip: 'restores hull' },
  missile:     { name: 'MISSILES',    color: 0xf2f6ff, css: '#f2f6ff', tip: '+3 missiles' },
  double:      { name: 'TWIN CANNON', color: 0xffd84d, css: '#ffd84d', tip: 'two bullets per shot (missile plane: missile pairs)' },
  rapid:       { name: 'RAPID FIRE',  color: 0xff9a3d, css: '#ff9a3d', tip: 'double fire rate (missile plane: rapid missiles)' },
  shield:      { name: 'SHIELD',      color: 0x4da6ff, css: '#4da6ff', tip: 'absorbs damage' },
  emp:         { name: 'EMP',         color: 0xc77dff, css: '#c77dff', tip: 'wipes nearby bullets, hurts nearby enemies' },
  afterburner: { name: 'AFTERBURNER', color: 0xff5a5a, css: '#ff5a5a', tip: 'faster and more agile' },
};

// Weighted pick from CFG.drop.weights. `rand` is injectable so tests can check the ratios exactly.
export function pickDropType(rand = simRand) {
  const w = CFG.drop.weights;
  let total = 0;
  for (const k in w) total += w[k];
  let r = rand() * total;
  for (const k in w) {
    r -= w[k];
    if (r < 0) return k;
  }
  return 'heal';
}

// Twin Cannon and Rapid Fire fit the plane: cannons only -> the cannon version, missile pylons only -> the missile
// version (Missile Pairs / Rapid Missiles), both -> either, 50/50 (the drop looks the same). A plane with neither
// still carries a few missiles, so it gets the missile version.
export function buffKind(plane, rand = simRand) {
  const P = plane.P || {};
  const cannons = !P.cannonMounts || P.cannonMounts.length > 0;     // (no blueprint = the stock single cannon)
  const pylons = P.missileReload > 0;
  if (cannons && pylons) return rand() < 0.5 ? 'cannon' : 'missile';
  return cannons ? 'cannon' : 'missile';
}

// Apply a picked-up power-up. Returns the text for the HUD message.
// ctx: { plane, weapons, enemies, onEnemyHit, fx }  (weapons/enemies/onEnemyHit/fx are only needed by EMP)
export function applyPowerup(type, ctx) {
  const { plane } = ctx;
  const P = CFG.power;
  switch (type) {
    case 'heal': {
      const before = plane.hp;
      plane.heal(CFG.drop.healAmount);
      return `REPAIR +${Math.round(plane.hp - before)}`;
    }
    case 'missile':
      plane.missiles = Math.min(plane.P.missileMax ?? CFG.missile.maxAmmo, plane.missiles + 3);
      return 'MISSILES +3';
    case 'double':
      if (buffKind(plane, ctx.rand) === 'missile') { plane.pairT = CFG.drop.doubleDuration; return 'MISSILE PAIRS! (every other launch fires two)'; }
      plane.doubleT = CFG.drop.doubleDuration;
      return 'TWIN CANNON!';
    case 'rapid':
      if (buffKind(plane, ctx.rand) === 'missile') { plane.mRapidT = P.rapidTime; return 'RAPID MISSILES!'; }
      plane.rapidT = P.rapidTime;
      return 'RAPID FIRE!';
    case 'shield':
      plane.shieldHp = P.shieldHp;
      plane.shieldT = P.shieldTime;
      return `SHIELD! (blocks ${P.shieldHp} damage)`;
    case 'afterburner':
      plane.burnT = P.burnTime;
      return 'AFTERBURNER!';
    case 'emp':
      return emp(ctx);
  }
  return '';
}

function emp({ plane, weapons, enemies, onEnemyHit, fx }) {
  const P = CFG.power;
  let wiped = 0, hit = 0;
  if (weapons) {
    const r2 = P.empClearRadius * P.empClearRadius;
    for (let i = weapons.enemyShots.length - 1; i >= 0; i--) {
      const s = weapons.enemyShots[i];
      if (s.pos.distanceToSquared(plane.pos) < r2) {
        weapons.scene.remove(s.mesh);
        weapons.enemyShots.splice(i, 1);
        wiped++;
      }
    }
  }
  if (enemies && onEnemyHit) {
    const r2 = P.empRadius * P.empRadius;
    for (const e of enemies.slice()) {
      if (e.alive && e.pos.distanceToSquared(plane.pos) < r2) { onEnemyHit(e, P.empDamage, e.pos); hit++; }
    }
  }
  if (fx) fx.pulse(plane.pos);
  return `EMP! ${wiped} bullets wiped, ${hit} enemies hit`;
}

// Timed effects shown as HUD chips: [{ key, label }]
export function activeBuffs(plane) {
  const out = [];
  if (plane.shieldT > 0 && plane.shieldHp > 0) out.push({ key: 'shield', label: `SHIELD ${Math.ceil(plane.shieldHp)}` });
  if (plane.doubleT > 0) out.push({ key: 'double', label: `TWIN ${plane.doubleT.toFixed(0)}s` });
  if (plane.rapidT > 0) out.push({ key: 'rapid', label: `RAPID ${plane.rapidT.toFixed(0)}s` });
  if (plane.pairT > 0) out.push({ key: 'double', label: `PAIRS ${plane.pairT.toFixed(0)}s` });
  if (plane.mRapidT > 0) out.push({ key: 'rapid', label: `RAPID M ${plane.mRapidT.toFixed(0)}s` });
  if (plane.burnT > 0) out.push({ key: 'afterburner', label: `BURNER ${plane.burnT.toFixed(0)}s` });
  return out;
}

/* ---------- Visual effects: shield bubble around the player, EMP shock wave ---------- */
export class PowerFX {
  constructor(scene) {
    this.scene = scene;
    this.bubble = new THREE.Mesh(
      new THREE.SphereGeometry(1, 18, 12),
      new THREE.MeshBasicMaterial({ color: POWERUPS.shield.color, transparent: true, opacity: 0.2, depthWrite: false }),
    );
    this.bubble.visible = false;
    scene.add(this.bubble);
    this.pulseGeo = new THREE.SphereGeometry(1, 24, 16);
    this.pulses = [];
  }

  pulse(pos) {
    const m = new THREE.Mesh(this.pulseGeo, new THREE.MeshBasicMaterial({
      color: POWERUPS.emp.color, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide,
    }));
    m.position.copy(pos);
    this.scene.add(m);
    this.pulses.push({ m, t: 0 });
  }

  update(dt, plane) {
    const on = plane.alive && plane.shieldT > 0 && plane.shieldHp > 0;
    this.bubble.visible = on;
    if (on) {
      this.bubble.position.copy(plane.pos);
      this.bubble.scale.setScalar((plane.P.radius || CFG.plane.radius) * 1.6);
      // faint on purpose: the chase camera looks through it, so it must never hide the enemies ahead
      this.bubble.material.opacity = 0.05 + 0.07 * (plane.shieldHp / CFG.power.shieldHp);
    }
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      p.t += dt;
      const k = Math.min(1, p.t / 0.6);
      p.m.scale.setScalar(20 + k * CFG.power.empRadius);
      p.m.material.opacity = 0.45 * (1 - k);
      if (k >= 1) { this.scene.remove(p.m); if (p.m.material.dispose) p.m.material.dispose(); this.pulses.splice(i, 1); }
    }
  }

  clear() {
    for (const p of this.pulses) this.scene.remove(p.m);
    this.pulses.length = 0;
    this.bubble.visible = false;
  }
}
