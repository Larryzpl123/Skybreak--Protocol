// js/view.js: plays sideways even when the phone is locked in portrait.
// iPhones that are locked to portrait never rotate the page, and in tilt mode steering like a wheel can make an
// unlocked phone flip to portrait in the middle of a turn. So on a phone whose window is portrait, the whole game
// (everything inside #app) is drawn rotated by 90 degrees: turn the phone sideways and it looks like a normal
// landscape game. Which way to rotate comes from the motion sensor when it is available (phone top to the left or
// to the right), otherwise a Flip button switches it by hand.
//
//   View.w, View.h    size of the game area in game pixels (landscape while rotated)
//   View.rot          0 (normal), 90 (phone top to the left) or -90 (phone top to the right)
//   View.toView(x, y) a screen point (clientX / clientY) -> game coordinates
//   View.vec(dx, dy)  a screen movement -> game coordinates
//
// The CSS rotation: rot 90 = rotate(90deg) (clockwise) and shift right by the screen width, so the game's top edge
// is on the screen's right edge, which is "up" when the phone's top points left. rot -90 is the mirror image.

export const PHONE_MAX = 600;         // the short side of a phone in CSS px (tablets are left alone)

// screen point -> game point for a rotation, given the screen size (sw x sh)
export function toViewPoint(x, y, rot, sw, sh) {
  if (rot === 90) return { x: y, y: sw - x };
  if (rot === -90) return { x: sh - y, y: x };
  return { x, y };
}
export function toViewVec(dx, dy, rot) {
  if (rot === 90) return { x: dy, y: -dx };
  if (rot === -90) return { x: -dy, y: dx };
  return { x: dx, y: dy };
}

// "Up" (away from the ground) in the phone's own axes (x = right edge, y = top edge, z = out of the screen),
// from the deviceorientation angles in degrees. Derived from the W3C rotation R = Rz(alpha) Rx(beta) Ry(gamma):
// up = third row of R = (-cos(beta) sin(gamma), sin(beta), cos(beta) cos(gamma)). Unlike beta and gamma themselves,
// this has no jumps when the phone is held upright on its side.
export function upVector(beta, gamma) {
  const b = beta * Math.PI / 180, g = gamma * Math.PI / 180;
  return { x: -Math.cos(b) * Math.sin(g), y: Math.sin(b), z: Math.cos(b) * Math.cos(g) };
}

// which way a sideways phone is held: 90 = top to the left (its right edge points up), -90 = top to the right,
// null = not clearly sideways (flat on a table, upright in portrait); `prev` is kept unless the other side is clear
export function sideFromUp(u, prev = null) {
  const inPlane = Math.hypot(u.x, u.y);
  if (inPlane < 0.35) return prev;                       // nearly flat: can't tell
  if (Math.abs(u.x) < 0.7 * inPlane) return prev;       // closer to portrait than to sideways
  return u.x > 0 ? 90 : -90;
}

// the screen's safe-area margins (notch, rounded corners, home bar) in px, read once through a probe element
let probe = null;
function screenInsets() {
  const z = { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function' || !document.body) return z;
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  for (const k in z) z[k] = parseFloat(cs['padding' + k[0].toUpperCase() + k.slice(1)]) || 0;
  return z;
}
// screen margins -> margins of the (possibly turned) game area
export function insetsForRot(e, rot) {
  if (rot === 90) return { left: e.top, right: e.bottom, top: e.right, bottom: e.left };
  if (rot === -90) return { left: e.bottom, right: e.top, top: e.left, bottom: e.right };
  return { ...e };
}

// The size of the page in CSS px: the area a position:fixed element really covers (what #app is placed in),
// or innerWidth / innerHeight if that is bigger.
// (An earlier version trusted the screen size in an iPhone web app, because iOS reported the page short by the
// status bar. That only moved the problem: the page itself was short, so the game got cut off instead. The real
// cause is the see-through status bar style, which index.html no longer uses.)
let sizeProbe = null;
export function viewportSize(win = globalThis) {
  let w = win.innerWidth, h = win.innerHeight;
  const doc = win.document;
  if (doc && doc.body && typeof doc.createElement === 'function') {
    if (!sizeProbe) {
      sizeProbe = doc.createElement('div');
      sizeProbe.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;visibility:hidden;pointer-events:none';
      doc.body.appendChild(sizeProbe);
    }
    const pw = sizeProbe.clientWidth, ph = sizeProbe.clientHeight;
    if (pw > 0 && ph > 0) { w = Math.max(w, pw); h = Math.max(h, ph); }
  }
  return { w, h };
}

// Scrolling lists (leaderboard, stats, parts...) while the game is drawn turned: the browser scrolls along the
// SCREEN's up/down, which inside a turned game is sideways, so a list barely moved or not at all ("the leaderboard is
// laggy on the phone"). While turned, finger drags on a scrollable list are turned into game directions here and
// scroll it by hand, with a little momentum when the finger lets go.
export function installTurnedScroll(doc = globalThis.document) {
  if (!doc || !doc.addEventListener) return;
  const now = () => performance.now();
  let drag = null, glide = null;
  const scroller = node => {
    for (let n = node; n && n.nodeType === 1 && n.id !== 'app'; n = n.parentNode) {
      const st = getComputedStyle(n);
      if (/(auto|scroll)/.test(st.overflowY + st.overflowX) && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1)) return n;
    }
    return null;
  };
  const stopGlide = () => { if (glide) { cancelAnimationFrame(glide); glide = null; } };
  doc.addEventListener('touchstart', e => {
    stopGlide();
    if (!View.rot || e.touches.length !== 1) { drag = null; return; }
    const el = scroller(e.target);
    if (!el) { drag = null; return; }
    const p = View.toView(e.touches[0].clientX, e.touches[0].clientY);
    drag = { el, x: p.x, y: p.y, t: now(), vx: 0, vy: 0, moved: false };
  }, { passive: true });
  doc.addEventListener('touchmove', e => {
    if (!drag || !View.rot || e.touches.length !== 1) return;
    const p = View.toView(e.touches[0].clientX, e.touches[0].clientY);
    const dx = p.x - drag.x, dy = p.y - drag.y, t = now(), dt = Math.max(1, t - drag.t);
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;           // still a tap
    drag.moved = true;
    drag.el.scrollTop -= dy; drag.el.scrollLeft -= dx;
    drag.vx = 0.8 * (dx / dt) + 0.2 * drag.vx; drag.vy = 0.8 * (dy / dt) + 0.2 * drag.vy;
    drag.x = p.x; drag.y = p.y; drag.t = t;
    e.preventDefault();
  }, { passive: false });
  doc.addEventListener('touchend', () => {
    if (!drag || !drag.moved) { drag = null; return; }
    const { el } = drag;
    let { vx, vy } = drag, last = now();
    drag = null;
    const step = () => {
      const t = now(), dt = t - last; last = t;
      el.scrollTop -= vy * dt; el.scrollLeft -= vx * dt;
      const k = Math.pow(0.995, dt); vx *= k; vy *= k;            // slows to a stop in about a second
      glide = Math.abs(vx) + Math.abs(vy) > 0.02 ? requestAnimationFrame(step) : null;
    };
    glide = requestAnimationFrame(step);
  });
}

