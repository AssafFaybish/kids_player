// spatial.js — PURE spatial-navigation geometry for TV D-pad focus (v1.0.9).
// Zero imports, node-tested. Given element rects, the current index and a direction,
// pick the element a TV remote user would expect the focus to move to.

/** Center point of a DOMRect-like {left, top, width, height}. */
const cx = (r) => r.left + r.width / 2;
const cy = (r) => r.top + r.height / 2;

/**
 * Which rect should receive focus when moving in `dir` from rects[fromIdx]?
 * -> the index of the best candidate, or -1 when none exists in that direction.
 *
 * Model: candidates must lie in the direction's half-plane (their center past the
 * current center); score = distance on the movement axis + 2× the orthogonal drift —
 * so "down" prefers the tile directly below over a closer one far to the side.
 */
export function pickNextIndex(rects, fromIdx, dir) {
  const cur = rects[fromIdx];
  if (!cur) return -1;
  const CX = cx(cur);
  const CY = cy(cur);
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === fromIdx) continue;
    const r = rects[i];
    if (!r || (r.width === 0 && r.height === 0)) continue;
    const dx = cx(r) - CX;
    const dy = cy(r) - CY;
    let main;
    let ortho;
    if (dir === 'left') { if (dx >= -1) continue; main = -dx; ortho = Math.abs(dy); }
    else if (dir === 'right') { if (dx <= 1) continue; main = dx; ortho = Math.abs(dy); }
    else if (dir === 'up') { if (dy >= -1) continue; main = -dy; ortho = Math.abs(dx); }
    else if (dir === 'down') { if (dy <= 1) continue; main = dy; ortho = Math.abs(dx); }
    else return -1;
    const score = main + 2 * ortho;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** The rect a fresh focus should land on: top-most, then start-most (RTL: right-most). */
export function pickFirstIndex(rects, { rtl = true } = {}) {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!r || (r.width === 0 && r.height === 0)) continue;
    const score = cy(r) * 3 + (rtl ? -cx(r) : cx(r));
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}
