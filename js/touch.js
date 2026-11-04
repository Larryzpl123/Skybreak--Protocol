// js/touch.js: phone and tablet controls.
// Two ways to steer, switchable in flight: a virtual joystick (left thumb), or tilting the phone (tilt steering).
// Buttons on the right: FIRE (hold), MISSILE, and throttle up / down (hold).
// The stick and the tilt give analog values 0..1 per direction; plane.js scales its turn rates by them,
// so a small push is a gentle turn and a full push equals holding the key.

import { Save } from './save.js';
import { View, upVector, sideFromUp } from './view.js';

// Is this a touch device? (window.__forceTouch lets tests and desktop debugging switch it on)
export function isTouch() {
  if (typeof window === 'undefined') return false;
  if (window.__forceTouch) return true;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return !!coarse || ((typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) && 'ontouchstart' in window);
}

// Joystick: finger offset (px) from the stick center -> x, y in -1..1 (y up = +1),
// with a dead zone in the middle so a resting thumb doesn't steer
export function stickToAxes(dx, dy, radius, dead = 0.15) {
  let x = dx / radius, y = -dy / radius;
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  const mm = Math.min(1, m);
  if (mm < dead) return { x: 0, y: 0 };
  const k = (mm - dead) / (1 - dead) / (mm || 1);   // rescale so output starts at 0 right outside the dead zone
  return { x: x * k, y: y * k };
}

// Tilt. Works from the "up" vector (js/view.js upVector) instead of raw beta / gamma: those jump around when a phone
// is held upright on its side, and their meaning depends on which way the page is turned, which a portrait-locked
// phone gets wrong. side = which way the sideways phone is held (90: its top points left, -90: right).
//   roll  = turning the phone like a steering wheel (+ = clockwise = steer right)
//   pitch = how far the screen leans back from upright (0 = upright, 90 = flat facing the sky)
export const TILT = { steerRange: 25, pitchRange: 20, dead: 3 };
const DEG = 180 / Math.PI;
export function tiltAngles(u, side) {
  const s = side === -90 ? -1 : 1;
  const up = s * u.x, right = -s * u.y;                  // the game's up and right in the phone's axes
  return { roll: Math.atan2(-right, up) * DEG, pitch: Math.asin(Math.max(-1, Math.min(1, u.z))) * DEG };
}
// -> x (steer right = +), y (pull up = +) relative to the calibrated rest pose.
// Pull up = bring the top of the phone toward you (like pulling a stick back); invertY flips it.
export function tiltToAxes(u, side, rest) {
  const a = tiltAngles(u, side);
  const steer = ((a.roll - rest.roll + 540) % 360) - 180;
  const pitch = rest.pitch - a.pitch;
  const f = (v, range) => {
    const s = Math.sign(v), m = Math.abs(v);
    if (m < TILT.dead) return 0;
    return s * Math.min(1, (m - TILT.dead) / (range - TILT.dead));
  };
  return { x: f(steer, TILT.steerRange), y: f(pitch, TILT.pitchRange) };
}

// analog axes -> the same input fields the keyboard produces (numbers 0..1 instead of true/false)
export function axesToInput({ x, y }, invertY = false) {
  const yy = invertY ? -y : y;
  return {
    pitchUp: Math.max(0, yy), pitchDown: Math.max(0, -yy),
    rollLeft: Math.max(0, -x), rollRight: Math.max(0, x),
  };
}

export class TouchControls {
  constructor() {
    this.$ = id => document.getElementById(id);
    this.axes = { x: 0, y: 0 };
    this.btn = { fire: false, missile: false, thrUp: false, thrDown: false };
    this.up = null;             // latest "up" vector from the motion sensor (phone axes)
    this.rest = null;           // calibrated rest pose { roll, pitch, side }
    this.stickId = null;
    this.bind();
  }

  get settings() {
    const c = Save.data.controls || {};
    return { mode: c.mode === 'tilt' ? 'tilt' : 'stick', invertY: c.invertY === true };
  }

  show(on) {
    this.$('touchUI').style.display = on ? 'block' : 'none';
    if (!on) this.release();
    this.refresh();
  }

  release() {
    this.axes = { x: 0, y: 0 };
    for (const k in this.btn) this.btn[k] = false;
    this.stickId = null;
    this.moveKnob(0, 0);
  }

  // the input fields for main.js (merged with the keyboard)
  // which way the sideways phone is held: the turned game decides, then the page orientation, then the sensor
  side() {
    if (View.rot) return View.rot;
    const a = typeof screen !== 'undefined' && screen.orientation ? screen.orientation.angle : (typeof window !== 'undefined' ? window.orientation : undefined);
    if (a === 90) return 90;
    if (a === 270 || a === -90) return -90;
    return (this.up && sideFromUp(this.up, null)) || 90;
  }
  input() {
    let axes = this.axes;
    if (this.settings.mode === 'tilt' && this.up) {
      const side = this.side();
      if (!this.rest || this.rest.side !== side) this.calibrate();     // turned the phone around: new level pose
      axes = tiltToAxes(this.up, side, this.rest);
    }
    return {
      ...axesToInput(axes, this.settings.invertY),
      fire: this.btn.fire, missile: this.btn.missile,
      throttleUp: this.btn.thrUp, throttleDown: this.btn.thrDown,
    };
  }

