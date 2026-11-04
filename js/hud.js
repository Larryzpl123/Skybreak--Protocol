// js/hud.js: HUD. Crosshair / lead indicator, health bar, radar, off-screen arrows, hint text.
// Not knowing where the enemies are is the second biggest reason people quit 3D air combat; radar + off-screen arrows fix it.

import * as THREE from 'three';
import { CFG } from './config.js';
import { heightAt } from './terrain.js';
import { POWERUPS, activeBuffs } from './powerups.js';
import { View } from './view.js';          // the game area's size (it may be drawn turned on a portrait-locked phone)

const _v = new THREE.Vector3();
// radar dot per enemy type (the on-screen boxes use the matching CSS classes in index.html)
const RADAR_COLOR = { boss: '#ff6ad5', fighter: '#ff6a5a', drone: '#ff3b3b', bomber: '#ffb35a', ace: '#f5f5f5', carrier: '#66ccff' };

export class HUD {
  constructor() {
    this.$ = id => document.getElementById(id);
    this.lead = this.$('lead');
    this.markers = this.$('markers');
    this.radar = this.$('radar');
    this.rctx = this.radar.getContext('2d');
    this.msgEl = this.$('msg');
    this.horizon = this.$('horizon');
    this.msgT = 0;
    this.pool = [];              // off-screen arrow DOM pool
    this.matePool = [];          // co-op: name tags over teammates
  }

  // big center message; `sub` is an optional smaller second line (all strings come from the game, not the player)
  message(text, secs = 2, sub = '') {
    this.msgEl.innerHTML = sub ? `${text}<div class="sub">${sub}</div>` : text;
    this.msgEl.style.opacity = '1';
    this.msgT = secs;
  }

  update(dt, ctx) {
    const { plane, enemies, camera, target, leadPoint, score, best, wave, drops = [], mates = [], foes = [], incoming = [] } = ctx;

    // --- text area ---
    this.$('hp').style.width = Math.max(0, (plane.hp / plane.maxHp) * 100) + '%';
    this.$('hpTxt').textContent = Math.ceil(plane.hp);
    this.$('score').textContent = score;
    this.$('best').textContent = best;
    this.$('wave').textContent = wave;
    this.$('spd').textContent = Math.round(plane.speed);
    this.$('alt').textContent = Math.round(plane.pos.y);
    this.$('msl').textContent = plane.missiles;
    const mn = this.$('tMslN');                      // phone missile button shows the count too
    if (mn) mn.textContent = plane.missiles;

    // active power-ups as colored chips (only rebuilt when the text changes)
    const buffs = activeBuffs(plane);
    const html = buffs.map(b => `<span class="buff" style="background:${POWERUPS[b.key].css}">${b.label}</span>`).join('');
    if (html !== this.buffHtml) { this.$('buffs').innerHTML = html; this.buffHtml = html; }

    // Artificial horizon: counter-rotates with roll and shifts with pitch, so your attitude is readable at a glance
    const fwd = plane.forward();
    const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
    this.$('bank').textContent = Math.round(-plane.roll * 57.2958) + '°';
    if (this.horizon) {
      this.horizon.style.transform =
        `rotate(${plane.roll * 57.2958}deg) translateY(${pitch * 57.2958 * 1.6}px)`;
    }

    if (this.msgT > 0) {
      this.msgT -= dt;
      if (this.msgT <= 0) this.msgEl.style.opacity = '0';
    }

    // --- lead indicator: tells the player where to shoot ---
    if (leadPoint && target) {
      const s = this.project(leadPoint, camera);
      if (s) {
        this.lead.style.display = 'block';
        this.lead.style.left = s.x + 'px';
        this.lead.style.top = s.y + 'px';
      } else this.lead.style.display = 'none';
    } else this.lead.style.display = 'none';

    // Low-altitude warning: flashing red text when too close to the ground. Terrain is a silent killer: no health bar, one touch and you're dead.
    const clearance = plane.pos.y - heightAt(plane.pos.x, plane.pos.z);
    const warn = this.$('pullup');
    if (warn) {
      // warn when the ground is close now, or will be within 2.5 s on this heading (tall plateaus and peaks count too;
      // 1.5 s was too short to climb over a steep snow peak)
      const ahead = t => {
        const x = plane.pos.x + fwd.x * plane.speed * t, z = plane.pos.z + fwd.z * plane.speed * t;
        return plane.pos.y + fwd.y * plane.speed * t - heightAt(x, z);
      };
      const danger = clearance < 55 || Math.min(ahead(0.6), ahead(1.2), ahead(1.8), ahead(2.5)) < 45;
      warn.style.display = danger ? 'block' : 'none';
      if (danger) warn.style.opacity = (Math.floor(performance.now() / 160) % 2) ? '1' : '0.25';
    }

    this.drawMarkers(enemies, camera, target);
    this.drawMates(mates.length ? mates : foes, camera, !mates.length);   // versus: other players' names, in orange
    this.drawRadar(plane, enemies, drops, mates, incoming);
    this.drawIncoming(incoming, plane, camera);
  }

