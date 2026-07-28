// player.js — plays an item in the watch host. Dispatches by type:
//   youtube -> YT IFrame (nocookie, controls:0) with a custom HUD; near-end auto-return.
//   file    -> <video> with the same custom HUD; hybrid streaming -> download+cache on failure.
// The HUD (play/pause, red seek bar with drag/tap, double-tap ±5s) is shared and driven through a
// small `ctl` abstraction so both engines behave identically (YouTube-like).
import { prepareStreamSrc, downloadAndCache, captureFrame } from './media.js';

const $id = (id) => document.getElementById(id);
let ytApiPromise = null;
let current = null; // { cleanup }

function loadYouTubeApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch {} resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

export function stop() {
  if (current && current.cleanup) { try { current.cleanup(); } catch {} }
  current = null;
}

export async function playItem(item, host, opts = {}) {
  stop();
  host.innerHTML = '';
  if (item.type === 'youtube') return playYouTube(item, host, opts);
  return playFile(item, host, opts);
}

/* ---------------- Shared HUD ----------------
   ctl: { getTime(), getDuration(), seekTo(sec), isPlaying(), togglePlay() } */
function setupHud(ctl) {
  const shield = $id('tap-shield');
  const playBtn = $id('ctl-play');
  const seek = $id('seek');
  const fill = $id('seek-fill');
  const knob = $id('seek-knob');
  const fb = $id('seek-feedback');
  let fbTimer = null;

  const setPlayIcon = (playing) => { if (playBtn) playBtn.textContent = playing ? '⏸' : '▶'; };
  const renderProgress = () => {
    const d = ctl.getDuration() || 0;
    const t = ctl.getTime() || 0;
    const pct = d > 0 ? Math.max(0, Math.min(100, (t / d) * 100)) : 0;
    if (fill) fill.style.width = pct + '%';
    if (knob) knob.style.left = pct + '%';
    setPlayIcon(ctl.isPlaying());
  };
  const flash = (txt) => {
    if (!fb) return;
    fb.textContent = txt;
    fb.classList.add('show');
    clearTimeout(fbTimer);
    fbTimer = setTimeout(() => fb.classList.remove('show'), 550);
  };

  // Seek bar (LTR timeline): tap or drag anywhere on it to jump.
  let dragging = false;
  const fracFrom = (e) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const seekFrac = (f) => { const d = ctl.getDuration() || 0; if (d > 0) { ctl.seekTo(f * d); renderProgress(); } };
  const onDown = (e) => { dragging = true; seekFrac(fracFrom(e)); e.preventDefault(); };
  const onMove = (e) => { if (dragging) seekFrac(fracFrom(e)); };
  const onUp = () => { dragging = false; };
  if (seek) seek.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  // Video-area taps: single = play/pause; double left/right = -5s / +5s (YouTube-style).
  let lastTap = 0;
  let tapTimer = null;
  const onTap = (e) => {
    const now = Date.now();
    const r = shield.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (now - lastTap < 300) {
      clearTimeout(tapTimer);
      lastTap = 0;
      if (x < r.width / 2) { ctl.seekTo(Math.max(0, ctl.getTime() - 5)); flash('⏪ 5'); }
      else { ctl.seekTo(ctl.getTime() + 5); flash('5 ⏩'); }
      renderProgress();
    } else {
      lastTap = now;
      tapTimer = setTimeout(() => { ctl.togglePlay(); }, 280);
    }
  };
  if (shield) shield.addEventListener('pointerup', onTap);
  if (playBtn) playBtn.onclick = () => ctl.togglePlay();

  const teardown = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (seek) seek.removeEventListener('pointerdown', onDown);
    if (shield) shield.removeEventListener('pointerup', onTap);
    clearTimeout(tapTimer);
    clearTimeout(fbTimer);
    if (playBtn) playBtn.onclick = null;
    if (fill) fill.style.width = '0%';
    if (knob) knob.style.left = '0%';
    if (fb) fb.classList.remove('show');
  };

  renderProgress();
  return { renderProgress, teardown };
}

