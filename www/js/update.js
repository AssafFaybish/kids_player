// update.js — in-app updater (F14) over GitHub Releases. The child never sees any of
// this; the parent screen owns the whole flow. The launch check NEVER blocks startup
// (fired un-awaited after 4s, 8s race, 6h throttle, every path caught).
//
// Signature rule (documented in PUBLISHING.md): a downloaded APK must be signed with
// the SAME release key as the installed app or Android refuses the install — that is
// prevention (keystore discipline), not something this code can fix at runtime.

import { httpRequest, prefGet, prefSet, appPlugin, fsMkdirExternal, fsStatExternal, fsDeleteExternal, fsDownloadExternal } from './platform.js';

export const UPDATE_REPO = 'devfassaf/kids_player';
// 1h (was 6h): a released update reaches devices within the hour. Field lesson:
// a release published minutes after a device's check stayed invisible for hours.
// Still tiny vs GitHub's unauthenticated 60 req/h/IP budget.
const CHECK_THROTTLE_MS = 60 * 60 * 1000;

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

/**
 * The one decision table for "what does this check mean" — shared by the fresh-fetch
 * and the throttled-cache paths so update.skip behaves identically in both.
 * skipped only applies to SILENT checks: a manual check must always surface the update.
 */
export function resolveUpdateStatus({ latest, local, skipped, silent }) {
  if (!latest || !isNewer(latest.version, local)) return 'up-to-date';
  if (silent && skipped === latest.version) return 'skipped';
  return 'available';
}

/** Stable link to the newest release page — the share fallback when no asset URL is known. */
export function releasesPageUrl() {
  return `https://github.com/${UPDATE_REPO}/releases/latest`;
}

/**
 * The "share the app" message (v1.0.5) — pure, node-tested. Direct APK link when the
 * latest release is known (one tap → download); the releases page otherwise. Either
 * way the installed app updates itself afterwards, so a stale link still ends current.
 */
export function buildAppShareMessage(latest) {
  const url = (latest && latest.assetUrl) || releasesPageUrl();
  const ver = latest && latest.version ? ` (גירסה ${latest.version})` : '';
  return [
    `היי! מוזמנים להתקין את "הסרטונים שלי"${ver} — נגן וידאו בטוח לילדים, שבו ההורים בוחרים בדיוק מה רואים.`,
    '',
    `הורדה לאנדרואיד: ${url}`,
    '',
    'איך מתקינים? מורידים, מקישים על הקובץ, ומאשרים חד-פעמית "התקנה מאפליקציות לא ידועות". מהרגע הזה האפליקציה מתעדכנת מעצמה.'
  ].join('\n');
}

/* ---------------- what's-new notes (v1.0.13, pure) ---------------- */

const NOTES_HEADING = /^\s*#{1,6}\s*(?:מה\s*חדש|what'?s\s*new)\s*\??\s*$/im;
const MAX_LINE = 160;
const MAX_LINES_PER_VERSION = 12;

/**
 * The PARENT-FACING lines of one release body. GitHub's auto-generated body is
 * English PR titles + @handles + URLs — noise for a parent. So:
 *   1. prefer the section under a `## מה חדש` heading (release.sh writes one);
 *   2. otherwise fall back to the whole body, aggressively de-noised.
 * Returns short plain-text lines (no markdown, no links) — never null.
 */
