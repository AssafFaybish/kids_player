// ui/pager.js — one pager implementation for every paginated grid (gallery, folder,
// watch). RTL-aware arrows, big kid-sized buttons, hidden controls on a single page
// WITHOUT hiding the host (the exit button lives inside the gallery pager's host).

/**
 * makePager({ mount, onChange }) -> { update(page, total), state(), el }
 * mount: container element. onChange(newPage): called on arrow taps.
 *
 * `state()` exists for the v1.0.57 swipe (ui/swipe.js): the flick and the arrows must
 * agree about which page is showing and how many there are, so the gesture reads the
 * SAME numbers the arrows were last drawn from instead of a copy kept beside them.
 */
export function makePager({ mount, onChange }) {
  const controls = document.createElement('div');
  controls.className = 'pg-controls';

  const prev = document.createElement('button');
  prev.className = 'pg-btn';
  prev.type = 'button';
  prev.setAttribute('aria-label', 'הקודם');
  prev.innerHTML = '<span class="pg-arrow">▶</span>'; // RTL: prev points "forward" visually

  const info = document.createElement('div');
  info.className = 'pg-info';
  info.textContent = '1 / 1';

  const next = document.createElement('button');
  next.className = 'pg-btn';
  next.type = 'button';
  next.setAttribute('aria-label', 'הבא');
  next.innerHTML = '<span class="pg-arrow">◀</span>';

  controls.appendChild(prev);
  controls.appendChild(info);
  controls.appendChild(next);
  mount.appendChild(controls);

  let page = 0;
  let total = 1;
  prev.addEventListener('click', () => { if (page > 0) onChange(page - 1); });
  next.addEventListener('click', () => { if (page < total - 1) onChange(page + 1); });

  function update(newPage, newTotal) {
    page = newPage;
    total = Math.max(1, newTotal);
    info.textContent = `${page + 1} / ${total}`;
    prev.disabled = page === 0;
    next.disabled = page >= total - 1;
    controls.classList.toggle('hidden', total <= 1);
  }

  update(0, 1);
  return { update, state: () => ({ page, total }), el: controls };
}
