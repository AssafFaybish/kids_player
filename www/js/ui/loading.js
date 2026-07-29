// ui/loading.js — the kids loading screen (F11). Four cycling scenes (horse, rocket,
// balloon, train) — emoji + CSS keyframes only, transform/opacity, NO JS animation
// loop (nothing may compete with the main thread). One innerHTML swap every 2600ms.
//
// Timing contract:
//   show({ defer })  — the view appears only if the operation outlives `defer` ms
//                      (a fast path never flashes a loading screen);
//   hide()           — once VISIBLE, honors a minimum display of MIN_SHOW_MS so a
//                      slow-ish path doesn't blink; resolves when done.
// The caller must ALWAYS reach hide() — wrap the awaited work in try/finally.

import * as nav from '../nav.js';

const MIN_SHOW_MS = 1200;
const CYCLE_MS = 2600;
const $ = (id) => document.getElementById(id);

const SCENES = [
  `<div class="load-scene scene-horse">
     <div class="scene-sprite">🐎</div>
     <div class="scene-ground"></div>
   </div>`,
  `<div class="load-scene scene-rocket">
     <div class="scene-sprite">🚀</div>
     <div class="spark s1"></div><div class="spark s2"></div><div class="spark s3"></div>
     <div class="star st1">✦</div><div class="star st2">✧</div><div class="star st3">✦</div>
   </div>`,
  `<div class="load-scene scene-balloon">
     <div class="scene-sprite">🎈</div>
     <div class="cloud c1">☁️</div><div class="cloud c2">☁️</div>
   </div>`,
  `<div class="load-scene scene-train">
     <div class="scene-sprite">🚂</div>
     <div class="puff">☁️</div>
   </div>`
];

let deferTimer = null;
let cycleTimer = null;
let shownAt = 0;
let order = [];
let idx = 0;

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function nextScene() {
  if (idx >= order.length) { order = shuffle(SCENES); idx = 0; }
  $('load-stage').innerHTML = order[idx];
  idx += 1;
}

function reveal() {
  shownAt = Date.now();
  order = shuffle(SCENES);
  idx = 0;
  nextScene();
  clearInterval(cycleTimer);
  cycleTimer = setInterval(nextScene, CYCLE_MS);
  nav.go('loading');
}

/** Show after `defer` ms unless hide() lands first. Safe to call repeatedly. */
export function show({ defer = 250, step = '' } = {}) {
  setStep(step);
  if (shownAt || deferTimer) return;
  if (defer <= 0) { reveal(); return; }
  deferTimer = setTimeout(() => { deferTimer = null; reveal(); }, defer);
}

export function setStep(text) {
  const el = $('load-sub');
  if (el) el.textContent = text || '';
}

/** Resolves after the minimum display time (if the view ever appeared). */
export async function hide() {
  clearTimeout(deferTimer);
  deferTimer = null;
  if (!shownAt) return; // never appeared — nothing to wait for
  const left = Math.max(0, MIN_SHOW_MS - (Date.now() - shownAt));
  if (left) await new Promise((r) => setTimeout(r, left));
  clearInterval(cycleTimer);
  cycleTimer = null;
  shownAt = 0;
  if (nav.isActive('loading')) nav.back() || nav.reset('gallery');
}

/** Registered once from app.js: back is swallowed — a child can't escape mid-load. */
export function registerLoadingView() {
  nav.register('loading', { onBack: () => true });
}
