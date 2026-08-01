// ui/modal.js — the kid-styled modal that replaces window.confirm/alert.
// One modal at a time; a second call resolves false immediately (no stacking).
// Scrim tap = cancel. The hardware back button cancels via nav.handleBack → closeModal.
//
// RTL BUTTON ORDER (deliberate): #modal-cancel is FIRST in the DOM, so it renders
// RIGHTMOST in RTL — where the thumb lands. Callers must put the SAFE choice in
// `cancel` (e.g. exit dialog: cancel='השאר' right, ok='צא' left + danger).

const $ = (id) => document.getElementById(id);

let openState = null; // { resolve }

export function isModalOpen() { return !!openState; }

export function closeModal(result) {
  if (!openState) return;
  const s = openState;
  openState = null;
  $('modal').classList.add('hidden');
  s.resolve(result);
}

function show({ emoji = '❓', title = '', text = '', ok = 'אישור', cancel = null, third = null, danger = false }) {
  if (openState) return Promise.resolve(false);
  $('modal-emoji').textContent = emoji;
  $('modal-title').textContent = title;
  $('modal-text').textContent = text || '';
  $('modal-text').classList.toggle('hidden', !text);
  const okBtn = $('modal-ok');
  const cancelBtn = $('modal-cancel');
  const thirdBtn = $('modal-third');
  okBtn.textContent = ok;
  okBtn.classList.toggle('modal-danger', !!danger);
  cancelBtn.classList.toggle('hidden', cancel == null);
  cancelBtn.textContent = cancel || '';
  // v1.0.23 — three-way questions. Hidden (and reset) whenever `third` is absent, so a
  // dialog raised later can never inherit the previous one's extra button.
  thirdBtn.classList.toggle('hidden', third == null);
  thirdBtn.textContent = third || '';
  $('modal').classList.remove('hidden');
  return new Promise((resolve) => { openState = { resolve }; });
}

/** Two big buttons; resolves true only on the ok button. */
export function confirmKid(opts) { return show(opts).then((r) => r === true); }

/**
 * Like confirmKid, but tells apart an EXPLICIT cancel-button press from an
 * accidental dismiss (scrim tap / hardware back): 'ok' | 'cancel' | 'dismiss'.
 * Use when "no" has consequences (e.g. the update prompt writes update.skip) —
 * a child poking outside the dialog must not silently answer for the parent.
 */
export function askKid(opts) {
  return show(opts).then((r) => (r === true ? 'ok' : r === 'cancel' ? 'cancel' : r === 'third' ? 'third' : 'dismiss'));
}

/** One button; resolves when dismissed. */
export function alertKid(opts) { return show({ ...opts, cancel: null }).then(() => undefined); }

/** Wire once from app.js init. */
export function mountModal() {
  $('modal-ok').addEventListener('click', () => closeModal(true));
  $('modal-cancel').addEventListener('click', () => closeModal('cancel'));
  $('modal-third').addEventListener('click', () => closeModal('third'));
  $('modal-scrim').addEventListener('click', () => closeModal(false)); // dismiss, not an answer
}
