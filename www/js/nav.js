// nav.js — explicit view stack (no router, no history entries).
// LAYERING RULE: nav.js imports NOTHING from views/* — views register their handlers
// via register() at mount time. It may import ui/* (modal) and platform primitives.
//
// HARDWARE BACK: registering Capacitor's backButton listener disables ALL default
// handling (verified in AppPlugin.java) — an unhandled view would mean a dead back
// button. handleBack() therefore ends in a catch-all swallow, never a fall-through.
// Precedence: fullscreen → modal → current view's onBack → pop → swallow.

import { isModalOpen, closeModal } from './ui/modal.js';

const stack = [];
const views = {}; // name -> { onEnter(entry), onLeave(entry), onBack(entry): boolean }

export function register(name, handlers = {}) { views[name] = handlers; }

export function current() { return stack[stack.length - 1] || null; }
export function depth() { return stack.length; }
export function isActive(name) { const c = current(); return !!c && c.name === name; }

function applyView(name) {
  for (const v of document.querySelectorAll('.view')) v.classList.remove('active');
  const el = document.getElementById('view-' + name);
  if (el) el.classList.add('active');
}

function saveScroll(entry) {
  if (!entry) return;
  const se = document.scrollingElement || document.documentElement;
  entry.state.scrollY = se.scrollTop;
}

function transition(entry, prev, { restoreScroll = false } = {}) {
  // onLeave receives the NEXT entry too — watch→watch must not tear the player down
  // (the loadVideoById reuse path depends on it staying alive).
  if (prev && views[prev.name] && views[prev.name].onLeave) { try { views[prev.name].onLeave(prev, entry); } catch {} }
  applyView(entry.name);
  if (views[entry.name] && views[entry.name].onEnter) { try { views[entry.name].onEnter(entry); } catch {} }
  if (restoreScroll) {
    const y = (entry.state && entry.state.scrollY) || 0;
    // double rAF: let the view re-render before restoring (img width/height keep layout stable)
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));
  } else {
    window.scrollTo(0, 0);
  }
}

export function go(name, params = {}) {
  const prev = current();
  saveScroll(prev);
  const entry = { name, params, state: {} };
  stack.push(entry);
  transition(entry, prev);
}

/** Swap the top entry (e.g. watch→watch from the under-player grid: back skips the chain). */
export function replace(name, params = {}) {
  const prev = stack.pop() || null;
  const entry = { name, params, state: {} };
  stack.push(entry);
  transition(entry, prev);
}

export function reset(name, params = {}) {
  const prev = current();
  stack.length = 0;
  const entry = { name, params, state: {} };
  stack.push(entry);
  transition(entry, prev);
}

export function back() {
  if (stack.length <= 1) return false;
  const prev = stack.pop();
  transition(current(), prev, { restoreScroll: true });
  return true;
}

/**
 * PURE decision core for the hardware back button — unit-tested in test/nav.test.mjs.
 * viewConsumesBack: the current view's onBack() said it handled the event.
 */
export function resolveBack({ depth, fullscreen = false, modal = false, viewConsumesBack = false, askView = null }) {
  if (fullscreen) return 'exit-fullscreen';
  if (modal) return 'close-modal';
  // `askView` lets the live caller defer the view's onBack (which has side effects) until
  // it is actually this step's turn; tests pass the plain boolean instead.
  const consumed = askView ? !!askView() : !!viewConsumesBack;
  if (consumed) return 'view';
  if (depth > 1) return 'pop';
  return 'swallow';
}

/**
 * The single hardware-back handler. Always consumes the event (catch-all swallow).
 *
 * It DELEGATES the precedence decision to `resolveBack` rather than re-implementing it.
 * That matters: the chain used to exist twice — once here and once in `resolveBack`, which
 * had no caller at all — so `test/nav.test.mjs` pinned a copy nothing ran. Reordering the
 * modal and fullscreen checks here, or dropping the final swallow (which is what stops
 * Android's default back from exiting the app under a 5-year-old), left every test green.
 */
export function handleBack() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  const c = current();
  const h = c && views[c.name];
  // The view is ASKED only when it is its turn — onBack has side effects (askExit, etc.),
  // so it must not run while fullscreen or a modal is still open.
  const askView = () => {
    if (!h || !h.onBack) return false;
    try { return !!h.onBack(c); } catch { return false; }
  };
  const action = resolveBack({
    depth: depth(),
    fullscreen: !!fsEl,
    modal: isModalOpen(),
    viewConsumesBack: undefined, // evaluated lazily below — see askView
    askView
  });
  if (action === 'exit-fullscreen') {
    try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch {}
    return true;
  }
  if (action === 'close-modal') { closeModal(false); return true; }
  if (action === 'view') return true;      // the view handled it
  if (action === 'pop') { back(); return true; }
  return true; // swallow — NEVER let the Android default (app exit) run
}
