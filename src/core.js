'use strict';
/* =====================================================================
   Picture Buzzer: real-time picture-trivia buzzer (host / player / stream)
   The HOST browser is the authoritative game state. Players and the stream
   view connect to it peer-to-peer over WebRTC via PeerJS (free public broker).
   ===================================================================== */
const APP_VERSION = '1.0.0';
const PEERJS_URLS = [
  'https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js',
];
const JSZIP_URLS = [
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
];
const PEER_PREFIX = 'picbuzz-';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = ['#ff5d73', '#4da3ff', '#2ee59d', '#ffb627', '#b085f5', '#ff8a3d', '#3dd6d0', '#f06fd0', '#c6e94f', '#8fa3ff'];
const CHUNK = 15000; // chars per image chunk (PeerJS JSON channel max message = 16300 bytes)
const MAX_MSG = 15500; // any larger message gets split into parts

/* ---------- tiny helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
function randStr(n, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, b => alphabet[b % alphabet.length]).join('');
}
const uid = (n = 10) => randStr(n);
const newRoomCode = () => randStr(6, ROOM_ALPHABET);
const normRoom = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const peerIdFor = room => PEER_PREFIX + normRoom(room).toLowerCase();
const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const params = (() => {
  const q = new URLSearchParams(location.search);
  const hq = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { get: k => q.get(k) ?? hq.get(k) };
})();
function baseUrl() { return location.href.split('#')[0].split('?')[0]; }
function toast(msg, ms = 2600) {
  let t = $('#toast');
  if (!t) { t = h('div', { id: 'toast', class: 'toast hidden' }); document.body.append(t); }
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); return true; }
  catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }); ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    ta.remove(); toast(ok ? 'Copied to clipboard' : 'Copy failed; select the text and copy it manually'); return ok;
  }
}
function loadScript(urls) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (i >= urls.length) return reject(new Error('Could not load ' + urls[0]));
      const s = document.createElement('script'); s.src = urls[i++]; s.async = true;
      s.onload = () => resolve(); s.onerror = () => { s.remove(); next(); };
      document.head.append(s);
    };
    next();
  });
}
async function ensurePeerJS() { if (!window.Peer) await loadScript(PEERJS_URLS); return window.Peer; }
// Public STUN servers (free, no account). NOTE: PeerJS's bundled default TURN hosts
// (eu-0/us-0.turn.peerjs.com) no longer resolve in DNS, and no free account-less TURN service
// exists today, so TURN is opt-in: the host can enter one in Game setup and it rides along
// in the share links (?turn=&turnuser=&turnpass=).
const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
function peerOptions(turn) {
  const opts = { debug: Number(params.get('debug') || 1) };
  const cfg = { iceServers: [...STUN_SERVERS], sdpSemantics: 'unified-plan' };
  const t = turn && turn.url ? turn : (params.get('turn') ? { url: params.get('turn'), user: params.get('turnuser') || '', pass: params.get('turnpass') || '' } : null);
  if (t) cfg.iceServers.push({ urls: t.url.split(/[\s,]+/).filter(Boolean), username: t.user || '', credential: t.pass || '' });
  if (params.get('relay') === '1') cfg.iceTransportPolicy = 'relay'; // force TURN only (troubleshooting)
  opts.config = cfg;
  // Optional self-hosted PeerJS server: ?peerhost=example.com&peerport=443&peerpath=/myapp
  if (params.get('peerhost')) {
    opts.host = params.get('peerhost'); opts.port = Number(params.get('peerport') || 443);
    opts.path = params.get('peerpath') || '/'; opts.secure = params.get('peersecure') !== '0';
  }
  return opts;
}
/* ---------- sounds (WebAudio, no files) ---------- */
let _actx = null;
function sfx(kind) {
  try {
    _actx = _actx || new (window.AudioContext || window.webkitAudioContext)();
    if (_actx.state === 'suspended') _actx.resume();
    const t0 = _actx.currentTime;
    const tone = (f, at, dur, type = 'square', vol = 0.12) => {
      const o = _actx.createOscillator(), g = _actx.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t0 + at);
      g.gain.setValueAtTime(vol, t0 + at); g.gain.exponentialRampToValueAtTime(0.0008, t0 + at + dur);
      o.connect(g).connect(_actx.destination); o.start(t0 + at); o.stop(t0 + at + dur + 0.03);
    };
    if (kind === 'buzz') { tone(740, 0, 0.11); tone(1110, 0.11, 0.3); }
    else if (kind === 'correct') { tone(660, 0, 0.12, 'triangle', 0.25); tone(880, 0.12, 0.12, 'triangle', 0.25); tone(1320, 0.24, 0.35, 'triangle', 0.25); }
    else if (kind === 'wrong') { tone(170, 0, 0.5, 'sawtooth', 0.16); tone(120, 0.05, 0.5, 'square', 0.08); }
    else if (kind === 'reveal') { tone(520, 0, 0.1, 'sine', 0.2); tone(780, 0.1, 0.25, 'sine', 0.2); }
  } catch {}
}
/* ---------- IndexedDB (host persistence) ---------- */
const DB = {
  _p: null,
  open() {
    if (!this._p) this._p = new Promise((res, rej) => {
      const r = indexedDB.open('picture-buzzer', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('kv'); d.createObjectStore('images'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return this._p;
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store); let out;
      const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get(store, k) { return this.tx(store, 'readonly', s => s.get(k)); },
  put(store, k, v) { return this.tx(store, 'readwrite', s => s.put(v, k)); },
  del(store, k) { return this.tx(store, 'readwrite', s => s.delete(k)); },
  all(store) { return this.tx(store, 'readonly', s => s.getAll()); },
  clear(store) { return this.tx(store, 'readwrite', s => s.clear()); },
};
/* ---------- image processing (resize + JPEG compress in-browser) ---------- */
const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|svg|avif|jfif)$/i;
const isImageFile = f => (f.type && f.type.startsWith('image/')) || IMG_EXT.test(f.name || '');
function loadImg(src, cors) {
  return new Promise((res, rej) => {
    const im = new Image(); if (cors) im.crossOrigin = 'anonymous';
    im.onload = () => res(im); im.onerror = () => rej(new Error('Image failed to load: ' + String(src).slice(0, 80)));
    im.src = src;
  });
}
function drawCompress(im, maxPx, quality, isSvg) {
  let w = im.naturalWidth || im.width || 1000, hh = im.naturalHeight || im.height || 750;
  let sc = maxPx / Math.max(w, hh);
  if (!isSvg) sc = Math.min(1, sc);
  const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(hh * sc));
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch); // transparent logos -> white
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(im, 0, 0, cw, ch);
  return { data: c.toDataURL('image/jpeg', quality), w: cw, h: ch };
}
async function compressBlob(blob, maxPx, quality) {
  const url = URL.createObjectURL(blob);
  try { const im = await loadImg(url); return drawCompress(im, maxPx, quality, /svg/.test(blob.type) || /\.svg$/i.test(blob.name || '')); }
  finally { URL.revokeObjectURL(url); }
}
async function processSrc(src, maxPx, quality) {
  // src: data: URL or http(s) URL. Returns {data,w,h} or {url,w,h} (linked, not embedded)
  if (/^data:image\/jpeg/.test(src) && src.length < 900000) {
    const im = await loadImg(src);
    if (Math.max(im.naturalWidth, im.naturalHeight) <= maxPx) return { data: src, w: im.naturalWidth, h: im.naturalHeight };
    return drawCompress(im, maxPx, quality);
  }
  if (/^data:/.test(src)) { const im = await loadImg(src); return drawCompress(im, maxPx, quality, /svg/.test(src.slice(0, 30))); }
  try {
    const r = await fetch(src, { mode: 'cors' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const b = await r.blob(); if (!/^image\//.test(b.type)) throw new Error('not an image');
    return await compressBlob(b, maxPx, quality);
  } catch {}
  try { const im = await loadImg(src, true); return drawCompress(im, maxPx, quality); } catch {}
  const im = await loadImg(src); // no CORS: can only link it; clients load the URL directly
  return { url: src, w: im.naturalWidth, h: im.naturalHeight };
}
/* ---------- file helpers ---------- */
async function filesFromDataTransfer(dt) {
  const items = Array.from(dt.items || []);
  const entries = items.map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return Array.from(dt.files || []);
  const out = [];
  async function walk(entry, path) {
    if (entry.isFile) {
      const f = await new Promise((res, rej) => entry.file(res, rej));
      try { Object.defineProperty(f, 'relPath', { value: path + f.name }); } catch {}
      out.push(f);
    } else if (entry.isDirectory) {
      const rd = entry.createReader(); let batch;
      do { batch = await new Promise((res, rej) => rd.readEntries(res, rej)); for (const e of batch) await walk(e, path + entry.name + '/'); } while (batch.length);
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}
async function unzipToFiles(file) {
  if (!window.JSZip) await loadScript(JSZIP_URLS);
  const zip = await window.JSZip.loadAsync(file);
  const out = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || /(^|\/)(__MACOSX|\.)/.test(path)) continue;
    const name = path.split('/').pop();
    const ext = (name.split('.').pop() || '').toLowerCase();
    const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', json: 'application/json' }[ext] || 'text/plain';
    const f = new File([await entry.async('blob')], name, { type });
    try { Object.defineProperty(f, 'relPath', { value: path }); } catch {}
    out.push(f);
  }
  return out;
}
/* Group image files into rounds by the first number in the filename.
   NN_question.jpg / NN_answer.jpg; two question images (NN_a.jpg + NN_b.jpg, NN_question_1/2...) = side-by-side. */
const ANSWER_RE = /(^|[^a-z])(answer|answers|ans|reveal|solution|sol|key)([^a-z]|$)/i;
function groupImageFiles(files) {
  const groups = new Map(); const loose = [];
  for (const f of files) {
    const base = f.name.replace(/\.[^.]+$/, '');
    const m = base.match(/(\d{1,4})/);
    const role = ANSWER_RE.test(base) ? 'a' : 'q';
    if (!m) { loose.push({ file: f, role }); continue; }
    const n = parseInt(m[1], 10);
    if (!groups.has(n)) groups.set(n, { num: n, q: [], a: [] });
    groups.get(n)[role].push(f);
  }
  const out = [];
  for (const g of [...groups.values()].sort((a, b) => a.num - b.num)) {
    g.q.sort((a, b) => natCmp(a.name, b.name)); g.a.sort((a, b) => natCmp(a.name, b.name));
    if (!g.q.length && g.a.length) { g.q.push(g.a.shift()); }
    out.push({ num: g.num, q: g.q.slice(0, 2), a: g.a[0] || null, extra: g.q.slice(2).concat(g.a.slice(1)) });
  }
  loose.sort((a, b) => natCmp(a.file.name, b.file.name));
  for (const l of loose) out.push({ num: null, q: [l.file], a: null, extra: [] });
  return out;
}
/* ---------- answer-sheet parsing (answers.md / .txt / .json) ---------- */
function stripMd(s) {
  return String(s || '')
    .replace(/\\([*_`|#])/g, (m, c) => '\u0000' + c.charCodeAt(0) + '\u0001') // protect escaped chars
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\*\*|__/g, '').replace(/(^|[\s("“])[*_]([^*_]+)[*_](?=[\s).,:;!?"”]|$)/g, '$1$2')
    .replace(/`/g, '').replace(/\u0000(\d+)\u0001/g, (m, c) => String.fromCharCode(+c)).trim();
}
function dropSources(s) { return s.replace(/;\s*source:\s*[^\s)]+\)/gi, ')').replace(/\(?\s*source:\s*[^\s)]+\)?(\s*\([^)]*\))?\.?/gi, '').replace(/\s{2,}/g, ' ').trim(); }
function parseAnswersText(txt) {
  const out = {}; let cur = null;
  const add = (n, k, v) => { v = dropSources(stripMd(v)); if (!v) return; out[n] = out[n] || {}; out[n][k] = out[n][k] ? out[n][k] + '\n' + v : v; };
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^#/.test(line) || /^[-*_=]{3,}$/.test(line)) { cur = null; continue; }
    if (line.startsWith('|')) {
      const cells = line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim());
      const n = stripMd(cells[0]).match(/^(\d{1,3})$/);
      if (n) {
        const num = +n[1];
        if (cells.length === 2) add(num, 'note', cells[1]);
        else {
          const qm = stripMd(cells[1]).match(/^["“](.+?)["”]\s*(?:\((.+)\))?$/); // "Prompt?" (description)
          if (qm) { add(num, 'prompt', qm[1]); if (qm[2]) add(num, 'title', qm[2].charAt(0).toUpperCase() + qm[2].slice(1)); }
          else add(num, 'prompt', cells[1]);
          add(num, 'note', cells.slice(2).filter(Boolean).join(' — '));
        }
      }
      cur = null; continue;
    }
    const m = line.match(/^(\*\*|__)?\s*(?:round|question|q|#)?\s*(\d{1,3})\s*[:.)\-–]\s*(.*)$/i);
    if (m) {
      const num = +m[2]; let rest = m[3];
      if (m[1]) { // **06: Title** (10 items). More text...
        const end = rest.indexOf(m[1]);
        let title = end >= 0 ? rest.slice(0, end) : rest; let after = end >= 0 ? rest.slice(end + 2) : '';
        const pm = after.match(/^\s*(\([^)]*\))\s*\.?\s*(.*)$/);
        if (pm) { title += ' ' + pm[1]; after = pm[2]; }
        add(num, 'title', title); if (after) add(num, 'note', after);
      } else add(num, 'note', rest);
      cur = num; continue;
    }
    if (cur != null) { if (/^source:/i.test(line)) continue; add(cur, 'note', line); }
  }
  return out;
}
function parseAnswersJson(obj) {
  const out = {};
  const norm = v => (typeof v === 'string' ? { note: v } : (v && typeof v === 'object' ? { title: v.title, prompt: v.prompt, note: v.note ?? v.answer, points: v.points } : null));
  if (Array.isArray(obj)) obj.forEach((v, i) => { const r = norm(v); if (r) out[(v && v.round) || i + 1] = r; });
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) { const n = parseInt(k, 10); const r = norm(v); if (!isNaN(n) && r) out[n] = r; }
  return out;
}
const isGameJson = o => o && typeof o === 'object' && Array.isArray(o.rounds) && (o.format === 'picture-buzzer-game' || o.rounds.some(r => r && (r.question || r.q)));

