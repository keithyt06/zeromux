import { render, screen, fireEvent, act } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { DialogHost, confirm, promptText } from '../dialogs'

describe('confirm / promptText', () => {
  it('confirm resolves true on confirm, false on cancel', async () => {
    render(<DialogHost />)
    let p!: Promise<boolean>
    act(() => { p = confirm({ title: '删除？', confirmLabel: '删除', danger: true }) })
    fireEvent.click(await screen.findByText('删除'))
    expect(await p).toBe(true)
    act(() => { p = confirm({ title: '再删？' }) })
    fireEvent.click(await screen.findByText('取消'))
    expect(await p).toBe(false)
  })
  it('promptText returns trimmed text or null', async () => {
    render(<DialogHost />)
    let p!: Promise<string | null>
    act(() => { p = promptText({ title: '重命名为', initial: 'a.txt' }) })
    const input = await screen.findByDisplayValue('a.txt')
    expect(input).toHaveClass('text-ui-input')
    fireEvent.change(input, { target: { value: '  b.txt ' } })
    fireEvent.click(screen.getByText('确定'))
    expect(await p).toBe('b.txt')
    act(() => { p = promptText({ title: 'x' }) })
    fireEvent(screen.getByRole('dialog', { hidden: true }), new Event('cancel', { cancelable: true }))
    expect(await p).toBeNull()
  })
})
