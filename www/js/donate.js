// donate.js — the OPTIONAL "support the developer" LOGIC (v1.0.14).
//
// The links themselves live in links.js (v1.0.15) — ONE config file for every
// external address, so changing a payment link never means hunting through code.
// An empty string there means "not configured": that method isn't offered, and when
// BOTH are empty the whole donation block hides itself. Nothing here is required for
// the app to work — donating is voluntary by design, and the block lives in the
// PIN-protected parent screen so a child can never reach a payment page.
//
// Links are opened in the SYSTEM browser (platform.openExternal → native intent):
// the in-app WebView deliberately blocks external navigation and popups.

import { LINKS } from './links.js';

/** The configured payment links — EDIT THEM IN links.js, not here. */
export const DONATE_LINKS = LINKS.donate;

/** How long the app must be in use before the one-time gentle reminder may appear. */
export const NUDGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const LABELS = {
  paybox: { label: 'PayBox — תשלום בעברית', hint: 'הדרך המהירה למי שיש לו PayBox' },
  paypal: { label: 'PayPal — כרטיס אשראי', hint: 'גם מחוץ לישראל' }
};

/**
 * PURE (node-tested): the payment methods that are actually configured, in the
 * order they should be offered (PayBox first — it is the familiar one locally).
 * -> [{ id, url, label, hint }]
 */
export function donateOptions(links = DONATE_LINKS) {
  return ['paybox', 'paypal']
    .map((id) => ({ id, url: String((links && links[id]) || '').trim(), ...LABELS[id] }))
    .filter((o) => /^https?:\/\//i.test(o.url));
}

/** PURE: is donating possible at all (i.e. is at least one link configured)? */
export function donateAvailable(links = DONATE_LINKS) {
  return donateOptions(links).length > 0;
}

/**
 * PURE (node-tested): may the ONE-TIME gentle reminder be shown now?
 * Conditions, all required: a link exists, the app has been in use for at least
 * NUDGE_AFTER_MS, and the parent never dismissed it. `firstSeenAt` is stamped on
 * first launch — a missing/garbage value means "we don't know yet", so: no nudge.
 */
export function shouldShowDonateNudge({ firstSeenAt, now = Date.now(), dismissed = false, links = DONATE_LINKS } = {}) {
  if (dismissed || !donateAvailable(links)) return false;
  const first = Number(firstSeenAt);
  if (!Number.isFinite(first) || first <= 0 || first > now) return false;
  return now - first >= NUDGE_AFTER_MS;
}