/* ---------- networking: client side (player + stream) ---------- */
class ClientNet {
  constructor(room, role, handlers) {
    this.room = normRoom(room); this.role = role; this.on = handlers;
    this.peer = null; this.conn = null; this.lastRx = 0; this.retryAt = 0; this.connStart = 0; this.peerStart = 0;
    const key = 'picbuzz-client-' + this.room;
    this.clientId = localStorage.getItem(key) || uid(12);
    try { localStorage.setItem(key, this.clientId); } catch {}
  }
  status(s, detail) { this._st = s; this.on.status && this.on.status(s, detail); }
  async start() {
    this.status('loading');
    try { await ensurePeerJS(); } catch (e) { this.status('error', 'Could not load PeerJS from the CDN. Check your internet connection.'); return; }
    this.makePeer();
    setInterval(() => this.tick(), 2000);
    addEventListener('online', () => this.tick());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.tick(); });
    addEventListener('pagehide', () => { try { this.conn && this.conn.close(); this.peer && this.peer.destroy(); } catch {} });
  }
  makePeer() {
    try { this.peer && this.peer.destroy(); } catch {}
    this.conn = null; this.peerStart = Date.now();
    const p = this.peer = new Peer(peerOptions());
    this.status('connecting');
    p.on('open', () => { if (p === this.peer) this.connect(); });
    p.on('disconnected', () => {
      if (p !== this.peer || p.destroyed) return;
      setTimeout(() => { if (p === this.peer && !p.destroyed && p.disconnected) { try { p.reconnect(); } catch { this.makePeer(); } } }, 1500);
    });
    p.on('error', err => {
      if (p !== this.peer) return;
      if (err.type === 'peer-unavailable') { this.dropConn(); this.retryAt = Date.now() + 2500; this.status('nohost'); }
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) { this.status('broker'); }
      else if (err.type === 'browser-incompatible') this.status('error', 'This browser does not support WebRTC.');
      else console.warn('peer error', err.type, err);
    });
  }
  connect() {
    if (!this.peer || this.peer.destroyed || this.peer.disconnected) return;
    this.dropConn();
    const c = this.conn = this.peer.connect(peerIdFor(this.room), { reliable: true, serialization: 'json', metadata: { role: this.role } });
    this.connStart = Date.now();
    if (this._st !== 'nohost') this.status('connecting');
    c.on('open', () => {
      if (c !== this.conn) return;
      this.lastRx = Date.now();
      this.send({ t: 'hi', role: this.role, clientId: this.clientId, v: APP_VERSION });
      this.status('connected');
      this.on.open && this.on.open();
    });
    const parts = {};
    c.on('data', d => {
      if (c !== this.conn) return; this.lastRx = Date.now();
      if (d && d.t === 'part') { // reassemble an oversized message
        const p = parts[d.id] = parts[d.id] || []; p[d.i] = d.d;
        if (p.filter(x => x != null).length === d.n) { delete parts[d.id]; try { d = JSON.parse(p.join('')); } catch { return; } } else return;
      }
      if (d && d.t !== 'pong') this.on.msg(d);
    });
    const lost = () => { if (c !== this.conn) return; this.conn = null; this.retryAt = Date.now() + 800; this.status('reconnecting'); this.on.lost && this.on.lost(); };
    c.on('close', lost);
    c.on('error', e => { console.warn('connection error', e && e.type); if (!c.open) lost(); });
  }
  dropConn() { const c = this.conn; this.conn = null; if (c) { try { c.close(); } catch {} } }
  send(m) { if (this.conn && this.conn.open) { try { sendSplit(this.conn, m); return true; } catch {} } return false; }
  tick() {
    const now = Date.now(), p = this.peer;
    if (!p || p.destroyed) { this.makePeer(); return; }
    if (p.disconnected || !p.open) { if (now - this.peerStart > 20000) this.makePeer(); return; }
    this.peerStart = now;
    if (!this.conn) { if (now >= this.retryAt) this.connect(); return; }
    if (!this.conn.open) { if (now - this.connStart > 10000) { this.dropConn(); this.retryAt = now; this.status(this._st === 'nohost' ? 'nohost' : 'reconnecting'); } return; }
    this.send({ t: 'ping' });
    if (now - this.lastRx > 15000) { this.dropConn(); this.retryAt = now; this.status('reconnecting'); this.on.lost && this.on.lost(); }
  }
}
/* send any message, splitting it if it exceeds the PeerJS JSON channel limit */
function sendSplit(conn, msg) {
  const str = JSON.stringify(msg);
  if (str.length <= MAX_MSG && new Blob([str]).size <= MAX_MSG) { conn.send(msg); return; }
  const id = uid(6), step = 4000; // 4000 chars <= 16KB even if every char is 4-byte UTF-8
  const n = Math.ceil(str.length / step);
  for (let i = 0; i < n; i++) conn.send({ t: 'part', id, i, n, d: str.slice(i * step, (i + 1) * step) });
}
/* image cache + chunk reassembly shared by player & stream */
class ImageCache {
  constructor(net, onReady) { this.net = net; this.onReady = onReady; this.ready = new Map(); this.pending = new Map(); }
  has(id) { return this.ready.has(id); }
  src(id) { return this.ready.get(id); }
  want(ids) {
    for (const id of ids) {
      if (!id || this.ready.has(id)) continue;
      const p = this.pending.get(id);
      if (p && Date.now() - p.at < 15000) continue;
      this.pending.set(id, { at: Date.now(), parts: [], got: 0, n: 0 });
      this.net.send({ t: 'getImg', id });
    }
  }
  reset() { this.pending.clear(); }
  handle(m) {
    if (m.t === 'imgUrl') { this.ready.set(m.id, m.url); this.pending.delete(m.id); this.onReady(m.id); return true; }
    if (m.t === 'imgChunk') {
      let p = this.pending.get(m.id); if (!p) { p = { at: Date.now(), parts: [], got: 0, n: 0 }; this.pending.set(m.id, p); }
      p.at = Date.now();
      if (p.parts[m.i] == null) { p.parts[m.i] = m.d; p.got++; } p.n = m.n;
      if (p.got === p.n) { this.ready.set(m.id, p.parts.join('')); this.pending.delete(m.id); this.onReady(m.id); }
      return true;
    }
    if (m.t === 'imgDenied') { this.pending.delete(m.id); return true; }
    return false;
  }
}
function renderImgPair(container, ids, srcOf, opts = {}) {
  // ids: array of image ids (1 or 2). Re-renders only when something changed.
  const key = ids.join('|') + '#' + ids.map(id => (srcOf(id) ? 1 : 0)).join('') + (opts.labels ? 'L' : '');
  if (container._key === key) return; container._key = key;
  container.innerHTML = '';
  const pair = h('div', { class: 'imgpair' });
  if (!ids.length) pair.append(h('div', { class: 'loading' }, opts.empty || ''));
  ids.forEach((id, i) => {
    const src = srcOf(id);
    const box = h('div', { class: 'imgbox' });
    if (src) box.append(h('img', { src, alt: 'round image', draggable: 'false' }));
    else box.append(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Loading image…'));
    if (ids.length > 1 && opts.labels !== false) box.append(h('div', { class: 'tag' }, String.fromCharCode(65 + i)));
    pair.append(box);
  });
  container.append(pair);
}
const STATUS_TEXT = {
  loading: 'Loading…', connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…',
  nohost: 'Host not found yet. Is the host page open? Retrying…', broker: 'Can’t reach the PeerJS broker. Retrying…', error: 'Error',
};
