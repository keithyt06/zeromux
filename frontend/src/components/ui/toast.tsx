import { useEffect, useRef, useSyncExternalStore } from 'react'

type Item = { id: string; message: string; action?: { label: string; onClick(): void | Promise<void> }; durationMs: number; key?: string }
const MAX = 3
let items: Item[] = []
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())
let seq = 0

// eslint-disable-next-line react-refresh/only-export-components -- imperative API is the point of this module
export const toast = {
  push(t: { message: string; action?: Item['action']; durationMs?: number; key?: string }): string {
    const id = `t${++seq}`
    const it: Item = { id, message: t.message, action: t.action, durationMs: t.durationMs ?? 3000, key: t.key }
    items = [...items.filter(x => !(t.key && x.key === t.key)), it].slice(-MAX)
    emit()
    return id
  },
  dismiss(id: string) { items = items.filter(x => x.id !== id); emit() },
}

function ToastRow({ it }: { it: Item }) {
  const left = useRef(it.durationMs)
  const started = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const start = () => { started.current = Date.now(); timer.current = setTimeout(() => toast.dismiss(it.id), left.current) }
  const pause = () => { clearTimeout(timer.current); left.current -= Date.now() - started.current }
  useEffect(() => { start(); return () => clearTimeout(timer.current) }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div role="status" data-toast-id={it.id}
      onPointerDown={it.action ? pause : undefined} onPointerUp={it.action ? start : undefined}
      className="pointer-events-auto flex items-center gap-3 px-4 min-h-[var(--row-h)] rounded-[var(--r-md)] bg-[var(--surface-3)] border border-[var(--border)] shadow-[var(--shadow-overlay)] text-ui-sm text-[var(--fg)]">
      <span className="flex-1">{it.message}</span>
      {it.action && (
        <button className="font-medium text-[var(--accent)]" onClick={async () => { await it.action!.onClick(); toast.dismiss(it.id) }}>{it.action.label}</button>
      )}
    </div>
  )
}

/** Toast stack. Desktop bottom-right; phone bottom-centre above the safe area. */
export function Toaster() {
  const list = useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => items, () => items)
  return (
    <div className="fixed z-toast pointer-events-none flex flex-col gap-2 left-1/2 -translate-x-1/2 md:left-auto md:translate-x-0 md:right-4 w-[min(420px,calc(100vw-24px))]"
      style={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
      {list.map(it => <ToastRow key={it.id} it={it} />)}
    </div>
  )
}
