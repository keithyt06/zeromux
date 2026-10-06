import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SegmentedControl } from '../SegmentedControl'

describe('SegmentedControl', () => {
  it('radio semantics and arrow keys', () => {
    const onChange = vi.fn()
    render(<SegmentedControl label="主题" value="system" onChange={onChange} options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} />)
    expect(screen.getByRole('radiogroup', { name: '主题' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '跟随系统' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(screen.getByRole('radio', { name: '跟随系统' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('light')
  })
  it('every option is a ≥44px touch target on coarse pointers (min-h --hit, not the 36px --ctl-h)', () => {
    render(<SegmentedControl label="面板" value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
    // Unlayered `.ctl` (min-height: --ctl-h, 36px coarse) beats Tailwind's @layer utilities, so `ctl` must be absent (jsdom has no cascade).
    for (const r of screen.getAllByRole('radio')) { expect(r).toHaveClass('min-h-[var(--hit)]'); expect(r).not.toHaveClass('ctl') }
  })
})
