/* =========================== HOST =========================== */
const H = { game: null, session: null, images: new Map(), conns: new Set(), net: null, tab: 'play', dbFail: false };
const defaultSettings = () => ({ autoOpen: true, autoRevealOnCorrect: false, allowSelfJoin: true, sound: true, maxPx: 1600, quality: 0.85, streamBg: 'dark', streamSound: true, autoBlank: false, turn: { url: '', user: '', pass: '' } });
const defaultGame = () => ({ title: 'Picture Trivia', defaultPoints: 1, wrongPenalty: 0, rounds: [] });
const defaultSession = () => ({ room: newRoomCode(), hostName: 'Host', players: [], roundIndex: 0, buzzOpen: false, winner: null, winnerAt: 0, queue: [], lockedOut: [], revealed: false, last: null, buzzSeq: 0, bindings: {}, ver: 0, blank: false, blankText: 'Get ready for the next picture!', settings: defaultSettings() });
const newRound = () => ({ id: 'r' + uid(8), title: '', prompt: '', note: '', points: null, test: false, q: [], a: null });
const curRound = () => H.game.rounds[H.session.roundIndex] || null;
const roundPoints = r => (r && r.points != null && r.points !== '' && isFinite(r.points)) ? Number(r.points) : (Number(H.game.defaultPoints) || 1);
const playerById = id => H.session.players.find(p => p.id === id) || null;
const pname = id => (playerById(id) || { name: '?' }).name;
const imgSrc = id => { const r = id && H.images.get(id); return r ? (r.data || r.url) : null; };
const thumbSrc = id => { const r = id && H.images.get(id); return r ? (r.thumb || r.data || r.url) : null; };
const isConnected = pid => [...H.conns].some(m => m.pid === pid && m.conn.open);

