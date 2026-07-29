// player.js — plays an item in the watch host. Dispatches by type:
//   youtube -> YT IFrame (nocookie, controls:0) with a custom HUD; near-end auto-return.
//   file    -> <video> with the same custom HUD; hybrid streaming -> download+cache on failure.
//
// HUD state machine (F1): HIDDEN / VISIBLE (3s timer) / PINNED (paused or dragging).
// One class drives it: .hud-on on #player-wrap; when hidden, the overlays also get
// pointer-events:none so taps fall through to #tap-shield.
// Tap model is "reveal first, then pause": when controls are hidden a tap only reveals
// them; when visible, a single tap in the middle 50% toggles play/pause; a double tap
// on the left/right half seeks ∓/±SEEK_STEP. While PLAYING everything auto-hides after
// HUD_HIDE_MS — 🏠 and ⛶ included — leaving bare video, like YouTube. Paused never hides.
//
// INVARIANTS (do not break — see DEVELOPMENT.md §12):
//   stop() only tears down; it NEVER calls onExit. Only finish() may.
//   setupHud() binds window listeners — it must never run twice without teardown().
//   The YouTube→YouTube reuse path (loadVideoById) must not call cleanup()/setupHud();
//   it swaps the mutable `cb` so finish() never fires a stale onExit closure.

import { prepareStreamSrc, downloadAndCache, captureFrame } from './media.js';
import { stripTimeHints } from './classify.js';
import { HUD_HIDE_MS, SEEK_STEP, TAP_DOUBLE_MS, TAP_SINGLE_DELAY } from './config.js';
import * as wake from './wake.js';

const $id = (id) => document.getElementById(id);
let ytApiPromise = null;
let current = null; // { cleanup, kind, reuse? }

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
  // Fast path: YouTube → YouTube switches reuse the live player (no black flash).
  if (item.type === 'youtube' && current && current.kind === 'youtube' && current.reuse) {
    try { current.reuse(item, opts); return; } catch { /* fall through to full restart */ }
  }
  stop();
  host.innerHTML = '';
  if (item.type === 'youtube') return playYouTube(item, host, opts);
  return playFile(item, host, opts);
}

/* ---------------- Shared HUD ----------------
   ctl: { getTime(), getDuration(), seekTo(sec), isPlaying(), togglePlay() } */
