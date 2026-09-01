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

import { swipePageAction, swipeDragArm, swipeDragOffset, swipeDragCommit } from '../plan.js';
import { SWIPE_SNAP_MS } from '../config.js';

const CLICK_SWALLOW_MS = 700;

/**
 * attachSwipePager(el, onSwipe, getState, live)
 *  el       — the surface to listen on (a whole view, or one grid).
 *  onSwipe  — ('next'|'prev') => void, the same work the arrow buttons do.
 *  getState — () => ({ page, total }) READ AT GESTURE END. Never captured at attach time:
 *             the page and the page count change on every render, and a stale pair would
 *             let the child swipe past the last page (or refuse a legal flick).
 *  live     — OPTIONAL { viewport, grid, renderPage } (v1.0.62). With it the page follows
 *             the finger and the neighbour slides in beside it; without it the old
 *             flick-on-release behaviour is exactly what happens.
 *
 * v1.0.62 — THE LIVE TRACK IS AN ADDITION, NEVER A REPLACEMENT, and that is a safety
 * property rather than politeness. `renderPage` is async (it reads the database), the
 * viewport can be missing, and a grid can re-render under the finger — so every one of
 * those falls back to `swipePageAction` on release, which is the path that has been
 * shipping since v1.0.57 and is what a TV remote and a mouse still use.
 */
