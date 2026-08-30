// ui/swipe.js — turn a page of tiles with a flick (v1.0.57, user request: "לדפדף גם על
// ידי גלילה ימינה ושמאלה על מסך האפליקציה — דפדוף על ידי האצבע").
//
// The blue arrows STAY. They are the only pager a TV remote can reach (a D-pad produces
// no pointer events at all), and they are what tells a child there is another page.
//
// THE DECISION IS PURE AND LIVES IN plan.swipePageAction — this module only collects the
// geometry. Everything below is the part node cannot test: pointer plumbing, and the two
// collisions that make a swipe on THIS app harder than a swipe on a carousel.
//
// 1. EVERY TILE IS A <button>, so the flick that turns the page ends ON a video. Without
//    the capture-phase click swallow below, turning the page also OPENS whatever the
//    finger happened to release over — with a mouse this is guaranteed (a drag still
//    fires a click on the common ancestor), and on touch it varies by WebView. The
//    suppression is a deadline, not a flag: a gesture that produces no click at all must
//    not leave a live trap that eats the child's NEXT real tap.
//
// 2. `pointercancel` IS BOUND NEXT TO `pointerup` — the invariant the seek bar paid for
//    in v1.0.22. The OS steals drags (the gesture inset, a scroll it decides to own), and
//    then no pointerup ever arrives; a start left standing would pair with some later,
//    unrelated release and flip a page nobody asked for.
//
// The host element must carry `touch-action: pan-y` (see .swipe-host in styles.css) —
// without it the browser claims a slightly-diagonal flick as a scroll and cancels the
// gesture before it ends. With it, vertical scrolling stays the browser's, horizontal
// stays ours, which is exactly the v1.0.52 split.

import { swipePageAction } from '../plan.js';

const CLICK_SWALLOW_MS = 700;

/**
 * attachSwipePager(el, onSwipe, getState)
 *  el       — the surface to listen on (a whole view, or one grid).
 *  onSwipe  — ('next'|'prev') => void, the same work the arrow buttons do.
 *  getState — () => ({ page, total }) READ AT GESTURE END. Never captured at attach time:
 *             the page and the page count change on every render, and a stale pair would
 *             let the child swipe past the last page (or refuse a legal flick).
 */
export function attachSwipePager(el, onSwipe, getState) {
  if (!el || typeof onSwipe !== 'function' || typeof getState !== 'function') return;

  let start = null;
  let swallowUntil = 0;

  el.addEventListener('pointerdown', (e) => {
    // A second finger means a pinch or a two-handed grab, never a page turn: drop the
    // gesture rather than measuring one finger's half of it.
    if (start) { start = null; return; }
    start = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
  }, { passive: true });

  el.addEventListener('pointerup', (e) => {
    const s = start;
    start = null;
    if (!s || (e.pointerId !== undefined && e.pointerId !== s.id)) return;
    let st = null;
    try { st = getState(); } catch { st = null; }
    if (!st) return;
    const action = swipePageAction({
      dx: e.clientX - s.x,
      dy: e.clientY - s.y,
      dt: Date.now() - s.t,
      page: st.page,
      total: st.total
    });
    if (!action) return;
    swallowUntil = Date.now() + CLICK_SWALLOW_MS;
    onSwipe(action);
  });

  el.addEventListener('pointercancel', () => { start = null; });

  // CAPTURE phase: the tile's own click handler is bound on the button itself, i.e. deeper
  // than this host, so a bubbling listener would run only after the video already opened.
  el.addEventListener('click', (e) => {
    if (Date.now() >= swallowUntil) return;
    swallowUntil = 0;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