function setupHud(ctl) {
  const wrap = $id('player-wrap');
  const shield = $id('tap-shield');
  const seek = $id('seek');
  const fill = $id('seek-fill');
  const knob = $id('seek-knob');
  const fb = $id('seek-feedback');
  let fbTimer = null;
  let hideTimer = null;
  let dragging = false;
  let wasVisible = true;   // HUD visibility at the START of the current touch
  let lastPlaying = null;  // detects play/pause transitions from the heartbeat

  const setHud = (on) => { if (wrap) wrap.classList.toggle('hud-on', on); };
  const hideNow = () => setHud(false);
  // The single timer entry point. Playing → visible for HUD_HIDE_MS then hidden;
  // paused or dragging → visible with no timer (PINNED).
  const reveal = () => {
    setHud(true);
    clearTimeout(hideTimer);
    if (ctl.isPlaying() && !dragging) hideTimer = setTimeout(hideNow, HUD_HIDE_MS);
  };

  const renderProgress = () => {
    const d = ctl.getDuration() || 0;
    const t = ctl.getTime() || 0;
    const pct = d > 0 ? Math.max(0, Math.min(100, (t / d) * 100)) : 0;
    if (fill) fill.style.width = pct + '%';
    if (knob) knob.style.left = pct + '%';
    const playing = ctl.isPlaying();
    wake.set('play', playing); // F7 heartbeat — self-healing, can't miss a transition
    if (playing !== lastPlaying) { lastPlaying = playing; reveal(); } // pin on pause, re-arm on play
  };

  const flash = (txt) => {
    if (!fb) return;
    fb.textContent = txt;
    fb.classList.add('show');
    clearTimeout(fbTimer);
    fbTimer = setTimeout(() => fb.classList.remove('show'), 550);
  };

  // Any touch anywhere in the player (buttons included — capture phase) reveals the
  // HUD and re-arms the timer. wasVisible is captured HERE, before reveal(), so the
  // tap handler below knows whether this tap started on a hidden HUD.
  const onAnyTouch = () => { wasVisible = wrap.classList.contains('hud-on'); reveal(); };

  // Seek bar (LTR timeline): tap or drag anywhere on it to jump. Dragging pins the HUD.
  const fracFrom = (e) => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const seekFrac = (f) => { const d = ctl.getDuration() || 0; if (d > 0) { ctl.seekTo(f * d); renderProgress(); } };
  const onDown = (e) => { dragging = true; clearTimeout(hideTimer); setHud(true); seekFrac(fracFrom(e)); e.preventDefault(); };
  const onMove = (e) => { if (dragging) seekFrac(fracFrom(e)); };
  const onUp = () => { if (dragging) { dragging = false; reveal(); } };

  // Video-area taps: double left/right = seek; single center = play/pause, but ONLY
  // when the HUD was already visible ("reveal first, then pause") — a child poking a
  // bare video reveals the controls instead of stopping the show.
  let lastTap = 0;
  let tapTimer = null;
  const onTap = (e) => {
    const now = Date.now();
    const r = shield.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (now - lastTap < TAP_DOUBLE_MS) {
      clearTimeout(tapTimer);
      lastTap = 0;
      if (x < r.width / 2) { ctl.seekTo(Math.max(0, ctl.getTime() - SEEK_STEP)); flash('⏪ ' + SEEK_STEP); }
      else { ctl.seekTo(ctl.getTime() + SEEK_STEP); flash(SEEK_STEP + ' ⏩'); }
      renderProgress();
      reveal();
    } else {
      lastTap = now;
      const visible = wasVisible;
      const center = x > r.width * 0.25 && x < r.width * 0.75;
      tapTimer = setTimeout(() => { if (visible && center) { ctl.togglePlay(); reveal(); } }, TAP_SINGLE_DELAY);
    }
  };

  const onFsChange = () => reveal(); // show 🏠/⛶ for 3s on fullscreen enter/exit

  wrap.addEventListener('pointerdown', onAnyTouch, true);
  if (shield) shield.addEventListener('pointerup', onTap);
  if (seek) seek.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  const teardown = () => {
    wrap.removeEventListener('pointerdown', onAnyTouch, true);
    if (shield) shield.removeEventListener('pointerup', onTap);
    if (seek) seek.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    document.removeEventListener('fullscreenchange', onFsChange);
    document.removeEventListener('webkitfullscreenchange', onFsChange);
    clearTimeout(tapTimer);
    clearTimeout(fbTimer);
    clearTimeout(hideTimer);
    if (fill) fill.style.width = '0%';
    if (knob) knob.style.left = '0%';
    if (fb) fb.classList.remove('show');
    setHud(true); // next video starts with controls visible
    wake.release('play');
  };

  /** Used by the loadVideoById fast path — resets progress + shows the HUD. NEVER re-setup. */
  const reset = () => {
    lastTap = 0;
    lastPlaying = null;
    clearTimeout(tapTimer);
    if (fill) fill.style.width = '0%';
    if (knob) knob.style.left = '0%';
    if (fb) fb.classList.remove('show');
    reveal();
  };

  renderProgress();
  reveal();
  return { renderProgress, teardown, reset, reveal };
}

