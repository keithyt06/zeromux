import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Sheet } from './Sheet'
import { useIsNarrow } from '../../lib/useMediaQuery'

const GAP = 6
const MARGIN = 12

// Open anchored layers, innermost last. A Menu opened from inside a Popover
// (QuickTargets row menu inside New session) portals as a sibling, so the outer
// layer must treat presses inside an inner layer as "inside", and only the
// innermost layer answers Esc.
const layers: HTMLElement[] = []

/** Anchored floating layer. Portals into #overlay-root so it's never inside
 *  .xterm-container (touch-action:none would block scrolling) or
 *  .vault-reading-surface (contain:paint would clip it). On phones it becomes
 *  a bottom Sheet — anchored layers get pushed off-screen by the soft keyboard.
 *  Exception: when the anchor already lives inside a modal (a Sheet/Dialog) it
 *  stays anchored and portals into that dialog — outside it the page is
 *  inert, and a Sheet inside a Sheet is not allowed. */
export function Popover({ open, onClose, anchor, placement = 'bottom', align = 'start', children, sheetTitle }: {
  open: boolean; onClose: () => void; anchor: HTMLElement | null; placement?: 'top' | 'bottom'; align?: 'start' | 'end'; children: ReactNode; sheetTitle?: string
}) {
  const narrow = useIsNarrow()
  const hostDialog = anchor?.closest('dialog') ?? null
  const inModal = !!hostDialog
  const asSheet = narrow && !inModal
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  // Callers pass inline closures; don't re-subscribe (and reorder `layers`) per render.
  const close = useEffectEvent(() => onClose())

  useLayoutEffect(() => {
    const el = ref.current
    if (!open || asSheet || !anchor || !el) return
    const place = () => {
      const a = anchor.getBoundingClientRect()
      const p = el.getBoundingClientRect()
      const vh = window.visualViewport?.height ?? window.innerHeight
      const vw = window.innerWidth
      const fitsBelow = a.bottom + GAP + p.height <= vh - MARGIN
      const fitsAbove = a.top - GAP - p.height >= MARGIN
      const below = placement === 'bottom' ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow
      const top = below ? a.bottom + GAP : a.top - GAP - p.height
      let left = align === 'start' ? a.left : a.right - p.width
      left = Math.min(Math.max(MARGIN, left), vw - MARGIN - p.width)
      setPos({ top: Math.max(MARGIN, top), left })
    }
    place()
    // Content changes size (New session steps, async lists) → re-anchor.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    ro?.observe(el)
    window.addEventListener('resize', place)
    return () => { ro?.disconnect(); window.removeEventListener('resize', place) }
  }, [open, asSheet, anchor, placement, align])

  useEffect(() => {
    const el = ref.current
    if (!open || asSheet || !el) return
    layers.push(el)
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (el.contains(t) || anchor?.contains(t)) return
      if (layers.slice(layers.indexOf(el) + 1).some(l => l.contains(t))) return
      close()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || layers[layers.length - 1] !== el) return
      // IME: Esc cancels the composition candidate, not the layer (same guard as Composer).
      if (e.isComposing || e.keyCode === 229) return
      // Keep the Esc from also cancelling a host Sheet/Dialog or an outer layer.
      e.preventDefault(); e.stopPropagation()
      close(); anchor?.focus()
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key, true)
    return () => {
      layers.splice(layers.indexOf(el), 1)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [open, asSheet, anchor])

  if (!open) return null
  if (asSheet) return <Sheet open side="bottom" onClose={onClose} title={sheetTitle}>{children}</Sheet>
  const host = hostDialog ?? document.getElementById('overlay-root') ?? document.body
  return createPortal(
    <div ref={ref} className="fixed z-popover min-w-[160px] max-w-[min(320px,calc(100vw-24px))] max-h-[calc(100dvh-24px)] overflow-y-auto rounded-[var(--r-lg)] bg-[var(--surface-2)] text-[var(--fg)] border border-[var(--border)] shadow-[var(--shadow-overlay)] py-1"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}>
      {children}
    </div>,
    host,
  )
}
