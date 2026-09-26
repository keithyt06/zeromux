import type { TmuxHealth } from '../lib/api'

/** Warning bar shown above a tmux terminal when the tmux server is unhealthy. */
export function TmuxHealthBar({ health }: { health: TmuxHealth | null }) {
  if (!health || (health.server && health.in_unit)) return null
  const msg = !health.server
    ? 'tmux 服务未运行，终端无法持久化。修复：sudo systemctl restart zeromux-tmux'
    : 'tmux server 不在 zeromux-tmux.service 中，部署时可能被连带杀掉。修复：tmux kill-server 后 sudo systemctl restart zeromux-tmux'
  return (
    <div role="alert" className="px-3 py-1.5 text-xs bg-[var(--accent-yellow)]/15 text-[var(--accent-yellow)] border-b border-[var(--border)]">
      {msg}
    </div>
  )
}

export function LostBanner({ onClose }: { onClose: () => void }) {
  return (
    <div role="status" className="flex items-center gap-2 px-3 py-1.5 text-xs bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-b border-[var(--border)]">
      <span className="flex-1">tmux 会话已丢失（服务重启？），已在原目录新建，之前的输出不可恢复</span>
      <button aria-label="关闭提示" onClick={onClose} className="px-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]">✕</button>
    </div>
  )
}

export function EndedOverlay({ name, origin, onRevive, onClose }: { name: string; origin?: 'own' | 'external' | null; onRevive: () => void; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--bg-primary)]/90 text-sm text-[var(--text-primary)]">
      <div>{origin === 'external' ? `${name} 已在其他终端结束` : 'tmux 会话已结束'}</div>
      <div className="flex gap-2">
        <button onClick={onRevive} className="px-3 py-1.5 rounded bg-[var(--accent-blue)] text-white">新建同名会话</button>
        <button onClick={onClose} className="px-3 py-1.5 rounded border border-[var(--border)]">关闭</button>
      </div>
    </div>
  )
}
