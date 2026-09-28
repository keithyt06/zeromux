import { render, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useNextKeys } from '../useNextKeys'

function H({ onNext, onPalette }: { onNext(): void; onPalette(): void }) {
  useNextKeys({ onNext, onPalette })
  return <div><input aria-label="i" /><textarea aria-label="t" /><div className="xterm"><span tabIndex={0} data-testid="x" /></div></div>
}

describe('useNextKeys', () => {
  it('J on the body calls onNext', () => {
    const onNext = vi.fn()
    render(<H onNext={onNext} onPalette={vi.fn()} />)
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(onNext).toHaveBeenCalledTimes(1)
  })
  it('J inside input / textarea / .xterm does not fire', () => {
    const onNext = vi.fn()
    const { getByLabelText, getByTestId } = render(<H onNext={onNext} onPalette={vi.fn()} />)
    fireEvent.keyDown(getByLabelText('i'), { key: 'j' })
    fireEvent.keyDown(getByLabelText('t'), { key: 'j' })
    fireEvent.keyDown(getByTestId('x'), { key: 'j' })
    expect(onNext).not.toHaveBeenCalled()
  })
  it('⌘K / Ctrl+K from any focus opens the palette and prevents default', () => {
    const onPalette = vi.fn()
    const { getByLabelText } = render(<H onNext={vi.fn()} onPalette={onPalette} />)
    const e1 = fireEvent.keyDown(getByLabelText('i'), { key: 'k', metaKey: true })
    const e2 = fireEvent.keyDown(document.body, { key: 'K', ctrlKey: true })
    expect(onPalette).toHaveBeenCalledTimes(2)
    expect(e1).toBe(false)   // fireEvent returns !defaultPrevented
    expect(e2).toBe(false)
  })
  it('⌘] calls onNext and prevents default (even inside an input)', () => {
    const onNext = vi.fn()
    const { getByLabelText } = render(<H onNext={onNext} onPalette={vi.fn()} />)
    expect(fireEvent.keyDown(getByLabelText('i'), { key: ']', metaKey: true })).toBe(false)
    expect(onNext).toHaveBeenCalledTimes(1)
  })
  it('ignores IME composition', () => {
    const onPalette = vi.fn()
    render(<H onNext={vi.fn()} onPalette={onPalette} />)
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true, isComposing: true })
    expect(onPalette).not.toHaveBeenCalled()
  })
})
