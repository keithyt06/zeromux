import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { modalStack } from './modalStack'

// Timer state lives in the store, not the row: the Toaster re-portals into the
// top modal when one opens, which remounts rows. A row-local timer would restart
// and let the undo toast outlive the server's undo window (I-18).
type Item = {
  id: string; message: string; action?: { label: string; onClick(): void | Promise<void> }; key?: string
  deadline: number | null   // null while paused
  remaining: number         // ms left when paused
}
const MAX = 3
let items: Item[] = []
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())
const update = (id: string, f: (it: Item) => Item) => { items = items.map(x => (x.id === id ? f(x) : x)); emit() }
let seq = 0

// eslint-disable-next-line react-refresh/only-export-components -- imperative API is the point of this module
export const toast = {
  push(t: { message: string; action?: Item['action']; durationMs?: number; key?: string }): string {
    const id = `t${++seq}`
    const ms = t.durationMs ?? 3000
    const it: Item = { id, message: t.message, action: t.action, key: t.key, deadline: Date.now() + ms, remaining: ms }
    items = [...items.filter(x => !(t.key && x.key === t.key)), it].slice(-MAX)
    emit()
    return id
  },
  dismiss(id: string) { items = items.filter(x => x.id !== id); emit() },
}

const pause = (id: string) => update(id, it => (it.deadline == null ? it : { ...it, deadline: null, remaining: Math.max(0, it.deadline - Date.now()) }))
const resume = (id: string) => update(id, it => (it.deadline != null ? it : { ...it, deadline: Date.now() + it.remaining }))

function ToastRow({ it }: { it: Item }) {
  useEffect(() => {
    if (it.deadline == null) return
    const t = setTimeout(() => toast.dismiss(it.id), Math.max(0, it.deadline - Date.now()))
    return () => clearTimeout(t)
  }, [it.id, it.deadline])
  const hold = it.action ? () => pause(it.id) : undefined
  const release = it.action ? () => resume(it.id) : undefined
  return (
    <div role="status" data-toast-id={it.id}
      onPointerDown={hold} onPointerUp={release} onPointerCancel={release} onPointerLeave={release}
      className="pointer-events-auto flex items-center gap-3 px-4 min-h-[var(--row-h)] rounded-[var(--r-md)] bg-[var(--surface-3)] border border-[var(--border)] shadow-[var(--shadow-overlay)] text-ui-sm text-[var(--fg)]">
      <span className="flex-1">{it.message}</span>
      {it.action && (
        // Dismiss before awaiting, and bail if already gone, so a double tap
        // (even before re-render) can't run restore twice.
        <button className="font-medium text-[var(--accent)]" onClick={async () => {
          if (!items.some(x => x.id === it.id)) return
          toast.dismiss(it.id)
          await it.action!.onClick()
        }}>{it.action.label}</button>
      )}
    </div>
  )
}

/** Toast stack. Desktop bottom-right; phone bottom-centre above the safe area.
 *  Portalled into the topmost open modal <dialog> (else body) so it is neither
 *  hidden under the top layer nor inert. */
export function Toaster() {
  const list = useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => items, () => items)
  const top = useSyncExternalStore(modalStack.subscribe, modalStack.top, modalStack.top)
  return createPortal(
    <div className="fixed z-toast pointer-events-none flex flex-col gap-2 left-1/2 -translate-x-1/2 md:left-auto md:translate-x-0 md:right-4 w-[min(420px,calc(100vw-24px))]"
      style={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
      {list.map(it => <ToastRow key={it.id} it={it} />)}
    </div>,
    top ?? document.body,
  )
}
