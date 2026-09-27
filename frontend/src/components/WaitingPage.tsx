import { useCallback } from 'react'
import { Clock, LogOut } from 'lucide-react'
import type { UserInfo } from '../lib/api'
import { request } from '../lib/http'
import { usePolling } from '../lib/usePolling'

interface Props {
  user: UserInfo
  onStatusChange: () => void
  onLogout: () => void
}

export default function WaitingPage({ user, onStatusChange, onLogout }: Props) {
  // Poll /api/me every 5 seconds to detect approval (paused while the tab is hidden)
  const checkApproval = useCallback(async () => {
    try {
      const data = await request<UserInfo>('/api/me')
      if (data.status === 'active') {
        onStatusChange()
      }
    } catch { /* ignore */ }
  }, [onStatusChange])
  usePolling(checkApproval, 5000)

  return (
    <div className="h-full bg-[var(--bg-primary)] flex items-center justify-center">
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-8 w-80 space-y-5 text-center">
        {user.avatar && (
          <img
            src={user.avatar}
            alt={user.login}
            className="w-16 h-16 rounded-full mx-auto border-2 border-[var(--border)]"
          />
        )}

        <div>
          <h2 className="text-ui-base font-bold text-[var(--text-primary)]">{user.login}</h2>
          <p className="text-ui-xs text-[var(--text-muted)] mt-1">Signed in via GitHub</p>
        </div>

        <div className="flex items-center justify-center gap-2 text-[var(--accent-yellow)]">
          <Clock size={16} className="animate-pulse" />
          <span className="text-ui-sm font-medium">Waiting for approval</span>
        </div>

        <p className="text-ui-xs text-[var(--text-secondary)] leading-relaxed">
          An administrator needs to approve your account before you can access ZeroMux.
          This page will automatically update once approved.
        </p>

        <button
          onClick={onLogout}
          className="flex items-center justify-center gap-1.5 w-full py-2 text-ui-sm text-[var(--text-secondary)] hover:text-[var(--accent-red)] transition-colors"
        >
          <LogOut size={14} />
          Sign out
        </button>
      </div>
    </div>
  )
}
