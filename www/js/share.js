// share.js — JS side of the Android share-target (F12b). The native side
// (KidsNativePlugin) queues EXTRA_TEXT into a static inbox and fires a retained
// 'shareReceived' event; boot order here is listener FIRST, then drain — double
// delivery is harmless because the key-duplicate check makes handling idempotent.
//
// Routing (decision 16): the parent-screen toggle (sources.shareIntent.requireApproval)
// decides pending-approval vs added-immediately. A share with no active profile is
// stashed in Preferences and drained on the next profile activation.

import { classifyShared } from './classify.js';
import { normalizeTitle } from './normalize.js';
import { sortKeyFor } from './order.js';
import { prefGet, prefSet } from './platform.js';
import * as db from './db.js';

const K_QUEUE = 'pendingShares';

function kidsNative() {
  const c = typeof window !== 'undefined' ? window.Capacitor : undefined;
  return c && c.Plugins ? c.Plugins.KidsNative : null;
}

let getPid = () => null;
let onAdded = () => {};
// v1.0.7: app.js provides the PIN+confirm dialog flow. Given the classified share it
// resolves 'live' | 'pending' | 'channel' | 'discard'. When absent (or it throws),
// everything falls back to the old silent pending routing — a share is never lost.
let interactive = null;
// v1.0.23: app.js decides WHICH profile a share lands in when the app already has one
// active. Resolves a profileId (it may have switched the app into it), or null to abort.
// Absent (browser preview) ⇒ the active profile, i.e. exactly the old behaviour.
let chooseProfile = null;

export function initShareTarget({ profileIdGetter, onShareAdded, interactiveHandler, profileChooser } = {}) {
  if (profileIdGetter) getPid = profileIdGetter;
  if (onShareAdded) onAdded = onShareAdded;
  if (interactiveHandler) interactive = interactiveHandler;
  if (profileChooser) chooseProfile = profileChooser;
  const plug = kidsNative();
  if (!plug || !plug.addListener) return; // browser preview / plugin absent
  plug.addListener('shareReceived', (o) => { handleShare(o).catch(() => {}); });
  plug.getPendingShares()
    .then(({ shares }) => { for (const s of shares || []) handleShare(s).catch(() => {}); })
    .catch(() => {});
}

/** Called on profile activation: absorb shares that arrived with no active profile. */
export async function drainShareQueue() {
  let queue = [];
  try { queue = JSON.parse((await prefGet(K_QUEUE)) || '[]'); } catch {}
  if (!Array.isArray(queue) || !queue.length) return;
  await prefSet(K_QUEUE, '[]');
  // alreadyRouted: these arrived with NO profile active, and the parent has just picked one
  // by entering it. That tap is the routing decision — do not ask a second time (v1.0.23).
  for (const s of queue) await handleShare(s, { alreadyRouted: true }).catch(() => {});
}

