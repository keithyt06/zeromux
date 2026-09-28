import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import Composer from '../Composer'

function setup(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn()
  const onChange = vi.fn()
  render(
    <Composer
      value={props.value ?? ''}
      onChange={props.onChange ?? onChange}
      onSend={props.onSend ?? onSend}
      submitOnEnter={props.submitOnEnter ?? true}
      placeholder="type here"
    />
  )
  return { onSend, onChange }
}

describe('Composer', () => {
  it('renders the textarea with placeholder', () => {
    setup()
    expect(screen.getByPlaceholderText('type here')).toBeInTheDocument()
  })

  it('send button is disabled when value is empty/whitespace', () => {
    setup({ value: '   ' })
    expect(screen.getByLabelText('send')).toBeDisabled()
  })

  it('clicking send calls onSend with trimmed value', () => {
    const { onSend } = setup({ value: '  hello  ' })
    fireEvent.click(screen.getByLabelText('send'))
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  it('submitOnEnter=true: Enter (no shift) sends', () => {
    const { onSend } = setup({ value: 'hi', submitOnEnter: true })
    fireEvent.keyDown(screen.getByPlaceholderText('type here'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hi')
  })

  it('submitOnEnter=false: Enter does NOT send (newline behavior)', () => {
    const { onSend } = setup({ value: 'hi', submitOnEnter: false })
    fireEvent.keyDown(screen.getByPlaceholderText('type here'), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('IME composing: Enter while isComposing does NOT send', () => {
    const { onSend } = setup({ value: '你好', submitOnEnter: true })
    fireEvent.keyDown(screen.getByPlaceholderText('type here'), { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('IME composing: Enter with keyCode 229 (Safari post-compositionend) does NOT send', () => {
    const { onSend } = setup({ value: '你好', submitOnEnter: true })
    fireEvent.keyDown(screen.getByPlaceholderText('type here'), { key: 'Enter', keyCode: 229 })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('plain Enter after composition ends still sends', () => {
    const { onSend } = setup({ value: '你好', submitOnEnter: true })
    fireEvent.keyDown(screen.getByPlaceholderText('type here'), { key: 'Enter', keyCode: 13 })
    expect(onSend).toHaveBeenCalledWith('你好')
  })
})

describe('Composer onSlash (line-start / presets)', () => {
  it('reports the query after / while the value starts with /, then null once it stops', () => {
    const onSlash = vi.fn()
    const el = (value: string) => <Composer value={value} onChange={() => {}} onSend={() => {}} submitOnEnter onSlash={onSlash} />
    const { rerender } = render(el('hello'))
    expect(onSlash).not.toHaveBeenCalled()
    rerender(el('/'))
    expect(onSlash).toHaveBeenLastCalledWith('')
    rerender(el('/fix 登录页'))
    expect(onSlash).toHaveBeenLastCalledWith('fix 登录页')
    rerender(el('fix'))
    expect(onSlash).toHaveBeenLastCalledWith(null)
    const n = onSlash.mock.calls.length
    rerender(el('fixed'))
    expect(onSlash).toHaveBeenCalledTimes(n) // null is sent once, on the transition only
  })

  it('renders leftSlot inside the input box', () => {
    render(<Composer value="" onChange={() => {}} onSend={() => {}} submitOnEnter placeholder="p" leftSlot={<span data-testid="ls" />} />)
    expect(screen.getByPlaceholderText('p').parentElement).toContainElement(screen.getByTestId('ls'))
  })
})
