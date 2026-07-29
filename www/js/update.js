// update.js — in-app updater (F14) over GitHub Releases. The child never sees any of
// this; the parent screen owns the whole flow. The launch check NEVER blocks startup
// (fired un-awaited after 4s, 8s race, 6h throttle, every path caught).
//
// Signature rule (documented in PUBLISHING.md): a downloaded APK must be signed with
// the SAME release key as the installed app or Android refuses the install — that is
// prevention (keystore discipline), not something this code can fix at runtime.

import { httpRequest, prefGet, prefSet, appPlugin, fsMkdirExternal, fsStatExternal, fsDeleteExternal, fsDownloadExternal } from './platform.js';

export const UPDATE_REPO = 'devfassaf/kids_player';
const CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000;

/* ---------------- pure (node-tested) ---------------- */

export function parseVersion(v) {
  // Strip bidi/zero-width marks first: a tag typed in a Hebrew-context field picks up
  // an invisible RLM (U+200F) — it happened with the real v1.0.0 release and silently
  // broke version detection (trim() does NOT remove bidi marks).
  const clean = String(v || '').replace(/[‎‏‪-‮⁦-⁩​-‍﻿]/g, '').trim();
  const m = clean.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
export function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  if (!A || !B) return 0; // garbage → "not newer" — fail safe, never downgrade
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  return 0;
}
export const isNewer = (remote, local) => compareVersions(remote, local) > 0;

export function pickApkAsset(assets, tag) {
  const list = Array.isArray(assets) ? assets : [];
  const cleanTag = String(tag || '').replace(/[‎‏‪-‮⁦-⁩​-‍﻿]/g, '').trim();
  return list.find((a) => a.name === `kids-player-${cleanTag}.apk`)
    || list.find((a) => /\.apk$/i.test(a.name || ''))
    || null;
}

/* ---------------- runtime ---------------- */

export async function currentVersion() {
  const App = appPlugin();
  if (!App || !App.getInfo) return null; // browser preview: "installed app only"
  try { return (await App.getInfo()).version || null; } catch { return null; }
}

/**
 * Check GitHub for a newer release. silent=true only records state (the parent panel
 * reads it later); it never downloads and never prompts.
 */
export async function checkForUpdate({ silent = true, force = false } = {}) {
  const local = await currentVersion();
  if (!local) return { status: 'browser' };

  const last = Number(await prefGet('update.lastCheck')) || 0;
  if (!force && Date.now() - last < CHECK_THROTTLE_MS) {
    const cached = JSON.parse((await prefGet('update.latest')) || 'null');
    if (!cached || !isNewer(cached.version, local)) return { status: 'up-to-date', latest: cached, local };
    // The cached path must honor update.skip too — otherwise a declined launch
    // prompt comes right back on the next launch inside the throttle window.
    if (silent && (await prefGet('update.skip')) === cached.version) return { status: 'skipped', latest: cached, local };
    return { status: 'available', latest: cached, local };
  }

  const res = await Promise.race([
    httpRequest({
      url: `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      headers: { Accept: 'application/vnd.github+json' },
      responseType: 'json'
    }),
    new Promise((r) => setTimeout(() => r({ status: 0 }), 8000))
  ]);
  await prefSet('update.lastCheck', String(Date.now()));
  if (res.status !== 200 || !res.data) return { status: 'network-error', local };

  const rel = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  const tag = rel.tag_name || '';
  const asset = pickApkAsset(rel.assets, tag);
  if (!asset) return { status: 'no-asset', local };

  const latest = {
    version: tag.replace(/^v/, ''), tag,
    assetName: asset.name, assetUrl: asset.browser_download_url, size: asset.size || 0,
    notes: (rel.body || '').slice(0, 2000), checkedAt: Date.now()
  };
  await prefSet('update.latest', JSON.stringify(latest));
  if (!isNewer(latest.version, local)) return { status: 'up-to-date', latest, local };
  const skipped = await prefGet('update.skip');
  if (silent && skipped === latest.version) return { status: 'skipped', latest, local };
  return { status: 'available', latest, local };
}

/** Download (with size verification) and hand the APK to the system installer. */
export async function downloadAndInstall(latest, { onProgress } = {}) {
  const kids = (window.Capacitor && window.Capacitor.Plugins) ? window.Capacitor.Plugins.KidsNative : null;
  if (!kids || !kids.installApk) return { ok: false, error: 'installed-app-only' };

  await fsMkdirExternal('updates'); // downloadFile ignores recursive — see platform.js
  const rel = 'updates/' + latest.assetName;

  let st = await fsStatExternal(rel);
  if (!st || (latest.size && st.size !== latest.size)) {
    try {
      await fsDownloadExternal(latest.assetUrl, rel, onProgress);
    } catch (e) {
      return { ok: false, error: 'download-failed' };
    }
    st = await fsStatExternal(rel);
  }
  // A truncated download otherwise surfaces as an opaque "problem parsing the package".
  if (!st || (latest.size && st.size !== latest.size)) {
    await fsDeleteExternal(rel);
    return { ok: false, error: 'truncated' };
  }

  await prefSet('update.pendingApk', rel);
  try {
    await kids.installApk({ path: st.uri ? String(st.uri).replace(/^file:\/\//, '') : rel });
    return { ok: true };
  } catch (e) {
    const code = String((e && e.message) || e);
    return { ok: false, error: /fileprovider/.test(code) ? 'fileprovider' : /no-installer/.test(code) ? 'no-installer' : 'install-failed' };
  }
}

/** Advisory only — a stale false is normal right after granting; always attempt anyway. */
export async function canInstall() {
  const kids = (window.Capacitor && window.Capacitor.Plugins) ? window.Capacitor.Plugins.KidsNative : null;
  if (!kids || !kids.canInstallPackages) return false;
  try { return (await kids.canInstallPackages()).value === true; } catch { return false; }
}

export async function openInstallSettings() {
  const kids = (window.Capacitor && window.Capacitor.Plugins) ? window.Capacitor.Plugins.KidsNative : null;
  if (kids && kids.openInstallPermissionSettings) { try { await kids.openInstallPermissionSettings(); } catch {} }
}

/** Next-boot cleanup: the installer has finished reading the old file by now. */
export async function cleanupPendingApk() {
  const pending = await prefGet('update.pendingApk');
  if (pending) {
    await fsDeleteExternal(pending);
    await prefSet('update.pendingApk', '');
  }
}
