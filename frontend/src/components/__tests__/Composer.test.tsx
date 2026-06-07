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
})
