// js/leaderboard.js: the online leaderboard (client side). The server is leaderboard/worker.js on Cloudflare.
// Everything here is optional: with no URL in CFG.leaderboard.url the whole feature stays hidden,
// and any network problem just shows "offline" instead of breaking the game.

import { CFG } from './config.js';
import { Save } from './save.js';
import { PRESETS } from './blueprint.js';

const PRESET_NAMES = new Set(PRESETS.map(p => p.name));

export const Leaderboard = {
  url: () => (CFG.leaderboard.url || '').replace(/\/+$/, ''),
  enabled() { return !!this.url(); },
  _fetch: (...a) => globalThis.fetch(...a),   // replaced in tests

  // the board only shows sample plane names; anything a player named themselves is "Custom"
  planeLabel(name) { return PRESET_NAMES.has(name) ? name : 'Custom'; },

  async call(path, body) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
    try {
      const r = await this._fetch(this.url() + path, body === undefined
        ? { cache: 'no-store', signal: ctl && ctl.signal }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl && ctl.signal });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return { ...data, error: data.error || `HTTP ${r.status}`, status: r.status };   // (some refusals say more, e.g. level)
      return data;
    } catch {
      return { error: 'offline' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  me() { return Save.data.lb || null; },

  // register this browser once; the id, token and callsign are kept in the save
  async ensureId() {
    if (this.me()) return this.me();
    if (this._registering) return this._registering;
    this._registering = (async () => {
      const r = await this.call('/register', {});
      if (r.error) return null;
      Save.setLeaderboard({ id: r.id, token: r.token, callsign: r.callsign });
      return this.me();
    })();
    const out = await this._registering;
    this._registering = null;
    return out;
  },

  // -> { rank, total, best, newBest, daily: { day, rank, total, best, newBest } | null } or { error }
  // `day` = the UTC day of the daily map the run was flown on (only daily-map runs are submitted)
  // `ticket` = what runStart() gave at take-off (the server checks the run really lasted that long)
  async submit({ score, wave, time, plane, day, acc, ticket, parts }) {
    if (!this.enabled()) return { error: 'disabled' };
    const me = await this.ensureId();
    if (!me) return { error: 'offline' };
    const r = await this.call('/score', {
      id: me.id, token: me.token, ticket, score, wave, time: Math.round(time), plane: this.planeLabel(plane), build: CFG.build, day,
      acc: Number.isFinite(acc) ? Math.round(acc) : undefined,
      parts: typeof parts === 'string' ? parts : undefined,          // the plane (parts only): others can copy it from the board
    });
    if (r.status === 401) Save.setLeaderboard(null);   // the server doesn't know us (database reset): register again next time
    return r;
  },

  // the plane a board run was flown in -> { parts } or { error }. day: that day's run, or '' for the all-time best
  async flownPlane(id, day = '') {
    if (!this.enabled()) return { error: 'disabled' };
    return this.call(`/plane/flown?id=${encodeURIComponent(id)}${day ? `&day=${encodeURIComponent(day)}` : ''}`);
  },

  // Creative board: a run in a Creative plane (over the load budget or the build area) -> { rank, total, best, newBest }
  async creativeSubmit({ score, wave, time, load, day, ticket, acc }) {
    if (!this.enabled()) return { error: 'disabled' };
    const me = await this.ensureId();
    if (!me) return { error: 'offline' };
    return this.call('/creative/score', { id: me.id, token: me.token, ticket, score, wave, time: Math.round(time), load: Math.round(load), day,
      acc: Number.isFinite(acc) ? Math.round(acc) : undefined });
  },

  // AI Ladder: a level was won -> { level, rank, total } or { error }
  async ladderClear({ level, time, kills, deaths, ticket, shots, acc }) {
    if (!this.enabled()) return { error: 'disabled' };
    const me = await this.ensureId();
    if (!me) return { error: 'offline' };
    return this.call('/ladder/clear', { id: me.id, token: me.token, ticket, level, time: Math.round(time), kills, deaths, build: CFG.build,
      shots: Number.isInteger(shots) ? shots : undefined, acc: Number.isFinite(acc) ? Math.round(acc) : undefined });
  },

  // a run on today's map takes off -> the ticket to send with its score, or null (offline)
  async runStart() {
    if (!this.enabled()) return null;
    const me = await this.ensureId();
    if (!me) return null;
    const r = await this.call('/run/start', { id: me.id, token: me.token });
    if (r.status === 401) Save.setLeaderboard(null);
    return r.ticket || null;
  },

  // board 'daily' (today's map, default), 'week', 'month', 'year', 'all', 'pvp' (versus Elo), 'creative' or 'ladder' (AI Ladder) -> { board, day, rows, total, me } or { error }
  async top(board = 'daily') {
    if (!this.enabled()) return { error: 'disabled' };
    const me = this.me();
    const b = ['all', 'pvp', 'week', 'month', 'year', 'ladder', 'creative'].includes(board) ? board : 'daily';
    return this.call(`/top?board=${b}` + (me ? `&id=${me.id}` : ''));
  },

  // quick match queue (versus 1v1): call find() every 2 s while searching
  // -> { status: 'waiting', searching, waited } | { status: 'matched', code, peer, key, opponent } | { error }
  async mmFind() {
    const me = await this.ensureId();
    if (!me) return { error: 'offline' };
    return this.call('/mm/find', { id: me.id, token: me.token });
  },
  async mmCancel() {
    const me = this.me();
    if (!this.enabled() || !me) return { ok: true };
    return this.call('/mm/cancel', { id: me.id, token: me.token });
  },
  // open rooms anyone can join, and how many are in the quick match queue -> { rooms, searching } | { error }
  async rooms() {
    if (!this.enabled()) return { error: 'disabled' };
    return this.call('/rooms');
  },

  // 6-letter plane codes: keep a plane (as its SKY1... code) on the server -> { code } | { error }
  async sharePlane(data) {
    if (!this.enabled()) return { error: 'disabled' };
    const me = await this.ensureId();
    if (!me) return { error: 'offline' };
    return this.call('/plane/share', { id: me.id, token: me.token, data });
  },
  // -> { code, data } | { error }
  // a backup code -> the pilot it belongs to ({ id, callsign, locked }) or { error } (nothing changes on the server)
  async whoami(id, token) {
    if (!this.enabled()) return { error: 'disabled' };
    return this.call('/whoami', { id, token });
  },

  async getPlane(code) {
    if (!this.enabled()) return { error: 'disabled' };
    return this.call(`/plane/get?code=${encodeURIComponent(code)}`);
  },

  // start of a rated versus match: "I am in this match". A player who then leaves early can be confirmed as
  // the loser by the ones who stayed (see /pvp/report in worker.js)
  async pvpStart(match) {
    const me = this.me();
    if (!this.enabled() || !me) return { error: 'disabled' };
    return this.call('/pvp/start', { id: me.id, token: me.token, match });
  },

  // end of a ranked versus match: send the final table. It counts once a second player has sent the same one,
  // so if the answer is 'pending' we ask again a little later.
  // -> { status: 'applied', delta, rating, games, wins } | { status: 'pending' } | { error }
  // dealt = { pilot id: damage my shots did to them } (see versus.js landed)
  async pvpReport(match, result, retryMs = 4000, tries = 3, dealt = undefined) {
    const me = this.me();
    if (!this.enabled() || !me) return { error: 'disabled' };
    let r;
    for (let i = 0; i < tries; i++) {
      r = await this.call('/pvp/report', { id: me.id, token: me.token, match, result, dealt });
      if (r.error || r.status === 'applied') return r;
      if (i < tries - 1) await new Promise(res => setTimeout(res, retryMs));
    }
    return r;
  },

  async reroll() {
    const me = await this.ensureId();
    if (!me) return { error: 'offline' };
    if (me.locked) return { error: 'callsign locked' };
    const r = await this.call('/callsign', { id: me.id, token: me.token });
    if (!r.error) Save.setLeaderboard({ ...me, callsign: r.callsign });
    if (r.error === 'callsign locked') Save.setLeaderboard({ ...me, locked: true });
    return r;
  },

  // lock the callsign in for good (the server refuses rerolls afterwards)
  async lock() {
    const me = await this.ensureId();
    if (!me) return { error: 'offline' };
    const r = await this.call('/lock', { id: me.id, token: me.token });
    if (!r.error) Save.setLeaderboard({ ...me, callsign: r.callsign, locked: true });
    return r;
  },
};
