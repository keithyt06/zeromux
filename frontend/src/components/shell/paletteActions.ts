import type { SessionInfo } from '../../lib/api'
import type { SessionAction } from '../../lib/sessionActions'
import type { ContextTab } from './useShellState'
import type { ShellPanel } from './TriageHeader'

export interface PaletteAction { id: string; label: string; run(): void }

const MODE_LABEL: Record<string, string> = { collect: 'Collect', interrupt: 'Interrupt' }

/** ⌘K action section (spec §4.6-2). Pure: the shell passes callbacks in. */
export function buildPaletteActions(env: {
  isAdmin: boolean
  vaultEnabled: boolean
  active: SessionInfo | null
  activeActions: SessionAction[]
  queueMode: string | undefined
  setQueueMode(sessionId: string, mode: string): void
  next(): void
  toggleTheme(): void
  openPanel(p: ShellPanel): void
  openVault(): void
  openContext(tab: ContextTab): void
  openMemory(): void
  logout(): void
}): PaletteAction[] {
  const out: PaletteAction[] = [
    { id: 'next', label: '下一个需要你的', run: env.next },
  ]
  const a = env.active
  if (a) {
    out.push({ id: 'ctx-git', label: '打开 Git 面板', run: () => env.openContext('git') })
    out.push({ id: 'ctx-files', label: '打开文件面板', run: () => env.openContext('files') })
    if (a.type !== 'tmux') out.push({ id: 'ctx-runs', label: '打开运行记录', run: () => env.openContext('runs') })
    if (a.type === 'crew') out.push({ id: 'memory', label: '打开记忆', run: env.openMemory })
    if (a.type !== 'tmux') {
      // Temporary home of the queue-mode switch until the composer chip (Task 12).
      // The shown value is the backend-authoritative mode (I-6), never a guess.
      const cur = env.queueMode ?? 'collect'
      const nextMode = cur === 'interrupt' ? 'collect' : 'interrupt'
      out.push({ id: 'queue-mode', label: `切换队列模式(当前:${MODE_LABEL[cur] ?? cur})`, run: () => env.setQueueMode(a.id, nextMode) })
    }
    for (const act of env.activeActions) out.push({ id: `session-${act.id}`, label: `当前会话:${act.label}`, run: () => { act.run() } })
  }
  out.push({ id: 'theme', label: '切换主题', run: env.toggleTheme })
  if (env.vaultEnabled) out.push({ id: 'vault', label: '打开笔记库', run: env.openVault })
  out.push({ id: 'scheduled', label: '定时任务', run: () => env.openPanel('scheduled') })
  out.push({ id: 'push', label: '推送设置', run: () => env.openPanel('push') })
  out.push({ id: 'prompts', label: '常用 prompt 管理', run: () => env.openPanel('prompts') })
  if (env.isAdmin) out.push({ id: 'admin', label: '用户管理', run: () => env.openPanel('admin') })
  out.push({ id: 'logout', label: '退出登录', run: env.logout })
  return out
}

/** ⌘K new-mode text that pre-fills "ask an agent about this note" (⚡, until SendToMenu lands). */
export function askAgentPaletteText(lastType: string, absDir: string, prompt: string): string {
  // tmux ignores initial_prompt, so the note context would be silently dropped.
  const type = lastType === 'tmux' ? 'claude' : lastType
  return `${type} ${absDir} ${prompt.trim()}`
}
