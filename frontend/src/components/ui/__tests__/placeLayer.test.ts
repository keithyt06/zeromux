import { describe, it, expect } from 'vitest'
import { placeLayer } from '../placeLayer'

const box = (top: number, bottom: number, left = 20, right = 300) => ({ top, bottom, left, right })

describe('placeLayer', () => {
  it('top placement sits above the anchor when it fits', () => {
    expect(placeLayer({ a: box(600, 650), w: 200, h: 100, vvTop: 0, vvHeight: 800, vw: 390, placement: 'top', align: 'start' }))
      .toEqual({ top: 600 - 6 - 100, left: 20 })
  })
  it('iOS keyboard: a panned visual viewport (offsetTop) shifts the fit check and the clamp', () => {
    // Layout viewport scrolled by the keyboard: visible band is [300, 700].
    // Anchor at 650 with a 320px list: above would start at 324 → fits (≥ 312).
    const up = placeLayer({ a: box(650, 690), w: 200, h: 320, vvTop: 300, vvHeight: 400, vw: 390, placement: 'top', align: 'start' })
    expect(up.top).toBe(650 - 6 - 320)
    // A taller list does not fit above the VISIBLE top; it must never be clamped
    // to 12 (layout top, hidden under the pan) but to the visible top + margin.
    const tall = placeLayer({ a: box(650, 690), w: 200, h: 380, vvTop: 300, vvHeight: 400, vw: 390, placement: 'top', align: 'start' })
    expect(tall.top).toBe(312)
  })
  it('bottom placement flips above when it does not fit below the visible band', () => {
    expect(placeLayer({ a: box(600, 640), w: 100, h: 200, vvTop: 0, vvHeight: 700, vw: 390, placement: 'bottom', align: 'end' }))
      .toEqual({ top: 600 - 6 - 200, left: 200 })
  })
})
