import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Popover } from './Popover'
import { Kbd } from './Kbd'

export type MenuItem = { label: string; icon?: LucideIcon; danger?: boolean; kbd?: string; disabled?: boolean; onSelect(): void }

export function Menu({ open, onClose, anchor, items, title }: { open: boolean; onClose(): void; anchor: HTMLElement | null; items: MenuItem[]; title?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    if (!open) return
    const first = () => refs.current.find(Boolean)?.focus()
    first()
    // As a bottom Sheet the <dialog> opens in the parent's effect (after ours),
    // so retry once it is shown.
    const r = requestAnimationFrame(() => { if (!refs.current.includes(document.activeElement as HTMLButtonElement)) first() })
    return () => cancelAnimationFrame(r)
  }, [open])
  const focusAt = (i: number) => refs.current[(i + items.length) % items.length]?.focus()
  const select = (i: number) => { const it = items[i]; if (it.disabled) return; it.onSelect(); onClose() }
  const onKey = (i: number) => (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1) }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0) }
    else if (e.key === 'End') { e.preventDefault(); focusAt(items.length - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i) }
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase()
      const j = items.findIndex((it, idx) => idx > i && it.label.toLowerCase().startsWith(k))
      const j2 = j >= 0 ? j : items.findIndex(it => it.label.toLowerCase().startsWith(k))
      if (j2 >= 0) focusAt(j2)
    }
  }
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} align="end" sheetTitle={title}>
      <div role="menu" aria-label={title}>
        {items.map((it, i) => (
          <button key={it.label} type="button" role="menuitem" ref={el => { refs.current[i] = el }} disabled={it.disabled}
            onKeyDown={onKey(i)} onClick={() => select(i)}
            className={`row w-full flex items-center gap-2.5 px-3 text-left text-ui-sm outline-none focus-visible:bg-[var(--surface-hover)] hover:bg-[var(--surface-hover)] disabled:opacity-50 ${it.danger ? 'text-[var(--danger)] danger' : 'text-[var(--fg)]'}`}>
            {it.icon && <it.icon size={16} className="shrink-0" />}
            <span className="flex-1">{it.label}</span>
            {it.kbd && <Kbd>{it.kbd}</Kbd>}
          </button>
        ))}
      </div>
    </Popover>
  )
}
