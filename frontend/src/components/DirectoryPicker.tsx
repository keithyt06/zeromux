import { useState, useEffect, useCallback } from 'react'
import { ChevronLeft, Home, Folder, FolderGit2 } from 'lucide-react'
import type { DirEntry } from '../lib/api'
import { listDirectories } from '../lib/api'

/** Inline directory browser, mirroring the New Session "Select directory" flow.
 *  Self-contained navigation state; the only outputs are onSelect (commit the
 *  current path) and onCancel. Used by the scheduled-task form so users pick a
 *  work dir instead of typing it. */
export default function DirectoryPicker({ initialPath, onSelect, onCancel }: {
  initialPath?: string
  onSelect: (path: string) => void
  onCancel: () => void
}) {
  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [homePath, setHomePath] = useState('')
  const [dirs, setDirs] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDirs = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await listDirectories(path)
      setCurrentPath(data.current)
      setParentPath(data.parent)
      setHomePath(data.home)
      setDirs(data.entries)
    } catch (e) {
      // Surface the failure instead of silently committing an empty path: a
      // blank currentPath would otherwise let "使用此目录" return '' as work_dir.
      setError(e instanceof Error ? e.message : '无法加载目录')
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadDirs(initialPath || undefined) }, [loadDirs, initialPath])

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--bg-secondary)]">
      {/* Header */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
        <button
          type="button"
          onClick={onCancel}
          className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
          title="返回"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider truncate flex-1">
          选择目录
        </span>
        {parentPath && (
          <button
            type="button"
            onClick={() => loadDirs(homePath)}
            className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
            title="主目录"
          >
            <Home size={12} />
          </button>
        )}
      </div>

      {/* Current path + use-this button */}
      <div className="px-3 py-1.5 border-b border-[var(--border)]">
        <div className="text-[10px] text-[var(--text-muted)] truncate mb-1 font-mono" title={currentPath}>
          {homePath && currentPath.startsWith(homePath) ? currentPath.replace(homePath, '~') : currentPath}
        </div>
        <button
          type="button"
          onClick={() => onSelect(currentPath)}
          disabled={!currentPath}
          className="w-full py-1 text-[10px] font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          使用此目录
        </button>
      </div>

      {/* Parent nav */}
      {parentPath && (
        <button
          type="button"
          onClick={() => loadDirs(parentPath)}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          <ChevronLeft size={12} className="shrink-0" />
          <span>..</span>
        </button>
      )}

      {/* Directory list */}
      <div className="max-h-48 overflow-y-auto">
        {loading ? (
          <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">加载中...</div>
        ) : error ? (
          <div className="px-3 py-2 text-[10px] text-[var(--accent-red)] break-words">{error}</div>
        ) : dirs.length === 0 ? (
          <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">没有子目录</div>
        ) : (
          dirs.map(d => (
            <button
              key={d.path}
              type="button"
              onClick={() => loadDirs(d.path)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              {d.is_git ? (
                <FolderGit2 size={13} className="text-[var(--accent-green-text)] shrink-0" />
              ) : (
                <Folder size={13} className="text-[var(--text-muted)] shrink-0" />
              )}
              <span className="truncate">{d.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
