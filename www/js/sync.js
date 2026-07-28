// sync.js — remote list mirroring. Fetches the parent's file, parses it, and rebuilds the
// stored list to match it exactly (single source of truth), preserving file order.
import { httpGetText } from './platform.js';
import {
  getSource, loadItems, saveItems, classifyLink, fetchYouTubeTitle, driveFileId
} from './store.js';

const MAX_ITEMS = 300;

// Turn a normal share link into something that returns raw CSV/text, so pasting the plain link
// "just works". Handles Google Sheets edit/share links and Google Drive file links. Already-CSV
// URLs (pub?output=csv, export?format=csv) and any other URL pass through unchanged.
export function resolveListUrl(url) {
  const u = String(url).trim();

  // Google Sheet share/edit link -> CSV export (needs the sheet shared "anyone with the link").
  // Skip the already-published /d/e/<token> form and anything already asking for csv.
  const gs = u.match(/docs\.google\.com\/spreadsheets\/d\/(?!e\/)([A-Za-z0-9_-]+)/);
  if (gs && !/[?&](output|format)=csv/.test(u)) {
    const gid = (u.match(/[#?&]gid=([0-9]+)/) || [])[1];
    return `https://docs.google.com/spreadsheets/d/${gs[1]}/export?format=csv` + (gid ? `&gid=${gid}` : '');
  }

  // Google Drive file share link (/file/d/ID/view) serves an HTML viewer, not the raw file.
  const id = driveFileId(u);
  if (id && !/[?&]export=download/.test(u)) {
    return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  return u;
}

// Parse plain text / CSV / JSON into rows of { url, title, thumb }.
export function parseList(text) {
  const t = String(text || '').trim();
  if (!t) return [];

  if (t[0] === '[') {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) {
        return arr
          .map((x) => (typeof x === 'string'
            ? { url: x, title: '', thumb: '' }
            : { url: x.url || x.link || '', title: x.title || '', thumb: x.thumb || '' }))
          .filter((r) => r.url);
      }
    } catch { /* fall through to line parsing */ }
  }

  const rows = [];
  for (let line of t.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/[\t,]/).map((s) => s.trim().replace(/^"+|"+$/g, ''));
    if (parts[0]) rows.push({ url: parts[0], title: parts[1] || '', thumb: parts[2] || '' });
  }
  return rows;
}

// Runs on launch, on resume, and via "Refresh now". Returns { ok, count } / { ok:false, error } / { skipped }.
export async function syncFromRemote() {
  const src = await getSource();
  if (src.mode !== 'remote' || !src.url) return { skipped: true };

  let text;
  try { text = await httpGetText(resolveListUrl(src.url)); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }

  const rows = parseList(text);
  const prev = await loadItems();
  const prevByKey = Object.fromEntries(prev.map((i) => [i.key, i]));

  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const c = classifyLink(row.url);
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    const old = prevByKey[c.key] || {};
    const item = { ...c, addedAt: old.addedAt || Date.now() };
    if (old.localPath) item.localPath = old.localPath; // keep already-downloaded files
    item.thumb = row.thumb || old.thumb || null;
    item.title = row.title || old.title || '';
    if (c.type === 'youtube' && !item.title) item.title = (await fetchYouTubeTitle(c.id)) || '';
    out.push(item);
    if (out.length >= MAX_ITEMS) break;
  }

  await saveItems(out);
  return { ok: true, count: out.length };
}
