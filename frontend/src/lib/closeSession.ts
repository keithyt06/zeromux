import type { CloseCheck } from './api'

// Graded confirm (user chose "X kills everything"): only interrupt when closing
// would surprise — another terminal is watching, the session wasn't made here,
// or something is running. Everything else closes immediately with a 5s undo.
export function closeConfirmMessage(name: string, c: CloseCheck | null): string | null {
  if (!c) return null
  if (c.other_clients > 0) return `${name} 正在 ${c.other_clients} 个其他终端中使用，关闭将终止整个 tmux 会话。`
  if (c.external) return `${name} 不是在 zeromux 中创建的，关闭将终止整个 tmux 会话。`
  if (c.busy_command) return `${name} 中 ${c.busy_command} 仍在运行，关闭将终止它。`
  return null
}
