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

function show({ emoji = '❓', title = '', text = '', ok = 'אישור', cancel = null, danger = false }) {
  if (openState) return Promise.resolve(false);
  $('modal-emoji').textContent = emoji;
  $('modal-title').textContent = title;
  $('modal-text').textContent = text || '';
  $('modal-text').classList.toggle('hidden', !text);
  const okBtn = $('modal-ok');
  const cancelBtn = $('modal-cancel');
  okBtn.textContent = ok;
  okBtn.classList.toggle('modal-danger', !!danger);
  cancelBtn.classList.toggle('hidden', cancel == null);
  cancelBtn.textContent = cancel || '';
  $('modal').classList.remove('hidden');
  return new Promise((resolve) => { openState = { resolve }; });
}

/** Two big buttons; resolves true only on the ok button. */
export function confirmKid(opts) { return show(opts).then(Boolean); }

/** One button; resolves when dismissed. */
export function alertKid(opts) { return show({ ...opts, cancel: null }).then(() => undefined); }

/** Wire once from app.js init. */
export function mountModal() {
  $('modal-ok').addEventListener('click', () => closeModal(true));
  $('modal-cancel').addEventListener('click', () => closeModal(false));
  $('modal-scrim').addEventListener('click', () => closeModal(false));
}
