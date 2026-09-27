import { api, ApiError } from './core'

// ── Crew memory proxy（zeromux 后端代理 Crew Gateway :5476 的记忆面）──
// 浏览器不能直连 Gateway：跨源（Gateway 只绑 loopback）+ token 是 20h 全权 JWT，
// 把它交给前端等于把 Gateway 放进 localStorage。所有调用走 zeromux 自己的
// `/api/crew/memory/*`，由后端持 token 并在服务端补齐 X-Session-Key。

export interface SemanticEntry {
  key: string
  /** Gateway 原样返回 JSON 字符串（如 `"\"pnpm\""`），用 parseSemanticValue 读。 */
  value_json: string
  confidence: number
  source: string
  created_at: string
  updated_at: string
  is_deleted: number
}

export interface LessonEntry {
  id: string
  text: string
  created_at: string
}

export interface CrewMemory {
  /** memory/preferences.md 原文（纯 markdown） */
  preferences: string
  /** memory/projects.md 原文（纯 markdown） */
  projects: string
  semantic: SemanticEntry[]
  lessons: LessonEntry[]
  /** Gateway 不可达时为 false，其余字段为空 —— 面板据此显示降级提示而非空状态。 */
  gateway_ok: boolean
}

/** 一次取回记忆面板全部分区（后端并发四个上游请求，前端一次 GET）。 */
export async function getCrewMemory(): Promise<CrewMemory> {
  const res = await api('/api/crew/memory')
  if (!res.ok) throw new ApiError(res.status, 'getCrewMemory failed')
  return res.json()
}

/** 写一条语义记忆。后端补 X-Session-Key 并用**不带 key** 的 PUT。 */
export async function putCrewSemantic(key: string, value: string): Promise<void> {
  const res = await api('/api/crew/memory/semantic', {
    method: 'PUT',
    body: JSON.stringify({ key, value, source: 'user_explicit', confidence: 1.0 }),
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
}

export async function deleteCrewSemantic(key: string): Promise<void> {
  const res = await api(`/api/crew/memory/semantic/${encodeURIComponent(key)}`, { method: 'DELETE' })
  if (!res.ok) throw new ApiError(res.status, await res.text())
}

/** 整文件 PUT（Gateway 只支持整文件；面板本地重组 markdown 后调用）。 */
export async function putCrewMemoryDoc(doc: 'preferences' | 'projects', content: string): Promise<void> {
  const res = await api(`/api/crew/memory/${doc}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new ApiError(res.status, await res.text())
}
