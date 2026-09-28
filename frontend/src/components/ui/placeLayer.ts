export const GAP = 6
export const MARGIN = 12

type Box = { top: number; bottom: number; left: number; right: number }

/** Where an anchored layer goes, in layout-viewport coords (what position:fixed
 *  uses). The visible band is [vvTop, vvTop + vvHeight]: with the iOS soft keyboard
 *  up the visual viewport is shorter AND may be panned (offsetTop > 0), so both
 *  the fit checks and the top clamp must be offset by it. */
export function placeLayer(o: {
  a: Box; w: number; h: number; vvTop: number; vvHeight: number; vw: number
  placement: 'top' | 'bottom'; align: 'start' | 'end'
}): { top: number; left: number } {
  const { a, w, h, vvTop, vvHeight, vw, placement, align } = o
  const fitsBelow = a.bottom + GAP + h <= vvTop + vvHeight - MARGIN
  const fitsAbove = a.top - GAP - h >= vvTop + MARGIN
  const below = placement === 'bottom' ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow
  const top = below ? a.bottom + GAP : a.top - GAP - h
  let left = align === 'start' ? a.left : a.right - w
  left = Math.min(Math.max(MARGIN, left), vw - MARGIN - w)
  return { top: Math.max(vvTop + MARGIN, top), left }
}
