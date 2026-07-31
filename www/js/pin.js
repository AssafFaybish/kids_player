// pin.js — parent gate. Stores a hash of the 4-digit PIN (not the plaintext).
// Threat model is a 4-year-old, not an attacker — hashing is just to avoid casual shoulder-surfing.
import { prefGet, prefSet, prefRemove } from './platform.js';

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

export async function hasPin() {
  return !!(await prefGet(K_PIN));
}

export async function setPin(pin) {
  await prefSet(K_PIN, await hash(pin));
}

export async function verifyPin(pin) {
  const stored = await prefGet(K_PIN);
  if (!stored) return false;
  return stored === (await hash(pin));
}

export async function clearPin() {
  await prefRemove(K_PIN);
}
