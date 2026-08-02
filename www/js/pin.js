// pin.js — parent gate. Stores a hash of the 4-digit PIN (not the plaintext).
// Threat model is a 4-year-old, not an attacker — hashing is just to avoid casual shoulder-surfing.
import { prefGet, prefRemove } from './platform.js';
import { getAllSettings, putSetting, ACCOUNT } from './settings.js';

const K_PIN = 'pin';

async function hash(str) {
  // Coerce FIRST. A numeric PIN has no `.length`, so the djb2 loop below never ran and
  // every number hashed to the same constant — any 4 digits would then open the gate.
  const s = String(str ?? '');
  try {
    if (crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kp:' + s));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {}
  // Fallback (insecure contexts only): simple djb2 — still fine for a toddler gate.
  // Same 'kp:' salt as above so a PIN stays verifiable if the context changes.
  let h = 5381;
  const salted = 'kp:' + s;
  for (let i = 0; i < salted.length; i++) h = ((h << 5) + h + salted.charCodeAt(i)) | 0;
  return 'djb2:' + (h >>> 0).toString(16);
}

/**
 * v1.0.25 — the hash lives in the SYNCED settings channel, so one family code opens the
 * parent screen on every device instead of each device inventing its own.
 *
 * The stored value is the source of truth even when it is EMPTY: '' means "the parent
 * cleared it", which is different from "never set". Collapsing the two would make
 * `clearPin` on one device re-import the old hash from Preferences on the next read.
 *
 * MIGRATION (deliberately not "start fresh", unlike the other settings): an existing PIN
 * is lifted out of Preferences on first read. Resetting it would leave every installed
 * app with NO parent gate for one launch — and the setup flow lets whoever gets there
 * first choose the new code, which on a child's tablet is the child.
 */
async function storedHash() {
  // The ENTRY, not getSetting(): "was this ever written?" cannot be asked through a
  // fallback parameter. `getSetting(scope, name, undefined)` passes undefined explicitly,
  // which triggers the `fallback = null` DEFAULT — so the answer came back as null, that
  // read as "already migrated", and the legacy lift below never ran. Caught in the
  // browser on an install that had a real PIN: the parent gate would have opened for
  // anyone after the update.
  const all = await getAllSettings();
  const entry = all.account[K_PIN];
  if (entry && 'v' in entry) return String(entry.v || '');
  const legacy = await prefGet(K_PIN);
  if (legacy) {
    // Write the channel FIRST, then drop the legacy copy — in that order, a failure
    // anywhere leaves the PIN readable from one place or the other, never neither.
    await putSetting(ACCOUNT, K_PIN, legacy);
    await prefRemove(K_PIN);
    return legacy;
  }
  return '';
}

async function writeHash(value) {
  await putSetting(ACCOUNT, K_PIN, value);
  // The legacy key is dropped, not mirrored: two sources of truth is exactly how a PIN
  // changed on one screen keeps opening with the old code on another.
  await prefRemove(K_PIN);
}

export async function hasPin() {
  return !!(await storedHash());
}

export async function setPin(pin) {
  await writeHash(await hash(pin));
}

export async function verifyPin(pin) {
  const stored = await storedHash();
  if (!stored) return false;
  return stored === (await hash(pin));
}

export async function clearPin() {
  await writeHash(''); // an explicit answer, so a peer's stale hash cannot revive it
}
