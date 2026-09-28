import { useCallback, useEffect, useRef } from 'react'
import type { SessionInfo, HostTmux, TaskRun } from '../../lib/api'
import { listSessionsWithHost, listConfirmations, getSessionStatus, getSchedulerHealth, isAuthError } from '../../lib/api'
import { resyncPush, shouldResyncNow } from '../../lib/push'
import { resolveActivePane } from '../../lib/docTabs'
import { usePolling } from '../../lib/usePolling'

/** Everything App.tsx used to poll / listen for, moved out verbatim (I-2/I-3/I-17). */
export function useSessionsPoll(o: {
  enabled: boolean
  onAuthLost: () => void
  setSessions: (s: SessionInfo[]) => void
  setHostTmux: (h: HostTmux[]) => void
  setActiveId: (f: (prev: string | null) => string | null) => void
  docTabIds: () => string[]
  setConfirmRuns: (r: TaskRun[]) => void
  setSchedulerHealthy: (ok: boolean) => void
  onOpenFromPush: (sid: string, gitDirty: number) => void
  activeId: string | null
  /** false on phones: the triage page is home, so a load never picks a pane for the user. */
  autoSelect: boolean
}): { reload(): Promise<void> } {
  // Callbacks held in a ref so the interval effects keep their [enabled] deps.
  const ref = useRef(o)
  useEffect(() => { ref.current = o })

  const reload = useCallback(async () => {
    const c = ref.current
    try {
      const r = await listSessionsWithHost()
      const list = r.sessions
      c.setSessions(list)
      c.setHostTmux(r.host_tmux)
      // Keep the prior selection if it still resolves; otherwise pick a session,
      // then a doc tab. Doc tabs alone (0 sessions) must still get a live pane.
      const ids = list.map(s => s.id)
      c.setActiveId(prev => ref.current.autoSelect
        ? resolveActivePane(prev, ids, ref.current.docTabIds())
        : (prev && (ids.includes(prev) || ref.current.docTabIds().includes(prev)) ? prev : null))
    } catch (err) {
      // Only a real 401/403 means the session is gone — bounce to LoginPage. A
      // transient 5xx/network error must NOT log the user out (pre-D-F1 this caught
      // every error and could eject the user on a momentary blip). (D-F1)
      if (isAuthError(err)) c.onAuthLost()
    }
  }, [])

  useEffect(() => { if (o.enabled) reload() }, [o.enabled, reload])

  // 3s polling: refresh session list so turn-state / activity fields stay live.
  // Replaces the whole list each tick; activeId is deliberately left untouched —
  // a background poll must not move user focus (a stale-snapshot response arriving
  // just after a local create would otherwise yank focus off the new session).
  // Transient failures are ignored (don't bounce to login).
  useEffect(() => {
    if (!o.enabled) return
    const tick = setInterval(async () => {
      try {
        const r = await listSessionsWithHost()
        ref.current.setSessions(r.sessions)
        ref.current.setHostTmux(r.host_tmux)
      } catch (err) {
        // A WS client can't observe the 401 on a failed upgrade, so its onclose just
        // reconnects forever. This REST poll is the reliable detector of credential
        // expiry / de-approval: on a genuine 401/403, log out (→ LoginPage) instead of
        // leaving every mounted pane in a silent reconnect loop against stale creds.
        // A transient network drop / 5xx is NOT an auth failure — keep retrying. (D-F1)
        if (isAuthError(err)) ref.current.onAuthLost()
        /* else: transient — ignore */
      }
    }, 3000)
    return () => clearInterval(tick)
  }, [o.enabled])

  // Poll the confirmation queue so the triage badges stay live (now + every 30s).
  useEffect(() => {
    if (!o.enabled) return
    let cancelled = false
    const poll = async () => {
      try {
        const r = await listConfirmations()
        if (!cancelled) ref.current.setConfirmRuns(r.runs)
      } catch { /* ignore transient */ }
    }
    poll()
    const id = setInterval(poll, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [o.enabled])

  // Scheduler health (once on mount, then every 60s).
  const pollSchedulerHealth = useCallback(async () => {
    try { ref.current.setSchedulerHealthy((await getSchedulerHealth()).healthy) } catch { /* ignore */ }
  }, [])
  usePolling(pollSchedulerHealth, 60_000, { enabled: o.enabled })

  // SW: report active session on change (allows SW to suppress front-tab notifications)
  const { activeId } = o
  useEffect(() => {
    const sw = navigator.serviceWorker?.controller
    if (sw) sw.postMessage({ type: 'active_session', id: activeId, visible: document.visibilityState === 'visible' })
  }, [activeId])
  useEffect(() => {
    const onVis = () => navigator.serviceWorker?.controller?.postMessage(
      { type: 'active_session', id: activeId, visible: document.visibilityState === 'visible' })
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [activeId])
  // Push: resync subscription on return to foreground, throttled to ≤ once/hour.
  // Bypass the throttle if the SW wrote a resync-needed marker (e.g. subscribe failed).
  useEffect(() => {
    let last: number | null = null
    const onVis = async () => {
      if (document.visibilityState !== 'visible') return
      let forced = false
      try { const c = await caches.open('zmx-push'); const m = await c.match('resync-needed'); if (m) { forced = true; await c.delete('resync-needed') } } catch { /* ignore */ }
      const now = Date.now()
      if (!forced && !shouldResyncNow(last, now)) return
      last = now
      resyncPush().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  // SW: listen for notification click → deep-link to session
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'open_session' && e.data.id) {
        const targetSession: string = e.data.id
        ref.current.onOpenFromPush(targetSession, 0)
        // route to the Git「改动」view if the finished turn left uncommitted changes (M26)
        getSessionStatus(targetSession)
          .then(st => { if (st.git_dirty > 0) ref.current.onOpenFromPush(targetSession, st.git_dirty) })
          .catch(() => {})
      }
    }
    navigator.serviceWorker?.addEventListener('message', onMsg)
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg)
  }, [])
  // Deep-link: parse ?session= query param on startup
  useEffect(() => {
    const sid = new URLSearchParams(location.search).get('session')
    if (sid) ref.current.setActiveId(() => sid)
  }, [])

  return { reload }
}
