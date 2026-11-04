// js/net.js: direct browser-to-browser connections for co-op (WebRTC data channels).
// The leaderboard Worker acts only as a mailbox to swap connection offers (see /room/* in leaderboard/worker.js).
// Star layout: every guest connects to the host; the host relays whatever guests need to know about each other.
//
//   host:  const code = await net.host()        guests join with that code; net.onPeer(peer, 'open') fires for each
//   guest: await net.join(code)                 resolves once connected to the host
//   both:  net.send(peer, msg, reliable) / net.broadcast(msg, reliable) / net.onMessage = (from, msg) => ...
//
// Two channels per connection: 'fast' (unordered, no resends) for the 15-20 per second state updates, where a lost
// packet is simply replaced by the next one, and 'safe' (ordered, reliable) for events that must arrive.

import { CFG } from './config.js';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const POLL_MS = 900;

// wait until the browser has found its network addresses, so one offer/answer carries everything
function gathered(pc, timeoutMs = 3500) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') done(); });
  });
}

export class Net {
  constructor({ base = null, RTC = null, fetchFn = null } = {}) {
    this.base = () => (base || CFG.leaderboard.url || '').replace(/\/+$/, '');
    this.RTC = RTC || (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null);
    this.fetch = fetchFn || ((...a) => globalThis.fetch(...a));
    this.me = null;              // { code, peer, key }
    this.links = new Map();      // peer -> { pc, fast, safe, open }
    this.onMessage = null;
    this.onPeer = null;          // (peer, 'open' | 'closed')
    this.polling = false;
  }

  get isHost() { return !!this.me && this.me.peer === 'h'; }
  get code() { return this.me ? this.me.code : null; }
  get available() { return !!this.RTC && !!this.base(); }
  openPeers() { return [...this.links.entries()].filter(([, l]) => l.open).map(([p]) => p); }

  async call(path, body) {
    const r = await this.fetch(this.base() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  // ---- host: create a room and keep answering guests' offers ----
  // assigned = a room the server already made for me (quick match): { code, peer: 'h', key }
  async host(assigned = null) {
    this.me = assigned || await this.call('/room/create', {});
    this.startPolling();
    return this.me.code;
  }

  // ---- guest: join a room, send an offer to the host, wait for the answer and the channels to open ----
  async join(code, timeoutMs = 20000, assigned = null) {
    this.me = assigned || await this.call('/room/join', { code });
    const link = this.makeLink('h');
    link.fast = this.wire('h', link.pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
    link.safe = this.wire('h', link.pc.createDataChannel('safe', { ordered: true }));
    await link.pc.setLocalDescription(await link.pc.createOffer());
    await gathered(link.pc);
    await this.call('/room/send', { ...this.auth(), to: 'h', data: JSON.stringify(link.pc.localDescription) });
    this.startPolling();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('could not connect to the host')), timeoutMs);
      link.onOpen = () => { clearTimeout(t); resolve(); };
    });
    this.polling = false;        // connected: no more mailbox checks
    return this.me.peer;
  }

  auth() { return { code: this.me.code, peer: this.me.peer, key: this.me.key }; }

  makeLink(peer) {
    const pc = new this.RTC({ iceServers: ICE_SERVERS });
    const link = { pc, fast: null, safe: null, open: false };
    this.links.set(peer, link);
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.drop(peer);
    });
    pc.addEventListener('datachannel', e => {
      if (e.channel.label === 'fast') link.fast = this.wire(peer, e.channel);
      else link.safe = this.wire(peer, e.channel);
    });
    return link;
  }

  // a link is usable once both of its channels are open
  checkOpen(peer) {
    const link = this.links.get(peer);
    if (!link || link.open || !link.fast || !link.safe) return;
    if (link.fast.readyState !== 'open' || link.safe.readyState !== 'open') return;
    link.open = true;
    if (link.onOpen) link.onOpen();
    if (this.onPeer) this.onPeer(peer, 'open');
  }

  wire(peer, ch) {
    ch.addEventListener('open', () => this.checkOpen(peer));
    // on the answering side a channel can already be open when it is handed over
    if (ch.readyState === 'open') setTimeout(() => this.checkOpen(peer), 0);
    ch.addEventListener('message', e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (this.onMessage) this.onMessage(peer, msg);
    });
    ch.addEventListener('close', () => this.drop(peer));
    return ch;
  }

  drop(peer) {
    const link = this.links.get(peer);
    if (!link) return;
    this.links.delete(peer);
    try { link.pc.close(); } catch {}
    if (link.open && this.onPeer) this.onPeer(peer, 'closed');
  }

  startPolling() {
    if (this.polling) return;
    this.polling = true;
    const tick = async () => {
      if (!this.polling || !this.me) return;
      try {
        const { messages } = await this.call('/room/recv', this.auth());
        for (const m of messages) await this.onSignal(m.from, JSON.parse(m.data));
      } catch {}
      if (this.polling) setTimeout(tick, POLL_MS);
    };
    tick();
  }
  stopPolling() { this.polling = false; }

  async onSignal(from, desc) {
    if (desc.type === 'offer' && this.isHost) {
      const link = this.makeLink(from);
      await link.pc.setRemoteDescription(desc);
      await link.pc.setLocalDescription(await link.pc.createAnswer());
      await gathered(link.pc);
      await this.call('/room/send', { ...this.auth(), to: from, data: JSON.stringify(link.pc.localDescription) });
    } else if (desc.type === 'answer') {
      const link = this.links.get(from);
      if (link && !link.pc.remoteDescription) await link.pc.setRemoteDescription(desc);
    }
  }

  send(peer, msg, reliable = false) {
    const link = this.links.get(peer);
    if (!link || !link.open) return false;
    const ch = reliable ? link.safe : link.fast;
    if (ch.readyState !== 'open') return false;
    ch.send(JSON.stringify(msg));
    return true;
  }
  broadcast(msg, reliable = false, except = null) {
    for (const p of this.openPeers()) if (p !== except) this.send(p, msg, reliable);
  }

  close() {
    this.polling = false;
    for (const p of [...this.links.keys()]) this.drop(p);
    this.me = null;
  }
}
