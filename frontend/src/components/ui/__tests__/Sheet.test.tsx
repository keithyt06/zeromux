import { render, screen } from '@testing-library/react'
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
  it('warns on Sheet-in-Sheet', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Sheet open side="bottom" onClose={() => {}}><Sheet open side="bottom" onClose={() => {}}>inner</Sheet></Sheet>)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('Sheet inside Sheet'))
    err.mockRestore()
  })
})
