import { useCallback, useRef, useState } from 'react'
import { listDirectories } from './api'
import type { DirEntry } from './api'
import { useLatestRequest } from './useLatestRequest'

/** Directory browser state shared by the New Session flow and DirectoryPicker.
 *  Out-of-order guard matters: currentPath is what gets committed as a
 *  session's / scheduled task's work_dir, and JuiceFS listings take seconds. */
export function useDirBrowser() {
  const req = useLatestRequest()
  const lastPath = useRef<string | undefined>(undefined)
  const [currentPath, setCurrentPath] = useState('')
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [homePath, setHomePath] = useState('')
  const [dirs, setDirs] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (path?: string) => {
    const t = req.begin()
    lastPath.current = path
    setLoading(true)
    setError(null)
    try {
      const data = await listDirectories(path)
      if (!req.isCurrent(t)) return
      setCurrentPath(data.current)
      setParentPath(data.parent)
      setHomePath(data.home)
      setDirs(data.entries)
    } catch (e) {
      if (!req.isCurrent(t)) return
      setError(e instanceof DOMException && e.name === 'AbortError'
        ? '加载超时，请重试'
        : (e instanceof Error ? e.message : '加载失败'))
    }
    if (req.isCurrent(t)) setLoading(false)
  }, [req])

  const retry = useCallback(() => { void load(lastPath.current) }, [load])

  /** Forget the previous browse location (New Session reopens clean) and
   *  invalidate any in-flight listing so it can't repopulate afterwards. */
  const reset = useCallback(() => {
    req.bump()
    lastPath.current = undefined
    setCurrentPath(''); setParentPath(null); setDirs([]); setError(null); setLoading(false)
  }, [req])

  return { currentPath, parentPath, homePath, dirs, loading, error, load, retry, reset }
}
