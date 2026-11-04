// js/coop.js: co-op (2 to 4 players on one team). The host runs the real game: waves, enemies, drops, weather.
// Guests fly their own plane locally (so their controls feel instant) and see the host's world through snapshots.
//
// Who decides what:
//   host   enemies, their hits by anyone's bullets or missiles, score, drops, waves, lightning, game over
//   guest  its own plane: flying, getting hit by enemy bullets / rams / lightning, picking up (after the host says yes)
// Messages (net.js channels: fast = 15-20 per second, may drop; safe = reliable events):
//   guest -> host  st (fast): my plane      sh: my bullets      ms: my missile      ram: I rammed enemy id
//                  pick: can I have drop id     dead: I went down     hello: my name and plane
//   host -> guest  snap (fast): enemies, drops, players, wave, score      es: enemy bullets (everyone simulates them)
//                  start / wave / msg / got (drop granted) / emp / bolt / over / left

import * as THREE from 'three';
import { CFG } from './config.js';
import { Enemy } from './enemies.js';
import { buildBlueprintMesh } from './partMesh.js';
import { POWERUPS } from './powerups.js';
import { computeStats } from './parts.js';
import { specFromStats } from './spec.js';
import { Versus, newMatchId } from './versus.js';

const SNAP_HZ = 15, STATE_HZ = 20;
const r1 = v => Math.round(v * 10) / 10;           // numbers on the wire: 0.1 precision is plenty
const r3 = v => Math.round(v * 1000) / 1000;
const _v = new THREE.Vector3();

// Another player's plane: a model that glides smoothly between network updates.
// It also looks enough like a Plane (pos, alive, speed, forward(), P.radius) for enemies to chase it.
export class RemotePlane {
  constructor(scene, peer, name, parts) {
    this.scene = scene; this.peer = peer; this.name = name || 'Pilot';
    this.pos = new THREE.Vector3(0, 340, 0); this.target = this.pos.clone(); this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion(); this.qTarget = new THREE.Quaternion();
    this.alive = true; this.hp = 1; this.maxHp = 1; this.speed = 170; this.P = { radius: CFG.plane.radius };
    this.type = 'player';                            // HUD marker style in versus
    this.parts = parts || [];
    // hit size from their build, the same number their own game uses (bigger planes are easier to hit)
    if (this.parts.length) {
      try { this.P.radius = specFromStats(computeStats(this.parts.map(([type, x, y, z]) => ({ type, x, y, z })))).radius; } catch {}
    }
    this.radius = this.P.radius;
    const built = this.parts.length ? buildBlueprintMesh(this.parts.map(([type, x, y, z]) => ({ type, x, y, z }))) : null;
    this.mesh = built ? built.group : new THREE.Group();
    scene.add(this.mesh);
  }
  forward(out = new THREE.Vector3()) { return out.set(0, 0, -1).applyQuaternion(this.quat); }
  up(out = new THREE.Vector3()) { return out.set(0, 1, 0).applyQuaternion(this.quat); }
  apply(s) {                                       // s = [x, y, z, qx, qy, qz, qw, vx, vy, vz, alive, hp, maxHp]
    this.stale = 0;
    this.target.set(s[0], s[1], s[2]);
    this.qTarget.set(s[3], s[4], s[5], s[6]);
    this.vel.set(s[7], s[8], s[9]);
    this.speed = this.vel.length();
    const wasAlive = this.alive;
    this.alive = !!s[10]; this.hp = s[11]; this.maxHp = s[12];
    if (this.alive && !wasAlive) this.pos.copy(this.target);   // respawned: jump there
  }
  update(dt) {
    // keep moving between updates (dead reckoning), but only briefly: a player whose game stopped sending
    // (tab in the background) must not drift off across the map
    this.stale = (this.stale || 0) + dt;
    if (this.stale < 0.6) this.target.addScaledVector(this.vel, dt);
    this.pos.lerp(this.target, Math.min(1, 10 * dt));
    this.quat.slerp(this.qTarget, Math.min(1, 10 * dt));
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);
    this.mesh.visible = this.alive;
  }
  remove() { this.scene.remove(this.mesh); }
}

