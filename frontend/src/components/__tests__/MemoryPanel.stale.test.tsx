import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import MemoryPanel from '../MemoryPanel'
import * as api from '../../lib/api'
import type { CrewMemory } from '../../lib/api'

// MemoryPanel has both a slow GET (backend fans out four upstream calls) and
// optimistic mutations (delete removes locally, then refetches) — the repo's
// stale-response clobber class. Same timing discipline as QuickTargets.test.tsx:
// 1. the DELETE never resolves, so the only write that can change the UI is the
//    stale GET (otherwise the corrective load() after it would heal the ghost
//    and the test would pass even with the guard removed);
// 2. assertions are fenced with act, not waitFor, so the wrong intermediate
//    state can't be polled away.
const mem = (keys: string[]): CrewMemory => ({
  preferences: '', projects: '', lessons: [], gateway_ok: true,
  semantic: keys.map(k => ({
    key: k, value_json: '"v"', confidence: 1, source: 'user_explicit',
    created_at: '2026-09-27T00:00:00Z', updated_at: '2026-09-27T00:00:00Z', is_deleted: 0,
  })),
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('MemoryPanel stale guard', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('a slow refresh in flight during a delete cannot resurrect the removed row', async () => {
    const slow = deferred<CrewMemory>()
    const get = vi.spyOn(api, 'getCrewMemory')
      .mockResolvedValueOnce(mem(['pref.alpha', 'pref.beta']))   // mount
      .mockImplementation(() => slow.promise)                     // refresh: slow, pre-delete snapshot
    vi.spyOn(api, 'deleteCrewSemantic').mockImplementation(() => new Promise<void>(() => {}))

    render(<MemoryPanel />)
    expect(await screen.findByLabelText('remove alpha')).toBeInTheDocument()
    expect(get).toHaveBeenCalledTimes(1)

    // Manual refresh → GET#2 in flight (slow).
    await act(async () => { screen.getByLabelText('refresh memory').click() })
    expect(get).toHaveBeenCalledTimes(2)

    // Delete alpha while GET#2 is in flight: ✕ → 「确认移除」.
    await act(async () => { screen.getByLabelText('remove alpha').click() })
    await act(async () => { screen.getByTestId('mem-remove-confirm').click() })
    expect(screen.queryByLabelText('remove alpha')).not.toBeInTheDocument()   // optimistic removal
    expect(screen.getByLabelText('remove beta')).toBeInTheDocument()

    // The stale pre-delete snapshot (still containing alpha) arrives last.
    await act(async () => {
      slow.resolve(mem(['pref.alpha', 'pref.beta']))
      await Promise.resolve(); await Promise.resolve()
    })
    expect(screen.queryByLabelText('remove alpha')).not.toBeInTheDocument()
    expect(screen.getByLabelText('remove beta')).toBeInTheDocument()
  })
})