export const View = {
  rot: 0, w: 0, h: 0,
  side: 90,            // the way a sideways phone is held (sensor or Flip button)
  sensor: false,       // true once the motion sensor has reported
  forcePhone: false,   // tests
  onChange: null,

  // is this a phone showing a portrait window? then draw the game rotated
  wantsRotation(touch, sw = innerWidth, sh = innerHeight) {
    return !!touch && sh > sw && (Math.min(sw, sh) <= PHONE_MAX || this.forcePhone);
  },

  update(touch) {
    const { w: sw, h: sh } = viewportSize();
    const rot = this.wantsRotation(touch, sw, sh) ? this.side : 0;
    const changed = rot !== this.rot || this.w !== (rot ? sh : sw) || this.h !== (rot ? sw : sh);
    this.touch = touch;
    this.sw = sw; this.sh = sh;
    this.rot = rot;
    this.w = rot ? sh : sw;
    this.h = rot ? sw : sh;
    const app = typeof document !== 'undefined' && document.getElementById('app');
    if (app) {
      const s = app.style;
      s.width = this.w + 'px';
      s.height = this.h + 'px';
      s.transform = rot === 90 ? `translateX(${sw}px) rotate(90deg)` : rot === -90 ? `translateY(${sh}px) rotate(-90deg)` : '';
      if (app.classList) app.classList.toggle('turned', !!rot);      // (see installTurnedScroll)
      // keep buttons clear of the notch and rounded corners: the screen's safe margins, turned with the game
      const e = screenInsets(), m = insetsForRot(e, rot);
      if (s.setProperty) for (const k in m) s.setProperty('--safe-' + k, m[k] + 'px');
    }
    if (changed && this.onChange) this.onChange();
    return changed;
  },

  toView(x, y) { return toViewPoint(x, y, this.rot, this.sw || innerWidth, this.sh || innerHeight); },
  // called every frame: iOS does not always send a resize event when the visible area changes (toolbars, prompts)
  check(now = typeof performance !== 'undefined' ? performance.now() : 0) {
    if (now - (this.checkedAt || 0) < 400) return;       // twice a second is plenty
    this.checkedAt = now;
    const { w, h } = viewportSize();
    if (w !== this.sw || h !== this.sh) this.update(this.touch);
  },
  vec(dx, dy) { return toViewVec(dx, dy, this.rot); },

  // the motion sensor saw which way the phone is held
  sensorUp(u, touch) {
    this.sensor = true;
    const s = sideFromUp(u, this.side);
    if (s && s !== this.side) {
      // wait for the new side to hold for a moment, so a hard turn in tilt mode never flips the screen
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (this.pendingSide !== s) { this.pendingSide = s; this.pendingSince = now; return; }
      if (now - this.pendingSince < 600) return;
      this.side = s;
      this.update(touch);
    }
    this.pendingSide = null;
  },
  flip(touch) { this.side = -this.side; this.update(touch); },
};
