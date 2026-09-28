import type { SessionInfo } from './api'
import { attachCommand, copyText } from './attachCommand'
import { toast } from '../components/ui/toast'

export interface ActionEnv { rename(id: string): void; close(id: string): void; openHistory(id: string): void }
export interface SessionAction { id: 'copy-attach' | 'rename' | 'copy-peer' | 'history' | 'close'; label: string; danger?: boolean; run(): void | Promise<void> }

/** The single session-action registry (spec R23): TriageRow ⋯, FocusHeader ⋯ and ⌘K all render this. */
export function sessionActions(s: SessionInfo, env: ActionEnv): SessionAction[] {
  const out: SessionAction[] = []
  if (s.tmux_name) out.push({ id: 'copy-attach', label: '复制接续命令', run: async () => {
    toast.push({ message: (await copyText(attachCommand(s.tmux_name!))) ? '已复制接续命令' : '复制失败' })
  } })
  out.push({ id: 'rename', label: '重命名 / 描述…', run: () => env.rename(s.id) })
  if (s.peer_name) out.push({ id: 'copy-peer', label: '复制 peer 名', run: async () => {
    toast.push({ message: (await copyText(s.peer_name!)) ? `已复制 ${s.peer_name}` : '复制失败' })
  } })
  if (s.tmux_name) out.push({ id: 'history', label: '查看历史', run: () => env.openHistory(s.id) })
  out.push({ id: 'close', label: '关闭', danger: true, run: () => env.close(s.id) })
  return out
}
