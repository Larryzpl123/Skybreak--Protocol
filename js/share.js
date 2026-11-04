// js/share.js: share a plane as a short code or a link, e.g. https://.../#plane=SKY1.TXlQbGFuZXxjMCwwLDA7dzEsMCww
// The code is the plane's name and parts, one letter per part type, in base64 (URL safe). Anything pasted in is
// treated as untrusted: it goes through the same checks as a saved plane (deserialize), and the name is cut short.

import { deserialize } from './blueprint.js';

const LETTER = { core: 'c', structure: 's', wing: 'w', prop: 'p', jet: 'j', cannon: 'k', pylon: 'm', armor: 'a' };
const TYPE = Object.fromEntries(Object.entries(LETTER).map(([t, l]) => [l, t]));
const PREFIX = 'SKY1.';

const b64 = {
  enc(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  },
};

// plane { name, parts: [{ type, x, y, z }] } -> "SKY1.xxxx"
export function planeToCode(bp) {
  const name = String(bp.name || 'Shared plane').replace(/[|;]/g, ' ').slice(0, 32);
  const parts = bp.parts.map(p => `${LETTER[p.type] || 's'}${p.x},${p.y},${p.z}`).join(';');
  return PREFIX + b64.enc(`${name}|${bp.parts.length}|${parts}`);      // the count catches a code that was cut short
}

// a code, or a whole link containing one -> { ok: true, bp } or { ok: false, reason }
export function codeToPlane(text) {
  const m = String(text || '').match(/SKY1\.([A-Za-z0-9_-]+)/);
  if (!m) return { ok: false, reason: 'That is not a plane code (it starts with SKY1.)' };
  let raw;
  try { raw = b64.dec(m[1]); } catch { return { ok: false, reason: 'The plane code is damaged (copy all of it)' }; }
  const damaged = { ok: false, reason: 'The plane code is damaged or cut short (copy all of it)' };
  const f = raw.split('|');
  if (f.length !== 3 || !/^\d+$/.test(f[1])) return damaged;
  const name = f[0].trim().slice(0, 32) || 'Shared plane';
  const cells = f[2].split(';').filter(Boolean);
  if (cells.length !== Number(f[1]) || cells.length > 400) return damaged;
  if (!cells.every(t => /^[a-z]-?\d+,-?\d+,-?\d+$/.test(t))) return damaged;
  const parts = cells.map(t => { const [x, y, z] = t.slice(1).split(',').map(Number); return [TYPE[t[0]], x, y, z]; });
  if (parts.some(p => !p[0])) return { ok: false, reason: 'The plane code has unknown parts' };
  // the normal save checks: known parts, whole-number cells, exactly one core (otherwise it falls back to the stock plane)
  const bp = deserialize(JSON.stringify({ v: 1, name, parts }));
  if (bp.parts.length !== parts.length || bp.name !== name) return { ok: false, reason: 'The plane code has broken parts' };
  return { ok: true, bp };
}

// The leaderboard keeps the plane each board run was flown in, as parts only (no name, so nothing a player typed
// can reach the board): "c0,0,0;w1,0,0;...". parts: [{ type, x, y, z }] or [[type, x, y, z]]
export function partsToText(parts) {
  return parts.map(p => (Array.isArray(p) ? `${LETTER[p[0]] || 's'}${p[1]},${p[2]},${p[3]}` : `${LETTER[p.type] || 's'}${p.x},${p.y},${p.z}`)).join(';');
}
// parts text from the board + a name we choose -> a plane code (which then gets the normal checks in codeToPlane)
export function partsTextToCode(text, name) {
  const cells = String(text || '').split(';').filter(Boolean);
  return PREFIX + b64.enc(`${String(name).replace(/[|;]/g, ' ').slice(0, 32)}|${cells.length}|${cells.join(';')}`);
}

// the link to send: this page with the plane in the address (#plane=...), so it opens straight into the hangar
export function planeLink(bp, base) {
  return `${base}#plane=${planeToCode(bp)}`;
}
