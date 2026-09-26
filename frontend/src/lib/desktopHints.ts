// Desktop terminal hints/prefs, both backed by a Storage-like object so tests
// can inject an in-memory stub instead of touching real localStorage.

type KV = Pick<Storage, 'getItem' | 'setItem'>
const SHIFT_KEY = 'zmx-shift-hint'
export const MOUSE_PREF_KEY = 'zmx-tmux-mouse'

/** tmux `mouse on` means plain drag goes to tmux; Shift+drag selects in the browser. */
export function shouldShowShiftHint(storage: KV): boolean {
  if (storage.getItem(SHIFT_KEY)) return false
  storage.setItem(SHIFT_KEY, '1')
  return true
}

export function mousePref(storage: KV): boolean {
  return storage.getItem(MOUSE_PREF_KEY) !== '0'
}