  moveKnob(x, y) {
    const k = this.$('tKnob');
    if (k) k.style.transform = `translate(${x}px, ${y}px)`;
  }

  bind() {
    const stick = this.$('tStick');
    const R = 55;   // px of travel for a full push
    const center = () => { const r = stick.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const moveTo = (cx, cy) => {
      const c = center();
      const v = View.vec(cx - c.x, cy - c.y);             // screen movement -> game directions (turned game)
      let dx = v.x, dy = v.y;
      const m = Math.hypot(dx, dy);
      if (m > R) { dx *= R / m; dy *= R / m; }
      this.moveKnob(dx, dy);
      this.axes = stickToAxes(dx, dy, R);
    };
    stick.addEventListener('pointerdown', e => {
      e.preventDefault();
      this.stickId = e.pointerId;
      if (stick.setPointerCapture) stick.setPointerCapture(e.pointerId);
      moveTo(e.clientX, e.clientY);
    });
    stick.addEventListener('pointermove', e => { if (e.pointerId === this.stickId) moveTo(e.clientX, e.clientY); });
    const end = e => { if (e.pointerId === this.stickId) { this.stickId = null; this.axes = { x: 0, y: 0 }; this.moveKnob(0, 0); } };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);

    // hold buttons: pressed while a finger is on them
    const hold = (id, key) => {
      const el = this.$(id);
      const on = e => { e.preventDefault(); this.btn[key] = true; if (el.setPointerCapture) el.setPointerCapture(e.pointerId); el.classList.add('down'); };
      const off = () => { this.btn[key] = false; el.classList.remove('down'); };
      el.addEventListener('pointerdown', on);
      el.addEventListener('pointerup', off);
      el.addEventListener('pointercancel', off);
    };
    hold('tFire', 'fire'); hold('tMissile', 'missile'); hold('tThrUp', 'thrUp'); hold('tThrDown', 'thrDown');

    this.$('tMode').onclick = () => this.toggleTilt();
    this.$('tRecenter').onclick = () => { this.calibrate(); this.flash('Level'); };
    this.$('tInvert').onclick = () => this.toggleInvert();
    this.$('tFlip').onclick = () => this.flipScreen();

    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('deviceorientation', e => this.sense(e));
    }
  }
  sense(e) {
    if (e.beta == null || e.gamma == null) return;
    this.up = upVector(e.beta, e.gamma);
    View.sensorUp(this.up, true);                      // also decides which way a portrait-locked phone is turned
    if (!this.rest && this.settings.mode === 'tilt') this.calibrate();
  }

  // the way the phone is held right now becomes "straight and level"
  calibrate() {
    if (!this.up) return;
    const side = this.side();
    this.rest = { ...tiltAngles(this.up, side), side };
  }

  // Switching to tilt asks for permission on iPhone (it has to happen inside a tap), then calibrates
  async toggleTilt() {
    const s = Save.data.controls || (Save.data.controls = {});
    if (this.settings.mode === 'tilt') {
      s.mode = 'stick';
    } else {
      const DOE = typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : null;
      if (DOE && typeof DOE.requestPermission === 'function') {
        try { if (await DOE.requestPermission() !== 'granted') { this.flash('Tilt needs motion access'); return; } }
        catch { this.flash('Tilt needs motion access'); return; }
      }
      s.mode = 'tilt';
      this.rest = null;
      this.calibrate();
      this.flash('Tilt: turn like a wheel to steer, top toward you to climb. Recenter = level');
    }
    Save.write();
    this.axes = { x: 0, y: 0 };
    this.refresh();
  }

  toggleInvert() {
    const s = Save.data.controls || (Save.data.controls = {});
    s.invertY = !s.invertY;
    Save.write();
    this.refresh();
  }

  // the game is drawn upside down for the way the phone is held: turn it round. On iPhone this also asks for the
  // motion sensor once, so from then on the game follows the phone by itself.
  async flipScreen() {
    View.flip(true);
    const DOE = typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : null;
    if (DOE && typeof DOE.requestPermission === 'function' && !this.askedMotion) {
      this.askedMotion = true;
      try { await DOE.requestPermission(); } catch {}
    }
    this.refresh();
  }

  flash(text) { if (this.onMessage) this.onMessage(text); }

  refresh() {
    const tilt = this.settings.mode === 'tilt';
    this.$('tStick').style.display = tilt ? 'none' : '';
    this.$('tTiltBox').style.display = tilt ? 'flex' : 'none';
    this.$('tFlip').style.display = View.rot && !View.sensor ? '' : 'none';
    this.$('tMode').textContent = tilt ? 'Tilt: ON' : 'Tilt: OFF';
    const inv = this.$('tInvert');
    inv.textContent = this.settings.invertY ? 'Climb: push away' : 'Climb: pull back';
  }
}