async function hostLoad() {
  let g = null, s = null;
  try { g = JSON.parse(localStorage.getItem('picbuzz-host-game') || 'null'); s = JSON.parse(localStorage.getItem('picbuzz-host-session') || 'null'); } catch {}
  H.game = Object.assign(defaultGame(), g || {});
  H.session = Object.assign(defaultSession(), s || {});
  H.session.settings = Object.assign(defaultSettings(), (s && s.settings) || {});
  H.session.winnerAt = 0;
  const pr = normRoom(params.get('room')); if (pr.length >= 4) H.session.room = pr;
  try { for (const r of await DB.all('images')) if (r && r.id) H.images.set(r.id, r); } catch (e) { H.dbFail = true; console.warn('IndexedDB unavailable', e); }
  H.session.roundIndex = clamp(H.session.roundIndex, 0, Math.max(0, H.game.rounds.length - 1));
  saveNow();
}
function saveNow() {
  try { localStorage.setItem('picbuzz-host-game', JSON.stringify(H.game)); localStorage.setItem('picbuzz-host-session', JSON.stringify(H.session)); }
  catch (e) { console.warn('save failed', e); }
}
async function makeThumb(src) {
  try { const im = await loadImg(src); return drawCompress(im, 260, 0.7).data; } catch { return null; }
}
async function storeImage(rec) {
  const id = 'i' + uid(10); rec.id = id;
  rec.thumb = await makeThumb(rec.data || rec.url);
  H.images.set(id, rec);
  try { await DB.put('images', id, rec); } catch (e) { H.dbFail = true; }
  return id;
}
function gcImages() {
  const used = new Set();
  for (const r of H.game.rounds) { r.q.forEach(i => used.add(i)); if (r.a) used.add(r.a); }
  for (const id of [...H.images.keys()]) if (!used.has(id)) { H.images.delete(id); DB.del('images', id).catch(() => {}); }
}
/* ---------- state broadcast ---------- */
function publicState(m) {
  const s = H.session, g = H.game, rr = curRound(), r = s.blank ? null : rr, rev = s.revealed, nx = g.rounds[s.roundIndex + 1];
  return {
    t: 'state', v: s.ver, room: s.room, hostName: s.hostName, title: g.title,
    roundIndex: s.roundIndex, roundCount: g.rounds.length,
    round: r ? { id: r.id, title: r.title || '', prompt: r.prompt || '', q: r.q.slice(), a: rev ? (r.a || null) : null, note: rev ? (r.note || '') : '', points: roundPoints(r), test: !!r.test } : null,
    blank: !!(s.blank && rr), blankText: s.blankText || '',
    revealed: rev, buzzOpen: s.buzzOpen, winner: s.winner, queue: s.queue, lockedOut: s.lockedOut, last: s.last, buzzSeq: s.buzzSeq,
    players: s.players.map(p => ({ id: p.id, name: p.name, score: p.score, color: p.color, connected: isConnected(p.id) })),
    allowSelfJoin: s.settings.allowSelfJoin,
    you: m && m.role === 'player' ? (m.pid || null) : null,
    prefetch: s.blank && rr ? rr.q.slice() : (nx ? nx.q.slice() : []),
  };
}
function hsend(m, msg) { try { if (m.conn.open) sendSplit(m.conn, msg); } catch (e) { console.warn('send failed', e); } }
function broadcastState() { for (const m of H.conns) if (m.role) hsend(m, publicState(m)); }
let _bcT = 0;
function broadcastSoon() { clearTimeout(_bcT); _bcT = setTimeout(broadcastState, 250); }
function commit(opts = {}) {
  H.session.ver++; saveNow(); broadcastState(); renderHostAll();
  if (opts.setup) renderSetup();
}
function allowedImages() {
  const s = H.session, r = curRound(), set = new Set();
  if (r) { r.q.forEach(i => set.add(i)); if (s.revealed && !s.blank && r.a) set.add(r.a); }
  const nx = H.game.rounds[s.roundIndex + 1]; if (nx) nx.q.forEach(i => set.add(i));
  return set;
}
function serveImage(m, id) {
  const rec = H.images.get(id);
  if (!rec || !allowedImages().has(id)) { hsend(m, { t: 'imgDenied', id }); return; }
  if (!rec.data && rec.url) { hsend(m, { t: 'imgUrl', id, url: rec.url }); return; }
  const d = rec.data, n = Math.ceil(d.length / CHUNK);
  for (let i = 0; i < n; i++) hsend(m, { t: 'imgChunk', id, i, n, d: d.slice(i * CHUNK, (i + 1) * CHUNK) });
}
/* ---------- networking (host) ---------- */
const NET_TEXT = { loading: 'Loading…', starting: 'Starting room…', online: 'Online', reconnecting: 'Reconnecting to broker…', taken: 'Room code busy, retrying…', broker: 'Broker unreachable, retrying…', error: 'Error' };
class HostNet {
  constructor(room) { this.room = room; this.peer = null; this.retryAt = 0; this.fails = 0; this.lastRe = 0; this.state = 'loading'; }
  setState(st, detail) { this.state = st; this.detail = detail || ''; renderTop(); }
  async start() {
    this.setState('loading');
    try { await ensurePeerJS(); } catch { this.setState('error', 'Could not load PeerJS from the CDN (no internet?)'); return; }
    this.make();
    setInterval(() => this.tick(), 3000);
    addEventListener('pagehide', () => { try { this.peer && this.peer.destroy(); } catch {} });
  }
  make() {
    if (this.peer) { this.peer._dying = true; try { this.peer.destroy(); } catch {} }
    const p = this.peer = new Peer(peerIdFor(this.room), peerOptions(H.session.settings.turn));
    if (this.state !== 'taken') this.setState('starting');
    p.on('open', () => { if (p !== this.peer) return; this.fails = 0; this.setState('online'); });
    p.on('connection', c => { if (p === this.peer) acceptConn(c); });
    p.on('disconnected', () => {
      if (p !== this.peer || p.destroyed || p._dying) return;
      this.setState('reconnecting');
      setTimeout(() => this.tryReconnect(p), 1500);
    });
    p.on('error', err => {
      if (p !== this.peer) return;
      if (err.type === 'unavailable-id') { this.fails++; p._dying = true; try { p.destroy(); } catch {} this.setState('taken'); this.retryAt = Date.now() + 2500; }
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) this.setState('broker');
      else if (err.type === 'invalid-id') this.setState('error', 'Invalid room code');
      else console.warn('host peer error', err.type, err);
    });
  }
  tryReconnect(p) {
    if (p !== this.peer || p.destroyed || !p.disconnected || Date.now() - this.lastRe < 4000) return;
    this.lastRe = Date.now(); try { p.reconnect(); } catch (e) { console.warn(e); }
  }
  tick() {
    const p = this.peer, now = Date.now();
    if ((!p || p.destroyed) && now >= this.retryAt) this.make();
    else if (p && p.disconnected && !p.destroyed) this.tryReconnect(p);
    for (const m of [...H.conns]) if (now - m.lastRx > 20000 || !m.conn.open) dropConn(m);
  }
  changeRoom(room) {
    this.room = room;
    for (const m of [...H.conns]) { try { m.conn.close(); } catch {} }
    H.conns.clear(); this.retryAt = 0; this.fails = 0; this.make();
  }
}
function acceptConn(c) {
  const m = { conn: c, role: null, clientId: null, pid: null, lastRx: Date.now() };
  c.on('open', () => { m.lastRx = Date.now(); H.conns.add(m); });
  c.on('data', d => { m.lastRx = Date.now(); try { onClientMsg(m, d); } catch (e) { console.error(e); } });
  c.on('close', () => dropConn(m)); c.on('error', e => { console.warn('client connection error', e && e.type); if (!c.open) dropConn(m); });
}
function dropConn(m) {
  if (!H.conns.has(m)) return;
  H.conns.delete(m); try { m.conn.close(); } catch {}
  renderHostAll(); broadcastState();
}
function onClientMsg(m, d) {
  if (!d || typeof d !== 'object') return;
  const s = H.session;
  if (!H.conns.has(m)) H.conns.add(m);
  switch (d.t) {
    case 'ping': hsend(m, { t: 'pong' }); return;
    case 'hi': {
      m.role = d.role === 'stream' ? 'stream' : 'player';
      m.clientId = String(d.clientId || '').slice(0, 40) || uid();
      if (m.role === 'player') { const pid = s.bindings[m.clientId]; m.pid = pid && playerById(pid) ? pid : null; }
      renderHostAll(); broadcastState(); return;
    }
    case 'join': {
      if (m.role !== 'player') return;
      let p = d.pid ? playerById(d.pid) : null;
      if (!p && d.name) {
        const name = String(d.name).replace(/\s+/g, ' ').trim().slice(0, 24); if (!name) return;
        p = s.players.find(x => x.name.toLowerCase() === name.toLowerCase());
        if (!p) {
          if (!s.settings.allowSelfJoin) { hsend(m, { t: 'err', msg: 'The host needs to add you first. Pick your name from the list.' }); return; }
          p = addPlayer(name, true);
        }
      }
      if (!p) return;
      for (const [cid, pid] of Object.entries(s.bindings)) if (pid === p.id && cid !== m.clientId) delete s.bindings[cid];
      for (const o of H.conns) if (o !== m && o.pid === p.id) o.pid = null;
      s.bindings[m.clientId] = p.id; m.pid = p.id;
      commit(); return;
    }
    case 'leave': if (m.clientId) delete s.bindings[m.clientId]; m.pid = null; commit(); return;
    case 'buzz': if (!(m.role === 'player' && m.pid && hostBuzz(m.pid, d.rid))) hsend(m, publicState(m)); return;
    case 'getImg': serveImage(m, String(d.id || '')); return;
  }
}
/* ---------- game actions ---------- */
function addPlayer(name, silent) {
  const s = H.session;
  const used = new Set(s.players.map(p => p.color));
  const color = COLORS.find(c => !used.has(c)) || COLORS[s.players.length % COLORS.length];
  const p = { id: 'p' + uid(6), name: String(name).trim().slice(0, 24), score: 0, color };
  s.players.push(p); if (!silent) commit(); return p;
}
function removePlayer(pid) {
  const s = H.session, p = playerById(pid); if (!p || !confirm(`Remove ${p.name}?`)) return;
  s.players = s.players.filter(x => x.id !== pid);
  for (const [cid, id] of Object.entries(s.bindings)) if (id === pid) delete s.bindings[cid];
  for (const m of H.conns) if (m.pid === pid) m.pid = null;
  s.lockedOut = s.lockedOut.filter(x => x !== pid); s.queue = s.queue.filter(x => x.id !== pid);
  if (s.winner === pid) s.winner = null;
  commit();
}
function renamePlayer(pid) {
  const p = playerById(pid); if (!p) return;
  const n = prompt('Rename player', p.name); if (n && n.trim()) { p.name = n.trim().slice(0, 24); commit(); }
}
function adjustScore(pid, delta) { const p = playerById(pid); if (p) { p.score = Math.round((p.score + delta) * 100) / 100; commit(); } }
function hostBuzz(pid, rid) {
  const s = H.session, r = curRound(), now = performance.now();
  if (!r || s.blank || (rid && rid !== r.id) || !s.buzzOpen || s.lockedOut.includes(pid) || s.queue.some(q => q.id === pid)) return false;
  if (!s.winner) { s.winner = pid; s.winnerAt = now; s.queue = [{ id: pid, dt: 0 }]; s.buzzSeq++; if (s.settings.sound) sfx('buzz'); }
  else s.queue.push({ id: pid, dt: Math.round(now - (s.winnerAt || now)) });
  commit(); return true;
}
function markCorrect() {
  const s = H.session; if (!s.winner) return;
  const v = Number($('#pts').value); const pts = curRound() && curRound().test ? 0 : (isFinite(v) && $('#pts').value !== '' ? v : roundPoints(curRound()));
  const p = playerById(s.winner); if (p) p.score = Math.round((p.score + pts) * 100) / 100;
  s.last = { type: 'correct', pid: s.winner, pts, at: Date.now() };
  s.winner = null; s.queue = []; s.buzzOpen = false;
  if (s.settings.autoRevealOnCorrect) s.revealed = true;
  if (s.settings.sound) sfx('correct');
  commit();
}
function markWrong() {
  const s = H.session; if (!s.winner) return;
  const pen = Number(H.game.wrongPenalty) || 0, p = playerById(s.winner);
  if (p && pen) p.score = Math.round((p.score - pen) * 100) / 100;
  s.lockedOut.push(s.winner);
  s.last = { type: 'wrong', pid: s.winner, pts: -pen, at: Date.now() };
  s.winner = null; s.queue = [];
  s.buzzOpen = s.players.some(x => !s.lockedOut.includes(x.id));
  if (s.settings.sound) sfx('wrong');
  commit();
}
function openBuzz() { const s = H.session; if (s.blank) { toast('Screen is blank - press B to show the round first'); return; } s.winner = null; s.queue = []; s.buzzOpen = true; commit(); }
function lockBuzz() { H.session.buzzOpen = false; commit(); }
function resetBuzz() { const s = H.session; s.winner = null; s.queue = []; s.lockedOut = []; s.last = null; s.buzzOpen = !s.blank; commit(); }
function toggleBlank(on) {
  const s = H.session; s.blank = typeof on === 'boolean' ? on : !s.blank;
  if (s.blank) { s.buzzOpen = false; s.winner = null; s.queue = []; }
  else if (s.settings.autoOpen && !s.revealed && curRound()) s.buzzOpen = true;
  commit();
}
function resetScores(ask = true) {
  if (ask && !confirm('Reset all scores to 0? Players and the current round are kept.')) return;
  H.session.players.forEach(p => { p.score = 0; }); H.session.last = null; commit(); toast('Scores reset');
}
function toggleReveal() { const s = H.session; s.revealed = !s.revealed; if (s.revealed) { s.buzzOpen = false; if (s.settings.sound) sfx('reveal'); } commit(); }
function resetRoundState(i) {
  const s = H.session;
  s.roundIndex = clamp(i, 0, Math.max(0, H.game.rounds.length - 1));
  s.winner = null; s.queue = []; s.lockedOut = []; s.revealed = false; s.last = null;
  s.blank = !!(s.settings.autoBlank && H.game.rounds.length);
  s.buzzOpen = !!(s.settings.autoOpen && H.game.rounds.length && !s.blank);
}
function gotoRound(i) {
  if (!H.game.rounds.length) return;
  const from = curRound(), to = H.game.rounds[clamp(i, 0, H.game.rounds.length - 1)];
  const askReset = from && from.test && to && !to.test && H.session.players.some(p => p.score);
  resetRoundState(i); commit();
  if (askReset) setTimeout(() => { if (confirm('Test rounds are done. Reset all scores to 0?')) resetScores(false); }, 50);
}
function resetGame() {
  if (!confirm('Reset the game? Scores go to 0 and you go back to round 1. Players and rounds are kept.')) return;
  H.session.players.forEach(p => { p.score = 0; }); resetRoundState(0); commit();
}
/* ---------- importing ---------- */
function progress(msg, frac) {
  $('#importProg').classList.remove('hidden'); $('#importMsg').textContent = msg;
  $('#importBar').style.width = Math.round(clamp(frac || 0, 0, 1) * 100) + '%';
}
function progressDone() { setTimeout(() => $('#importProg').classList.add('hidden'), 600); }
function applyAnswers(rounds, answers) {
  let n = 0;
  rounds.forEach((r, i) => {
    const a = answers[r.srcNum != null ? r.srcNum : i + 1]; if (!a) return; n++;
    if (a.title) r.title = a.title; if (a.prompt) r.prompt = a.prompt; if (a.note) r.note = a.note;
    if (a.points != null && isFinite(a.points)) r.points = Number(a.points);
  });
  return n;
}
function prettyTitle(s) { s = String(s).replace(/[-_]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); }
async function importFiles(fileList) {
  let files = Array.from(fileList || []).filter(f => !/^\./.test(f.name) && !/__MACOSX/.test(f.relPath || f.webkitRelativePath || ''));
  if (!files.length) return;
  const expanded = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) { progress('Unzipping ' + f.name + '…', 0.02); try { expanded.push(...await unzipToFiles(f)); } catch (e) { toast('Could not read zip: ' + e.message); } }
    else expanded.push(f);
  }
  files = expanded;
  const imgs = files.filter(isImageFile);
  const jsons = files.filter(f => /\.json$/i.test(f.name));
  const texts = files.filter(f => /\.(md|markdown|txt)$/i.test(f.name))
    .sort((a, b) => (/answer|key|solution/i.test(b.name) ? 1 : 0) - (/answer|key|solution/i.test(a.name) ? 1 : 0));
  const answers = {};
  for (const j of jsons) {
    let obj; try { progress('Reading ' + j.name + '…', 0.05); obj = JSON.parse(await j.text()); } catch { toast('Not valid JSON: ' + j.name); continue; }
    if (isGameJson(obj)) { if (!imgs.length) { await importGameObject(obj); return; } }
    else for (const [k, v] of Object.entries(parseAnswersJson(obj))) if (!answers[k]) answers[k] = v;
  }
  for (const t of texts) for (const [k, v] of Object.entries(parseAnswersText(await t.text()))) if (!answers[k]) answers[k] = v;
  if (!imgs.length) {
    if (Object.keys(answers).length && H.game.rounds.length) { const n = applyAnswers(H.game.rounds, answers); commit({ setup: true }); toast(`Applied answer notes to ${n} rounds`); }
    else toast('No images found in what you dropped.');
    $('#importProg').classList.add('hidden'); return;
  }
  const groups = groupImageFiles(imgs);
  let replace = true;
  if (H.game.rounds.length) replace = confirm(`Replace the current ${H.game.rounds.length} rounds with ${groups.length} new rounds?\n\nOK = replace   Cancel = add to the end`);
  const total = groups.reduce((a, g) => a + g.q.length + (g.a ? 1 : 0), 0); let done = 0;
  const { maxPx, quality } = H.session.settings; const out = []; let failed = 0;
  for (const g of groups) {
    const r = newRound(); r.srcNum = g.num;
    for (const f of g.q) { try { r.q.push(await storeImage(await compressBlob(f, maxPx, quality))); } catch (e) { failed++; console.warn(e); } progress(`Processing images ${++done}/${total}…`, done / total); }
    if (g.a) { try { r.a = await storeImage(await compressBlob(g.a, maxPx, quality)); } catch (e) { failed++; } progress(`Processing images ${++done}/${total}…`, done / total); }
    if (r.q.length) out.push(r);
  }
  const nAns = applyAnswers(out, answers);
  out.forEach(r => delete r.srcNum);
  const folder = (files.find(f => (f.relPath || f.webkitRelativePath || '').includes('/')) || {});
  const folderName = (folder.relPath || folder.webkitRelativePath || '').split('/')[0];
  if (replace) {
    H.game.rounds = out;
    if (folderName && (H.game.title === 'Picture Trivia' || !H.game.title || true)) H.game.title = prettyTitle(folderName);
    resetRoundState(0);
  } else H.game.rounds.push(...out);
  gcImages(); progress(`Loaded ${out.length} rounds${nAns ? `, ${nAns} with answer notes` : ''}${failed ? `, ${failed} images failed` : ''}.`, 1); progressDone();
  commit({ setup: true });
  toast(`Loaded ${out.length} rounds${nAns ? ` (${nAns} with answer notes)` : ''}`);
}
const looksLikeImgSrc = v => typeof v === 'string' && /^(data:image|https?:|blob:)/i.test(v.trim());
async function importGameObject(obj) {
  const rounds = obj.rounds.filter(Boolean);
  if (H.game.rounds.length && !confirm(`Replace the current game (${H.game.rounds.length} rounds) with "${obj.title || 'imported game'}" (${rounds.length} rounds)?`)) { $('#importProg').classList.add('hidden'); return; }
  const { maxPx, quality } = H.session.settings; const cache = new Map();
  const dict = obj.images && typeof obj.images === 'object' ? obj.images : {};
  const resolve = async src => {
    if (!src) return null;
    if (typeof src === 'object') src = src.data || src.url || src.src;
    if (typeof src === 'string' && dict[src]) { const d = dict[src]; src = typeof d === 'string' ? d : (d.data || d.url); }
    if (!looksLikeImgSrc(src)) return null;
    if (cache.has(src)) return cache.get(src);
    const id = await storeImage(await processSrc(src.trim(), maxPx, quality)); cache.set(src, id); return id;
  };
  const out = []; let failed = 0;
  for (let i = 0; i < rounds.length; i++) {
    const x = rounds[i], r = newRound();
    r.title = String(x.title || ''); r.prompt = String(x.prompt || '');
    const ansImg = x.answerImage ?? x.answer_image ?? (looksLikeImgSrc(x.answer) || (typeof x.answer === 'string' && dict[x.answer]) ? x.answer : (x.a ?? null));
    r.note = String(x.note ?? x.answerNote ?? x.answerText ?? (typeof x.answer === 'string' && !looksLikeImgSrc(x.answer) && !dict[x.answer] ? x.answer : '') ?? '');
    r.points = x.points != null && isFinite(x.points) ? Number(x.points) : null;
    r.test = !!(x.test || x.isTest);
    for (const s of [].concat(x.question ?? x.questions ?? x.q ?? []).slice(0, 2)) { try { const id = await resolve(s); if (id) r.q.push(id); } catch (e) { failed++; console.warn(e); } }
    try { r.a = await resolve(ansImg); } catch (e) { failed++; }
    if (r.q.length) out.push(r);
    progress(`Importing round ${i + 1}/${rounds.length}…`, (i + 1) / rounds.length);
  }
  H.game = Object.assign(defaultGame(), { title: String(obj.title || 'Imported game'), defaultPoints: Number(obj.defaultPoints) || 1, wrongPenalty: Number(obj.wrongPenalty) || 0, rounds: out });
  resetRoundState(0); gcImages();
  progress(`Imported "${H.game.title}": ${out.length} rounds${failed ? `, ${failed} images failed` : ''}.`, 1); progressDone();
  commit({ setup: true }); toast(`Imported ${out.length} rounds`);
}
async function addFromUrls(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('//'));
  if (!lines.length) return;
  const { maxPx, quality } = H.session.settings; let added = 0, failed = 0;
  for (let i = 0; i < lines.length; i++) {
    const [main, ...noteParts] = lines[i].split(/\s+#\s+/);
    const [qs, a] = main.split(/\s*>\s*/);
    const r = newRound(); r.note = noteParts.join(' # ');
    for (const u of qs.split(/\s*\|\s*/).filter(Boolean).slice(0, 2)) { try { r.q.push(await storeImage(await processSrc(u, maxPx, quality))); } catch (e) { failed++; } }
    if (a) { try { r.a = await storeImage(await processSrc(a.trim(), maxPx, quality)); } catch (e) { failed++; } }
    if (r.q.length) { H.game.rounds.push(r); added++; }
    progress(`Adding URL rounds ${i + 1}/${lines.length}…`, (i + 1) / lines.length);
  }
  progressDone(); if (H.game.rounds.length === added) resetRoundState(0);
  commit({ setup: true }); toast(`Added ${added} rounds${failed ? `; ${failed} images could not be loaded` : ''}`);
  return added;
}
function exportGame() {
  const g = H.game;
  const out = {
    format: 'picture-buzzer-game', version: 1, title: g.title, defaultPoints: g.defaultPoints, wrongPenalty: g.wrongPenalty, exportedAt: new Date().toISOString(),
    rounds: g.rounds.map(r => ({ title: r.title, prompt: r.prompt, note: r.note, points: r.points, ...(r.test ? { test: true } : {}), question: r.q.map(imgSrc).filter(Boolean), answer: r.a ? imgSrc(r.a) : null })),
  };
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: (g.title || 'game').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() + '.picbuzz.json' });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function pickImage(onFile) {
  const inp = h('input', { type: 'file', accept: 'image/*' });
  inp.onchange = () => { if (inp.files[0]) onFile(inp.files[0]); };
  inp.click();
}
async function setRoundImage(r, slot, fileOrUrl) {
  const { maxPx, quality } = H.session.settings;
  try {
    const rec = typeof fileOrUrl === 'string' ? await processSrc(fileOrUrl, maxPx, quality) : await compressBlob(fileOrUrl, maxPx, quality);
    const id = await storeImage(rec);
    if (slot === 'a') r.a = id; else { const i = slot === 'q2' ? 1 : 0; if (i === 1 && !r.q.length) r.q.push(id); else r.q[i] = id; }
    gcImages(); commit({ setup: true });
  } catch (e) { toast('Could not load that image'); }
}
/* ---------- host UI ---------- */
function buildHost() {
  document.title = 'Host · Picture Buzzer';
  document.body.className = 'view-host';
  $('#app').innerHTML = `
<div class="host">
  <div class="topbar">
    <div class="brand">🔔 Picture Buzzer</div>
    <div class="tabs"><button data-tab="play" class="active">Play</button><button data-tab="setup">Game setup</button><button data-tab="help">Help</button></div>
    <div class="grow"></div>
    <label class="row">Host name <input id="hostName" style="width:9em" maxlength="24"></label>
    <div class="row"><span class="muted">Room</span><span id="roomCode" class="roomcode code"></span><button class="small ghost" id="btnRoom" title="Change room code">✎</button></div>
    <div class="pill" id="netStatus"><span class="dot"></span><span class="txt">…</span></div>
  </div>
  <div id="tab-play" class="hostmain">
    <div class="side">
      <div class="card col">
        <div class="row"><h3 class="grow">Players</h3><span class="muted" id="streamCount" style="font-size:.85rem"></span></div>
        <div id="plist" class="plist"></div>
        <form id="addPlayer" class="row" autocomplete="off"><input id="newPlayer" class="grow" placeholder="Add player name" maxlength="24"><button class="blue">Add</button></form>
      </div>
      <div class="card col">
        <h3>Share</h3>
        <div id="fileWarn" class="hidden" style="color:var(--orange);font-size:.85rem">You opened this as a local file, so friends can’t use these links. Host index.html on a web page, or send friends the file and the room code.</div>
        <div class="muted" style="font-size:.85rem">Player link (send to friends):</div>
        <div class="linkbox"><input id="linkPlayer" readonly><button class="small" data-copy="linkPlayer">Copy</button></div>
        <div class="muted" style="font-size:.85rem">Stream link (OBS browser source 1920×1080):</div>
        <div class="linkbox"><input id="linkStream" readonly><button class="small" data-copy="linkStream">Copy</button></div>
        <div class="row" style="font-size:.85rem"><label class="row">Background <select id="streamBg"><option value="dark">Dark</option><option value="transparent">Transparent</option><option value="green">Green screen</option><option value="black">Black</option></select></label><label class="row"><input type="checkbox" id="streamSound"> Stream sounds</label></div>
        <div class="row"><button class="small ghost" id="openStream">Open stream view</button><button class="small ghost" id="openPlayer">Open a player view</button></div>
      </div>
    </div>
    <div class="col" style="min-width:0">
      <div class="roundhead"><span class="rn" id="rNum"></span><span class="rt" id="rTitle"></span><span class="rp" id="rPrompt"></span></div>
      <div id="buzzbar" class="buzzbar">
        <span id="buzzText" class="grow"></span>
        <span class="row" id="judge"><button id="bCorrect" class="green">✔ Correct<span class="kbd">C</span></button><input id="pts" type="number" step="any" style="width:4.5em" title="Points for a correct answer"><span style="font-size:1rem" class="muted">pts</span><button id="bWrong" class="red">✖ Wrong<span class="kbd">W</span></button></span>
      </div>
      <div class="controls">
        <button id="bPrev">◀ Prev<span class="kbd">←</span></button>
        <button id="bNext">Next ▶<span class="kbd">→</span></button>
        <button id="bOpen" class="green">Open buzzers<span class="kbd">O</span></button>
        <button id="bLock">Lock buzzers<span class="kbd">L</span></button>
        <button id="bReset">Reset buzzers<span class="kbd">X</span></button>
        <button id="bReveal" class="blue">Reveal answer<span class="kbd">R</span></button>
        <button id="bBlank">Blank screen<span class="kbd">B</span></button>
        <div class="grow"></div>
        <button id="bResetScores" class="ghost">Reset scores</button>
        <button id="bResetGame" class="ghost">Reset game</button>
      </div>
      <div class="blankbar row hidden" id="blankBar"><b>⏸ Screen is blank</b><span class="muted">Players and stream see:</span><input id="blankText" class="grow" maxlength="120" placeholder="Get ready…"><span class="muted" style="font-size:.85rem">Buzzers locked. Press B to show the round.</span></div>
      <div class="stagehost">
        <div class="card col"><div class="row"><b class="grow">Question (everyone sees this)</b><span class="pill" id="revealPill"></span></div><div class="imgarea" id="hostQ"></div></div>
        <div class="answerbox"><div class="lbl" id="ansLbl">Answer: host only until revealed</div><div class="imgarea" id="hostA"></div><div class="note" id="hostNote"></div></div>
      </div>
      <div class="strip" id="strip"></div>
    </div>
  </div>
  <div id="tab-setup" class="setup hidden">
    <div class="card col">
      <h2>Load a game</h2>
      <div class="drop" id="drop">
        <b>Drag and drop a folder, image files, a .zip, or a game file (.json) here</b>
        <div class="muted" style="margin-top:.4rem">Files pair up by number: <code>01_question.jpg</code> + <code>01_answer.jpg</code>. Two question images with the same number (e.g. <code>05_a.png</code>, <code>05_b.png</code>) show side by side. Include <code>answers.md</code>, <code>.txt</code>, or <code>.json</code> to fill in the answer notes.</div>
        <div class="row" style="justify-content:center;margin-top:.9rem"><button id="pickFiles" class="primary">Choose files…</button><button id="pickFolder">Choose folder…</button><button id="pickJson">Import game file (.json)…</button></div>
        <input type="file" id="fileInput" multiple accept="image/*,.json,.md,.txt,.zip" hidden>
        <input type="file" id="folderInput" webkitdirectory directory multiple hidden>
        <input type="file" id="jsonInput" accept=".json,application/json" hidden>
      </div>
      <div id="importProg" class="hidden col"><div id="importMsg"></div><div class="progress"><div id="importBar"></div></div></div>
      <details><summary><b>Paste image URLs</b></summary>
        <div class="muted" style="margin:.4rem 0">One round per line: <code>question_url</code>, or <code>left_url | right_url</code> for two side by side. Add <code>&gt; answer_url</code> for an answer image and <code> # answer note</code> for the answer text. Images from sites that block cross-origin loading are linked instead of embedded, so viewers load them straight from that site.</div>
        <textarea id="urls" rows="4" style="width:100%" placeholder="https://example.com/q1.jpg > https://example.com/a1.jpg # The phone on the desk"></textarea>
        <div class="row" style="margin-top:.4rem"><button id="addUrls" class="blue">Add rounds from URLs</button></div>
      </details>
    </div>
    <div class="card col">
      <h2>Game</h2>
      <div class="row"><label class="col grow">Title <input id="gTitle" maxlength="80"></label><label class="col">Default points <input id="gPoints" type="number" step="any" style="width:7em"></label><label class="col">Wrong-answer penalty <input id="gPenalty" type="number" step="any" style="width:7em"></label>
        <label class="col">Image size <select id="sMaxPx"><option value="1280">1280 px (fastest)</option><option value="1600">1600 px</option><option value="1920">1920 px (sharpest)</option></select></label></div>
      <div class="row settings">
        <label><input type="checkbox" id="sAutoOpen"> Open buzzers automatically on each new round</label>
        <label><input type="checkbox" id="sAutoReveal"> Reveal the answer automatically when marked correct</label>
        <label><input type="checkbox" id="sSelfJoin"> Players can add themselves by typing a name</label>
        <label><input type="checkbox" id="sSound"> Host sounds</label>
        <label><input type="checkbox" id="sAutoBlank"> Start each round on a blank "Get ready" screen</label>
      </div>
      <div class="row"><button id="exportGame" class="primary">Export / save game file</button><button id="addRound">+ Add empty round</button><button id="clearRounds" class="red">Remove all rounds</button><span class="muted" id="gameStats"></span></div>
      <details><summary><b>Connection help: optional TURN relay server</b></summary>
        <div class="muted" style="margin:.4rem 0">Most home networks connect directly. If a player sits behind a strict firewall or mobile network and can’t connect, add a TURN server here (for example a free-tier account from Metered or Cloudflare, or your own coturn). It’s added to the player and stream links automatically, so re-copy the links after saving.</div>
        <div class="row"><input id="tUrl" class="grow" placeholder="turn:turn.example.com:3478?transport=udp, turns:turn.example.com:443"><input id="tUser" placeholder="username" style="width:10em"><input id="tPass" placeholder="credential" style="width:10em"><button id="tSave" class="blue">Save</button></div>
      </details>
      <div id="dbWarn" class="hidden" style="color:var(--orange)">This browser blocked storage (IndexedDB), so images won’t survive a page refresh. Export the game file to keep it.</div>
    </div>
    <div class="card col"><h2>Rounds</h2><div class="muted">Click a slot or drop an image on it to set it. Text changes save automatically. Prompt and title show to everyone; the answer note shows only after you reveal.</div><div id="rlist" class="rlist"></div></div>
  </div>
  <div id="tab-help" class="help hidden">${HELP_HTML}</div>
</div>`;
  bindHost();
}
const HELP_HTML = `
<h2>Running a game</h2>
<ol>
<li><b>Load a game</b> under <i>Game setup</i>: drag in a folder of images (with an optional <code>answers.md</code>), a .zip, or a saved game file (.json). You can also paste image URLs.</li>
<li><b>Add your players</b> (optional: friends can type their own name when they join).</li>
<li><b>Share the player link</b> (or just the room code). Friends open it on a phone or computer and pick or type their name.</li>
<li><b>Add the stream view to OBS</b>: Sources → + → <i>Browser</i>, paste the stream link, Width 1920, Height 1080. To hear the buzz sounds, tick “Control audio via OBS”. For a see-through background choose <i>Transparent</i> before copying the link.</li>
<li>Play: when someone buzzes, their name lights up. Press <b>Correct</b> (adds the points) or <b>Wrong</b> (locks that player out for this round and reopens the buzzers for everyone else). Press <b>Reveal</b> to show the answer to everyone. <b>Next</b> moves on and opens the buzzers again.</li>
</ol>
<h2>Keyboard shortcuts (host)</h2>
<p><code>←</code>/<code>→</code> previous/next round · <code>O</code> open buzzers · <code>L</code> lock · <code>C</code> correct · <code>W</code> wrong · <code>R</code> reveal or hide · <code>X</code> reset buzzers (clears lockouts) · <code>B</code> blank / “Get ready” screen</p>
<h2>Good to know</h2>
<ul>
<li>This page is the game’s brain. Keep this tab open while you play. If you refresh it, the game, scores, and images come back and players reconnect on their own.</li>
<li>Players never receive the answer image or note until you reveal.</li>
<li><b>Blank screen</b> (<code>B</code>) hides the round from players and the stream and shows your “Get ready” text (the stream also shows the scoreboard). Buzzers stay locked while blank; you still see the round here.</li>
<li><b>Test rounds</b> (tick “Test” in Game setup) are for tech checks: a correct answer scores 0, and when you move past the last test round you’re offered a score reset. <b>Reset scores</b> zeroes scores any time.</li>
<li>Tap or click any picture to view it full screen. Pinch or scroll to zoom, drag to pan, and press Esc, ✕ or Back to close.</li>
<li>Multi-item rounds (“find all 10”): mark Correct for each item found, then press <b>Open buzzers</b> again.</li>
<li>Connections are peer-to-peer (WebRTC) using the free PeerJS broker, so everyone needs internet access. If a player can’t connect on a strict network (some work or school Wi-Fi), have them try mobile data.</li>
<li>Custom room code: click ✎ next to the room code, or open <code>?view=host&amp;room=MYCODE</code>.</li>
</ul>
<h2>File naming for folders</h2>
<p><code>01_question.jpg</code>, <code>01_answer.jpg</code>, <code>02_question.jpg</code>, … The first number in a filename sets the round. Names containing <i>answer</i>, <i>ans</i>, <i>reveal</i>, or <i>solution</i> become the answer image. Two non-answer images with the same number show side by side as A and B (for example, “which logo is correct?”).</p>
<p>Answer notes: <code>answers.json</code> like <code>{"1": "The phone", "2": {"prompt": "…", "note": "…", "points": 2}}</code>, or a text or markdown file with lines like <code>01: answer text</code> or table rows <code>| 01 | prompt | answer |</code>.</p>
<p class="muted">Picture Buzzer v${APP_VERSION}</p>`;
function bindHost() {
  $$('.tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
  $('#hostName').oninput = e => { H.session.hostName = e.target.value.slice(0, 24) || 'Host'; saveNow(); broadcastSoon(); };
  $('#btnRoom').onclick = () => {
    const v = prompt('Room code (4-12 letters/numbers). Leave blank for a new random code.', H.session.room);
    if (v === null) return; const code = normRoom(v) || newRoomCode();
    if (code.length < 4) { toast('Room code needs at least 4 characters'); return; }
    H.session.room = code; H.session.bindings = {}; saveNow(); H.net.changeRoom(code); renderHostAll();
    history.replaceState(null, '', baseUrl() + '?view=host');
  };
  $('#addPlayer').onsubmit = e => { e.preventDefault(); const v = $('#newPlayer').value.trim(); if (v) { addPlayer(v); $('#newPlayer').value = ''; } };
  $$('[data-copy]').forEach(b => b.onclick = () => copyText($('#' + b.dataset.copy).value));
  $('#streamBg').onchange = e => { H.session.settings.streamBg = e.target.value; saveNow(); renderTop(); };
  $('#streamSound').onchange = e => { H.session.settings.streamSound = e.target.checked; saveNow(); renderTop(); };
  $('#openStream').onclick = () => window.open($('#linkStream').value, '_blank');
  $('#openPlayer').onclick = () => window.open($('#linkPlayer').value, '_blank');
  $('#bPrev').onclick = () => gotoRound(H.session.roundIndex - 1);
  $('#bNext').onclick = () => gotoRound(H.session.roundIndex + 1);
  $('#bOpen').onclick = openBuzz; $('#bLock').onclick = lockBuzz; $('#bReset').onclick = resetBuzz;
  $('#bReveal').onclick = toggleReveal; $('#bResetGame').onclick = resetGame;
  $('#bBlank').onclick = () => toggleBlank(); $('#bResetScores').onclick = () => resetScores();
  $('#blankText').oninput = e => { H.session.blankText = e.target.value.slice(0, 120); saveNow(); broadcastSoon(); };
  $('#bCorrect').onclick = markCorrect; $('#bWrong').onclick = markWrong;
  // setup tab
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = async e => { e.preventDefault(); drop.classList.remove('over'); const files = await filesFromDataTransfer(e.dataTransfer); importFiles(files); };
  addEventListener('dragover', e => e.preventDefault()); addEventListener('drop', e => e.preventDefault());
  $('#pickFiles').onclick = () => $('#fileInput').click();
  $('#pickFolder').onclick = () => $('#folderInput').click();
  $('#pickJson').onclick = () => $('#jsonInput').click();
  for (const id of ['fileInput', 'folderInput', 'jsonInput']) $('#' + id).onchange = e => { const f = Array.from(e.target.files); e.target.value = ''; importFiles(f); };
  $('#addUrls').onclick = async () => { const n = await addFromUrls($('#urls').value); if (n) $('#urls').value = ''; };
  $('#gTitle').oninput = e => { H.game.title = e.target.value; saveNow(); broadcastSoon(); };
  $('#gPoints').oninput = e => { H.game.defaultPoints = Number(e.target.value) || 1; saveNow(); renderPlay(true); broadcastSoon(); };
  $('#gPenalty').oninput = e => { H.game.wrongPenalty = Number(e.target.value) || 0; saveNow(); };
  $('#sMaxPx').onchange = e => { H.session.settings.maxPx = Number(e.target.value); saveNow(); };
  const chk = (id, key) => { $(id).onchange = e => { H.session.settings[key] = e.target.checked; commit(); }; };
  chk('#sAutoOpen', 'autoOpen'); chk('#sAutoReveal', 'autoRevealOnCorrect'); chk('#sSelfJoin', 'allowSelfJoin'); chk('#sSound', 'sound'); chk('#sAutoBlank', 'autoBlank');
  $('#exportGame').onclick = exportGame;
  $('#tSave').onclick = () => {
    H.session.settings.turn = { url: $('#tUrl').value.trim(), user: $('#tUser').value.trim(), pass: $('#tPass').value.trim() };
    saveNow(); renderTop(); H.net.changeRoom(H.session.room); toast('Saved. Re-copy the player and stream links.');
  };
  $('#addRound').onclick = () => { H.game.rounds.push(newRound()); commit({ setup: true }); };
  $('#clearRounds').onclick = () => { if (!H.game.rounds.length || !confirm('Remove all rounds and images from this game?')) return; H.game.rounds = []; resetRoundState(0); gcImages(); commit({ setup: true }); };
  addEventListener('keydown', hostKeys);
}
function setTab(t) {
  H.tab = t; $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  for (const x of ['play', 'setup', 'help']) $('#tab-' + x).classList.toggle('hidden', x !== t);
  if (t === 'setup') renderSetup();
}
function hostKeys(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tg = e.target; if (tg && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable)) return;
  if (H.tab !== 'play') return;
  const k = e.key.toLowerCase();
  const map = { arrowleft: () => gotoRound(H.session.roundIndex - 1), arrowright: () => gotoRound(H.session.roundIndex + 1), o: openBuzz, l: lockBuzz, c: markCorrect, w: markWrong, r: toggleReveal, x: resetBuzz, b: () => toggleBlank() };
  if (map[k]) { e.preventDefault(); map[k](); }
}
function netParams() {
  const t = H.session.settings.turn || {}; let q = '';
  if (t.url) q += '&turn=' + encodeURIComponent(t.url) + (t.user ? '&turnuser=' + encodeURIComponent(t.user) : '') + (t.pass ? '&turnpass=' + encodeURIComponent(t.pass) : '');
  for (const k of ['peerhost', 'peerport', 'peerpath', 'peersecure']) if (params.get(k)) q += `&${k}=` + encodeURIComponent(params.get(k));
  return q;
}
const playerLink = () => baseUrl() + '?view=player&room=' + H.session.room + netParams();
function streamLink() {
  const st = H.session.settings; let u = baseUrl() + '?view=stream&room=' + H.session.room + netParams();
  if (st.streamBg && st.streamBg !== 'dark') u += '&bg=' + st.streamBg;
  if (!st.streamSound) u += '&sound=0';
  return u;
}
function renderTop() {
  if (!H.session) return;
  const s = H.session, n = H.net;
  $('#roomCode').textContent = s.room;
  if (document.activeElement !== $('#hostName')) $('#hostName').value = s.hostName;
  const st = n ? n.state : 'loading';
  const ns = $('#netStatus');
  ns.querySelector('.dot').className = 'dot ' + (st === 'online' ? 'on' : (st === 'error' ? 'off' : 'warn'));
  ns.querySelector('.txt').textContent = (NET_TEXT[st] || st) + (n && n.detail ? ': ' + n.detail : '') + (st === 'taken' && n.fails > 4 ? ' (is this room open in another tab?)' : '');
  $('#linkPlayer').value = playerLink();
  $('#linkStream').value = streamLink();
  $('#streamBg').value = s.settings.streamBg || 'dark'; $('#streamSound').checked = !!s.settings.streamSound;
  $('#fileWarn').classList.toggle('hidden', location.protocol !== 'file:');
  const streams = [...H.conns].filter(m => m.role === 'stream').length;
  $('#streamCount').textContent = `${streams} stream view${streams === 1 ? '' : 's'} connected`;
}
function renderPlayers() {
  const s = H.session, list = $('#plist'); list.innerHTML = '';
  if (!s.players.length) list.append(h('div', { class: 'muted' }, 'No players yet. Add them here, or friends can join with the player link.'));
  for (const p of s.players) {
    const on = isConnected(p.id);
    list.append(h('div', { class: 'prow' + (s.winner === p.id ? ' winner' : '') + (s.lockedOut.includes(p.id) ? ' locked' : ''), style: { borderLeftColor: p.color }, 'data-pid': p.id },
      h('span', { class: 'dot ' + (on ? 'on' : 'off'), title: on ? 'Connected' : 'Not connected' }),
      h('span', { class: 'pname', title: p.name }, p.name, s.lockedOut.includes(p.id) ? h('span', { title: 'Locked out this round' }, ' 🔒') : null),
      h('button', { class: 'small', title: 'Subtract 1 point', onclick: () => adjustScore(p.id, -1) }, '−'),
      h('span', { class: 'pscore' }, String(p.score)),
      h('div', { class: 'menu' },
        h('button', { class: 'small', title: 'Add 1 point', onclick: () => adjustScore(p.id, 1) }, '+'),
        h('button', { class: 'small ghost', title: 'Rename', onclick: () => renamePlayer(p.id) }, '✎'),
        h('button', { class: 'small ghost', title: 'Remove', onclick: () => removePlayer(p.id) }, '✕'))));
  }
}
function renderPlay(ptsOnly) {
  const s = H.session, g = H.game, r = curRound();
  if (r && (H._ptsRound !== r.id || ptsOnly)) { $('#pts').value = roundPoints(r); H._ptsRound = r.id; }
  if (ptsOnly) return;
  $('#rNum').textContent = r ? `Round ${s.roundIndex + 1} / ${g.rounds.length}` : 'No rounds loaded';
  $('#rTitle').textContent = r ? (r.title || '') + (r.test ? '  [TEST - scores 0]' : '') : '';
  $('#rPrompt').textContent = r ? (r.prompt || '') : '';
  const bar = $('#buzzbar'), bt = $('#buzzText');
  bar.className = 'buzzbar ' + (s.blank ? 'blank' : s.winner ? 'winner' : s.buzzOpen ? 'open' : 'locked');
  let txt;
  if (!r) txt = 'Load a game under Game setup to begin.';
  else if (s.winner) {
    const p = playerById(s.winner);
    txt = h('span', null, '🔔 ', h('span', { style: { color: p ? p.color : '' } }, pname(s.winner)), ' buzzed first!',
      s.queue.length > 1 ? h('span', { class: 'muted', style: { fontSize: '1rem', fontWeight: 600 } }, '  then ' + s.queue.slice(1).map(q => `${pname(q.id)} (+${(q.dt / 1000).toFixed(2)}s)`).join(', ')) : null);
  } else if (s.blank) txt = '⏸ Blank screen: everyone sees “Get ready”';
  else if (s.buzzOpen) txt = 'Buzzers OPEN. Waiting for a buzz…';
  else txt = 'Buzzers locked';
  if (r && !s.winner && s.last) txt = h('span', null, txt, h('span', { class: 'muted', style: { fontSize: '1rem', marginLeft: '.8em' } }, s.last.type === 'correct' ? `✔ ${pname(s.last.pid)} +${s.last.pts}` : `✖ ${pname(s.last.pid)} wrong`));
  if (r && s.lockedOut.length) txt = h('span', null, txt, h('span', { style: { fontSize: '1rem', color: 'var(--red)', marginLeft: '.8em' } }, 'Locked out: ' + s.lockedOut.map(pname).join(', ')));
  bt.replaceChildren(txt);
  $('#bCorrect').disabled = $('#bWrong').disabled = !s.winner;
  $('#bPrev').disabled = !r || s.roundIndex <= 0; $('#bNext').disabled = !r || s.roundIndex >= g.rounds.length - 1;
  $('#bOpen').disabled = $('#bLock').disabled = $('#bReset').disabled = $('#bReveal').disabled = $('#bBlank').disabled = !r;
  $('#bBlank').textContent = ''; $('#bBlank').append(s.blank ? 'Show round' : 'Blank screen', h('span', { class: 'kbd' }, 'B')); $('#bBlank').className = s.blank ? 'primary' : '';
  $('#blankBar').classList.toggle('hidden', !(s.blank && r)); if (document.activeElement !== $('#blankText')) $('#blankText').value = s.blankText || '';
  $('#bOpen').textContent = ''; $('#bOpen').append(s.winner ? 'Clear buzz & reopen' : 'Open buzzers', h('span', { class: 'kbd' }, 'O'));
  $('#bReveal').textContent = ''; $('#bReveal').append(s.revealed ? 'Hide answer' : 'Reveal answer', h('span', { class: 'kbd' }, 'R'));
  const rp = $('#revealPill'); rp.textContent = s.revealed ? 'ANSWER REVEALED' : 'Answer hidden'; rp.style.background = s.revealed ? 'var(--blue)' : ''; rp.style.color = s.revealed ? '#021428' : '';
  renderImgPair($('#hostQ'), r ? r.q : [], imgSrc, { empty: r ? 'No question image. Add one in Game setup.' : '', zoom: true });
  renderImgPair($('#hostA'), r && r.a ? [r.a] : [], imgSrc, { empty: r ? 'No answer image for this round' : '', zoom: true });
  Viewer.check([...(r ? r.q : []), ...(r && r.a ? [r.a] : [])]);
  $('#hostNote').textContent = r ? (r.note || '') : '';
  $('#ansLbl').textContent = s.revealed ? 'Answer: revealed to everyone' : 'Answer: host only until revealed';
  const strip = $('#strip'), key = g.rounds.map(x => x.id + (x.q[0] || '')).join(',') + '@' + s.roundIndex;
  if (strip._key !== key) {
    strip._key = key; strip.innerHTML = '';
    g.rounds.forEach((x, i) => {
      const t = thumbSrc(x.q[0]);
      strip.append(h('div', { class: 'th' + (i === s.roundIndex ? ' cur' : ''), title: `Round ${i + 1}${x.title ? ': ' + x.title : ''}`, style: t ? { backgroundImage: `url("${t}")` } : null, onclick: () => gotoRound(i) }, h('span', null, String(i + 1))));
    });
    const cur = strip.children[s.roundIndex]; if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
}
function renderHostAll() { if (!H.session || !$('#plist')) return; renderTop(); renderPlayers(); renderPlay(); }
function renderSetup() {
  const g = H.game, s = H.session;
  const setv = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
  setv('#gTitle', g.title); setv('#gPoints', g.defaultPoints); setv('#gPenalty', g.wrongPenalty);
  $('#sMaxPx').value = String(s.settings.maxPx);
  $('#sAutoOpen').checked = s.settings.autoOpen; $('#sAutoReveal').checked = s.settings.autoRevealOnCorrect;
  $('#sSelfJoin').checked = s.settings.allowSelfJoin; $('#sSound').checked = s.settings.sound; $('#sAutoBlank').checked = !!s.settings.autoBlank;
  $('#dbWarn').classList.toggle('hidden', !H.dbFail);
  const t = s.settings.turn || {}; setv('#tUrl', t.url || ''); setv('#tUser', t.user || ''); setv('#tPass', t.pass || '');
  let bytes = 0; for (const r of H.images.values()) bytes += (r.data || '').length;
  $('#gameStats').textContent = `${g.rounds.length} rounds · ${H.images.size} images · ${(bytes / 1048576 * 0.75).toFixed(1)} MB`;
  const list = $('#rlist'); list.innerHTML = '';
  if (!g.rounds.length) list.append(h('div', { class: 'muted' }, 'No rounds yet. Load a folder or files above.'));
  g.rounds.forEach((r, i) => list.append(roundRow(r, i)));
}
function roundRow(r, i) {
  const s = H.session;
  const slot = (label, id, slotName, onClear) => {
    const t = thumbSrc(id);
    const el = h('div', { class: 'slot' + (id ? ' filled' : ''), title: 'Click or drop an image here', style: t ? { backgroundImage: `url("${t}")` } : null },
      h('span', { class: 'lab' }, label), id ? null : '+ image',
      id && onClear ? h('span', { class: 'x', title: 'Remove image', onclick: e => { e.stopPropagation(); onClear(); } }, '×') : null);
    el.onclick = () => pickImage(f => setRoundImage(r, slotName, f));
    el.ondragover = e => { e.preventDefault(); e.stopPropagation(); el.classList.add('over'); };
    el.ondragleave = () => el.classList.remove('over');
    el.ondrop = e => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove('over');
      const f = Array.from(e.dataTransfer.files).find(isImageFile);
      if (f) return setRoundImage(r, slotName, f);
      const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
      if (url) setRoundImage(r, slotName, url);
    };
    return el;
  };
  const upd = (key, conv = v => v) => e => { r[key] = conv(e.target.value); saveNow(); if (curRound() === r) { renderPlay(key === 'points'); if (key !== 'points') renderPlay(); broadcastSoon(); } };
  const move = d => {
    const j = i + d; if (j < 0 || j >= H.game.rounds.length) return;
    const cur = curRound(); const arr = H.game.rounds; [arr[i], arr[j]] = [arr[j], arr[i]];
    s.roundIndex = Math.max(0, arr.indexOf(cur)); commit({ setup: true });
  };
  const del = () => {
    if (!confirm(`Delete round ${i + 1}?`)) return;
    const cur = curRound(); H.game.rounds.splice(i, 1);
    if (cur === r) resetRoundState(Math.min(i, H.game.rounds.length - 1)); else s.roundIndex = Math.max(0, H.game.rounds.indexOf(cur));
    gcImages(); commit({ setup: true });
  };
  return h('div', { class: 'rrow' + (i === s.roundIndex ? ' cur' : '') },
    h('div', { class: 'num' }, String(i + 1)),
    h('div', { class: 'slots' },
      slot('Q', r.q[0], 'q1', r.q.length > 1 ? () => { r.q.splice(0, 1); gcImages(); commit({ setup: true }); } : null),
      slot('Q2 (B)', r.q[1], 'q2', () => { r.q.splice(1, 1); gcImages(); commit({ setup: true }); }),
      slot('Answer', r.a, 'a', () => { r.a = null; gcImages(); commit({ setup: true }); })),
    h('div', { class: 'fields' },
      h('input', { placeholder: 'Title (optional)', value: r.title || '', oninput: upd('title') }),
      h('input', { placeholder: 'Prompt to show players (optional)', value: r.prompt || '', oninput: upd('prompt') }),
      h('input', { type: 'number', step: 'any', placeholder: `pts (${H.game.defaultPoints})`, title: 'Points for this round (blank = default)', value: r.points == null ? '' : r.points, oninput: upd('points', v => (v === '' ? null : Number(v))) }),
      h('textarea', { placeholder: 'Answer note (host only until revealed)', rows: 2, value: r.note || '', oninput: upd('note') }),
      h('label', { class: 'row', style: { fontSize: '.85rem', gridColumn: '1 / -1' }, title: 'Tech-check round: correct answers score 0' }, h('input', { type: 'checkbox', class: 'rtest', checked: !!r.test, onchange: e => { r.test = e.target.checked; commit(); } }), 'Test round (doesn’t count)')),
    h('div', { class: 'rbtns' },
      h('button', { class: 'small', title: 'Go to this round', onclick: () => { gotoRound(i); setTab('play'); } }, '▶ Play'),
      h('button', { class: 'small ghost', title: 'Move up', onclick: () => move(-1), disabled: i === 0 }, '▲'),
      h('button', { class: 'small ghost', title: 'Move down', onclick: () => move(1), disabled: i === H.game.rounds.length - 1 }, '▼'),
      h('button', { class: 'small ghost', title: 'Delete round', onclick: del }, '🗑')));
}
async function startHost() {
  buildHost();
  await hostLoad();
  renderHostAll(); renderSetup();
  if (!H.game.rounds.length) setTab('setup');
  H.net = new HostNet(H.session.room);
  H.net.start();
  window.__pb = { H, publicState, hostBuzz, gotoRound, markCorrect, markWrong, toggleReveal, toggleBlank, resetScores, openBuzz, resetBuzz, importFiles, importGameObject, addFromUrls };
}
