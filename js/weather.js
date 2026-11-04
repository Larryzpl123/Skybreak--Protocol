// js/weather.js: weather. Rain, thunderstorms, snow, blizzards, sandstorms and fog.
// Light gameplay effects only, and always the same for you and the enemies:
//   visibility  fog closes in; enemies only open fire within gunRange x vis, and your missile lock range shrinks the same way
//   wind        pushes your plane sideways a little (gusting), easy to correct
//   lightning   thunderstorms only: a glowing column marks where a bolt will land 1.3 s later; fly out of it

import * as THREE from 'three';
import { heightAt } from './terrain.js';

export const WEATHER = {
  clear:        { name: 'Clear',        fog: [900, 4200], tint: null,     vis: 1.0,  wind: 0 },
  fog:          { name: 'Fog',          fog: [220, 1500], tint: 0xb8c4cc, vis: 0.6,  wind: 0 },
  rain:         { name: 'Rain',         fog: [600, 3000], tint: 0x7d8a96, vis: 0.85, wind: 12, dark: 0.2,
                  particles: { kind: 'rain', count: 2500, fall: 520, color: 0xaac4dd } },
  thunderstorm: { name: 'Thunderstorm', fog: [450, 2400], tint: 0x4f5864, vis: 0.75, wind: 22, dark: 0.45, lightning: true,
                  particles: { kind: 'rain', count: 3500, fall: 620, color: 0x9fb3c8 } },
  sandstorm:    { name: 'Sandstorm',    fog: [240, 1400], tint: 0xc9a46a, vis: 0.6,  wind: 45, dark: 0.15,
                  particles: { kind: 'sand', count: 3000, fall: 25, color: 0xd9b57a } },
  snow:         { name: 'Snow',         fog: [700, 3200], tint: 0xdfe6ee, vis: 0.9,  wind: 8,
                  particles: { kind: 'snow', count: 2000, fall: 60, color: 0xffffff } },
  blizzard:     { name: 'Blizzard',     fog: [300, 1600], tint: 0xe8eef4, vis: 0.65, wind: 38, dark: 0.1,
                  particles: { kind: 'snow', count: 4000, fall: 110, color: 0xffffff } },
};

// which weather each map type can have, with odds
export const BIOME_WEATHER = {
  forest:  [['clear', 0.5], ['rain', 0.3], ['fog', 0.2]],
  desert:  [['clear', 0.4], ['sandstorm', 0.6]],
  snow:    [['snow', 0.4], ['blizzard', 0.6]],
  islands: [['rain', 0.4], ['thunderstorm', 0.6]],
  canyon:  [['clear', 0.6], ['sandstorm', 0.4]],
  city:    [['clear', 0.5], ['rain', 0.25], ['fog', 0.25]],
};
export function pickWeather(biome, r) {
  const table = BIOME_WEATHER[biome] || BIOME_WEATHER.forest;
  for (const [w, p] of table) { if (r < p) return w; r -= p; }
  return table[table.length - 1][0];
}

export const LIGHTNING = {
  warn: 1.3,            // seconds of warning before the bolt lands
  radius: 70,           // horizontal reach of a bolt
  playerDamage: 35,
  enemyDamage: 80,
  every: [5, 9],        // seconds between bolts
  lead: 1.4,            // aims where you will be this many seconds ahead (so flying straight gets you hit)
};

const BOX = { x: 900, y: 520, z: 900 };   // particles live in this box around the camera

