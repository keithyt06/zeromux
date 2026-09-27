import { useEffect, useId, useRef, useState, type ReactNode, type PointerEvent } from 'react'
import { modalStack } from './modalStack'

let openSheets = 0
const KEYBOARD_PX = 120

function keyboardHeight(): number | null {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  if (!vv) return null
  return window.innerHeight - vv.height > KEYBOARD_PX ? vv.height : null
}

/** Panel / drawer on a native modal <dialog>. bottom: two snap points, drag
 *  the handle down to dismiss, full height while the soft keyboard is up so
 *  focused inputs aren't covered. Only one Sheet may be open at a time. */
export function Sheet({ open, onClose, side, title, actions, snap = 'half', children }: {
  open: boolean; onClose: () => void; side: 'bottom' | 'right' | 'full'; title?: string; actions?: ReactNode; snap?: 'half' | 'full'; children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)
  const titleId = useId()
  const [kb, setKb] = useState<number | null>(() => (side === 'bottom' ? keyboardHeight() : null))
  const drag = useRef<{ y: number; t: number } | null>(null)
  const [dy, setDy] = useState(0)
  const downOnSelf = useRef(false)

  useEffect(() => {
    if (!open) return
    if (openSheets > 0 && import.meta.env.DEV) console.error('Sheet inside Sheet is not allowed')
    openSheets++
    const el = ref.current
    opener.current = document.activeElement
    if (el && !el.open) el.showModal()
    if (el) modalStack.push(el)
    return () => {
      openSheets--
      if (el) modalStack.pop(el)
      if (el?.open) el.close()
      ;(opener.current as HTMLElement | null)?.focus?.()
    }
  }, [open])

  useEffect(() => {
    if (!open || side !== 'bottom' || !window.visualViewport) return
    const vv = window.visualViewport
    const on = () => setKb(keyboardHeight())
    vv.addEventListener('resize', on)
    return () => vv.removeEventListener('resize', on)
  }, [open, side])

  if (!open) return null

  const effSnap = side === 'bottom' && kb != null ? 'full' : snap
  const height = side === 'bottom' ? (kb != null ? `${kb}px` : effSnap === 'full' ? 'calc(100dvh - env(safe-area-inset-top) - 8px)' : '50dvh') : undefined

  const onDown = (e: PointerEvent) => {
    if ((bodyRef.current?.scrollTop ?? 0) > 0) return
    drag.current = { y: e.clientY, t: performance.now() }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onMove = (e: PointerEvent) => { if (drag.current) setDy(Math.max(0, e.clientY - drag.current.y)) }
  const onUp = (e: PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const dist = Math.max(0, e.clientY - d.y)
    const v = dist / Math.max(1, performance.now() - d.t)
    const h = ref.current?.getBoundingClientRect().height ?? 1
    setDy(0)
    if (dist > h * 0.3 || (dist > 24 && v > 0.5)) onClose()
  }
  const onCancelDrag = () => { drag.current = null; setDy(0) }

  const base = 'p-0 m-0 max-w-none max-h-none bg-[var(--surface-1)] text-[var(--fg)] backdrop:bg-black/50'
  const bySide = {
    full: 'inset-0 w-screen h-[100dvh]',
    right: 'ml-auto mr-0 h-[100dvh] w-[360px] border-l border-[var(--border)]',
    bottom: 'mt-auto mb-0 w-screen rounded-t-[var(--r-sheet)] border-t border-[var(--border)] shadow-[var(--shadow-overlay)]',
  }[side]

  return (
    <dialog
      ref={ref}
      data-side={side}
      data-snap={effSnap}
      aria-labelledby={title ? titleId : undefined}
      onCancel={e => { e.preventDefault(); onClose() }}
      onPointerDown={e => { downOnSelf.current = e.target === e.currentTarget }}
      onClick={e => {
        const self = downOnSelf.current && e.target === e.currentTarget
        downOnSelf.current = false
        if (self) onClose()
      }}
      style={{ height, transform: dy ? `translateY(${dy}px)` : undefined, transition: dy ? 'none' : 'transform var(--dur-base) var(--ease-out)' }}
      className={`${base} ${bySide} flex flex-col`}
    >
      {side === 'bottom' && (
        <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancelDrag} className="flex justify-center py-2 touch-none cursor-grab" aria-hidden>
          <span className="h-1 w-10 rounded-full bg-[var(--border)]" />
        </div>
      )}
      {(title || actions) && (
        <header className="flex items-center gap-2 px-4 min-h-[var(--row-h)] border-b border-[var(--border-subtle)]">
          {title && <h2 id={titleId} className="flex-1 text-ui-lg font-semibold text-[var(--fg-strong)] truncate">{title}</h2>}
          {actions}
        </header>
      )}
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
        {children}
      </div>
    </dialog>
  )
}
