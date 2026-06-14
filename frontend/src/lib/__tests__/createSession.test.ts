import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSession } from '../api'

describe('createSession initial_prompt', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 's1', name: 'n', type: 'claude' }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('includes initial_prompt in body when provided', async () => {
    await createSession('claude', undefined, '/tmp/x', undefined, '查 bug')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.initial_prompt).toBe('查 bug')
  })

  it('sends initial_prompt: null when omitted (backward compat)', async () => {
    await createSession('claude', undefined, '/tmp/x')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.initial_prompt).toBeNull()
  })
})
