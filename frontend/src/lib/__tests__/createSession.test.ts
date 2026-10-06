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

  it('sends crew_mode / crew_agent only when crew opts are given', async () => {
    await createSession('crew', undefined, '/tmp/x', undefined, undefined, { crew_mode: '', crew_agent: 'kirocrew-conductor' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.crew_agent).toBe('kirocrew-conductor')
    expect(body.crew_mode).toBe('')
    await createSession('claude', undefined, '/tmp/x')
    const plain = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect('crew_mode' in plain || 'crew_agent' in plain).toBe(false)
  })
})
