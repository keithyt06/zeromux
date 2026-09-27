import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Sheet } from '../Sheet'

describe('Sheet', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('full sheet stays full-viewport even under a relative ancestor (top-layer)', () => {
    render(<div style={{ position: 'relative', width: 224 }}><Sheet open side="full" onClose={() => {}} title="定时任务">x</Sheet></div>)
    const d = screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement
    expect(d.open).toBe(true)
    expect(d.dataset.side).toBe('full')
    expect(d.className).toMatch(/\binset-0\b|\bw-screen\b|\bmax-w-none\b/)
  })
  it('bottom sheet adopts visualViewport height when the keyboard is open', () => {
    vi.stubGlobal('visualViewport', { height: 400, offsetTop: 0, addEventListener() {}, removeEventListener() {} })
    vi.stubGlobal('innerHeight', 844)
    render(<Sheet open side="bottom" onClose={() => {}}><input /></Sheet>)
    const d = screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement
    expect(d.dataset.snap).toBe('full')
    expect(d.style.height).toBe('400px')
  })
  it('keyboard open: pins to the visual viewport (top follows offsetTop on vv resize AND scroll)', () => {
    const ls: Record<string, (() => void)[]> = {}
    const vv = { height: 400, offsetTop: 150, addEventListener(t: string, f: () => void) { (ls[t] ??= []).push(f) }, removeEventListener() {} }
    vi.stubGlobal('visualViewport', vv)
    vi.stubGlobal('innerHeight', 844)
    render(<Sheet open side="bottom" onClose={() => {}}><input /></Sheet>)
    const d = screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement
    // iOS keeps fixed/top-layer boxes on the layout viewport: anchoring to its
    // bottom (mt-auto) would leave the sheet under the keyboard.
    expect(d.style.top).toBe('150px')
    expect(d.style.height).toBe('400px')
    expect(d.style.bottom).toBe('auto')
    expect(d.style.margin).toBe('0px')
    expect(ls.scroll?.length, 'listens to vv scroll').toBeGreaterThan(0)
    vv.offsetTop = 220
    act(() => ls.scroll.forEach(f => f()))
    expect(d.style.top).toBe('220px')
    vv.height = 380; vv.offsetTop = 10
    act(() => ls.resize.forEach(f => f()))
    expect(d.style.top).toBe('10px')
    expect(d.style.height).toBe('380px')
    // Keyboard closed → back to CSS anchoring.
    vv.height = 844; vv.offsetTop = 0
    act(() => ls.resize.forEach(f => f()))
    expect(d.style.top).toBe('')
    expect(d.dataset.snap).toBe('half')
  })
  it('drag that ends on the backdrop does not close', () => {
    const onClose = vi.fn()
    render(<Sheet open side="right" onClose={onClose}><input /></Sheet>)
    const d = screen.getByRole('dialog', { hidden: true })
    fireEvent.pointerDown(d.querySelector('input')!)
    fireEvent.click(d)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(d)
    fireEvent.click(d)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('warns on Sheet-in-Sheet', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Sheet open side="bottom" onClose={() => {}}><Sheet open side="bottom" onClose={() => {}}>inner</Sheet></Sheet>)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Sheet inside Sheet'))
    err.mockRestore()
  })
})
