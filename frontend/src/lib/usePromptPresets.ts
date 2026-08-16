import { useState, useCallback, useRef } from 'react'
import {
  type PromptPreset,
  listPrompts, createPrompt, updatePrompt, deletePrompt,
} from './api'

/**
 * Shared data/CRUD/error state for prompt presets. Both the Sidebar pick-prompt
 * step and the AcpChatView Composer popover use this. All mutations re-list()
 * afterwards (no optimistic updates → no rollback logic, and a fresh list
 * naturally corrects this client's view). Cross-device/tab staleness is accepted
 * (last-writer-wins): callers reload() on open. Errors are caught here and never
 * thrown upward — the core flow (create session / send message) must not break.
 */
export function usePromptPresets() {
  const [presets, setPresets] = useState<PromptPreset[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Monotonic request token: `reload` is fired from several entry points that can
  // overlap on this ONE client (open popover → a slow cold `listPrompts` GET is in
  // flight while the user adds/deletes a preset, whose mutation issues its OWN faster
  // reload). Committing every response unconditionally lets the stale open-reload land
  // last and clobber the fresh list — a just-added preset vanishes (re-add → server
  // dup) or a deleted one reappears as a ghost row (re-delete 404s, swallowed). Because
  // each mutation `reload()`s only AFTER its await, its ticket is always higher than the
  // stale in-flight one, so discarding any response whose ticket is superseded keeps the
  // authoritative (latest-started) reload's result. Same class as SessionInfoBar notes
  // (review 2026-08-15) and AgentDashboard events (2026-08-11). No optimistic-write bump
  // is needed here — this hook has no optimistic setState, only re-list-after-mutation.
  const reqRef = useRef(0)

  const reload = useCallback(async () => {
    const myReq = ++reqRef.current
    setLoading(true)
    setError(null)
    try {
      const data = await listPrompts()
      if (myReq !== reqRef.current) return // superseded by a newer reload — drop this stale list
      setPresets(data)
    } catch (e) {
      if (myReq !== reqRef.current) return
      setError(e instanceof Error ? e.message : 'Failed to load presets')
      setPresets([])
    }
    if (myReq !== reqRef.current) return
    setLoading(false)
  }, [])

  // add/edit return whether the write succeeded, so callers (PromptManager) can
  // keep the edit form open on failure instead of discarding the user's draft.
  const add = useCallback(async (title: string, body: string): Promise<boolean> => {
    try {
      await createPrompt(title, body)
      await reload()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create preset')
      return false
    }
  }, [reload])

  const edit = useCallback(async (id: string, fields: { title?: string; body?: string }): Promise<boolean> => {
    try {
      await updatePrompt(id, fields)
      await reload()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update preset')
      // A concurrently-deleted row 404s here; re-list so it self-corrects (spec: last-writer-wins).
      reload()
      return false
    }
  }, [reload])

  const remove = useCallback(async (id: string) => {
    try {
      await deletePrompt(id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete preset')
      // Already-deleted elsewhere → 404; re-list so the stale row disappears.
      reload()
    }
  }, [reload])

  return { presets, loading, error, reload, add, edit, remove }
}