/* ---------------- YouTube ---------------- */
async function playYouTube(item, host, { onExit } = {}) {
  await loadYouTubeApi();
  const mount = document.createElement('div');
  mount.id = 'yt-player-' + Date.now();
  host.appendChild(mount);

  let player = null;
  let timer = null;
  let torn = false;
  let hud = null;

  const ctl = {
    getTime: () => { try { return player.getCurrentTime(); } catch { return 0; } },
    getDuration: () => { try { return player.getDuration(); } catch { return 0; } },
    seekTo: (s) => { try { player.seekTo(Math.max(0, s), true); } catch {} },
    isPlaying: () => { try { const st = player.getPlayerState(); return st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING; } catch { return false; } },
    togglePlay: () => {
      try {
        const st = player.getPlayerState();
        if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING) player.pauseVideo();
        else player.playVideo();
      } catch {}
    }
  };

  const cleanup = () => {
    if (torn) return;
    torn = true;
    if (timer) clearInterval(timer);
    if (hud) hud.teardown();
    try { player && player.stopVideo && player.stopVideo(); } catch {}
    try { player && player.destroy && player.destroy(); } catch {}
  };
  const finish = () => { const first = !torn; cleanup(); if (first && onExit) onExit(); };
  current = { cleanup };
  hud = setupHud(ctl);

  player = new YT.Player(mount.id, {
    videoId: item.id,
    host: 'https://www.youtube-nocookie.com',
    width: '100%', height: '100%',
    playerVars: {
      // controls:0 hides YouTube's whole bar; we draw our own HUD (play/pause + seek + double-tap).
      rel: 0, iv_load_policy: 3, disablekb: 1, playsinline: 1,
      fs: 0, controls: 0, autoplay: 1, enablejsapi: 1,
      modestbranding: 1, origin: window.location.origin
    },
    events: {
      onReady: (e) => {
        try { e.target.unMute(); e.target.setVolume(100); e.target.playVideo(); } catch {}
        try { e.target.unloadModule('captions'); e.target.unloadModule('cc'); } catch {} // hide subtitles
        hud.renderProgress();
        timer = setInterval(() => {
          try {
            const d = player.getDuration();
            const c = player.getCurrentTime();
            hud.renderProgress();
            if (d > 0 && d - c <= 1.5) finish(); // leave before the end-screen recommendations
          } catch {}
        }, 250);
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) { finish(); return; }
        hud.renderProgress();
      },
      onError: () => { setTimeout(finish, 400); }
    }
  });
}

/* ---------------- Direct file ---------------- */
async function playFile(item, host, { onExit, onStatus, onThumb } = {}) {
  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.controls = false; // we provide our own HUD
  video.autoplay = true;
  video.preload = 'auto';
  video.volume = 1;     // always full; the tablet's volume buttons control loudness
  video.muted = false;
  host.appendChild(video);

  let torn = false;
  let hud = null;
  const ctl = {
    getTime: () => video.currentTime || 0,
    getDuration: () => video.duration || 0,
    seekTo: (s) => { try { video.currentTime = Math.max(0, s); } catch {} },
    isPlaying: () => !video.paused,
    togglePlay: () => { if (video.paused) { const p = video.play(); if (p && p.catch) p.catch(() => {}); } else video.pause(); }
  };
  const onTime = () => { if (hud) hud.renderProgress(); };

  const cleanup = () => {
    if (torn) return;
    torn = true;
    if (hud) hud.teardown();
    video.removeEventListener('timeupdate', onTime);
    video.removeEventListener('loadedmetadata', onTime);
    video.removeEventListener('play', onTime);
    video.removeEventListener('pause', onTime);
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
  };
  const finish = () => { const first = !torn; cleanup(); if (first && onExit) onExit(); };
  current = { cleanup };
  hud = setupHud(ctl);

  video.addEventListener('timeupdate', onTime);
  video.addEventListener('loadedmetadata', onTime);
  video.addEventListener('play', onTime);
  video.addEventListener('pause', onTime);
  video.addEventListener('ended', finish);

  const play = (src) => { video.src = src; const p = video.play(); if (p && p.catch) p.catch(() => {}); };
  const first = await prepareStreamSrc(item);
  let downloading = false;
  play(first.src);

  if (!first.local) {
    video.addEventListener('error', async () => {
      if (downloading || torn) return;
      downloading = true;
      if (onStatus) onStatus('downloading');
      try {
        const res = await downloadAndCache(item);
        if (torn) return;
        if (onStatus) onStatus('');
        play(res.src);
      } catch (e) {
        if (onStatus) onStatus(String(e && e.message) === 'download-unsupported' ? 'unsupported' : 'error');
      }
    });
  }

  if (!item.thumb && onThumb) {
    video.addEventListener('loadeddata', () => {
      const data = captureFrame(video);
      if (data) onThumb(data);
    }, { once: true });
  }
}
