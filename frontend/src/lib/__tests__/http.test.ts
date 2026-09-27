import { describe, it, expect, vi, afterEach } from 'vitest'
import { request } from '../http'
import { ApiError, isAuthError } from '../api'

const respond = (status: number, body: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status, headers }))

describe('request', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('parses json on 2xx', async () => {
    respond(200, '{"a":1}')
    expect(await request<{ a: number }>('/api/x')).toEqual({ a: 1 })
  })
  it('throws ApiError with status and body on non-2xx', async () => {
    respond(500, 'boom')
    await expect(request('/api/x')).rejects.toMatchObject({ status: 500, message: 'boom' })
  })
  it('401 is an auth error (drives logout, I-3)', async () => {
    respond(401, '')
    const e = await request('/api/x').catch(x => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(isAuthError(e)).toBe(true)
  })
  it('text and none parse modes', async () => {
    respond(200, 'hello', {})
    expect(await request('/x', { parse: 'text' })).toBe('hello')
    respond(204, '', {})
    expect(await request('/x', { parse: 'none' })).toBeUndefined()
  })
  it('no timeout unless asked', async () => {
    vi.useFakeTimers()
    let aborted = false
    vi.spyOn(globalThis, 'fetch').mockImplementation((_u, init) => new Promise((_r, rej) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; rej(new DOMException('a', 'AbortError')) })
    }))
    const p = request('/slow').catch(e => e)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(aborted).toBe(false)
    const q = request('/slow', { timeoutMs: 1000 }).catch(e => e)
    await vi.advanceTimersByTimeAsync(1001)
    expect(aborted).toBe(true)
    expect(await q).toMatchObject({ status: 0, message: '请求超时' })
    void p
  })
  it('sends auth header and same-origin credentials like api()', async () => {
    localStorage.setItem('zeromux_token', 't0k')
    const spy = respond(200, '{}')
    await request('/api/x')
    const init = spy.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer t0k')
    expect(init.credentials).toBe('same-origin')
    localStorage.removeItem('zeromux_token')
  })
})
