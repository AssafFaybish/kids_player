// ui/sound.js — the gift-unwrap jingle (F9). Web Audio SYNTHESIS, not a bundled file:
// the project deliberately ships zero binary assets, and file decode via the
// https://localhost scheme has real failure modes for a decorative sound.
// The AudioContext is created lazily INSIDE the tap handler (autoplay policy) and
// resumed on app-foreground (Android suspends it). Everything try/catch — a silent
// unwrap is fine; a thrown error is not.

import { onAppResume } from '../platform.js';

let ctx = null;
let resumeHooked = false;

function ensureCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (!resumeHooked) {
    resumeHooked = true;
    onAppResume(() => { try { if (ctx && ctx.state === 'suspended') ctx.resume(); } catch {} });
  }
  return ctx;
}

/** C5-E5-G5-C6 triangle arpeggio + a soft sparkle of high-passed noise. ~0.6s. */
export function playUnwrap() {
  try {
    const c = ensureCtx();
    if (!c) return;
    const master = c.createGain();
    master.gain.value = 0.25;
    master.connect(c.destination);
    const t0 = c.currentTime;

    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const at = t0 + i * 0.09;
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.9, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.19);
      osc.connect(g).connect(master);
      osc.start(at);
      osc.stop(at + 0.22);
    });

    const len = Math.floor(c.sampleRate * 0.15);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const noise = c.createBufferSource();
    noise.buffer = buf;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const ng = c.createGain();
    ng.gain.value = 0.08;
    noise.connect(hp).connect(ng).connect(master);
    noise.start(t0 + 0.05);
  } catch { /* decorative */ }
}
