import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Execute public/sw.js against a fake ServiceWorkerGlobalScope and drive its
// 'message' / 'push' listeners directly.
const SRC = readFileSync(resolve(__dirname, '../../../public/sw.js'), 'utf8')

type Handler = (e: unknown) => void
interface Shown { title: string; opts: { body?: string; tag?: string; data?: { session_id?: string } } }

function loadSw(windows: { id: string; visible: boolean; activeSession?: string }[]) {
  const handlers: Record<string, Handler> = {}
  const shown: Shown[] = []
  const fakeSelf = {
    addEventListener: (t: string, h: Handler) => { handlers[t] = h },
    clients: { matchAll: async () => windows.map(w => ({ id: w.id, visibilityState: w.visible ? 'visible' : 'hidden' })) },
    registration: { showNotification: async (title: string, opts: Shown['opts']) => { shown.push({ title, opts }) } },
  }
  const fakeCaches = { open: async () => ({ match: async () => undefined, put: async () => {} }) }
  new Function('self', 'caches', SRC)(fakeSelf, fakeCaches)
  for (const w of windows) {
    if (w.activeSession) handlers.message({ data: { type: 'active_session', id: w.activeSession, visible: w.visible }, source: { id: w.id } })
  }
  const push = async (payload: Record<string, string>) => {
    let done: Promise<unknown> = Promise.resolve()
    handlers.push({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => { done = p } })
    await done
  }
  return { push, shown }
}

describe('sw.js push handler', () => {
  it('run_done is suppressed while its session is the visible active one', async () => {
    const sw = loadSw([{ id: 'w1', visible: true, activeSession: 's1' }])
    await sw.push({ kind: 'run_done', session_id: 's1', title: '⏰ 夜巡 完成', body: '无新告警' })
    expect(sw.shown).toHaveLength(0)
  })
  it('run_done shows in background with its body and a per-session tag', async () => {
    const sw = loadSw([{ id: 'w1', visible: false, activeSession: 's1' }])
    await sw.push({ kind: 'run_done', session_id: 's1', title: '⏰ 夜巡 完成', body: '无新告警' })
    expect(sw.shown).toEqual([{ title: '⏰ 夜巡 完成', opts: { body: '无新告警', tag: 's1', data: { session_id: 's1' } } }])
  })
  it('run_done and turn_done of one session share a tag (newest replaces)', async () => {
    const sw = loadSw([])
    await sw.push({ kind: 'turn_done', session_id: 's1', title: 'a', body: 'x' })
    await sw.push({ kind: 'run_done', session_id: 's1', title: 'b', body: 'y' })
    expect(sw.shown.map(s => s.opts.tag)).toEqual(['s1', 's1'])
  })
  it('important kinds are never foreground-suppressed and keep the kind in the tag', async () => {
    const sw = loadSw([{ id: 'w1', visible: true, activeSession: 's1' }])
    await sw.push({ kind: 'run_failed', session_id: 's1', title: 'f', body: 'b' })
    expect(sw.shown.map(s => s.opts.tag)).toEqual(['s1:run_failed'])
  })
})
