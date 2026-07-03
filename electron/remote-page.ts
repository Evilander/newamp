// NewAmp Remote — the phone page. One self-contained HTML string, no build
// step, no framework: big transport buttons, live art, scrub + volume, all
// driven by the token-gated /now/events SSE stream and POST /control.
//
// Auth model: the token rides the URL #fragment (fragments never reach
// servers or logs). The page stores it in sessionStorage and presents it as
// the x-newamp-token header on every request. This shell itself contains no
// data and is served unauthenticated.

export function remotePageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0e0d10">
<title>NewAmp Remote</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; height: 100%; background: #0e0d10; color: #e3e1e6;
    font: 15px/1.4 -apple-system, system-ui, "Segoe UI", sans-serif; overscroll-behavior: none; }
  #app { display: flex; flex-direction: column; align-items: center; gap: 18px;
    min-height: 100%; padding: max(24px, env(safe-area-inset-top)) 20px max(28px, env(safe-area-inset-bottom)); }
  .brand { font: 700 12px ui-monospace, monospace; letter-spacing: 0.28em; color: #98ffd1; }
  #art { width: min(78vw, 340px); height: min(78vw, 340px); border-radius: 14px;
    background: #1a181d center/cover no-repeat; border: 1px solid #2b2731;
    box-shadow: 0 18px 60px rgba(0,0,0,0.55); }
  #title { font-size: 20px; font-weight: 700; text-align: center; max-width: 90vw;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #artist { color: #918aa0; text-align: center; max-width: 90vw; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .row { display: flex; align-items: center; gap: 10px; width: min(92vw, 420px); }
  input[type=range] { flex: 1; accent-color: #98ffd1; height: 28px; }
  .time { font: 12px ui-monospace, monospace; color: #918aa0; min-width: 44px; text-align: center; }
  .transport { display: flex; align-items: center; gap: 22px; margin-top: 4px; }
  button { border: 1px solid #2b2731; background: #1a181d; color: #e3e1e6;
    border-radius: 999px; cursor: pointer; display: grid; place-items: center; }
  button:active { background: #262230; }
  .skip { width: 66px; height: 66px; font-size: 24px; }
  #play { width: 92px; height: 92px; font-size: 36px; background: #98ffd1; color: #0e0d10; border: none; }
  #status { color: #6f6a78; font-size: 12px; min-height: 16px; text-align: center; }
  #gate { display: none; text-align: center; color: #918aa0; padding: 40px 24px; }
</style>
</head>
<body>
<div id="app">
  <div class="brand">NEWAMP REMOTE</div>
  <div id="art"></div>
  <div id="title">—</div>
  <div id="artist">Connecting…</div>
  <div class="row">
    <span class="time" id="cur">0:00</span>
    <input type="range" id="seek" min="0" max="100" step="1" value="0" aria-label="Seek">
    <span class="time" id="dur">0:00</span>
  </div>
  <div class="transport">
    <button class="skip" id="prev" aria-label="Previous">&#9198;</button>
    <button id="play" aria-label="Play or pause">&#9654;</button>
    <button class="skip" id="next" aria-label="Next">&#9197;</button>
  </div>
  <div class="row">
    <span class="time">vol</span>
    <input type="range" id="vol" min="0" max="2" step="0.01" value="0.75" aria-label="Volume">
  </div>
  <div id="status"></div>
</div>
<div id="gate">
  <p>This remote needs its link token.</p>
  <p>Open <b>Settings &rarr; Radio Brain</b> in NewAmp and scan the QR code again.</p>
</div>
<script>
(function () {
  var hashToken = location.hash ? location.hash.slice(1) : '';
  if (hashToken) {
    try { sessionStorage.setItem('newamp-remote-token', hashToken); } catch (e) {}
    // Scrub the token out of the visible URL/history.
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }
  var token = '';
  try { token = sessionStorage.getItem('newamp-remote-token') || ''; } catch (e) {}
  if (!token) {
    document.getElementById('app').style.display = 'none';
    document.getElementById('gate').style.display = 'block';
    return;
  }

  var el = function (id) { return document.getElementById(id); };
  var state = null;
  var receivedAt = 0;
  var scrubbing = false;
  var volDragging = false;

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    var s = Math.floor(sec);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function livePosition() {
    if (!state) return 0;
    if (!state.isPlaying) return state.position;
    return Math.min(state.duration || Infinity, state.position + (Date.now() - receivedAt) / 1000);
  }

  function render() {
    if (!state || state.trackId == null && !state.title) {
      el('title').textContent = '—';
      el('artist').textContent = 'Nothing playing';
      el('play').textContent = '▶';
      el('art').style.backgroundImage = 'none';
      return;
    }
    el('title').textContent = state.title || 'Unknown track';
    el('artist').textContent = state.artist || '';
    el('play').textContent = state.isPlaying ? '❚❚' : '▶';
    if (typeof state.trackId === 'number' && isFinite(state.trackId)) {
      el('art').style.backgroundImage =
        'url(/art/' + Math.floor(state.trackId) + '?token=' + encodeURIComponent(token) + ')';
    }
  }

  function tick() {
    if (state && !scrubbing) {
      var pos = livePosition();
      el('cur').textContent = fmt(pos);
      el('dur').textContent = fmt(state.duration);
      var seek = el('seek');
      seek.max = String(Math.max(1, Math.round(state.duration || 0)));
      seek.value = String(Math.round(pos));
    }
    if (state && !volDragging && typeof state.volume === 'number') {
      el('vol').value = String(state.volume);
    }
  }
  setInterval(tick, 500);

  function connect() {
    var es = new EventSource('/now/events?token=' + encodeURIComponent(token));
    es.onmessage = function (event) {
      try { state = JSON.parse(event.data); } catch (e) { return; }
      receivedAt = Date.now();
      el('status').textContent = '';
      render();
      tick();
    };
    es.onerror = function () {
      el('status').textContent = 'Reconnecting…';
      es.close();
      setTimeout(connect, 2500);
    };
  }
  connect();

  function control(cmd, arg) {
    var body = arg === undefined ? { cmd: cmd } : { cmd: cmd, arg: arg };
    fetch('/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-newamp-token': token },
      body: JSON.stringify(body),
    }).catch(function () { el('status').textContent = 'Command failed — is NewAmp running?'; });
  }

  el('play').addEventListener('click', function () { control('togglePlay'); });
  el('prev').addEventListener('click', function () { control('prev'); });
  el('next').addEventListener('click', function () { control('next'); });

  var seek = el('seek');
  seek.addEventListener('pointerdown', function () { scrubbing = true; });
  function finishSeek() {
    if (!scrubbing) return;
    scrubbing = false;
    control('seek', Number(seek.value));
  }
  seek.addEventListener('pointerup', finishSeek);
  seek.addEventListener('pointercancel', finishSeek);
  seek.addEventListener('change', finishSeek);

  var vol = el('vol');
  var volTimer = 0;
  vol.addEventListener('pointerdown', function () { volDragging = true; });
  vol.addEventListener('input', function () {
    if (volTimer) return;
    volTimer = setTimeout(function () { volTimer = 0; control('setVolume', Number(vol.value)); }, 80);
  });
  function finishVol() {
    if (!volDragging) return;
    volDragging = false;
    if (volTimer) { clearTimeout(volTimer); volTimer = 0; }
    control('setVolume', Number(vol.value));
  }
  vol.addEventListener('pointerup', finishVol);
  vol.addEventListener('pointercancel', finishVol);
})();
</script>
</body>
</html>`;
}