const planeState = p => {
  const f = p.forward();
  return [r1(p.pos.x), r1(p.pos.y), r1(p.pos.z), r3(p.quat.x), r3(p.quat.y), r3(p.quat.z), r3(p.quat.w),
    r1(f.x * p.speed), r1(f.y * p.speed), r1(f.z * p.speed), p.alive ? 1 : 0, Math.round(p.hp), Math.round(p.maxHp)];
};

export class Coop {
  // g = the game: { scene, plane, weapons, waves, drops, fx, hud, net, Weather, applyPowerup, onEnemyHit, onPlayerHit,
  //                 launch(map, slot, players), leave(), toast(text), score(), respawn() }
  // hooks set by the game: onLobby() (the player list changed), onOver(m) (the whole team is down)
  constructor(g) {
    this.g = g;
    this.role = null;              // null | 'host' | 'guest'
    this.remotes = new Map();      // peer -> RemotePlane
    this.lobby = new Map();        // peer -> { name, parts } (host: everyone who joined)
    this.ghosts = new Map();       // guest: enemy id -> Enemy (display only)
    this.dropViews = new Map();    // guest: drop id -> { id, type, pos, mesh }
    this.pendingPick = new Set();
    this.score = 0; this.wave = 0;
    this.snapT = 0; this.stateT = 0;
    this.started = false;
    this.spectate = null;
    this.mode = 'team';            // 'team' (co-op against the waves) | 'versus' (PvP)
    this.clock = 0;                // seconds of my own game running (stops when my tab is in the background)
    this.seen = new Map();         // peer -> this.clock when their last message arrived
    this.vs = new Versus(this);
    g.net.onMessage = (from, m) => this.onMessage(from, m);
    g.net.onPeer = (peer, state) => this.onPeer(peer, state);
  }

  get net() { return this.g.net; }
  get active() { return this.started && !!this.role; }
  get versus() { return this.mode === 'versus'; }
  get isHost() { return this.role === 'host'; }
  get isGuest() { return this.role === 'guest'; }
  players() { return 1 + this.remotes.size; }
  teammates() { return [...this.remotes.values()]; }

  // ---------------- lobby ----------------
  // opts: { isPublic (listed for anyone to join), assigned (a room the server made: quick match), quick }
  async hostRoom(me, mode = 'team', opts = {}) {
    this.role = 'host';
    this.mode = mode === 'versus' ? 'versus' : 'team';
    this.me = me;                              // { name, parts, lbId, rankOk }
    this.isPublic = !!opts.isPublic;
    this.quick = !!opts.quick;                 // quick match: starts by itself as soon as the opponent is in
    const code = await this.g.net.host(opts.assigned || null);
    this.publish();
    return code;
  }
  async joinRoom(code, me, assigned = null) {
    this.role = 'guest';
    this.me = me;
    this.quick = !!assigned;
    await this.g.net.join(code, 20000, assigned);
    this.g.net.send('h', { t: 'hello', name: me.name, parts: me.parts, lbId: me.lbId, rankOk: me.rankOk }, true);
  }
  lobbyList() {
    const list = [{ peer: this.isHost ? 'h' : 'me', name: this.me ? this.me.name : 'You', you: true }];
    for (const [peer, p] of this.lobby) list.push({ peer, name: p.name });
    return list;
  }

  // host: everyone in the lobby flies; each on their own plane, all on the host's map
  start(map) {
    if (!this.isHost) return;
    this.g.net.stopPolling();
    const players = [{ peer: 'h', name: this.me.name, parts: this.me.parts, lbId: this.me.lbId }];
    for (const [peer, p] of this.lobby) players.push({ peer, name: p.name, parts: p.parts, lbId: p.lbId });
    const vs = this.versus ? { match: newMatchId(), ...this.rankInfo() } : null;
    this.g.net.broadcast({ t: 'start', map, players, mode: this.mode, vs }, true);
    this.publish(true);
    this.begin(map, players, this.mode, vs);
  }