/* ---------------- YouTube ---------------- */
async function playYouTube(item, host, opts = {}) {
  await loadYouTubeApi();
  const mount = document.createElement('div');
  mount.id = 'yt-player-' + Date.now();
  host.appendChild(mount);

  let cb = opts;      // MUTABLE — reuse() swaps it (stale-onExit trap, see header)
  let player = null;
  let timer = null;
  let torn = false;
  let hud = null;
  let swapAt = 0;     // last loadVideoById time; guards the near-end check during swaps
  let ccLast = 0;

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

  // F2: kill captions/auto-translate overlays. Four ops, each in its own try/catch,
  // debounced (each is a cross-origin postMessage). Re-applied from onApiChange —
  // the canonical hook that fires exactly when the captions module loads — plus
  // onReady, PLAYING, and after every loadVideoById. NOT from the 250ms poll.
  const killCaptions = (force = false) => {
    const now = Date.now();
    if (!force && now - ccLast < 400) return;
    ccLast = now;
    try { player.unloadModule('captions'); } catch {}
    try { player.unloadModule('cc'); } catch {}
    try { player.setOption('captions', 'track', {}); } catch {}
    try { player.setOption('cc', 'track', {}); } catch {}
  };

  const cleanup = () => {
    if (torn) return;
    torn = true;
    if (timer) clearInterval(timer);
    if (hud) hud.teardown();
    try { player && player.stopVideo && player.stopVideo(); } catch {}
    try { player && player.destroy && player.destroy(); } catch {}
  };
  const finish = () => { const first = !torn; cleanup(); if (first && cb.onExit) cb.onExit(); };

  const reuse = (nextItem, nextOpts) => {
    if (torn || !player || !player.loadVideoById) throw new Error('not-reusable');
    cb = nextOpts || {};
    swapAt = Date.now();
    player.loadVideoById({ videoId: nextItem.id, startSeconds: 0 }); // F3: always from 0
    killCaptions(true);
    hud.reset();
  };

  current = { cleanup, kind: 'youtube', reuse };
  hud = setupHud(ctl);

  player = new YT.Player(mount.id, {
    videoId: item.id,
    host: 'https://www.youtube-nocookie.com',
    width: '100%', height: '100%',
    playerVars: {
      // controls:0 hides YouTube's whole bar; we draw our own HUD.
      rel: 0, iv_load_policy: 3, disablekb: 1, playsinline: 1,
      fs: 0, controls: 0, autoplay: 1, enablejsapi: 1,
      modestbranding: 1, origin: window.location.origin,
      cc_load_policy: 0, // F2 (do NOT set cc_lang_pref/hl — they can enable a track)
      start: 0           // F3 (classifyLink already dropped t=; this is belt-and-braces)
    },
    events: {
      onReady: (e) => {
        try { e.target.unMute(); e.target.setVolume(100); e.target.playVideo(); } catch {}
        killCaptions(true);
        hud.renderProgress();
        timer = setInterval(() => {
          try {
            const d = player.getDuration();
            const c = player.getCurrentTime();
            hud.renderProgress();
            // Leave before the end-screen recommendations. After loadVideoById,
            // getDuration() briefly reports the OLD video with currentTime≈0 — require
            // a swap grace period AND real progress, or the child gets bounced out.
            if (d > 0 && d - c <= 1.5 && Date.now() - swapAt > 1200 && c > 0.5) finish();
          } catch {}
        }, 250);
      },
      onApiChange: () => killCaptions(),
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED) { finish(); return; }
        if (e.data === YT.PlayerState.PLAYING) killCaptions();
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
  let forcedZero = false;
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
  current = { cleanup, kind: 'file' };
  hud = setupHud(ctl);

  video.addEventListener('timeupdate', onTime);
  video.addEventListener('loadedmetadata', onTime);
  video.addEventListener('play', onTime);
  video.addEventListener('pause', onTime);
  video.addEventListener('ended', finish);
  // F3: a media-fragment (#t=30) that survived somewhere WILL seek — force 0 once.
  video.addEventListener('loadedmetadata', () => {
    if (!forcedZero && video.currentTime > 0.5) { try { video.currentTime = 0; } catch {} }
    forcedZero = true; // once-only: never stomp a legitimate later seek
  });

  const play = (src) => { video.src = stripTimeHints(src); const p = video.play(); if (p && p.catch) p.catch(() => {}); };
  const first = await prepareStreamSrc(item);
  let downloading = false;
  play(first.src);

  if (!first.local) {
    video.addEventListener('error', async () => {
      if (downloading || torn) return;
      downloading = true;
      if (onStatus) onStatus('downloading');
      await wake.acquire('download'); // a long first-download must not let the screen sleep
      try {
        const res = await downloadAndCache(item);
        if (torn) return;
        if (onStatus) onStatus('');
        play(res.src);
      } catch (e) {
        if (onStatus) onStatus(String(e && e.message) === 'download-unsupported' ? 'unsupported' : 'error');
      } finally {
        wake.release('download');
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
