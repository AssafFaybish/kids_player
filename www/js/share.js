// share.js — JS side of the Android share-target (F12b). The native side
// (KidsNativePlugin) queues EXTRA_TEXT into a static inbox and fires a retained
// 'shareReceived' event; boot order here is listener FIRST, then drain — double
// delivery is harmless because the key-duplicate check makes handling idempotent.
//
// Routing (decision 16): the parent-screen toggle (sources.shareIntent.requireApproval)
// decides pending-approval vs added-immediately. A share with no active profile is
// stashed in Preferences and drained on the next profile activation.

import { classifyFromSharedText } from './classify.js';
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

export function initShareTarget({ profileIdGetter, onShareAdded } = {}) {
  if (profileIdGetter) getPid = profileIdGetter;
  if (onShareAdded) onAdded = onShareAdded;
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
  for (const s of queue) await handleShare(s).catch(() => {});
}

async function handleShare(o) {
  const pid = getPid();
  if (!pid) { // no profile active yet — stash (cap 50, dedupe by text)
    let queue = [];
    try { queue = JSON.parse((await prefGet(K_QUEUE)) || '[]'); } catch {}
    if (!queue.some((q) => q.text === o.text)) queue.push({ text: o.text, subject: o.subject, at: o.at });
    await prefSet(K_QUEUE, JSON.stringify(queue.slice(-50)));
    return;
  }

  const c = classifyFromSharedText(o.text, o.subject);
  if (!c) return; // the safety boundary held — not a playable link

  const src = await db.getSources(pid);
  const scope = db.profScope(pid);
  if (await db.getVideo(scope, c.key)) return; // idempotent on double delivery
  if (src && src.libraryId && await db.getVideo(src.libraryId, c.key)) return;
  const deny = await db.loadDenySet(scope);
  if (deny.has(c.key)) return; // a deleted video stays deleted, even via share

  const requireApproval = !src || !src.shareIntent || src.shareIntent.requireApproval !== false;
  const now = Date.now();
  await db.putVideos([{
    scopeId: scope, key: c.key, type: c.type, id: c.id ?? null, url: c.url ?? null,
    srcUrl: c.srcUrl, driveId: c.driveId ?? null,
    title: c.title || '', titleSource: c.title ? 'sheet' : null, normTitle: normalizeTitle(c.title),
    folderId: requireApproval ? '~pending' : 'mine',
    homeFolderId: 'mine', channelId: null,
    sortKey: sortKeyFor({ origin: 'share-intent', addedAt: now }),
    publishedAt: null, rowIndex: null, origin: 'share-intent',
    state: requireApproval ? 'pending' : 'live',
    addedAt: now, approvedAt: requireApproval ? null : now,
    thumbId: null, thumbUrl: null, localPath: null, updatedAt: now
  }]);
  try { onAdded({ key: c.key, title: c.title, pending: requireApproval }); } catch {}
}