  // host: tell the server about the room, so a public one shows up in everyone's room list (and a started or
  // private one does not). Best effort: an older server without the room list just ignores it.
  publish(started = this.started) {
    if (!this.isHost || !this.g.net.me || typeof this.g.net.call !== 'function') return;
    const rank = this.versus ? this.rankInfo() : { ranked: false };
    this.g.net.call('/room/info', { ...this.g.net.auth(), mode: this.mode, name: this.me.name, public: this.isPublic && !this.quick,
      started, players: 1 + this.lobby.size, rated: rank.ranked }).catch(() => {});
  }

  // versus: is this match rated? Everyone needs a pilot number, and a plane inside the normal limits
  rankInfo() {
    const all = [{ name: this.me.name, lbId: this.me.lbId, rankOk: this.me.rankOk }, ...this.lobby.values()];
    if (all.length < 2) return { ranked: false, why: 'waiting for players' };
    const noId = all.find(p => !Number.isInteger(p.lbId));
    if (noId) return { ranked: false, why: `${noId.name} has no pilot number (leaderboard offline?)` };
    const creative = all.find(p => !p.rankOk);
    if (creative) return { ranked: false, why: `${creative.name} is flying a Creative plane` };
    return { ranked: true, why: '' };
  }

  begin(map, players, mode = this.mode, vsInfo = null) {
    this.mode = mode === 'versus' ? 'versus' : 'team';
    this.clearWorld();
    const myPeer = this.isHost ? 'h' : this.g.net.me.peer;
    for (const p of players) if (p.peer !== myPeer) this.remotes.set(p.peer, new RemotePlane(this.g.scene, p.peer, p.name, p.parts));
    this.started = true;
    this.score = 0; this.wave = 0;
    const W = this.g.waves, Wx = this.g.Weather;
    if (this.isHost) {
      W.setTargets([this.g.plane, ...this.teammates()]);
      W.playerCount = this.players();
      this.g.weapons.onEnemyFire = (pos, dir, speed, dmg) =>
        this.g.net.broadcast({ t: 'es', p: [r1(pos.x), r1(pos.y), r1(pos.z)], d: [r3(dir.x), r3(dir.y), r3(dir.z)], s: speed, g: dmg }, true);
      Wx.onBolt = (pos, airY) => this.g.net.broadcast({ t: 'bolt', p: [r1(pos.x), r1(pos.y), r1(pos.z)], a: r1(airY) }, true);
    }
    this.teamOver = null;
    this.slot = Math.max(0, players.findIndex(p => p.peer === myPeer));
    for (const p of players) this.seen.set(p.peer, this.clock);
    if (this.versus) this.vs.begin(players, vsInfo || {});
    this.g.launch(map, this.slot, players.length);
    if (this.versus) this.vs.spawnSlot(this.slot, players.length);
    if (this.isGuest) Wx.remoteBolts = true;
  }

  clearWorld() {
    for (const r of this.remotes.values()) r.remove();
    this.remotes.clear();
    for (const e of this.ghosts.values()) e.remove();
    this.ghosts.clear();
    for (const d of this.dropViews.values()) this.g.scene.remove(d.mesh);
    this.dropViews.clear();
    this.pendingPick.clear();
  }

  // leave the room (or the host closed it): back to a normal single-player game
  end() {
    this.role = null; this.started = false; this.lobby.clear(); this.lobbyFromHost = null; this.teamOver = null;
    this.mode = 'team'; this.vs.over = null; this.rankFromHost = null; this.quick = false; this.isPublic = false;
    this.clearWorld();
    const W = this.g.waves;
    W.setTargets(null); W.playerCount = 1;
    this.g.weapons.onEnemyFire = null;
    this.g.Weather.onBolt = null; this.g.Weather.remoteBolts = false;
    this.g.net.close();                  // role is already null, so the 'closed' events this fires are ignored
  }

