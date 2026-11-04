// js/tutorial.js: first-flight training + one-time hangar tips.
// Training is a normal flight with no waves: each step waits until the player has actually done the thing
// (climbed, turned, hit a target...) before moving on. Targets are ordinary enemies that are never allowed to attack.

import { Enemy } from './enemies.js';

const heading = f => Math.atan2(f.x, -f.z);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

// Each step: text, optional setup(t), and progress(t) returning 0..1 (1 = done).
// `t` is the Training instance (t.plane, t.waves, t.drops, t.weapons, t.s = per-step scratch state).
export const STEPS = [
  {
    text: 'Hold <b>W</b> to pull the nose up. Climb 150 higher.',
    touch: 'Push the <b>stick</b> (bottom left) up to pull the nose up. Climb 150 higher.',
    setup: t => { t.s.y0 = t.plane.pos.y; },
    progress: t => (t.plane.pos.y - t.s.y0) / 150,
  },
  {
    text: 'Hold <b>A</b> or <b>D</b> to bank. A banked plane turns by itself. Turn 90&deg; either way.',
    touch: 'Push the <b>stick</b> left or right to bank. A banked plane turns by itself. Turn 90&deg; either way.',
    setup: t => { t.s.turned = 0; },
    progress: t => Math.abs(t.s.turned) / (Math.PI / 2),
  },
  {
    text: 'Tight turn: hold <b>A</b> (or <b>D</b>) <i>and</i> <b>W</b> together to pull through it. Turn all the way around (180&deg;).',
    touch: 'Tight turn: push the stick <b>diagonally up and to the side</b> to bank and pull at once. Turn all the way around (180&deg;).',
    setup: t => { t.s.turned = 0; },
    progress: t => Math.abs(t.s.turned) / Math.PI,
  },
  {
    text: '<b>Shift</b> = throttle up, <b>Ctrl</b> = throttle down. Speed up to 260.',
    touch: 'Hold <b>FASTER</b> (right side) to throttle up, <b>SLOWER</b> to slow down. Speed up to 260.',
    progress: t => (t.plane.speed - t.plane.P.speedBase) / (260 - t.plane.P.speedBase),
  },
  {
    touch: 'A target drone is circling you. Hold <b>FIRE</b>. Aim at the <b style="color:var(--gold)">gold ring</b> in front of it (where it <i>will</i> be), not at the drone itself.',
    text: 'A target drone is circling you. <b>Space</b> fires the cannon. Aim at the <b style="color:var(--gold)">gold ring</b> in front of it (where it <i>will</i> be), not at the drone itself.',
    setup: t => { t.s.target = t.spawnTarget(700); },
    progress: t => (t.s.target.alive ? 1 - t.s.target.hp / t.s.target.maxHp : 1),
  },
  {
    text: 'Missiles: point roughly at the new target until its box turns <b style="color:var(--gold)">gold</b> (locked), then press <b>F</b>.',
    touch: 'Missiles: point roughly at the new target until its box turns <b style="color:var(--gold)">gold</b> (locked), then tap <b>MISSILE</b>.',
    setup: t => { t.plane.missiles = Math.max(t.plane.missiles, 2); t.s.target = t.spawnTarget(1100); },
    progress: t => {
      // never get stuck here: if every missile missed, hand out two more
      if (t.plane.missiles === 0 && t.weapons.missiles.length === 0) t.plane.missiles = 2;
      return t.s.target.alive ? 1 - t.s.target.hp / t.s.target.maxHp : 1;
    },
  },
  {
    text: 'Power-ups: fly through the glowing crystal ahead. <b style="color:#7dff9a">Green</b> repairs (the most common); other colors give shields, rapid fire, an EMP and more.',
    setup: t => {
      const p = t.plane.pos.clone().addScaledVector(t.plane.forward(), 500);
      p.y = Math.max(p.y, 400);
      t.drops.spawn(p, 'shield');
      t.s.drop = t.drops.list[t.drops.list.length - 1];
    },
    progress: t => (t.drops.list.includes(t.s.drop) ? 0 : 1),
  },
  {
    text: 'Last thing: the ground is fatal. When <b style="color:var(--warn)">PULL UP</b> flashes, climb right away. Trees only cost hull. The <b>radar</b> (bottom right) shows enemies and power-ups.',
    progress: t => t.s.time / 6,
  },
];

export class Training {
  constructor({ plane, waves, drops, weapons, scene, touch = false }) {
    Object.assign(this, { plane, waves, drops, weapons, scene, touch });
    this.i = -1;
    this.s = {};
    this.lastHeading = heading(plane.forward());
    this.doneT = 0;
    this.$ = id => document.getElementById(id);
    this.$('tutBox').style.display = 'block';
    this.next();
  }