export function attachSwipePager(el, onSwipe, getState, live = null) {
  if (!el || typeof onSwipe !== 'function' || typeof getState !== 'function') return;
  const vp = live && live.viewport;
  const grid = live && live.grid;
  const renderPage = live && typeof live.renderPage === 'function' ? live.renderPage : null;
  const canLive = !!(vp && grid && renderPage);

  let start = null;
  let swallowUntil = 0;
  let drag = null;   // { dir, width, edge, ghost } once the grid is actually moving
  let seq = 0;       // invalidates a ghost render that lands after its gesture ended

  const setX = (px) => {
    grid.style.transform = px ? `translateX(${px}px)` : '';
    if (drag && drag.ghost) {
      // the neighbour sits one full width away on the side it is coming FROM, and travels
      // with the current page: 'next' enters from the left, 'prev' from the right (RTL)
      const base = drag.dir === 'next' ? -drag.width : drag.width;
      drag.ghost.style.transform = `translateX(${base + px}px)`;
    }
  };

  let pending = null;   // a committed turn whose settle animation has not finished yet

  /**
   * Put everything back the way the renderer expects to find it — and FLUSH a committed
   * turn that has not run yet.
   *
   * ⚠️ The flush is not tidiness. A child flipping pages quickly starts the next gesture
   * inside the 220ms settle, and without this that pointerdown would cancel the settle and
   * the page turn it was carrying: the first swipe would be silently lost, and the faster
   * they swipe the more pages disappear.
   */
  const clearDrag = () => {
    seq += 1;
    const token = seq;
    const d = drag;
    drag = null;                       // a new gesture must never adopt this one's state
    const run = pending; pending = null;

    const reset = () => {
      // OUR ghost, by reference — removed even if a newer gesture has taken over the grid
      if (d && d.ghost && d.ghost.parentNode) d.ghost.remove();
      if (token !== seq) return;       // a newer gesture owns the transform now
      if (grid) { grid.style.transform = ''; grid.style.willChange = ''; }
      if (vp) vp.classList.remove('swiping', 'snapping');
    };

    if (!run) { reset(); return; }
    // ⚠️ THE PAGE IS RENDERED WHILE THE GRID IS STILL TRANSLATED OFF-SCREEN, and only then
    // is the transform cleared. The old order did the opposite — ghost away, transform to 0,
    // THEN render — so for the frames until the (async) render landed, the grid sat at rest
    // still holding the PREVIOUS page: the flicker reported from a device ("אחרי שמדפדפים
    // יש ריצוד ולרגע הדף הקודם מוצג"). The comment on the commit path already promised this
    // order; the code did not.
    //
    // The render is awaited BY VALUE, not by a timer: every onSwipe returns the promise of
    // its own render, so the swap happens exactly when the new content exists.
    Promise.resolve().then(run).catch(() => {}).then(reset);
  };

  /**
   * Settle: animate to `px`, then hand control back. `after` runs once the animation is
   * over — for a committed turn that is the real page change, so the new page is rendered
   * behind a grid that is already sitting where the ghost was, and the swap is invisible.
   */
  const settle = (px, after) => {
    if (!vp || !grid) { if (after) after(); return; }
    const token = seq;
    pending = after || null;
    vp.classList.add('snapping');
    setX(px);
    const done = () => {
      if (token !== seq) return;   // a new gesture started; clearDrag already flushed it
      clearDrag();                 // …which runs `pending`, i.e. `after`
    };
    let fired = false;
    const once = () => { if (fired) return; fired = true; grid.removeEventListener('transitionend', once); done(); };
    grid.addEventListener('transitionend', once);
    // A transition that never runs fires no event — a zero-distance settle, a hidden tab, or
    // prefers-reduced-motion. The timer is the floor, not the primary path.
    setTimeout(once, SWIPE_SNAP_MS + 60);
  };

  // v1.0.62 — a grid that re-renders mid-gesture (a sync landing, a Drive pull applying)
  // would otherwise be left translated, with a ghost of a page that no longer exists. The
  // renderer clears the grid's children, so watching for that is the honest signal.
  if (canLive) {
    el.addEventListener('kp:gridrender', () => { if (drag) clearDrag(); });
  }

  el.addEventListener('pointerdown', (e) => {
    // ALWAYS a fresh gesture — never "a start already exists, so drop this one".
    //
    // MEASURED (2026-08-30, browser): that guard was written for a second finger and its
    // real effect was to EAT THE CHILD'S NEXT SWIPE whenever an end went missing, then
    // work again, then eat one — the flakiness that makes an app feel broken. An end goes
    // missing for ordinary reasons: the grid re-renders under the finger (a sync landing, a
    // Drive pull applying) and the pointerup fires on a node no longer in the tree, so it
    // never reaches this host; or the app is backgrounded mid-touch by an incoming call.
    //
    // Multi-touch is still refused, by the pointerId check on the release instead: a second
    // finger overwrites this start, and then NEITHER release matches (the first carries the
    // wrong id, the second finds no start), so a pinch turns no page. Same protection, no
    // way to poison the gesture that follows.
    if (drag) clearDrag();   // a previous gesture that never ended cleanly
    start = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId };
  }, { passive: true });

  if (canLive) el.addEventListener('pointermove', (e) => {
    const s = start;
    if (!s || (e.pointerId !== undefined && e.pointerId !== s.id)) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!drag) {
      // ARM. Deciding this DURING the move (rather than at release, as the fallback does)
      // is what the live feedback costs: a movement that is not clearly horizontal is a
      // SCROLL, and arming on it would make the grid jitter sideways every time the child
      // scrolls the page. `swipeDragArm` answers null until it is sure.
      const dir = swipeDragArm({ dx, dy });
      if (!dir) return;
      let st = null;
      try { st = getState(); } catch { st = null; }
      if (!st) return;
      const width = vp.clientWidth || 0;
      if (!width) return;
      // Is there a page that way? If not the drag still arms — the rubber band is how the
      // first/last page ANSWERS (the user's decision), instead of the screen reading frozen.
      const edge = dir === 'next'
        ? !(Number(st.page) < Number(st.total) - 1)
        : !(Number(st.page) > 0);
      drag = { dir, width, edge, ghost: null };
      vp.classList.add('swiping');
      grid.style.willChange = 'transform';
      if (!edge) {
        // The neighbour is rendered NOW, with the finger already moving — the one place
        // this feature pays for itself in latency. A render that lands after the gesture
        // ended belongs to nobody, which is what the token check is for; and if it never
        // lands, the release simply falls through to the non-live path.
        const token = ++seq;
        const ghost = document.createElement(grid.tagName);
        ghost.className = grid.className + ' swipe-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        Promise.resolve(renderPage(Number(st.page) + (dir === 'next' ? 1 : -1), ghost))
          .then(() => {
            if (token !== seq || !drag) return;
            drag.ghost = ghost;
            vp.appendChild(ghost);
            setX(swipeDragOffset({ dx: e.clientX - s.x, dir: drag.dir, width: drag.width, edge: false }));
          })
          .catch(() => {});
      }
    }
    setX(swipeDragOffset({ dx, dir: drag.dir, width: drag.width, edge: drag.edge }));
  }, { passive: true });

  el.addEventListener('pointerup', (e) => {
    const s = start;
    start = null;
    if (!s || (e.pointerId !== undefined && e.pointerId !== s.id)) { if (drag) settle(0); return; }
    // THE LIVE PATH: what the child SEES decides, so the rule is the relative one and the
    // page they are looking at is the page they get.
    if (drag) {
      const d = drag;
      const dx = e.clientX - s.x;
      const commit = !!d.ghost && swipeDragCommit({ dx, dir: d.dir, width: d.width, edge: d.edge });
      swallowUntil = Date.now() + CLICK_SWALLOW_MS;   // the release lands ON a tile either way
      if (commit) {
        // Animate to a full page, THEN turn: the real render happens behind a grid already
        // sitting where the ghost was, so the swap itself is never seen.
        settle(d.dir === 'next' ? d.width : -d.width, () => onSwipe(d.dir));
      } else {
        settle(0);
      }
      return;
    }
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

  // The OS steals drags (the gesture inset, a scroll it decides to own) and then no
  // pointerup ever arrives. A translated grid left standing is far worse than a lost page
  // turn, so this springs back rather than only dropping the start.
  el.addEventListener('pointercancel', () => { start = null; if (drag) settle(0); });

  // CAPTURE phase: the tile's own click handler is bound on the button itself, i.e. deeper
  // than this host, so a bubbling listener would run only after the video already opened.
  el.addEventListener('click', (e) => {
    if (Date.now() >= swallowUntil) return;
    swallowUntil = 0;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
