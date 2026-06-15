import { useState, useCallback } from 'react'
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

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPresets(await listPrompts())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load presets')
      setPresets([])
    }
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
