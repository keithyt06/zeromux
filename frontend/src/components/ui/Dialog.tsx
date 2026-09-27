import { useEffect, useId, useRef, type ReactNode, type MouseEvent } from 'react'
import { modalStack } from './modalStack'

/** Native <dialog> modal. Lives in the browser top layer, so ancestors'
 *  `contain: paint` / overflow / z-index can't clip or reorder it (replaces
 *  the "full-screen only because no positioned ancestor" panels, audit §4.2). */
export function Dialog({ open, onClose, title, children, className = '', labelledBy }: {
  open: boolean; onClose: () => void; title?: string; children: ReactNode; className?: string; labelledBy?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef<Element | null>(null)
  const titleId = useId()

  useEffect(() => {
    const el = ref.current
    if (open) {
      if (!el) return
      if (!el.open) {
        opener.current = document.activeElement
        el.showModal()
      }
      modalStack.push(el)
      return () => modalStack.pop(el)
    }
    // open=false renders null (the <dialog> is already gone, ref is null), so
    // restore focus here rather than gating on the element.
    el?.close()
    ;(opener.current as HTMLElement | null)?.focus?.()
    opener.current = null
  }, [open])

  useEffect(() => () => { (opener.current as HTMLElement | null)?.focus?.() }, [])

  // Only a press that both started and ended on the backdrop closes: a text
  // selection dragged out of an input must not dismiss (and lose) the dialog.
  const downOnSelf = useRef(false)
  const onBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    const self = downOnSelf.current && e.target === e.currentTarget
    downOnSelf.current = false
    if (self) onClose()
  }

  if (!open) return null
  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy ?? (title ? titleId : undefined)}
      onCancel={e => { e.preventDefault(); onClose() }}
      onPointerDown={e => { downOnSelf.current = e.target === e.currentTarget }}
      onClick={onBackdrop}
      className={`bg-transparent p-0 m-auto backdrop:bg-black/50 ${className}`}
    >
      <div className="bg-[var(--surface-2)] text-[var(--fg)] border border-[var(--border)] rounded-[var(--r-lg)] shadow-[var(--shadow-overlay)] w-[min(480px,calc(100vw-24px))]">
        {title && <h2 id={titleId} className="px-4 pt-4 text-ui-lg font-semibold text-[var(--fg-strong)]">{title}</h2>}
        {children}
      </div>
    </dialog>
  )
}