  onPeer(peer, state) {
    if (!this.role) return;
    if (state === 'closed') {
      const r = this.remotes.get(peer);
      const name = (r && r.name) || (this.lobby.get(peer) || {}).name || 'A teammate';
      if (r) { r.remove(); this.remotes.delete(peer); }
      this.lobby.delete(peer);
      if (this.isGuest && peer === 'h') {
        // versus: the match ends here and the host counts as having left (a rated match still counts)
        if (this.started && this.versus) {
          if (!this.vs.over) { this.vs.playerLeft('h'); this.g.toast('The host left'); }
          return;                                      // keep the final table on screen
        }
        this.g.toast('The host left the game'); this.g.leave(); return;
      }
      if (this.isHost) {
        this.g.waves.setTargets([this.g.plane, ...this.teammates()]);
        this.g.net.broadcast({ t: 'left', peer, name }, true);
        this.g.net.broadcast(this.lobbyMsg(), true);
        if (!this.started) this.publish();
        if (this.started) this.checkTeamOver();
        if (this.started && this.versus) this.vs.playerLeft(peer);
      }
      this.g.toast(`${name} left`);
      if (this.onLobby) this.onLobby();
    }
  }

  // ---------------- messages ----------------
  onMessage(from, m) {
    const g = this.g;
    // alive = their game loop is running: only the regular state updates count (a hidden tab still answers
    // messages, so a reply is no sign that the game there is running)
    if (m.t === 'st' || m.t === 'snap') this.seen.set(from, this.clock);
    switch (m.t) {
      // ----- to the host -----
      case 'hello':
        if (!this.isHost) return;
        this.lobby.set(from, { name: String(m.name || 'Pilot').slice(0, 30), parts: Array.isArray(m.parts) ? m.parts.slice(0, 300) : [],
          lbId: Number.isInteger(m.lbId) ? m.lbId : null, rankOk: m.rankOk === true });
        g.net.broadcast(this.lobbyMsg(), true);
        this.publish();
        if (this.onLobby) this.onLobby();
        return;
      case 'st': { const r = this.remotes.get(from); if (r) r.apply(m.s); return; }
      case 'sh':
        if (this.isHost) for (const b of m.b || []) g.weapons.addRemoteBullet(b[0], b[1], b[2]);
        return;
      case 'ms': {
        if (!this.isHost) return;
        const tgt = g.waves.enemies.find(e => e.id === m.id && e.alive), r = this.remotes.get(from);
        if (tgt && r) g.weapons.fireMissile({ missCd: 0, missiles: 1, pos: r.pos.clone(), forward: () => r.forward() }, tgt);
        return;
      }
      case 'ram': {
        if (!this.isHost) return;
        const e = g.waves.enemies.find(x => x.id === m.id && x.alive);
        if (e && !e.solid) g.onEnemyHit(e, 9999, e.pos);
        return;
      }
      case 'pick': {
        if (!this.isHost) return;
        const type = g.drops.take(m.id);
        if (!type) return;
        g.net.send(from, { t: 'got', id: m.id, type }, true);
        const r = this.remotes.get(from);
        if (type === 'emp' && r) {                          // the EMP goes off where the teammate is
          g.applyPowerup('emp', { plane: r, weapons: g.weapons, enemies: g.waves.enemies, onEnemyHit: g.onEnemyHit, fx: g.fx });
          g.net.broadcast({ t: 'emp', p: [r1(r.pos.x), r1(r.pos.y), r1(r.pos.z)] }, true);
        }
        return;
      }
      // ----- to the guests -----
      case 'lobby':
        this.lobbyFromHost = m.list;
        if (m.mode) this.mode = m.mode;
        this.rankFromHost = m.rank || null;
        if (this.onLobby) this.onLobby();
        return;
      case 'start': this.begin(m.map, m.players, m.mode, m.vs); return;
      case 'snap': this.applySnap(m); return;
      case 'es': g.weapons.fireEnemy(new THREE.Vector3(...m.p), new THREE.Vector3(...m.d), m.s, m.g); return;
      case 'bolt': g.Weather.addBolt(new THREE.Vector3(...m.p), m.a); return;
      case 'msg': g.hud.message(m.text, m.secs || 2, m.sub || ''); return;
      case 'wave': this.onWave(m); return;
      case 'got': {
        this.pendingPick.delete(m.id);
        if (!g.plane.alive) return;                        // went down while the request was on its way
        const txt = g.applyPowerup(m.type, { plane: g.plane, weapons: g.weapons, enemies: [], onEnemyHit: () => {}, fx: g.fx });
        g.hud.message(txt, 1.6);
        return;
      }
      case 'emp': {                                        // clear the enemy bullets near that EMP in my copy too
        const p = new THREE.Vector3(...m.p), r2 = CFG.power.empClearRadius ** 2, w = g.weapons;
        for (let i = w.enemyShots.length - 1; i >= 0; i--) if (w.enemyShots[i].pos.distanceToSquared(p) < r2) { w.scene.remove(w.enemyShots[i].mesh); w.enemyShots.splice(i, 1); }
        g.fx.pulse(p);
        return;
      }
      case 'left': { const r = this.remotes.get(m.peer); if (r) { r.remove(); this.remotes.delete(m.peer); } g.toast(`${m.name} left`); return; }
      case 'dead': return;
      case 'over': this.onTeamOver(m); return;
      default:
        if (typeof m.t === 'string' && m.t[0] === 'v') this.vs.onMessage(from, m);   // versus rules (versus.js)
    }
  }