export function extractReleaseNotes(body) {
  let text = String(body || '');
  const m = text.match(NOTES_HEADING);
  if (m) {
    const after = text.slice(m.index + m[0].length);
    const next = after.search(/^\s*#{1,6}\s+\S|^\s*---\s*$/m); // next heading or divider
    text = next >= 0 ? after.slice(0, next) : after;
  }
  return text
    .split(/\r?\n/)
    // markdown HEADINGS are structure, never content — in the fallback path they'd
    // otherwise leak in as a bogus first bullet ("What's Changed")
    .map((raw) => (/^\s*#{1,6}\s+/.test(raw) ? '' : raw)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^\s*[>]+\s*/, '')                        // quotes
      .replace(/^\s*[-*+]\s+/, '')                       // bullet markers
      .replace(/\*\*(.*?)\*\*/g, '$1').replace(/[*_`]/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')           // md links → their text
      .replace(/\bby\s+@[\w-]+\s+in\s+\S+/gi, '')        // "by @user in <url>"
      .replace(/@[\w-]+/g, '')                            // bare handles
      .replace(/https?:\/\/\S+/g, '')                     // bare urls
      .replace(/^\s*Full Changelog.*$/i, '')
      .replace(/\(#\d+\)|#\d+/g, '')                      // PR/issue refs
      .replace(/\s{2,}/g, ' ')
      .trim())
    .filter((l) => l && !/^[-=–—.:]+$/.test(l))
    .map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE - 1).trimEnd() + '…' : l))
    .slice(0, MAX_LINES_PER_VERSION);
}

/**
 * Group release notes per version for the what's-new screen.
 * `above` (default) keeps only versions NEWER than `local` — a device jumping several
 * versions sees everything it missed, newest first, capped so the screen stays a
 * screen (the remainder is reported as `moreCount`).
 */
export function buildWhatsNew(releases, local, { max = 8, above = true } = {}) {
  const list = (Array.isArray(releases) ? releases : [])
    .filter((r) => r && !r.draft && !r.prerelease && r.tag_name)
    .map((r) => ({ version: String(r.tag_name).replace(/^v/, ''), lines: extractReleaseNotes(r.body), tag: r.tag_name }))
    .filter((r) => parseVersion(r.version))
    .filter((r) => (above ? isNewer(r.version, local) : true))
    .sort((a, b) => compareVersions(b.version, a.version));
  return { versions: list.slice(0, max), moreCount: Math.max(0, list.length - max) };
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
    const status = resolveUpdateStatus({ latest: cached, local, skipped: await prefGet('update.skip'), silent });
    return { status, latest: cached, local };
  }

  // v1.0.13: fetch the release LIST (same one call) — it yields both the newest
  // publishable release AND the notes of every version in between, so a device that
  // skipped several versions can be told everything it missed.
  const res = await Promise.race([
    httpRequest({
      url: `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`,
      headers: { Accept: 'application/vnd.github+json' },
      responseType: 'json'
    }),
    new Promise((r) => setTimeout(() => r({ status: 0 }), 8000))
  ]);
  await prefSet('update.lastCheck', String(Date.now()));
  if (res.status !== 200 || !res.data) return { status: 'network-error', local };

  const all = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  const releases = Array.isArray(all) ? all : [];
  // same semantics as /releases/latest: newest non-draft, non-prerelease
  const rel = releases.find((r) => r && !r.draft && !r.prerelease) || null;
  if (!rel) return { status: 'no-asset', local };
  // every version's notes (not just newer ones) — the About tab reads the installed
  // version's entry from here after the update lands
  await prefSet('update.notesAll', JSON.stringify(buildWhatsNew(releases, local, { above: false, max: 30 }).versions));
  const tag = rel.tag_name || '';
  const asset = pickApkAsset(rel.assets, tag);
  if (!asset) return { status: 'no-asset', local };

  const latest = {
    version: tag.replace(/^v/, ''), tag,
    assetName: asset.name, assetUrl: asset.browser_download_url, size: asset.size || 0,
    notes: (rel.body || '').slice(0, 2000), checkedAt: Date.now(),
    // v1.0.13: parent-facing notes for EVERY version this device would gain
    whatsNew: buildWhatsNew(releases, local)
  };
  await prefSet('update.latest', JSON.stringify(latest));
  const status = resolveUpdateStatus({ latest, local, skipped: await prefGet('update.skip'), silent });
  return { status, latest, local };
}

/**
 * Newest release we can name (v1.0.5, for sharing the app): the cached check result,
 * refreshed from GitHub when absent. Null in the browser preview / offline —
 * callers fall back to releasesPageUrl().
 */
export async function latestKnownRelease() {
  let latest = null;
  try { latest = JSON.parse((await prefGet('update.latest')) || 'null'); } catch {}
  if (!latest) {
    try { latest = (await checkForUpdate({ silent: true, force: true })).latest || null; } catch {}
  }
  return latest;
}

/**
 * v1.0.13: the notes of the version this device is RUNNING — for the About tab's
 * "what's new" button after an update landed. Falls back to the newest known entry.
 */
export async function notesForInstalledVersion() {
  const local = await currentVersion();
  let all = [];
  try { all = JSON.parse((await prefGet('update.notesAll')) || '[]'); } catch {}
  if (!Array.isArray(all) || !all.length) return { versions: [], moreCount: 0 };
  const exact = local ? all.find((v) => compareVersions(v.version, local) === 0) : null;
  return { versions: exact ? [exact] : all.slice(0, 1), moreCount: 0 };
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