  // versus: the nearest missile homing on you -> "MISSILE 640 m" under the crosshair, and an arrow on a ring around
  // the crosshair pointing toward it (it usually comes from behind, where the chase camera cannot see it)
  drawIncoming(missiles, plane, camera) {
    const tag = this.$('mslWarn'), arrow = this.$('mslArrow');
    if (!tag || !arrow) return;
    let m = null, best = Infinity;
    for (const x of missiles) { const d = x.pos.distanceToSquared(plane.pos); if (d < best) { best = d; m = x; } }
    if (!m) { tag.style.display = 'none'; arrow.style.display = 'none'; return; }
    tag.style.display = 'block';
    this.$('mslDist').textContent = `${Math.round(Math.sqrt(best) / 10) * 10} m`;
    _v.copy(m.pos).project(camera);
    let dx = _v.x, dy = -_v.y;
    if (_v.z > 1) { dx = -dx; dy = -dy; }               // behind the camera: the projection comes out mirrored
    const l = Math.hypot(dx, dy * View.h / View.w) || 1;
    const ux = dx / l, uy = dy * View.h / View.w / l, r = 110;
    arrow.style.display = 'block';
    arrow.style.left = (View.w / 2 + ux * r) + 'px';
    arrow.style.top = (View.h / 2 + uy * r) + 'px';
    arrow.style.transform = `rotate(${Math.atan2(uy, ux) - Math.PI / 2}rad)`;   // (the triangle points down at 0)
  }

  // co-op: each living teammate's name above their plane (hidden when behind the camera)
  drawMates(mates, camera, foe = false) {
    while (this.matePool.length < mates.length) {
      const d = document.createElement('div');
      d.className = 'mateTag';
      this.markers.appendChild(d);
      this.matePool.push(d);
    }
    this.matePool.forEach((el, i) => {
      const m = mates[i];
      const s = m && m.alive ? this.project(m.pos, camera) : null;
      if (!s) { el.style.display = 'none'; return; }
      el.style.display = 'block';
      if (el.textContent !== m.name) el.textContent = m.name;
      el.classList.toggle('foe', foe);
      el.style.left = s.x + 'px';
      el.style.top = s.y + 'px';
    });
  }

  // world position -> screen pixels; returns null if behind the camera
  project(p, camera) {
    _v.copy(p).project(camera);
    if (_v.z > 1) return null;
    return {
      x: (_v.x * 0.5 + 0.5) * View.w,
      y: (-_v.y * 0.5 + 0.5) * View.h,
      behind: false,
    };
  }

