import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import AdminPanel from '../AdminPanel'
import * as api from '../../lib/api'

describe('AdminPanel', () => {
  it('renders in a full-screen Sheet and lists users', async () => {
    vi.spyOn(api, 'listUsers').mockResolvedValue([{ id: 'u1', github_login: 'alice', role: 'user', status: 'pending', avatar_url: null }] as never)
    render(<AdminPanel open onClose={() => {}} />)
    const d = screen.getByRole('dialog', { hidden: true })
    expect(d.dataset.side).toBe('full')
    expect(await screen.findByText('alice')).toBeInTheDocument()
  })
})