  lobbyMsg() { return { t: 'lobby', list: this.lobbyForGuests(), mode: this.mode, rank: this.versus ? this.rankInfo() : null }; }
  lobbyForGuests() {
    return [{ peer: 'h', name: this.me.name }, ...[...this.lobby].map(([peer, p]) => ({ peer, name: p.name }))];
  }

  // ---------------- every frame ----------------
  // host, after the normal game update: remote players, snapshots, respawns, team game over
  // my clock for "has that player gone quiet?": real time while my game runs (a slow phone at 15 fps must not
  // stretch the 12 s), but at most 0.25 s per frame, so my own pause (my tab hidden) never counts against others
  tickClock(dt) {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const real = this.lastTick === undefined ? dt : (now - this.lastTick) / 1000;
    this.lastTick = now;
    this.clock += Math.max(dt, Math.min(0.25, real));
  }

  hostTick(dt) {
    this.tickClock(dt);
    for (const r of this.remotes.values()) r.update(dt);
    // versus: a player whose game went quiet (tab in the background, phone locked) pauses the match for everyone
    // (see Versus.setPaused); too long, and they count as having left
    if (this.versus && this.started && !this.vs.over) this.checkQuiet(dt, [...this.remotes.keys()], p => this.dropAway(p));
    this.snapT -= dt;
    if (this.snapT <= 0) {
      this.snapT = 1 / SNAP_HZ;
      const g = this.g;
      g.net.broadcast({
        t: 'snap', w: g.waves.wave, sc: g.score(), tl: this.versus ? r1(this.vs.timeLeft) : undefined,
        en: g.waves.enemies.filter(e => e.alive).map(e => [e.id, e.type, r1(e.pos.x), r1(e.pos.y), r1(e.pos.z),
          r3(e.quat.x), r3(e.quat.y), r3(e.quat.z), r3(e.quat.w), r1(e.vel.x), r1(e.vel.y), r1(e.vel.z),
          Math.round(e.hp), Math.round(e.maxHp), e.shielded ? 1 : 0, e.canAttack ? 1 : 0]),
        dr: g.drops.list.map(d => [d.id, d.type, r1(d.pos.x), r1(d.pos.y), r1(d.pos.z)]),
        pl: [['h', ...planeState(g.plane)], ...this.teammates().map(r => [r.peer, ...planeState(r)])],
      });
    }
  }

  // versus: is one of these players' games quiet? Then pause (the host also tells the guests), count their
  // pause time, and give up on them after awayLimit seconds in one go or pauseBudget in total.
  checkQuiet(dt, peers, giveUp) {
    const V = CFG.versus, vs = this.vs;
    let who = null, quiet = 0;
    for (const peer of peers) {
      const q = this.clock - (this.seen.get(peer) ?? this.clock);
      if (q > V.quietAfter && q > quiet) { who = peer; quiet = q; }
    }
    const fromMe = !vs.paused || peers.includes(vs.paused.peer);   // a pause the host announced is the host's to lift
    if (!who) {
      if (vs.paused && fromMe) { vs.setPaused(null); if (this.isHost) this.g.net.broadcast({ t: 'vresume' }, true); }
      return;
    }
    const used = (vs.pauseUsed.get(who) || 0) + dt;
    vs.pauseUsed.set(who, used);
    const left = Math.max(0, Math.min(V.awayLimit - quiet, V.pauseBudget - used));
    const name = vs.name(who);
    vs.setPaused({ peer: who, name, left });
    if (this.isHost) {
      this.pauseSendT = (this.pauseSendT || 0) - dt;
      if (this.pauseSendT <= 0) { this.pauseSendT = 0.5; this.g.net.broadcast({ t: 'vpause', peer: who, name, left: Math.ceil(left) }, true); }
    }
    if (left <= 0) { vs.setPaused(null); if (this.isHost) this.g.net.broadcast({ t: 'vresume' }, true); giveUp(who); }
  }

