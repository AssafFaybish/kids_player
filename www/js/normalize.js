// normalize.js — Hebrew-aware title normalization + duplicate-merge policy (F8).
// Pure, node-tested. Title dedupe applies ONLY within the same channel/folder —
// two channels legitimately both have a "פרק 1".

/**
 * Normalize a title for comparison. The Hebrew-specific steps are the point:
 *  - NFKC folds presentation forms (U+FB1D–FB4F) from web copy-paste;
 *  - bidi controls (LRM/RLM/…): Google Sheets inserts them into mixed RTL/LTR
 *    cells — a real, non-obvious duplicate cause;
 *  - niqqud/te'amim stripped: "שָׁלוֹם" must equal "שלום";
 *  - emoji stripped; punctuation/symbols → space; whitespace collapsed.
 * Episode markers ("חלק 2", "#3") are deliberately KEPT — those are real differences.
 * An empty result must never dedupe (guarded by callers via findByNormTitle).
 */
export function normalizeTitle(s) {
  let t = String(s ?? '');
  try { t = t.normalize('NFKC'); } catch {}
  t = t.replace(/[‎‏‪-‮⁦-⁩؜]/g, ''); // bidi controls
  t = t.replace(/[​-‍﻿­]/g, '');                    // zero-width/joiners
  t = t.replace(/[֑-ׇ]/g, '');                                // niqqud + te'amim
  t = t.replace(/\p{Extended_Pictographic}/gu, '');                     // emoji
  t = t.replace(/[︎️\u{1F3FB}-\u{1F3FF}⃣]/gu, '');       // VS / skin tones / keycap
  t = t.toLocaleLowerCase();
  t = t.replace(/[\p{P}\p{S}]+/gu, ' ');                                // punctuation/symbols
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

const TITLE_SOURCE_RANK = { api: 4, rss: 3, sheet: 2, oembed: 1, legacy: 1 };

/**
 * Which of two records representing the SAME video survives, and what it absorbs.
 * Survivor: prefer real bytes on disk (localPath), then the older addedAt.
 * The loser's key goes into survivor.mergedFrom — NOT the deny-list (that would
 * block a legitimate future re-add).
 */
export function mergeVideoRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  let s = a, l = b;
  if (!!b.localPath !== !!a.localPath) { s = b.localPath ? b : a; l = s === a ? b : a; }
  else if ((b.addedAt || Infinity) < (a.addedAt || Infinity)) { s = b; l = a; }

  const out = { ...s };
  out.addedAt = Math.min(a.addedAt || Infinity, b.addedAt || Infinity);
  if (out.addedAt === Infinity) out.addedAt = Date.now();
  out.localPath = s.localPath || l.localPath || null;
  if ((l.state === 'live' && out.state === 'pending')) { out.state = 'live'; out.approvedAt = l.approvedAt || out.approvedAt; }
  const rs = TITLE_SOURCE_RANK[s.titleSource] || 0;
  const rl = TITLE_SOURCE_RANK[l.titleSource] || 0;
  if ((rl > rs && l.title) || (!out.title && l.title) ||
      (rl === rs && l.title && (l.title.length > (out.title || '').length))) {
    out.title = l.title;
    out.titleSource = l.titleSource;
  }
  out.normTitle = normalizeTitle(out.title);
  out.thumbId = s.thumbId || l.thumbId || null;
  out.thumbUrl = s.thumbUrl || l.thumbUrl || null;
  const merged = new Set([...(s.mergedFrom || []), ...(l.mergedFrom || [])]);
  if (l.key !== out.key) merged.add(l.key);
  out.mergedFrom = [...merged];
  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0) || Date.now();
  return out;
}

/**
 * v1.0.22 — make a merged record's curation SELF-CONSISTENT. Two shapes are illegal and
 * BOTH were reachable, because `mergeVideoRecord` above flips `state` (a live loser
 * promotes a pending survivor) and never touches `folderId`:
 *  - pending but not parked: `by_folder_sort` carries no state component, so an
 *    unapproved record left in a real folder is visible to the CHILD.
 *  - live but still parked in '~pending': invisible in the child's folder AND absent from
 *    the approval queue — a record that exists and can never be reached.
 * Lives here, next to the merge it repairs, because BOTH callers of that merge need it:
 * `plan.planMutations` (the sync's title-twin and prior branches) and
 * `drive.applyRemoteDoc` (a peer's approval arriving over the Drive doc).
 */
export function settleCuration(rec, fallbackFolderId, now = Date.now()) {
  if (rec.state === 'pending') {
    rec.homeFolderId = rec.homeFolderId || fallbackFolderId;
    rec.folderId = '~pending';
  } else {
    if (rec.folderId === '~pending') rec.folderId = rec.homeFolderId || fallbackFolderId;
    if (!rec.approvedAt) rec.approvedAt = now; // it becomes live HERE — say when
  }
  return rec;
}
