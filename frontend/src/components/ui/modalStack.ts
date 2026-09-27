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