  // box when on screen, edge arrow when off screen
  drawMarkers(enemies, camera, target) {
    const need = enemies.length;
    while (this.pool.length < need) {
      const d = document.createElement('div');
      d.className = 'marker';
      this.markers.appendChild(d);
      this.pool.push(d);
    }
    for (let i = need; i < this.pool.length; i++) this.pool[i].style.display = 'none';

    const W = View.w, H = View.h, pad = 34;
    for (let i = 0; i < need; i++) {
      const e = enemies[i], el = this.pool[i];
      _v.copy(e.pos).project(camera);
      const behind = _v.z > 1;
      let x = (_v.x * 0.5 + 0.5) * W;
      let y = (-_v.y * 0.5 + 0.5) * H;
      if (behind) { x = W - x; y = H - y; }

      const off = behind || x < pad || x > W - pad || y < pad || y > H - pad;
      el.style.display = 'block';
      // per-type color, see .marker.<type> in index.html; a drone that is diving at you blinks
      const diving = e.type === 'drone' && e.canAttack && e.pos.distanceToSquared(camera.position) < 1100 * 1100;
      el.className = 'marker ' + e.type + (diving ? ' diving' : '');
      el.classList.toggle('locked', e === target);

      if (off) {
        // clamp to the screen edge as an arrow
        const cx = W / 2, cy = H / 2;
        let dx = x - cx, dy = y - cy;
        const m = Math.max(Math.abs(dx) / (W / 2 - pad), Math.abs(dy) / (H / 2 - pad)) || 1;
        dx /= m; dy /= m;
        el.classList.add('edge');
        el.style.left = (cx + dx) + 'px';
        el.style.top = (cy + dy) + 'px';
        el.style.transform = `translate(-50%,-50%) rotate(${Math.atan2(dy, dx)}rad)`;
      } else {
        el.classList.remove('edge');
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.transform = 'translate(-50%,-50%)';
      }
    }
  }

  // top-down radar, nose pointing up
  drawRadar(plane, enemies, drops = [], mates = [], incoming = []) {
    const c = this.rctx, R = this.radar.width / 2, range = 2200;
    c.clearRect(0, 0, this.radar.width, this.radar.height);

    c.strokeStyle = 'rgba(120,230,190,.35)'; c.lineWidth = 1;
    c.beginPath(); c.arc(R, R, R - 2, 0, 6.283); c.stroke();
    c.beginPath(); c.arc(R, R, (R - 2) / 2, 0, 6.283); c.stroke();
    c.beginPath(); c.moveTo(R, 0); c.lineTo(R, this.radar.height);
    c.moveTo(0, R); c.lineTo(this.radar.width, R); c.stroke();

    // heading angle (world XZ plane)
    const f = plane.forward();
    const yaw = Math.atan2(f.x, -f.z);
    const cos = Math.cos(-yaw), sin = Math.sin(-yaw);

    const toRadar = p => {
      const dx = p.x - plane.pos.x, dz = p.z - plane.pos.z;
      // rotate so the nose points up
      let px = ((dx * cos - dz * sin) / range) * (R - 4);
      let py = ((dx * sin + dz * cos) / range) * (R - 4);
      const d = Math.hypot(px, py);
      if (d > R - 4) { px = px / d * (R - 4); py = py / d * (R - 4); }   // pin to the edge
      return [R + px, R + py];
    };

    // power-ups: small squares in their own color
    for (const dr of drops) {
      const [x, y] = toRadar(dr.pos);
      c.fillStyle = (POWERUPS[dr.type] || POWERUPS.heal).css;
      c.fillRect(x - 2.5, y - 2.5, 5, 5);
    }
    for (const e of enemies) {
      const [x, y] = toRadar(e.pos);
      c.fillStyle = RADAR_COLOR[e.type] || '#ff6a5a';
      c.beginPath(); c.arc(x, y, e.type === 'boss' ? 5 : e.type === 'bomber' ? 4 : 3, 0, 6.283); c.fill();
    }
    // teammates: green triangles
    c.fillStyle = '#7dffc8';
    for (const m of mates) {
      if (!m.alive) continue;
      const [x, y] = toRadar(m.pos);
      c.beginPath(); c.moveTo(x, y - 4); c.lineTo(x - 3.5, y + 3.5); c.lineTo(x + 3.5, y + 3.5); c.closePath(); c.fill();
    }
    // self
    c.fillStyle = '#9fe8ff';
    c.beginPath(); c.moveTo(R, R - 6); c.lineTo(R - 4, R + 5); c.lineTo(R + 4, R + 5); c.closePath(); c.fill();
    // missiles homing on you: bright red dots with a glow
    for (const m of incoming) {
      const [x, y] = toRadar(m.pos);
      c.fillStyle = '#ff3030'; c.shadowColor = 'rgba(255,40,40,.9)'; c.shadowBlur = 8;
      c.beginPath(); c.arc(x, y, 3, 0, 6.283); c.fill();
      c.shadowBlur = 0;
    }
  }
}
