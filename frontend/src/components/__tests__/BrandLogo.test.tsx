import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { BrandLogo } from '../BrandLogo'

describe('BrandLogo', () => {
  it('renders svg with brand title', () => {
    const { container } = render(<BrandLogo size={28} />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(container.querySelector('title')?.textContent).toBe('ZeroMux')
  })
})
