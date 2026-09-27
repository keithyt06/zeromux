// Open modal <dialog>s, topmost last. Toaster portals into top() so toasts stay
// visible and clickable instead of sitting under the top layer / inert page.
let stack: HTMLElement[] = []
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())

export const modalStack = {
  push(el: HTMLElement) { stack = [...stack.filter(x => x !== el), el]; emit() },
  pop(el: HTMLElement) { if (stack.includes(el)) { stack = stack.filter(x => x !== el); emit() } },
  top(): HTMLElement | null { return stack[stack.length - 1] ?? null },
  subscribe(cb: () => void) { subs.add(cb); return () => { subs.delete(cb) } },
}

/** Return focus to `target` only if focus is lost (null/body) or still inside
 *  the layer that is closing (a detached element counts as lost). If something already took focus on purpose (e.g.
 *  a rename input mounted by the chosen menu item), leave it there. */
export function restoreFocus(target: Element | null | undefined, closing: Element | null | undefined) {
  const a = document.activeElement
  if (a && a !== document.body && a.isConnected && !(closing && closing.contains(a))) return
  ;(target as HTMLElement | null)?.focus?.()
}
