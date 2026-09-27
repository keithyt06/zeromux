import { useState, useEffect, useCallback } from 'react'
import { Check, Trash2, X, Shield, Clock } from 'lucide-react'
import type { AdminUser } from '../lib/api'
import { listUsers, approveUser, removeUser } from '../lib/api'
import { useLatestRequest } from '../lib/useLatestRequest'
import { Sheet } from './ui'

interface Props {
  open: boolean
  onClose: () => void
}

export default function AdminPanel({ open, onClose }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const req = useLatestRequest()

  const load = useCallback(async () => {
    const t = req.begin()
    try {
      const data = await listUsers()
      if (!req.isCurrent(t)) return
      setUsers(data)
    } catch { /* ignore */ }
    if (!req.isCurrent(t)) return
    setLoading(false)
  }, [req])

  useEffect(() => { load() }, [load])

  const handleApprove = async (id: string) => {
    try {
      await approveUser(id)
      load()
    } catch { /* ignore */ }
  }

  const handleRemove = async (id: string) => {
    try {
      await removeUser(id)
      load()
    } catch { /* ignore */ }
  }

  const pending = users.filter(u => u.status === 'pending')
  const active = users.filter(u => u.status === 'active')

  return (
    <Sheet
      open={open}
      side="full"
      onClose={onClose}
      title="用户管理"
      actions={
        <button onClick={onClose} aria-label="关闭"
          className="p-1 text-[var(--fg-muted)] hover:text-[var(--fg)] rounded transition-colors">
          <X size={18} />
        </button>
      }
    >
      <div className="p-4 space-y-4">
        {loading ? (
          <div className="text-ui-sm text-[var(--fg-subtle)]">Loading...</div>
        ) : (
          <>
            {/* Pending users */}
            {pending.length > 0 && (
              <div>
                <h3 className="text-ui-xs font-semibold text-[var(--attention)] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Clock size={12} />
                  Pending Approval ({pending.length})
                </h3>
                <div className="space-y-1">
                  {pending.map(u => (
                    <UserRow key={u.id} user={u} onApprove={handleApprove} onRemove={handleRemove} />
                  ))}
                </div>
              </div>
            )}

            {/* Active users */}
            <div>
              <h3 className="text-ui-xs font-semibold text-[var(--success)] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Shield size={12} />
                Active Users ({active.length})
              </h3>
              <div className="space-y-1">
                {active.map(u => (
                  <UserRow key={u.id} user={u} onRemove={handleRemove} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </Sheet>
  )
}

function UserRow({ user, onApprove, onRemove }: {
  user: AdminUser
  onApprove?: (id: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-[var(--surface-2)] rounded-lg border border-[var(--border)]">
      {user.avatar_url ? (
        <img src={user.avatar_url} alt="" className="w-7 h-7 rounded-full shrink-0" />
      ) : (
        <div className="w-7 h-7 rounded-full bg-[var(--surface-3)] shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-ui-xs font-medium text-[var(--fg)] truncate">
          {user.github_login}
          {user.role === 'admin' && (
            <span className="ml-1.5 text-ui-2xs text-[var(--peer)] font-normal">admin</span>
          )}
        </div>
        {user.display_name && (
          <div className="text-ui-2xs text-[var(--fg-subtle)] truncate">{user.display_name}</div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {onApprove && user.status === 'pending' && (
          <button
            onClick={() => onApprove(user.id)}
            className="p-1 text-[var(--success)] hover:bg-[var(--surface-3)] rounded transition-colors"
            title="Approve"
          >
            <Check size={14} />
          </button>
        )}
        {user.role !== 'admin' && (
          <button
            onClick={() => onRemove(user.id)}
            className="p-1 text-[var(--fg-muted)] hover:text-[var(--danger)] hover:bg-[var(--surface-3)] rounded transition-colors"
            title="Remove"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  )
}
