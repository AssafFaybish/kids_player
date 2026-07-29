// ui/confetti.js — the gift-unwrap burst (F9). CSS keyframes, NOT canvas: a canvas
// needs a rAF loop on the main thread for ~1s — exactly what competes with video and
// thumbnail decoding on a low-end tablet. Transform/opacity only → compositor.

const COLORS = ['#ff7ab6', '#4ea1ff', '#6c63ff', '#ffd166', '#34c759'];

/** One burst radiating from originEl's center. Self-cleans after 1.1s. */
export function burst(originEl) {
  try {
    const r = originEl.getBoundingClientRect(); // read once, before any writes
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;

    const overlay = document.createElement('div');
    overlay.className = 'confetti-overlay';
    for (let i = 0; i < 24; i++) {
      const p = document.createElement('div');
      p.className = 'confetti-piece';
      p.style.left = cx + 'px';
      p.style.top = cy + 'px';
      p.style.background = COLORS[i % COLORS.length];
      p.style.setProperty('--dx', (Math.random() * 80 - 40) + 'vw');
      p.style.setProperty('--dy', (Math.random() * 75 - 30) + 'vh');
      p.style.setProperty('--rot', (Math.random() * 1440 - 720) + 'deg');
      p.style.animationDelay = (Math.random() * 120) + 'ms';
      overlay.appendChild(p);
    }
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 1100);
  } catch { /* decorative — never throw */ }
}
