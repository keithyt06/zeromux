import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import MobileKeyBar from '../MobileKeyBar'

describe('MobileKeyBar', () => {
  it('渲染全部 5 个键', () => {
    render(<MobileKeyBar onKey={() => {}} />)
    for (const k of ['left', 'up', 'down', 'right', 'enter']) {
      expect(screen.getByLabelText(k)).toBeInTheDocument()
    }
  })

  it('pointerDown 时用逻辑键名触发 onKey', () => {
    const onKey = vi.fn()
    render(<MobileKeyBar onKey={onKey} />)
    fireEvent.pointerDown(screen.getByLabelText('up'))
    expect(onKey).toHaveBeenCalledWith('up')
    fireEvent.pointerDown(screen.getByLabelText('enter'))
    expect(onKey).toHaveBeenCalledWith('enter')
  })
})
