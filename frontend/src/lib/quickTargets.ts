import type { SessionType } from './api'

// 当前支持的会话类型。agent 是库里的字符串：某个 agent 类型被移除时（`kiro` 已在
// Task 11 被 crew 取代），旧行会留下已失效的值。用白名单校验后再用，而不是把脏
// 字符串原样发给后端。
// note 行的 agent 是空串，不在白名单里 → 返回 null，由调用方走 Obsidian 路径。
const AGENTS: readonly SessionType[] = ['tmux', 'claude', 'crew', 'codex']

/** 把库里的 agent 收敛为合法 SessionType；不合法/缺失返回 null。 */
export function coerceAgent(v: string | null | undefined): SessionType | null {
  return AGENTS.includes(v as SessionType) ? (v as SessionType) : null
}
