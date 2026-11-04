// js/lobby.js: the multiplayer window in the hangar.
//   Quick match   join the versus queue; the server pairs you with someone and makes the room; it starts by itself
//   Create        a team or versus room (listed publicly unless unticked); friends join with the 4-letter code
//   Open rooms    public rooms waiting for players, one tap to join
// Everyone flies the plane that is in their own hangar; the host's map is used.

import { validate, computeStats, outsideArea } from './parts.js';
import { Leaderboard } from './leaderboard.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LETTERS = /[^ABCDEFGHJKMNPQRSTUVWXYZ]/g;          // same letters the server uses for codes

export const cleanCode = s => String(s || '').toUpperCase().replace(LETTERS, '').slice(0, 4);

// server and connection errors in words a player understands
export function coopError(e) {
  const m = String((e && e.message) || e || '');
  if (m === 'no such room') return 'No room with that code. Check the letters, or the room has closed.';
  if (m === 'room is full') return 'That room is full (4 players).';
  if (m === 'not found') return 'The multiplayer server is not set up yet.';
  if (m === 'server error') return 'The multiplayer server had a problem. Try again in a minute.';
  if (m.includes('could not connect')) return 'Could not reach the host. The game may have started already, or this network blocks direct connections (some school and phone networks do).';
  if (m.includes('fetch') || m === 'offline' || m.includes('NetworkError')) return 'Offline: the multiplayer server could not be reached.';
  return m || 'Something went wrong.';
}

