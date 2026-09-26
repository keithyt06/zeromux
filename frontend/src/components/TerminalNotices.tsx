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
