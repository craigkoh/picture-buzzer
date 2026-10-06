/* =========================== PLAYER =========================== */
function startPlayer() {
  const room = normRoom(params.get('room'));
  if (room.length < 4) return startLanding('Enter the room code from your host.');
  document.title = 'Player · Picture Buzzer'; document.body.className = 'view-player';
  $('#app').innerHTML = `
<div class="player" id="pmain">
  <div class="phead"><span class="me" id="me"></span><span class="myscore" id="myScore"></span><span class="muted" id="phost" style="font-size:.85rem"></span><div class="grow"></div>
    <span class="connbar"><span class="dot" id="cdot"></span><span id="ctext"></span></span><button class="small ghost" id="switch" title="Pick a different name">Switch</button></div>
  <div class="pstatus" id="pstatus">Connecting…</div>
  <div class="pstage"><div class="pprompt" id="pprompt"></div><div class="imgarea" id="pimg"></div><div class="panswer hidden" id="pans"></div></div>
  <button class="buzz" id="buzz" disabled>BUZZ!</button>
  <div class="scores" id="pscores"></div>
</div>
<div class="join hidden" id="join"><div class="card">
  <h2>Join room <span class="code" style="color:var(--accent)">${room}</span></h2>
  <div class="muted" id="jHost"></div>
  <div id="jPick" class="col"><div><b>Tap your name:</b></div><div class="pickbtns" id="jList"></div></div>
  <form id="jForm" class="col" autocomplete="off"><label class="col"><b id="jNameLbl">Or type your name:</b><input id="jName" maxlength="24" placeholder="Your name" enterkeyhint="go"></label><button class="green" style="font-size:1.2rem">Join game</button></form>
  <div id="jErr" style="color:var(--red)"></div>
  <div class="connbar"><span class="dot" id="jdot"></span><span id="jconn">Connecting…</span></div>
</div></div>`;
  let S = null, pressed = false, connected = false, autoJoined = false, lastBuzzSeq = null;
  const nameKey = 'picbuzz-name-' + room;
  const net = new ClientNet(room, 'player', {
    status: (st, detail) => { connected = st === 'connected'; if (!connected) cache.reset(); renderConn(st, detail); render(); },
    msg: m => {
      if (cache.handle(m)) return;
      if (m.t === 'state') { S = m; pressed = false; onState(); }
      else if (m.t === 'err') { $('#jErr').textContent = m.msg; }
    },
  });
  const cache = new ImageCache(net, () => { render(); wantImages(); });
  function wantImages() {
    if (!S || !S.round) return;
    const cur = S.round.q.concat(S.revealed && S.round.a ? [S.round.a] : []);
    cache.want(cur);
    if (cur.every(id => cache.has(id))) cache.want(S.prefetch || []);
  }
  function onState() {
    if (S.you) { const me = S.players.find(p => p.id === S.you); if (me) try { localStorage.setItem(nameKey, me.name); } catch {} }
    else if (!autoJoined && localStorage.getItem(nameKey)) { autoJoined = true; net.send({ t: 'join', name: localStorage.getItem(nameKey) }); }
    if (S.winner && S.winner === S.you && lastBuzzSeq !== null && S.buzzSeq !== lastBuzzSeq && navigator.vibrate) navigator.vibrate([80, 40, 160]);
    lastBuzzSeq = S.buzzSeq;
    wantImages(); render();
  }
  function renderConn(st, detail) {
    const txt = st === 'error' ? (detail || 'Error') : (STATUS_TEXT[st] || st);
    for (const [d, t] of [['#cdot', '#ctext'], ['#jdot', '#jconn']]) {
      $(d).className = 'dot ' + (st === 'connected' ? 'on' : st === 'error' ? 'off' : 'warn');
      $(t).textContent = st === 'connected' ? 'Connected' : txt;
    }
  }
  const canBuzz = () => !!(connected && S && S.you && S.round && S.buzzOpen && !S.winner && !S.revealed && !S.lockedOut.includes(S.you) && !pressed);
  function doBuzz() {
    if (!canBuzz()) return;
    pressed = true; net.send({ t: 'buzz', rid: S.round.id });
    if (navigator.vibrate) navigator.vibrate(25);
    render();
    setTimeout(() => { if (pressed) { pressed = false; render(); } }, 4000);
  }
  function render() {
    const joinNeeded = connected && S && !S.you;
    $('#join').classList.toggle('hidden', !joinNeeded && !(!S));
    $('#pmain').classList.toggle('hidden', joinNeeded || !S);
    if (!S) { $('#jPick').classList.add('hidden'); return; }
    // join card
    $('#jHost').textContent = `Hosted by ${S.hostName}${S.title ? ' · ' + S.title : ''}`;
    const list = $('#jList'); list.innerHTML = '';
    S.players.forEach(p => list.append(h('button', { style: { background: p.color, color: '#111' }, onclick: () => { $('#jErr').textContent = ''; net.send({ t: 'join', pid: p.id }); } }, p.name + (p.connected ? ' •' : ''))));
    $('#jPick').classList.toggle('hidden', !S.players.length);
    $('#jForm').classList.toggle('hidden', !S.allowSelfJoin);
    $('#jNameLbl').textContent = S.players.length ? 'Or type your name:' : 'Your name:';
    if (joinNeeded) return;
    // main
    const me = S.players.find(p => p.id === S.you);
    $('#me').textContent = me ? me.name : ''; $('#me').style.color = me ? me.color : '';
    $('#myScore').textContent = me ? `${me.score} pt${me.score === 1 ? '' : 's'}` : '';
    $('#phost').textContent = `Room ${room} · Host: ${S.hostName}`;
    const r = S.round, st = $('#pstatus'), btn = $('#buzz');
    const nm = id => (S.players.find(p => p.id === id) || { name: '?' }).name;
    let cls = '', txt = '', bl = 'LOCKED', bcls = '';
    if (!connected) { txt = 'Reconnecting…'; }
    else if (!r) { txt = 'Waiting for the host to start…'; }
    else if (S.revealed) { cls = 'rev'; txt = 'Answer revealed'; }
    else if (S.winner === S.you) { cls = 'win'; txt = '🔔 You buzzed first! Answer now!'; bl = "YOU'RE FIRST!"; bcls = 'win'; }
    else if (S.winner) { cls = 'other'; txt = `🔔 ${nm(S.winner)} buzzed first`; bl = `${nm(S.winner).toUpperCase()} BUZZED`; }
    else if (S.lockedOut.includes(S.you)) { cls = 'out'; txt = '✖ You’re locked out this round'; bl = 'LOCKED OUT'; }
    else if (S.buzzOpen) { cls = 'open'; txt = 'Buzzers OPEN: tap BUZZ!'; bl = pressed ? '…' : 'BUZZ!'; }
    else { txt = 'Buzzers locked'; }
    if (connected && r && !S.winner && S.last && S.last.type === 'correct' && !S.buzzOpen) txt += ` · ✔ ${nm(S.last.pid)} +${S.last.pts}`;
    st.className = 'pstatus ' + cls; st.textContent = txt;
    btn.textContent = bl; btn.disabled = !canBuzz() && bcls !== 'win';
    btn.className = 'buzz ' + bcls + (canBuzz() ? ' armed' : '') + (pressed ? ' pressed' : '');
    if (bcls === 'win') btn.disabled = true, btn.classList.add('win');
    $('#pprompt').textContent = r ? [r.title, r.prompt].filter(Boolean).join(': ') : '';
    $('#pprompt').classList.toggle('hidden', !r || (!r.title && !r.prompt));
    const showIds = r ? (S.revealed && r.a ? [r.a] : r.q) : [];
    renderImgPair($('#pimg'), showIds, id => cache.src(id), { empty: r ? '' : 'Waiting for the first round…', labels: !(S.revealed && r && r.a) });
    const ans = $('#pans');
    ans.classList.toggle('hidden', !(r && S.revealed && r.note));
    ans.textContent = r && S.revealed ? '✅ ' + (r.note || '') : '';
    const sc = $('#pscores'); sc.innerHTML = '';
    for (const p of S.players) sc.append(h('div', { class: 'chip' + (S.winner === p.id ? ' win' : '') + (S.lockedOut.includes(p.id) ? ' out' : '') + (p.id === S.you ? ' me' : ''), style: { borderColor: S.winner === p.id ? '' : p.color } }, p.name, h('b', null, String(p.score))));
  }
  $('#buzz').addEventListener('pointerdown', e => { e.preventDefault(); doBuzz(); });
  $('#buzz').addEventListener('click', e => { if (e.detail === 0) doBuzz(); });
  addEventListener('keydown', e => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) doBuzz(); }
  });
  $('#jForm').onsubmit = e => { e.preventDefault(); const n = $('#jName').value.trim(); if (!n) return; $('#jErr').textContent = ''; net.send({ t: 'join', name: n }); };
  $('#switch').onclick = () => { if (confirm('Pick a different name?')) { try { localStorage.removeItem(nameKey); } catch {} autoJoined = true; net.send({ t: 'leave' }); } };
  $('#jName').value = localStorage.getItem(nameKey) || '';
  net.start();
  window.__pb = { get S() { return S; }, net, cache, doBuzz };
}
/* =========================== STREAM (OBS) =========================== */
function startStream() {
  const room = normRoom(params.get('room'));
  if (room.length < 4) return startLanding('Enter the room code to open the stream view.');
  const bg = (params.get('bg') || 'dark').toLowerCase();
  const sound = params.get('sound') !== '0';
  document.title = 'Stream · Picture Buzzer';
  document.body.className = 'view-stream bg-' + (['dark', 'transparent', 'green', 'black'].includes(bg) ? bg : 'dark');
  $('#app').innerHTML = `
<div class="stream">
  <div class="s-top" id="sTop"><div class="s-panel s-round" id="sRound"></div><div class="s-panel s-title" id="sTitle"></div><div class="s-panel s-state" id="sState"></div><div class="s-panel s-host" id="sHost"></div></div>
  <div class="s-panel s-prompt hidden" id="sPrompt"></div>
  <div class="s-stage" id="sStage">
    <div class="imgarea" id="sImg"></div>
    <div class="s-answer hidden" id="sAns"></div>
    <div class="s-revealtag hidden" id="sRevTag">ANSWER</div>
    <div class="s-banner hidden" id="sBanner"></div>
    <div class="s-toast hidden" id="sToast"></div>
  </div>
  <div class="s-scores" id="sScores"></div>
</div>
<div class="s-flash" id="sFlash"></div>`;
  let S = null, connected = false, seenSeq = null, seenLast = null, connSt = 'loading';
  const net = new ClientNet(room, 'stream', {
    status: st => { connSt = st; connected = st === 'connected'; if (!connected) cache.reset(); render(); },
    msg: m => { if (cache.handle(m)) return; if (m.t === 'state') { S = m; onState(); } },
  });
  const cache = new ImageCache(net, () => { render(); wantImages(); });
  function wantImages() {
    if (!S || !S.round) return;
    const cur = S.round.q.concat(S.revealed && S.round.a ? [S.round.a] : []);
    cache.want(cur); if (cur.every(id => cache.has(id))) cache.want(S.prefetch || []);
  }
  function onState() {
    const nm = id => (S.players.find(p => p.id === id) || { name: '?' });
    if (seenSeq !== null && S.buzzSeq !== seenSeq && S.winner) {
      const f = $('#sFlash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
      const b = $('#sBanner'); b.classList.remove('pop', 'gone'); void b.offsetWidth; b.classList.add('pop');
      clearTimeout(onState._b); onState._b = setTimeout(() => b.classList.add('gone'), 2200);
      if (sound) sfx('buzz');
    }
    const lastKey = S.last ? S.last.at + S.last.type : null;
    if (seenLast !== null && lastKey && lastKey !== seenLast) {
      const t = $('#sToast'), p = nm(S.last.pid);
      t.className = 's-toast ' + S.last.type;
      t.textContent = S.last.type === 'correct' ? `✔ ${p.name} +${S.last.pts}` : `✖ ${p.name}`;
      clearTimeout(onState._t); onState._t = setTimeout(() => t.classList.add('hidden'), 2600);
      if (sound) sfx(S.last.type);
    }
    seenSeq = S.buzzSeq; seenLast = lastKey || '';
    wantImages(); render();
  }
  function render() {
    const stage = $('#sStage'), r = S && S.round;
    let wait = stage.querySelector('.s-wait');
    const waitMsg = !connected ? (connSt === 'nohost' ? 'Waiting for the host…' : (STATUS_TEXT[connSt] || 'Connecting…')) : (!r ? 'Get ready…' : null);
    $('#sTop').style.visibility = S ? '' : 'hidden';
    if (!S || !r) {
      if (!wait) { wait = h('div', { class: 's-wait' }); stage.prepend(wait); }
      wait.replaceChildren(waitMsg, h('small', null, S ? `${S.title} · hosted by ${S.hostName}` : 'Picture Buzzer'));
      $('#sImg').classList.add('hidden');
    } else { if (wait) wait.remove(); $('#sImg').classList.remove('hidden'); }
    if (!S) return;
    const nm = id => (S.players.find(p => p.id === id) || { name: '?', color: '#ffd23f' });
    $('#sRound').textContent = r ? `Round ${S.roundIndex + 1}/${S.roundCount}` : S.title;
    $('#sTitle').textContent = r ? (r.title || S.title) : '';
    $('#sHost').textContent = `Host: ${S.hostName}`;
    const st = $('#sState');
    if (!r) { st.className = 's-panel s-state locked'; st.textContent = ''; }
    else if (S.revealed) { st.className = 's-panel s-state rev'; st.textContent = 'ANSWER'; }
    else if (S.winner) { const p = nm(S.winner); st.className = 's-panel s-state winner'; st.textContent = `🔔 ${p.name.toUpperCase()}`; st.style.setProperty('--c', p.color); }
    else if (S.buzzOpen) { st.className = 's-panel s-state open'; st.textContent = '● BUZZERS OPEN'; }
    else { st.className = 's-panel s-state locked'; st.textContent = 'LOCKED'; }
    const pr = $('#sPrompt'); pr.textContent = r ? (r.prompt || '') : ''; pr.classList.toggle('hidden', !(r && r.prompt));
    const showAnsImg = !!(r && S.revealed && r.a);
    renderImgPair($('#sImg'), r ? (showAnsImg ? [r.a] : r.q) : [], id => cache.src(id), { labels: !showAnsImg });
    $('#sRevTag').classList.toggle('hidden', !showAnsImg);
    const ans = $('#sAns'); ans.classList.toggle('hidden', !(r && S.revealed && r.note));
    ans.replaceChildren(h('span', { class: 'lbl' }, 'ANSWER:'), r && S.revealed ? r.note || '' : '');
    const b = $('#sBanner');
    if (r && S.winner && !S.revealed) { const p = nm(S.winner); b.classList.remove('hidden'); b.style.setProperty('--c', p.color); b.textContent = `🔔 ${p.name}`; }
    else b.classList.add('hidden');
    const sc = $('#sScores'); sc.innerHTML = '';
    for (const p of S.players) sc.append(h('div', { class: 's-card' + (S.winner === p.id ? ' win' : '') + (r && S.lockedOut.includes(p.id) ? ' out' : '') + (p.connected ? '' : ' off'), style: { '--c': p.color } },
      h('span', { class: 'n' }, p.name), h('span', { class: 's' }, String(p.score))));
    for (const el of sc.children) el.style.setProperty('--c', el.style.getPropertyValue('--c'));
  }
  // B toggles background (handy when previewing in a normal browser)
  addEventListener('keydown', e => { if (e.key === 'b' || e.key === 'B') { const order = ['dark', 'transparent', 'green', 'black']; const cur = order.find(x => document.body.classList.contains('bg-' + x)) || 'dark'; document.body.classList.remove('bg-' + cur); document.body.classList.add('bg-' + order[(order.indexOf(cur) + 1) % order.length]); } });
  net.start();
  window.__pb = { get S() { return S; }, net, cache };
}
/* =========================== LANDING =========================== */
function startLanding(msg) {
  document.body.className = 'view-landing';
  $('#app').innerHTML = `
<div class="landing">
  <h1>🔔 Picture Buzzer</h1>
  <p class="muted" style="font-size:1.15rem">A real-time buzzer for picture-guessing games. The host runs the game, friends buzz in from their phones, and a clean stream view drops into OBS.</p>
  ${msg ? `<p style="color:var(--accent);font-weight:700">${msg}</p>` : ''}
  <div class="grid">
    <div class="card col"><h2>Host a game</h2><p class="muted" style="margin:0">Load images, add players, run the show.</p><button class="primary" id="goHost">Open host screen</button></div>
    <div class="card col"><h2>Join as a player</h2><input id="jRoom" class="code" placeholder="ROOM CODE" maxlength="12" style="font-size:1.4rem;text-transform:uppercase"><button class="green" id="goPlayer">Join</button></div>
    <div class="card col"><h2>Stream view</h2><input id="sRoom" class="code" placeholder="ROOM CODE" maxlength="12" style="text-transform:uppercase"><button id="goStream">Open stream view</button></div>
  </div>
  <p class="muted" style="margin-top:2rem;font-size:.85rem">Everything runs in your browser. No accounts. The host’s browser holds the game; players connect peer-to-peer (WebRTC via PeerJS).</p>
</div>`;
  const go = q => { location.href = baseUrl() + q; };
  $('#goHost').onclick = () => go('?view=host');
  $('#goPlayer').onclick = () => { const r = normRoom($('#jRoom').value); if (r.length >= 4) go('?view=player&room=' + r); else toast('Enter the room code'); };
  $('#goStream').onclick = () => { const r = normRoom($('#sRoom').value); if (r.length >= 4) go('?view=stream&room=' + r); else toast('Enter the room code'); };
  $('#jRoom').onkeydown = e => { if (e.key === 'Enter') $('#goPlayer').click(); };
  $('#sRoom').onkeydown = e => { if (e.key === 'Enter') $('#goStream').click(); };
}
/* =========================== BOOT =========================== */
(function boot() {
  const v = (params.get('view') || '').toLowerCase();
  if (v === 'host') startHost();
  else if (v === 'player' || v === 'play' || (!v && params.get('room'))) startPlayer();
  else if (v === 'stream' || v === 'obs') startStream();
  else startLanding();
})();
