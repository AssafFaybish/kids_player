// ui/dpad.js — Android TV D-pad focus manager (v1.0.9). Active ONLY in TV mode
// (initDpad is called once when platform.isTv()). The remote's arrows move a visible
// focus ring between the active view's controls; OK activates (native button
// behavior); Back rides the existing Capacitor backButton → nav.handleBack pipe.
//
// Watch view special case: with nothing focused, the remote controls the PLAYER —
// OK = play/pause, left/right = ±10s seek (universal media convention, not RTL),
// down = move focus into the under-player grid, up from the grid = back to player.
// The geometry is pure (spatial.js, node-tested); this module is the DOM glue.

import { pickNextIndex, pickFirstIndex } from '../spatial.js';
import { isModalOpen } from './modal.js';
import * as nav from '../nav.js';
import { handleTvKey } from '../player.js';

const KEY_DIR = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/** Focusable, actually-visible controls of the current context (modal wins). */
function candidates() {
  // v1.0.29: the preview bubble is an OVERLAY, not a view (that is its whole design —
  // the screen behind keeps its state), so the view-scoped scan below could never see
  // its buttons: on TV the bubble opened and the remote was trapped behind it. Priority
  // matches stacking: modal (a confirm can stack over the bubble) → open bubble → view.
  const pv = document.getElementById('preview-bubble');
  const scope = isModalOpen()
    ? document.getElementById('modal')
    : (pv && !pv.classList.contains('hidden'))
      ? pv
      : document.querySelector('.view.active');
  if (!scope) return [];
  // v1.0.28: `summary` is focusable and toggles its <details> natively on Enter — but it
  // was missing here, so every folded section (the rejected archive since v1.0.23, the
  // whole grouped library list now) was simply UNREACHABLE from a TV remote. Rows inside
  // a CLOSED section have offsetParent null, so the existing visibility filter already
  // keeps them out until the section opens.
  return [...scope.querySelectorAll(
    'button, input, select, textarea, summary, [href], [tabindex]:not([tabindex="-1"])'
  )].filter((el) => !el.disabled && el.offsetParent !== null);
}

function focusFirst(els) {
  // A fresh focus lands on CONTENT (a tile in the grid), not on top-bar chrome —
  // the child's first arrow press must highlight a video, not the parent button.
  const gridEls = els.filter((el) => el.closest('.grid, .profiles-grid'));
  const pool = gridEls.length ? gridEls : els;
  const idx = pickFirstIndex(pool.map((el) => el.getBoundingClientRect()));
  if (idx >= 0) pool[idx].focus();
  return idx >= 0;
}

function onKeyDown(e) {
  const dir = KEY_DIR[e.key];
  const isEnter = e.key === 'Enter';
  if (!dir && !isEnter) return;

  const active = document.activeElement;
  // TEXT-like fields only: checkboxes/radios are INPUTs too, but the remote's OK
  // must toggle them (handled below), not be swallowed as "editing"
  const inText = active && (active.tagName === 'TEXTAREA'
    || (active.tagName === 'INPUT' && active.type !== 'checkbox' && active.type !== 'radio'));
  // inside a text field the remote edits text; only up/down leave it
  if (inText && (dir === 'left' || dir === 'right' || isEnter)) return;

  const els = candidates();
  const focusedIdx = els.indexOf(active);
  const watchMode = nav.isActive('watch') && !isModalOpen();

  // Watch-view focus model: top buttons (🏠/🗑️) ↕ PLAYER (nothing focused) ↕ grid.
  if (watchMode && focusedIdx < 0) {
    // player mode — the remote drives the video
    // e.repeat is load-bearing: Android TV auto-repeats a HELD key at ~30/s, and each
    // event was a full ±10s seek. One second on the arrow jumped ~4 minutes and could
    // run past the end, where YouTube fires ENDED → onExit → the child is thrown out of
    // the video. A held key now reveals the HUD instead of scrubbing.
    if (e.repeat) { handleTvKey('reveal'); e.preventDefault(); return; }
    if (isEnter) { if (handleTvKey('toggle')) e.preventDefault(); return; }
    if (dir === 'left') { if (handleTvKey('back')) e.preventDefault(); return; }
    if (dir === 'right') { if (handleTvKey('fwd')) e.preventDefault(); return; }
    if (dir === 'down') { if (focusFirst(els.filter((el) => el.closest('#watch-grid, #watch-pager')))) e.preventDefault(); return; }
    if (dir === 'up') { if (focusFirst(els.filter((el) => el.closest('.watch-top')))) e.preventDefault(); return; }
    return;
  }
  if (watchMode && dir) {
    // crossing the player band returns the remote to PLAYER mode first
    const inGrid = active.closest('#watch-grid, #watch-pager');
    const inTop = active.closest('.watch-top');
    if ((inGrid && dir === 'up') || (inTop && dir === 'down')) {
      e.preventDefault();
      try { active.blur(); } catch {}
      handleTvKey('reveal');
      return;
    }
  }

  if (isEnter) {
    // buttons activate natively on Enter; checkboxes/radios only toggle on SPACE —
    // the remote's OK must toggle them too (parent-screen switches on TV, v1.0.11)
    if (active && active.tagName === 'INPUT' && (active.type === 'checkbox' || active.type === 'radio')) {
      e.preventDefault();
      active.click();
    }
    return;
  }

  if (!els.length) return;
  e.preventDefault();
  if (focusedIdx < 0) { focusFirst(els); return; }

  const next = pickNextIndex(els.map((el) => el.getBoundingClientRect()), focusedIdx, dir);
  if (next >= 0) {
    els[next].focus();
    els[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/** Entering the watch view starts in player mode (nothing focused). */
function onViewChange() {
  if (nav.isActive('watch') && document.activeElement && document.activeElement !== document.body) {
    try { document.activeElement.blur(); } catch {}
  }
}

let inited = false;
export function initDpad() {
  if (inited) return;
  inited = true;
  window.addEventListener('keydown', onKeyDown, true);
  // view switches toggle .active on .view sections — watch for them
  const obs = new MutationObserver(onViewChange);
  for (const v of document.querySelectorAll('.view')) {
    obs.observe(v, { attributes: true, attributeFilter: ['class'] });
  }
}