  // a harmless target: a regular fighter that never gets an attack slot, flying a little slower
  spawnTarget(dist) {
    const p = this.plane.pos.clone().addScaledVector(this.plane.forward(), dist);
    p.y = Math.max(p.y, 420);
    const e = new Enemy(this.scene, 'fighter', p, 1);
    e.canAttack = false;
    e.speed = 115;
    this.waves.enemies.push(e);
    return e;
  }

  next() {
    this.i++;
    this.s = { time: 0, turned: 0 };
    const step = STEPS[this.i];
    if (!step) { this.doneT = 3; this.render(1, 'Training complete! Next: the hangar, where you build your own plane.'); return; }
    if (step.setup) step.setup(this);
    this.render(0);
  }

  render(frac, text) {
    const n = STEPS.length;
    this.$('tutStep').textContent = this.i < n ? `TRAINING ${this.i + 1} / ${n}` : 'TRAINING';
    if (text !== undefined || this.shownStep !== this.i) {
      const st = STEPS[this.i];
      this.$('tutText').innerHTML = text !== undefined ? text : (this.touch && st.touch) || st.text;
      this.shownStep = this.i;
    }
    this.$('tutFill').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  }

  // Called every frame instead of the wave system. Returns true when training is finished.
  update(dt) {
    // targets: update them ourselves and never let them attack
    for (const e of this.waves.enemies) { e.canAttack = false; e.update(dt, this.plane, this.weapons, this.waves.enemies); }
    for (let i = this.waves.enemies.length - 1; i >= 0; i--) {
      if (!this.waves.enemies[i].alive) { this.waves.enemies[i].remove(); this.waves.enemies.splice(i, 1); }
    }

    // heading change since last frame, for the turning steps
    const h = heading(this.plane.forward());
    this.s.turned += wrap(h - this.lastHeading);
    this.lastHeading = h;
    this.s.time += dt;

    if (this.doneT > 0) {
      this.doneT -= dt;
      return this.doneT <= 0;
    }
    const step = STEPS[this.i];
    const frac = step.progress(this);
    this.render(frac);
    if (frac >= 1) this.next();
    return false;
  }

  // crashed during training: no game over, just put the plane back in the air and keep the current step
  respawn() {
    this.plane.reset();
    this.lastHeading = heading(this.plane.forward());
    const step = STEPS[this.i];
    if (step && step.setup && this.i < 4) step.setup(this);   // steps 1-4 measure from the respawn point
    this.s.turned = 0;
  }

  close() {
    this.$('tutBox').style.display = 'none';
    for (const e of this.waves.enemies) e.remove();
    this.waves.enemies.length = 0;
  }
}

/* ---------- One-time hangar tips ---------- */
// phones: the same tips in taps instead of clicks and keys
export const HANGAR_TIPS_TOUCH = [
  'This is the <b>hangar</b>. The plane in the middle is the one you will fly.',
  'Pick a part on the left, then <b>tap</b> a face of the plane to attach it. Turn on <b>Remove</b> (top) to tap parts away. <b>Drag</b> to turn the view, <b>pinch</b> to zoom.',
  '<b>Flight Data</b> (right) shows how your build flies compared to the Stock Fighter. Every part uses <b>load</b>; the Core gives you 120.',
  'Not sure what to build? Load one of the <b>Sample planes</b> or tap <b>&#127922; Random sample plane</b>. When you are ready, tap <b>SORTIE (PLAY)</b>.',
];
export const HANGAR_TIPS = [
  'This is the <b>hangar</b>. The plane on the grid is the one you will fly.',
  'Pick a part on the left (or press <b>1</b>-<b>7</b>), then <b>left-click</b> a face of the plane to attach it. <b>Right-click</b> removes a part. <b>Drag</b> to rotate the view.',
  '<b>Flight Data</b> (right) shows how your build flies compared to the Stock Fighter. Every part uses <b>load</b>; the Core gives you 120.',
  'Not sure what to build? Load one of the <b>Sample planes</b> or hit <b>&#127922; Random sample plane</b>. When you are ready, press <b>SORTIE (PLAY)</b>.',
];

export class HangarTips {
  constructor(onDone, touch = false) {
    this.onDone = onDone;
    this.tips = touch ? HANGAR_TIPS_TOUCH : HANGAR_TIPS;
    this.i = 0;
    this.$ = id => document.getElementById(id);
    this.$('hgTip').style.display = 'block';
    this.$('hgTipNext').onclick = () => this.next();
    this.$('hgTipSkip').onclick = () => this.finish();
    this.show();
  }
  show() {
    this.$('hgTipText').innerHTML = this.tips[this.i];
    this.$('hgTipCount').textContent = `${this.i + 1} / ${this.tips.length}`;
    this.$('hgTipNext').textContent = this.i === this.tips.length - 1 ? 'Got it' : 'Next';
  }
  next() {
    this.i++;
    if (this.i >= this.tips.length) this.finish(); else this.show();
  }
  finish() {
    this.$('hgTip').style.display = 'none';
    if (this.onDone) { const f = this.onDone; this.onDone = null; f(); }
  }
}
