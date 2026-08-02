// recovery.js — the way back in when the parent forgets the code (v1.0.26).
//
// WHY THIS HAS TO EXIST. Until v1.0.25 a forgotten PIN had an ugly but real answer:
// reinstall the app. Then the PIN hash moved into the synced settings channel and rides
// the Drive document (`drive.serializeDb` -> `settings.account.pin`), so a family with
// backup enabled reinstalls, reconnects, and gets the forgotten code back on the first
// pull. The families who did the right thing were the ones with no way in.
//
// WHY A WAIT. It is the only mechanism that works everywhere: no device lock (a child's
// tablet often has none, and Android TV never does), no permission, no network, nothing
// for a parent to have kept. It stops the person it must stop — a 5-year-old will not sit
// out a day — and the countdown shown on the child's home is the parent's warning that
// somebody asked for a reset. The device-credential path (fingerprint / device lock code)
// is the FAST path for parents whose device has one; this is the floor under it.
//
// WHAT IT IS NOT. Not a security boundary. Whoever can move the system clock forward
// skips the wait, and that is unavoidable without a server. Stated plainly in the docs
// rather than papered over: this app's threat model has always been a small child.
//
// DEVICE-LOCAL ON PURPOSE. The request is NOT synced. A pending reset is not family
// state, and syncing it would let one device start everyone else's clock — the reset
// itself is what travels, because it rewrites the shared PIN.
import { prefGet, prefSet, prefRemove } from './platform.js';
import { planPinRecovery, pinRecoveryLabel } from './plan.js';
import { PIN_RECOVERY_DELAY_HOURS } from './config.js';

const K_AT = 'pinRecoveryAt';

/** Where a request stands right now: 'none' | 'waiting' | 'ready' (+ the countdown). */
export async function recoveryState(now = Date.now()) {
  const raw = await prefGet(K_AT);
  return planPinRecovery({ requestedAt: Number(raw), now, hours: PIN_RECOVERY_DELAY_HOURS });
}

/** The sentence shown to whoever is looking, or '' when there is nothing to say. */
export async function recoveryNote(now = Date.now()) {
  return pinRecoveryLabel(await recoveryState(now));
}

/**
 * Start the clock — or leave it alone if it is already running.
 *
 * NEVER restamps an existing request: re-tapping "שכחתי את הקוד" must not push the
 * deadline away, or a parent who taps it twice on day one waits two days, and a child
 * who found the button could keep the parent locked out indefinitely.
 */
export async function requestRecovery(now = Date.now()) {
  const cur = await recoveryState(now);
  if (cur.state !== 'none') return cur;
  await prefSet(K_AT, String(now));
  return recoveryState(now);
}

/**
 * Cancel a pending request. Deliberately NOT protected by the PIN: the whole point is
 * that a parent who did not ask for this can stop it, and they cannot prove who they are
 * — that is the situation the feature exists for. A child cancelling only restores the
 * status quo, which costs nothing.
 */
export async function cancelRecovery() {
  await prefRemove(K_AT);
}
