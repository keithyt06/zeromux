import { api, ApiError } from './api/core'

type Parse = 'json' | 'text' | 'none'

/** Typed fetch wrapper: every non-2xx becomes an ApiError carrying the HTTP
 *  status, so callers (and isAuthError) can tell 401/403 from 5xx/network.
 *  No default timeout (spec R9): createSession with worktree isolation (~24s),
 *  uploads and JuiceFS-backed git diffs would be killed by one. */
export async function request<T = unknown>(
  path: string,
  init: RequestInit & { timeoutMs?: number; parse?: Parse } = {},
): Promise<T> {
  const { timeoutMs, parse = 'json', ...rest } = init
  const ctl = timeoutMs ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined
  let res: Response
  try {
    res = await api(path, ctl ? { ...rest, signal: ctl.signal } : rest)
  } catch (e) {
    if (ctl?.signal.aborted) throw new ApiError(0, '请求超时')
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).trim().slice(0, 300)
    throw new ApiError(res.status, body || res.statusText)
  }
  if (parse === 'none') return undefined as T
  if (parse === 'text') return (await res.text()) as T
  return (await res.json()) as T
}