async function handleShare(o, { alreadyRouted = false } = {}) {
  let pid = getPid();
  if (!pid) { // no profile active yet — stash (cap 50, dedupe by text)
    let queue = [];
    try { queue = JSON.parse((await prefGet(K_QUEUE)) || '[]'); } catch {}
    if (!queue.some((q) => q.text === o.text)) queue.push({ text: o.text, subject: o.subject, at: o.at });
    await prefSet(K_QUEUE, JSON.stringify(queue.slice(-50)));
    return;
  }

  const c = classifyShared(o.text, o.subject);
  if (!c) return; // the safety boundary held — not a playable link

  // v1.0.23 — WHICH profile? Only asked when the app already has one active, i.e. the
  // parent shared into a RUNNING app and we would otherwise pick for them silently. The
  // cold-start path deliberately does not ask: it lands on the profile picker anyway, and
  // the profile the parent then taps IS the answer (asking again would be the same question
  // twice). `alreadyRouted` marks a share replayed from that queue.
  if (!alreadyRouted && chooseProfile) {
    let chosen;
    try { chosen = await chooseProfile(c); } catch { chosen = pid; }
    if (!chosen) return; // the parent backed out — nothing written, nothing lost
    pid = chosen;
  }

  if (c.kind === 'channel') { await handleChannelShare(pid, c); return; }

  const src = await db.getSources(pid);
  // v1.0.6: shares land in the SHARED library folder ('sheet') when sources exist —
  // one list for the whole family; the profile scope stays only as the pre-first-sync
  // fallback (absorbed into the library on the next activation).
  const lib = src && src.libraryId;
  const scope = lib || db.profScope(pid);
  const homeFolder = lib ? 'sheet' : 'mine';
  if (await db.getVideo(scope, c.key)) return; // idempotent on double delivery
  if (lib && await db.getVideo(db.profScope(pid), c.key)) return;
  if ((await db.loadDenySet(scope)).has(c.key)) return; // deleted stays deleted
  if (lib && (await db.loadDenySet(db.profScope(pid))).has(c.key)) return;

  // v1.0.7: the interactive PIN+confirm flow decides; without it (browser preview,
  // handler error) the old toggle-based routing still applies. A declined/cancelled
  // interactive share PARKS AS PENDING (user decision) — never silently lost.
  let decision = null;
  if (interactive) {
    try { decision = await interactive(c); } catch { decision = null; }
  }
  if (decision === 'discard') return;
  const requireApproval = decision
    ? decision !== 'live'
    : !src || !src.shareIntent || src.shareIntent.requireApproval !== false;

  const now = Date.now();
  await db.putVideos([{
    scopeId: scope, key: c.key, type: c.type, id: c.id ?? null, url: c.url ?? null,
    srcUrl: c.srcUrl, driveId: c.driveId ?? null,
    title: c.title || '', titleSource: c.title ? 'sheet' : null, normTitle: normalizeTitle(c.title),
    folderId: requireApproval ? '~pending' : homeFolder,
    homeFolderId: homeFolder, channelId: null,
    sortKey: sortKeyFor({ origin: 'share-intent', addedAt: now }),
    publishedAt: null, rowIndex: null, origin: 'share-intent',
    state: requireApproval ? 'pending' : 'live',
    addedAt: now, approvedAt: requireApproval ? null : now,
    thumbId: null, thumbUrl: null, localPath: null, updatedAt: now
  }]);
  if (!requireApproval && lib) {
    // straight-to-live share = part of the master list now; pending ones enqueue at approval
    try {
      const { enqueueSheetRow } = await import('./sheetwrite.js');
      await enqueueSheetRow(pid, { key: c.key, srcUrl: c.srcUrl, title: c.title || '' });
    } catch {}
  }
  try { onAdded({ key: c.key, title: c.title, pending: requireApproval }); } catch {}
}

/**
 * v1.0.7: a shared CHANNEL link — behaves exactly like adding a channel in the parent
 * screen: PIN + confirm (interactive handler), resolve the reference, subscribe with
 * approval-required default, register a sheet row, then sync pulls its videos.
 * Without the interactive handler a channel share is ignored (subscribing a whole
 * channel silently is too big a side effect for a fallback path).
 *
 * v1.0.25: "behaves exactly like the parent screen" is now TRUE. This used to fire the
 * sync without awaiting it and report success immediately, so the whole back catalogue
 * landed in ממתינים with no dialog and no count — the v1.0.22 bug, still live on this
 * path. The import and the question belong to app.js (they need the loading screen and
 * the modal, neither of which this layer may import), so `onAdded` owns them and this
 * function stops at subscribing.
 */
async function handleChannelShare(pid, c) {
  if (!interactive) return;
  let decision = null;
  try { decision = await interactive(c); } catch { decision = null; }
  if (decision !== 'channel') return;

  const src = await db.getSources(pid);
  const lib = src && src.libraryId;
  if (!lib) return; // no sources yet (pre-first-sync) — the parent screen path covers this
  try {
    const yt = await import('./yt.js');
    const channelId = await yt.resolveChannelRef(c.channelRef, await yt.getApiKey());
    if (!channelId) { try { onAdded({ channelFailed: true }); } catch {} return; }
    const known = (await db.listLibraryChannels(lib)).some((x) => x.channelId === channelId);
    await db.putLibraryChannel({
      libraryId: lib, channelId, autoApprove: false, autoApproveSource: 'ui',
      order: Date.now(), addedAt: Date.now(), hidden: false, sourceRow: false,
      titleOverride: c.title || ''
    });
    if (!known) {
      try {
        const { enqueueSheetRow } = await import('./sheetwrite.js');
        await enqueueSheetRow(pid, {
          key: 'ch:' + channelId,
          srcUrl: 'https://www.youtube.com/channel/' + channelId,
          flag: 'manual'
        });
      } catch {}
    }
    // No sync here: `onAdded` awaits one behind the loading screen and then raises the
    // approval dialog. Firing one here too would just make the parent wait twice.
    try { await onAdded({ channelAdded: channelId, title: c.title }); } catch {}
  } catch { /* a failed resolve must not crash the share pipeline */ }
}
