// ui/toast.js — a short message at the bottom of the screen (v1.0.26).
//
// The app had NO lightweight feedback channel: every outcome was either a full modal
// (which stacks badly and demands a tap) or nothing at all. Sharing a link from YouTube
// took the "nothing at all" path on EVERY route — success, parked-for-approval, and each
// of the seven silent failures alike — so a parent could not tell them apart.
//
// Deliberately not a modal: it must never block, never need dismissing, and never fight
// the PIN screen or a confirm dialog that is already up.

let hideTimer = null;

/** @param kind 'ok' | 'warn' | 'err' — colour only; the TEXT carries the meaning. */
export function toast(text, kind = 'ok', ms = 4200) {
  const el = document.getElementById('toast');
  if (!el || !text) return;
  clearTimeout(hideTimer);
  el.textContent = text;
  el.className = 'toast toast-' + kind;
  // restart the animation even when a toast is already on screen
  void el.offsetWidth;
  el.classList.add('toast-on');
  hideTimer = setTimeout(() => {
    el.classList.remove('toast-on');
    hideTimer = null;
  }, ms);
}
