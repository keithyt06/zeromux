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

/** The mouse toggle / on-connect `mouse off` only touch sessions zeromux owns;
 *  an External session (e.g. VSCode's) keeps whatever option its owner set. */
export function mouseToggleApplies(origin: 'own' | 'external' | null | undefined): boolean {
  return origin === 'own'
}

/** On (re)connect: re-apply the user's "mouse to browser" pref to Own sessions. */
export function shouldSendMouseOffOnConnect(hasTmux: boolean, origin: 'own' | 'external' | null | undefined, storage: KV): boolean {
  return hasTmux && mouseToggleApplies(origin) && !mousePref(storage)
}
