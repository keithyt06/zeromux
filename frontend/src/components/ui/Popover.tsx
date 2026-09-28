import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Sheet } from './Sheet'
import { useIsNarrow } from '../../lib/useMediaQuery'
import { placeLayer } from './placeLayer'


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
 *  inert, and a Sheet inside a Sheet is not allowed. `anchored` also keeps it
 *  anchored on phones: for typeaheads whose input must keep focus (a modal Sheet
 *  would make the input inert and drop the keyboard mid-typing). */
export function Popover({ open, onClose, anchor, placement = 'bottom', align = 'start', children, sheetTitle, anchored = false }: {
  open: boolean; onClose: () => void; anchor: HTMLElement | null; placement?: 'top' | 'bottom'; align?: 'start' | 'end'; children: ReactNode; sheetTitle?: string; anchored?: boolean
}) {
  const narrow = useIsNarrow()
  const hostDialog = anchor?.closest('dialog') ?? null
  const inModal = !!hostDialog
  const asSheet = narrow && !inModal && !anchored
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  // Callers pass inline closures; don't re-subscribe (and reorder `layers`) per render.
  const close = useEffectEvent(() => onClose())

  useLayoutEffect(() => {
    const el = ref.current
    if (!open || asSheet || !anchor || !el) return
    const place = () => {
      const p = el.getBoundingClientRect()
      const vv = window.visualViewport
      setPos(placeLayer({
        a: anchor.getBoundingClientRect(), w: p.width, h: p.height,
        vvTop: vv?.offsetTop ?? 0, vvHeight: vv?.height ?? window.innerHeight, vw: window.innerWidth,
        placement, align,
      }))
    }
    place()
    // Content changes size (New session steps, async lists) → re-anchor.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    ro?.observe(el)
    window.addEventListener('resize', place)
    // Soft keyboard: iOS resizes/pans the visual viewport without a window resize.
    const vv = window.visualViewport
    vv?.addEventListener('resize', place)
    vv?.addEventListener('scroll', place)
    return () => {
      ro?.disconnect(); window.removeEventListener('resize', place)
      vv?.removeEventListener('resize', place); vv?.removeEventListener('scroll', place)
    }
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
