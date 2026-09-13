import type { SessionType } from './api'

// 当前支持的会话类型。agent 是库里的字符串：某个 agent 类型日后被移除时（如 kiro），
// 旧行会留下已失效的值。用白名单校验后再用，而不是把脏字符串原样发给后端。
// note 行的 agent 是空串，不在白名单里 → 返回 null，由调用方走 Obsidian 路径。
const AGENTS: readonly SessionType[] = ['tmux', 'claude', 'kiro', 'codex']

/** 把库里的 agent 收敛为合法 SessionType；不合法/缺失返回 null。 */
export function coerceAgent(v: string | null | undefined): SessionType | null {
  return AGENTS.includes(v as SessionType) ? (v as SessionType) : null
}
