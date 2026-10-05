// platform.js — the v1.0.93 halves of the links list's copy and share that node can run.
//
// The two field bugs behind "📨 שליחה כטקסט does nothing" were both in this seam: the
// export's file path arrived PERCENT-ENCODED (a Hebrew profile name in the file name), so
// the native share could not find the file; and the native share "succeeded" over a pinned
// screen where Android refuses every new window. The native halves are device-only; what
// the JS side decides about their answers is pinned here.
//
// platform.js reads `window.Capacitor.Plugins` on EVERY call (plugin()), so a stub installed
// after import is seen — each test installs exactly the plugins it means to exist.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const plat = await import('../www/js/platform.js');

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function withNavigator(value) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
}
function withPlugins(plugins) {
  globalThis.window = { Capacitor: { Plugins: plugins } };
}
afterEach(() => {
  delete globalThis.window;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  else delete globalThis.navigator;
  delete globalThis.document;
});

test('fileUriToPath decodes the percent-encoded Hebrew file name Filesystem hands back (v1.0.93)', () => {
  // Uri.fromFile(file).toString() encodes every non-ASCII character; `new File()` on the
  // encoded string never exists. This is the whole reason the export's share sheet never opened.
  const enc = 'file:///storage/emulated/0/Android/data/com.assaf.kidsplayer/files/exports/kids-player-links-%D7%A0%D7%95%D7%A2%D7%9D-2026-10-05.txt';
  assert.equal(plat.fileUriToPath(enc),
    '/storage/emulated/0/Android/data/com.assaf.kidsplayer/files/exports/kids-player-links-נועם-2026-10-05.txt');
  assert.equal(plat.fileUriToPath('file:///a/b/plain.txt'), '/a/b/plain.txt');
  assert.equal(plat.fileUriToPath('/already/a/path.txt'), '/already/a/path.txt');
  // a malformed escape keeps the raw string rather than throwing
  assert.equal(plat.fileUriToPath('file:///a/%E0%A4%A.txt'), '/a/%E0%A4%A.txt');
  assert.equal(plat.fileUriToPath(''), null);
  assert.equal(plat.fileUriToPath(null), null);
});

test('copyText prefers the NATIVE clipboard, and passes the text through untouched (v1.0.93)', async () => {
  const calls = [];
  withPlugins({ KidsNative: { copyText: async (o) => { calls.push(o); } } });
  withNavigator({ clipboard: { writeText: async () => { throw new Error('must not be reached'); } } });
  assert.equal(await plat.copyText('א\nb', 'רשימה'), 'native');
  assert.deepEqual(calls, [{ text: 'א\nb', label: 'רשימה' }]);
});

test('copyText falls through native → browser clipboard → nothing, and never throws (v1.0.93)', async () => {
  // native refused (an APK built before the method, or a clip too large for the system)
  withPlugins({ KidsNative: { copyText: async () => { throw new Error('copy-failed'); } } });
  let written = null;
  withNavigator({ clipboard: { writeText: async (t) => { written = t; } } });
  assert.equal(await plat.copyText('list'), 'web');
  assert.equal(written, 'list');
  // the browser API refuses too, and there is no document for the legacy path
  withNavigator({ clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } });
  assert.equal(await plat.copyText('list'), 'none');
  // no plugin at all, no clipboard API
  delete globalThis.window;
  withNavigator({});
  assert.equal(await plat.copyText('list'), 'none');
  // nothing to copy is not a success
  assert.equal(await plat.copyText(''), 'none');
  assert.equal(await plat.copyText(null), 'none');
});

test('copyText uses the legacy execCommand path when the async API is missing (v1.0.93)', async () => {
  withNavigator({});
  let removed = false;
  let selected = false;
  const ta = { setAttribute() {}, style: {}, select() { selected = true; }, remove() { removed = true; } };
  globalThis.document = {
    body: { appendChild() {} },
    createElement: () => ta,
    execCommand: (cmd) => cmd === 'copy'
  };
  assert.equal(await plat.copyText('list'), 'legacy');
  assert.equal(ta.value, 'list');
  assert.ok(selected, 'the textarea must be selected before the copy');
  assert.ok(removed, 'the helper textarea must not be left in the page');
  globalThis.document.execCommand = () => false;
  assert.equal(await plat.copyText('list'), 'none', 'a refused execCommand is not a copy');
});

test('a share refused under the KIOSK LOCK is told apart from any other failure (v1.0.93)', async () => {
  // Capacitor rejects with { message, code } — the native side answers code LOCKED
  const locked = Object.assign(new Error('locked'), { code: 'LOCKED' });
  withPlugins({ KidsNative: { shareFile: async () => { throw locked; } } });
  assert.equal(await plat.shareFile('/x.txt'), 'locked');
  withPlugins({ KidsNative: { shareFile: async () => { throw new Error('share-file-failed: boom'); } } });
  assert.equal(await plat.shareFile('/x.txt'), 'none');
  withPlugins({ KidsNative: { shareFile: async () => {} } });
  assert.equal(await plat.shareFile('/x.txt'), 'native');
  assert.equal(await plat.shareFile(''), 'none');
});

test('shareText under the kiosk lock COPIES instead of announcing a window that never opens (v1.0.93)', async () => {
  const copied = [];
  withPlugins({
    KidsNative: {
      shareText: async () => { throw Object.assign(new Error('locked'), { code: 'LOCKED' }); },
      copyText: async (o) => { copied.push(o.text); }
    }
  });
  withNavigator({ share: async () => { throw new Error('must not be reached'); } });
  assert.equal(await plat.shareText('הודעה', 'נושא'), 'clipboard');
  assert.deepEqual(copied, ['הודעה']);
  // and when even the copy fails, it says so
  withPlugins({
    KidsNative: {
      shareText: async () => { throw Object.assign(new Error('locked'), { code: 'LOCKED' }); },
      copyText: async () => { throw new Error('no'); }
    }
  });
  withNavigator({});
  assert.equal(await plat.shareText('הודעה'), 'none');
  // an ordinary success is untouched
  withPlugins({ KidsNative: { shareText: async () => {} } });
  assert.equal(await plat.shareText('הודעה'), 'native');
});
