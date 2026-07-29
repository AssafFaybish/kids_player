// state.js — shared mutable state + a tiny event bus, so view modules never have to
// import each other (the #1 hazard of a no-bundler ES-module split is an import cycle,
// which surfaces as `undefined` bindings at call time, not as a build error).
//
// Views subscribe in their mount() and re-render on events; mutators here dispatch.

export const state = {
  items: [],                        // legacy in-memory list (until views read from db.js)
  source: { mode: 'manual', url: '' },
  profiles: [],
  folderId: null,                   // current folder in the folders/folder views
  currentWatch: null,
  pages: { folders: 0, folder: 0, watch: 0, gallery: 0 }
};

export const bus = new EventTarget();

export function emit(type) { bus.dispatchEvent(new Event(type)); }
export function on(type, fn) { bus.addEventListener(type, fn); }

export function setItems(items) { state.items = items; emit('items-changed'); }
export function setProfiles(profiles) { state.profiles = profiles; emit('profiles-changed'); }