  // host, versus: take a silent player out of the match (they are told first, then the connection is closed)
  dropAway(peer) {
    const r = this.remotes.get(peer);
    this.vs.playerLeft(peer, 'away');
    if (r) { r.remove(); this.remotes.delete(peer); }
    this.g.toast(`${(r && r.name) || 'A player'} stopped responding`);
    const net = this.g.net;
    if (typeof net.drop === 'function') setTimeout(() => net.drop(peer), 1500);
  }

  // Everyone is down (host decides): team game over
  checkTeamOver() {
    if (!this.isHost || this.versus) return false;     // versus: everyone respawns, the match ends by kills or time
    const anyAlive = this.g.plane.alive || this.teammates().some(r => r.alive);
    if (anyAlive) return false;
    const m = { t: 'over', score: this.g.score(), wave: this.g.waves.wave };
    this.g.net.broadcast(m, true);
    this.onTeamOver(m);
    return true;
  }
  onTeamOver(m) { this.teamOver = m; if (this.onOver) this.onOver(m); }

  // host: a new wave; everyone who was down comes back
  hostWave(wave, text, sub) {
    this.g.net.broadcast({ t: 'wave', wave, text, sub }, true);
  }
  onWave(m) {
    this.wave = m.wave;
    const g = this.g;
    if (!g.plane.alive) { g.respawn(); g.hud.message('BACK IN THE FIGHT', 2); }
    else if (m.wave > 1) { const b = g.plane.hp; g.plane.heal(CFG.wave.clearHeal); if (g.plane.hp > b) g.hud.message(`WAVE CLEAR  +${Math.round(g.plane.hp - b)} HP`, 1.6); }
    if (m.text) g.hud.message(m.text, 3.5, m.sub || '');
  }

  // guest: fly locally, show the host's world, report my plane and shots
  guestTick(dt, shotsBefore) {
    const g = this.g;
    this.tickClock(dt);
    // the host's game went quiet (its tab in the background): paused until it is back; too long = the host left
    if (this.versus && this.started && !this.vs.over) {
      this.checkQuiet(dt, ['h'], () => { this.vs.playerLeft('h'); this.g.toast('The host did not come back'); });
    }
    // ghosts glide toward their last reported spot
    for (const e of this.ghosts.values()) {
      e.target.addScaledVector(e.vel, dt);
      e.pos.lerp(e.target, Math.min(1, 10 * dt));
      e.quat.slerp(e.qTarget, Math.min(1, 10 * dt));
      e.mesh.position.copy(e.pos); e.mesh.quaternion.copy(e.quat);
      if (e.bubble) { e.bubble.visible = e.shielded; if (e.shielded) e.bubble.position.copy(e.pos); }
    }
    for (const r of this.remotes.values()) r.update(dt);
    for (const d of this.dropViews.values()) { d.mesh.position.copy(d.pos); d.mesh.rotation.y += 2.2 * dt; }

    // my new bullets go to the host (it decides what they hit)
    const fresh = this.versus ? [] : g.weapons.bullets.slice(shotsBefore);   // versus sends its own (versus.js)
    if (fresh.length) g.net.send('h', { t: 'sh', b: fresh.map(b => [[r1(b.pos.x), r1(b.pos.y), r1(b.pos.z)], [r3(b.dir.x), r3(b.dir.y), r3(b.dir.z)], b.dmg]) }, true);

    // rams and drone blasts against my copy of the enemies: my damage, the host removes the enemy
    const p = g.plane;
    if (p.alive) {
      if (p.ramCd > 0) p.ramCd -= dt;
      for (const e of this.ghosts.values()) {
        const rr = Math.max(e.blastRadius || 0, e.radius + p.P.radius);
        if (e.pos.distanceToSquared(p.pos) >= rr * rr) continue;
        if (e.solid) {
          _v.copy(p.pos).sub(e.pos).normalize();
          p.pos.copy(e.pos).addScaledVector(_v, rr + 6);
          if (p.ramCd <= 0) { g.onPlayerHit(e.ramDamage, 'COLLISION'); p.ramCd = CFG.plane.ramCooldown; }
        } else if (!e.rammed && (p.ramCd <= 0 || e.type === 'drone')) {
          e.rammed = true;
          g.onPlayerHit(e.ramDamage, e.type === 'drone' ? 'DRONE' : 'COLLISION');
          p.ramCd = CFG.plane.ramCooldown;
          g.net.send('h', { t: 'ram', id: e.id }, true);
        }
      }
      // drops: ask the host; it answers 'got' if nobody was faster
      for (const d of this.dropViews.values()) {
        const r = CFG.drop.pickupRadius;
        if (!this.pendingPick.has(d.id) && d.pos.distanceToSquared(p.pos) < r * r) {
          this.pendingPick.add(d.id);
          g.net.send('h', { t: 'pick', id: d.id }, true);
        }
      }
    }

    this.stateT -= dt;
    if (this.stateT <= 0) { this.stateT = 1 / STATE_HZ; g.net.send('h', { t: 'st', s: planeState(p) }); }
  }

