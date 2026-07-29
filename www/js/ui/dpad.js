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
  const scope = isModalOpen()
    ? document.getElementById('modal')
    : document.querySelector('.view.active');
  if (!scope) return [];
  return [...scope.querySelectorAll(
    'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])'
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
  const inText = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
  // inside a text field the remote edits text; only up/down leave it
  if (inText && (dir === 'left' || dir === 'right' || isEnter)) return;

  const els = candidates();
  const focusedIdx = els.indexOf(active);
  const watchMode = nav.isActive('watch') && !isModalOpen();

  // Watch-view focus model: top buttons (🏠/🗑️) ↕ PLAYER (nothing focused) ↕ grid.
  if (watchMode && focusedIdx < 0) {
    // player mode — the remote drives the video
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

  if (isEnter) return; // a focused button activates natively on Enter

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
