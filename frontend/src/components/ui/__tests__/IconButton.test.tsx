import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { X } from 'lucide-react'
import { IconButton } from '../IconButton'

describe('IconButton', () => {
  it('requires and exposes an accessible label; hit area uses --hit', () => {
    render(<IconButton label="关闭" icon={X} />)
    const b = screen.getByRole('button', { name: '关闭' })
    expect(b.className).toMatch(/min-w-\[var\(--hit\)\]/)
    expect(b.className).toMatch(/min-h-\[var\(--hit\)\]/)
  })
})