  applySnap(m) {
    const g = this.g;
    this.score = m.sc; this.wave = m.w;
    if (this.versus && typeof m.tl === 'number') this.vs.timeLeft = m.tl;
    // enemies
    const seen = new Set();
    for (const s of m.en) {
      const [id, type, x, y, z, qx, qy, qz, qw, vx, vy, vz, hp, maxHp, sh, atk] = s;
      seen.add(id);
      let e = this.ghosts.get(id);
      if (!e) {
        e = new Enemy(g.scene, type, new THREE.Vector3(x, y, z));
        e.id = id; e.target = e.pos.clone(); e.qTarget = new THREE.Quaternion(qx, qy, qz, qw); e.quat.copy(e.qTarget);
        this.ghosts.set(id, e);
      }
      e.target.set(x, y, z); e.qTarget.set(qx, qy, qz, qw); e.vel.set(vx, vy, vz);
      e.hp = hp; e.maxHp = maxHp; e.shielded = !!sh; e.canAttack = !!atk; e.alive = true;
    }
    for (const [id, e] of this.ghosts) if (!seen.has(id)) { e.alive = false; e.remove(); this.ghosts.delete(id); }
    // drops
    const dseen = new Set();
    for (const [id, type, x, y, z] of m.dr) {
      dseen.add(id);
      let d = this.dropViews.get(id);
      if (!d) {
        const mesh = new THREE.Mesh(g.drops.geo, g.drops.mat(type));
        g.scene.add(mesh);
        d = { id, type, pos: new THREE.Vector3(), mesh };
        this.dropViews.set(id, d);
      }
      d.pos.set(x, y, z);
    }
    for (const [id, d] of this.dropViews) if (!dseen.has(id)) { g.scene.remove(d.mesh); this.dropViews.delete(id); this.pendingPick.delete(id); }
    // other players (the host and other guests; not me)
    const mine = g.net.me && g.net.me.peer;
    for (const row of m.pl) {
      const [peer, ...s] = row;
      if (peer === mine) continue;
      const r = this.remotes.get(peer);
      if (r) r.apply(s);
    }
  }

  // what the HUD, radar and targeting use for enemies on this screen
  enemyList() { return this.isGuest ? [...this.ghosts.values()] : this.g.waves.enemies; }
  dropList() { return this.isGuest ? [...this.dropViews.values()] : this.g.drops.list; }

  // when I am down, the camera follows a teammate who is still flying
  spectateTarget() {
    if (this.versus) return this.vs.watch && this.vs.watch.alive ? this.vs.watch : null;
    for (const r of this.remotes.values()) if (r.alive) return r;
    return null;
  }
}