const SEARCH_EVERY = 2000, ROOMS_EVERY = 3000;
const CONNECT_WAIT = 25000;          // quick match host: give up on an opponent who never connects
const fmtWait = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export class Lobby {
  // hangar: the Hangar; coop: the Coop; getMap(): the map the host picked
  constructor(hangar, coop, getMap) {
    this.hangar = hangar; this.coop = coop; this.getMap = getMap;
    this.$ = id => document.getElementById(id);
    this.busy = false;
    this.searching = null;          // quick match in progress: { since }
    this.rooms = [];
    coop.onLobby = () => { this.render(); this.quickStart(); };
    this.$('coopQuick').onclick = () => this.quick();
    this.$('coopRooms').onclick = e => {
      const code = e.target && e.target.dataset && e.target.dataset.code;
      if (code) { this.$('coopCode').value = code; this.join(); }
    };
    this.$('hgCoop').onclick = () => this.open();
    this.$('coopCreate').onclick = () => this.create('team');
    this.$('coopCreateVs').onclick = () => this.create('versus');
    this.$('coopJoin').onclick = () => this.join();
    this.$('coopCode').oninput = () => { const el = this.$('coopCode'); el.value = cleanCode(el.value); };
    this.$('coopClose').onclick = () => this.leaveOrClose();
    this.$('coopStart').onclick = () => this.start();
  }

  me() {
    const lb = Leaderboard.me();
    const bp = this.hangar.bp;
    const st = computeStats(bp.parts);
    return {
      name: lb ? lb.callsign : 'Pilot', parts: bp.parts.map(p => [p.type, p.x, p.y, p.z]), plane: bp.name || 'Custom',
      lbId: lb ? lb.id : null,
      rankOk: st.load <= st.budget && outsideArea(bp.parts) === 0,       // Creative planes can play versus, unrated
    };
  }
  // a pilot number and callsign (needed for versus ratings; also the name the others see)
  async identity() {
    if (Leaderboard.enabled() && !Leaderboard.me()) { this.status('Getting your pilot number...'); await Leaderboard.ensureId(); }
  }
  planeOk() {
    const v = validate(this.hangar.bp.parts, undefined, { creative: this.hangar.creative });
    if (!v.ok) { this.status(`Fix your plane first: ${v.errors[0]}`); return false; }
    return true;
  }

  get isOpen() { return this.$('hgCoopBox').style.display === 'block'; }
  open() {
    this.$('hgCoopBox').style.display = 'block';
    if (!this.coop.net.available) this.status('Multiplayer needs a browser with WebRTC and the online server.');
    else if (!this.coop.role && !this.searching) this.status('Everyone flies the plane in their own hangar. Co-op runs are not ranked; versus matches are rated.');
    this.render();
    this.refreshRooms();
  }
  close() {
    if (this.searching) this.cancelSearch();
    this.$('hgCoopBox').style.display = 'none';
  }

  /* ---------- open rooms ---------- */
  // while the menu is on screen, keep the list of public rooms (and the number of players searching) fresh
  async refreshRooms() {
    clearTimeout(this.roomsTimer);
    if (!this.isOpen || this.coop.role || this.searching) return;
    const r = await Leaderboard.rooms();
    if (!r.error) {
      this.rooms = r.rooms || [];
      const rooms = this.rooms.length;
      this.$('coopOnline').textContent = `${r.searching} pilot${r.searching === 1 ? '' : 's'} looking for a quick match · ${rooms} open room${rooms === 1 ? '' : 's'}`;
      this.$('coopRooms').innerHTML = rooms ? this.rooms.map(x =>
        `<div class="coopRm"><b>${x.mode === 'versus' ? 'Versus' : 'Team'}</b>${x.rated ? '<i>rated</i>' : ''}<span>${esc(x.host)} · ${x.players}/4</span>` +
        `<button class="hgBtn" data-code="${esc(x.code)}">Join</button></div>`).join('')
        : '<div class="coopNone">No open rooms right now. Create one, or try Quick match.</div>';
    } else {
      this.$('coopOnline').textContent = '';
      this.$('coopRooms').innerHTML = '<div class="coopNone">Room list unavailable (offline, or the server is not updated yet).</div>';
    }
    this.roomsTimer = setTimeout(() => this.refreshRooms(), ROOMS_EVERY);
  }

  /* ---------- quick match ---------- */
  async quick() {
    if (this.busy || this.searching || !this.planeOk()) return;
    if (!this.me().rankOk) { this.status('Quick match is rated: fly a normal plane (Creative planes over the limits can play in a room instead).'); return; }
    await this.identity();
    if (!Leaderboard.me()) { this.status('Quick match needs the online server (offline right now).'); return; }
    this.searching = { since: Date.now() };
    this.render();
    this.poll();
  }
  async poll() {
    const s = this.searching;
    if (!s) return;
    if (!this.isOpen) { this.cancelSearch(); return; }     // the window was closed (Esc): stop searching
    const r = await Leaderboard.mmFind();
    if (this.searching !== s) return;                 // cancelled meanwhile
    if (r.error) { this.searching = null; this.status(`Quick match: ${coopError(r.error)}`); this.render(); return; }
    if (r.status === 'matched') { this.searching = null; this.connect(r); return; }
    this.$('coopSearchText').innerHTML = `Looking for an opponent... <b>${fmtWait(Date.now() - s.since)}</b><br>` +
      `<span style="color:var(--dim);font-size:12.5px">${r.searching} searching now. Close ratings first; after 30 s anyone.</span>`;
    s.timer = setTimeout(() => this.poll(), SEARCH_EVERY);
  }
  cancelSearch() {
    if (!this.searching) return;
    clearTimeout(this.searching.timer);
    this.searching = null;
    Leaderboard.mmCancel();
    this.render();
    this.refreshRooms();
  }
  // paired: the server made a room for us two; one hosts, the other joins, the match starts by itself
  async connect(r) {
    const opp = `${r.opponent.callsign} (${r.opponent.elo})`;
    this.busy = true; this.render();
    this.status(`Found ${opp}. Connecting...`);
    const assigned = { code: r.code, peer: r.peer, key: r.key };
    const retry = why => {
      this.coop.end();
      this.busy = false;
      this.status(`${why} Searching again...`);
      this.quick();
    };
    try {
      if (r.peer === 'h') {
        await this.coop.hostRoom(this.me(), 'versus', { assigned, quick: true });
        this.busy = false; this.render();
        this.status(`Found ${opp}. Waiting for them to connect...`);
        const code = r.code;
        setTimeout(() => {
          if (this.coop.isHost && this.coop.net.code === code && !this.coop.started && this.coop.lobby.size === 0) retry(`Could not connect to ${opp}.`);
        }, CONNECT_WAIT);
      } else {
        await this.coop.joinRoom(r.code, this.me(), assigned);
        this.busy = false; this.render();
        this.status(`Connected to ${opp}. Starting...`);
      }
    } catch (e) {
      retry(`Could not connect to ${opp} (${coopError(e)})`);
    }
  }
  // quick match host: go as soon as the opponent is in
  quickStart() {
    const c = this.coop;
    if (c.quick && c.isHost && !c.started && c.lobby.size >= 1 && !this.quickStarting) {
      this.quickStarting = true;
      setTimeout(() => { this.quickStarting = false; if (c.quick && c.isHost && !c.started && c.lobby.size >= 1) this.start(); }, 600);
    }
  }
  status(text) { this.$('coopStatus').textContent = text; }

  async create(mode = 'team') {
    if (this.busy || !this.planeOk()) return;
    this.busy = true;
    await this.identity();
    this.status('Creating a room...');
    try {
      const isPublic = this.$('coopPublic').checked;
      const code = await this.coop.hostRoom(this.me(), mode, { isPublic });
      this.status(`${isPublic ? 'Listed in Open rooms. ' : ''}Friends can also join with the code ${code}. Keep this tab in front while you play: the game runs on your computer.`);
    } catch (e) { this.coop.end(); this.status(`Could not create a room. ${coopError(e)}`); }
    this.busy = false;
    this.render();
  }

  async join() {
    const code = cleanCode(this.$('coopCode').value);
    if (code.length !== 4) { this.status('Room codes are 4 letters.'); return; }
    if (this.busy || !this.planeOk()) return;
    this.busy = true;
    await this.identity();
    this.status(`Joining ${code}...`);
    try {
      await this.coop.joinRoom(code, this.me());
      this.status('Connected. Waiting for the host to start.');
    } catch (e) { this.coop.end(); this.status(`Could not join. ${coopError(e)}`); }
    this.busy = false;
    this.render();
  }

  start() {
    const c = this.coop;
    if (!c.isHost || c.lobby.size < 1) return;
    c.me = this.me();                               // the plane in the hangar right now
    c.start(this.getMap());
  }

  leaveOrClose() {
    if (this.searching) { this.cancelSearch(); this.status('Search cancelled.'); return; }
    if (this.coop.role) { this.coop.end(); this.status('You left the room.'); this.render(); this.refreshRooms(); }
    else this.close();
  }

  render() {
    const c = this.coop, inRoom = !!c.role && !this.busy && !!c.net.code;
    this.$('coopMenu').style.display = inRoom || this.busy || this.searching ? 'none' : '';
    this.$('coopSearch').style.display = this.searching ? '' : 'none';
    this.$('coopRoom').style.display = inRoom ? '' : 'none';
    this.$('coopClose').textContent = this.searching ? 'Cancel' : c.role ? 'Leave room' : 'Close';
    const startBtn = this.$('coopStart');
    startBtn.style.display = inRoom && c.isHost ? '' : 'none';
    startBtn.disabled = !(c.isHost && c.lobby.size >= 1);
    startBtn.textContent = c.isHost && c.lobby.size >= 1 ? `Start (${1 + c.lobby.size} players) ▶` : 'Waiting for players...';
    if (!inRoom) return;
    this.$('coopCodeShow').textContent = c.net.code;
    const rank = c.isHost ? (c.versus ? c.rankInfo() : null) : c.rankFromHost;
    this.$('coopMode').textContent = !c.versus ? 'Mode: Team (co-op against the waves)'
      : 'Mode: Versus, every pilot for themselves · ' + (rank && rank.ranked ? 'rated (Elo)' : `not rated${rank && rank.why ? ': ' + rank.why : ''}`);
    const list = c.isHost ? c.lobbyForGuests() : (c.lobbyFromHost || [{ peer: 'h', name: 'Host' }]);
    const mine = c.isHost ? 'h' : c.net.me && c.net.me.peer;
    this.$('coopList').innerHTML = list.map((p, i) =>
      `<div class="coopP${p.peer === mine ? ' me' : ''}">${i + 1}. ${esc(p.name)}${p.peer === 'h' ? ' <span>host</span>' : ''}${p.peer === mine ? ' <span>you</span>' : ''}</div>`).join('');
  }
}