export const Weather = {
  key: 'clear',
  vis: 1,
  wind: new THREE.Vector3(),       // current wind velocity (world units/s)
  drift: { x: 0, y: 0, z: 0 },     // how far the particles have been carried so far
  t: 0,
  scene: null,
  bolts: [],                       // pending and landed strikes { pos, t, struck }
  nextBolt: 6,
  flash: 0,                        // 0..1 screen flash after a strike

  get def() { return WEATHER[this.key] || WEATHER.clear; },

  // pick the weather for a map. `seed` fixes the wind direction so a daily map is the same for everyone.
  set(scene, key, seed = 0) {
    this.clear();
    this.scene = scene;
    this.key = WEATHER[key] ? key : 'clear';
    const d = this.def;
    this.vis = d.vis;
    const a = (Math.sin((seed + 1) * 3.17) * 1000) % (Math.PI * 2);
    this.windDir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    this.wind.set(0, 0, 0);
    this.drift = { x: 0, y: 0, z: 0 };
    this.t = 0;
    this.nextBolt = LIGHTNING.every[0] + 1;
    this.remoteBolts = false;
    if (d.particles) this.makeParticles(d.particles);
  },

  makeParticles(p) {
    const n = p.count;
    this.base = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i += 3) {
      this.base[i] = Math.random() * BOX.x;
      this.base[i + 1] = Math.random() * BOX.y;
      this.base[i + 2] = Math.random() * BOX.z;
    }
    const rain = p.kind === 'rain';
    const verts = new Float32Array(n * 3 * (rain ? 2 : 1));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    this.particleGeo = geo;
    this.particles = rain
      ? new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: p.color, transparent: true, opacity: 0.55 }))
      : new THREE.Points(geo, new THREE.PointsMaterial({ color: p.color, size: p.kind === 'sand' ? 2.2 : 2.6, transparent: true, opacity: p.kind === 'sand' ? 0.6 : 0.85, sizeAttenuation: false }));
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
  },

  clear() {
    if (this.scene && this.particles) this.scene.remove(this.particles);
    if (this.particleGeo && this.particleGeo.dispose) this.particleGeo.dispose();
    this.particles = null; this.particleGeo = null;
    for (const b of this.bolts) this.removeBolt(b);
    this.bolts = [];
    this.flash = 0;
  },

  // ctx: { plane, camera, enemies, onPlayerHit(dmg, cause), onEnemyHit(e, dmg) }
  update(dt, ctx) {
    const d = this.def;
    this.t += dt;
    // gusting wind: 60 to 100 percent of the nominal strength
    const gust = 0.8 + 0.15 * Math.sin(this.t * 0.7) + 0.05 * Math.sin(this.t * 2.3);
    this.wind.copy(this.windDir || new THREE.Vector3(1, 0, 0)).multiplyScalar(d.wind * gust);
    // how far the sand / snow / rain has travelled: added up step by step. (It used to be wind x total time, so when
    // a gust eased off, everything already blown away swung back: sand sweeping back and forth, which made people dizzy.)
    if (d.particles) {
      const sway = d.particles.kind === 'rain' ? 1 : 2.5;     // snow and sand blow sideways more
      this.drift.x += this.wind.x * sway * dt;
      this.drift.z += this.wind.z * sway * dt;
      this.drift.y -= d.particles.fall * dt;
    }
    if (this.particles && ctx.camera) this.moveParticles(ctx.camera.position, d.particles);
    if (d.lightning) this.updateLightning(dt, ctx);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 3);
  },

  moveParticles(cam, p) {
    const pos = this.particleGeo.attributes.position;
    const a = pos.array, b = this.base, n = b.length / 3;
    const rain = p.kind === 'rain';
    const dx = this.drift.x, dz = this.drift.z, dy = this.drift.y;
    const wig = p.kind === 'snow' ? 12 : 0;
    const x0 = cam.x - BOX.x / 2, y0 = cam.y - BOX.y / 2, z0 = cam.z - BOX.z / 2;
    const m = (v, s) => ((v % s) + s) % s;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      // wrap every flake into the box around the camera, so there is always weather wherever you fly
      const x = x0 + m(b[k] + dx + (wig ? Math.sin(this.t + i) * wig : 0) - x0, BOX.x);
      const y = y0 + m(b[k + 1] + dy - y0, BOX.y);
      const z = z0 + m(b[k + 2] + dz - z0, BOX.z);
      if (rain) {
        const o = k * 2;
        a[o] = x; a[o + 1] = y; a[o + 2] = z;
        a[o + 3] = x - this.wind.x * 0.04; a[o + 4] = y + 16; a[o + 5] = z - this.wind.z * 0.04;
      } else { a[k] = x; a[k + 1] = y; a[k + 2] = z; }
    }
    pos.needsUpdate = true;
  },

  updateLightning(dt, ctx) {
    // co-op: the host aims bolts at any living player (ctx.targets) and tells the guests; guests never make their own
    const pool = (ctx.targets || [ctx.plane]).filter(p => p && p.alive);
    const plane = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    const self = ctx.plane;
    this.nextBolt -= dt;
    if (!this.remoteBolts && this.nextBolt <= 0 && plane) {
      const [lo, hi] = LIGHTNING.every;
      this.nextBolt = lo + Math.random() * (hi - lo);
      const ahead = plane.forward().multiplyScalar(plane.speed * LIGHTNING.lead);
      const p = plane.pos.clone().add(ahead);
      p.x += (Math.random() - 0.5) * 160; p.z += (Math.random() - 0.5) * 160;
      p.y = heightAt(p.x, p.z);
      this.bolts.push(this.makeBolt(p, plane.pos.y));
      if (this.onBolt) this.onBolt(p, plane.pos.y);
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t += dt;
      if (!b.struck && b.t >= LIGHTNING.warn) {
        b.struck = true;
        this.flash = 1;
        if (b.bolt) b.bolt.visible = true;
        const r2 = LIGHTNING.radius * LIGHTNING.radius;
        const flat = v => (v.x - b.pos.x) ** 2 + (v.z - b.pos.z) ** 2;
        if (self && self.alive && flat(self.pos) < r2 && ctx.onPlayerHit) ctx.onPlayerHit(LIGHTNING.playerDamage, 'LIGHTNING');
        for (const e of ctx.enemies || []) if (e.alive && flat(e.pos) < r2 * 1.6 && ctx.onEnemyHit) ctx.onEnemyHit(e, LIGHTNING.enemyDamage, e.pos);
      }
      // the warning marks brighten as the strike gets closer
      const glow = b.struck ? 0 : 0.25 + 0.6 * (b.t / LIGHTNING.warn);
      for (const m of b.marks || []) if (m.material) m.material.opacity = glow;
      if (b.t > LIGHTNING.warn + 0.25) { this.removeBolt(b); this.bolts.splice(i, 1); }
    }
  },

  // Warning: a thin glowing pillar where the bolt will land, plus a ring the size of the danger zone
  // on the ground and another at the plane's altitude (so it is easy to see while flying toward it)
  // co-op guests: a bolt the host announced
  addBolt(pos, airY) { this.bolts.push(this.makeBolt(pos, airY)); },

  makeBolt(pos, airY = pos.y + 400) {
    const b = { pos, t: 0, struck: false, marks: [] };
    if (!this.scene) return b;
    const h = 1600;
    const mat = () => new THREE.MeshBasicMaterial({ color: 0xcfeaff, transparent: true, opacity: 0.25, depthWrite: false });
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, h, 8), mat());
    pillar.position.set(pos.x, pos.y + h / 2, pos.z);
    for (const y of [pos.y + 3, airY]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(LIGHTNING.radius, 2.5, 6, 48), mat());
      ring.rotation.x = Math.PI / 2;
      ring.position.set(pos.x, y, pos.z);
      b.marks.push(ring);
    }
    b.marks.push(pillar);
    b.bolt = new THREE.Mesh(new THREE.BoxGeometry(7, h, 7), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    b.bolt.position.copy(pillar.position);
    b.bolt.visible = false;
    for (const m of [...b.marks, b.bolt]) this.scene.add(m);
    return b;
  },

  removeBolt(b) {
    if (!this.scene) return;
    for (const m of [...(b.marks || []), b.bolt]) {
      if (!m) continue;
      this.scene.remove(m);
      if (m.geometry && m.geometry.dispose) m.geometry.dispose();
      if (m.material && m.material.dispose) m.material.dispose();
    }
  },
};
