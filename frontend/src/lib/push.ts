import { api } from './api'

export function vapidKeyToUint8Array(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4)
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  // Allocate an explicit ArrayBuffer (not ArrayBufferLike) so the result is
  // accepted as BufferSource by pushManager.subscribe's applicationServerKey.
  const arr = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

export type PushLevels = { important: boolean; routine: boolean }

export function levelAllows(kind: string, levels: PushLevels): boolean {
  if (kind === 'test') return true
  if (kind === 'turn_done') return levels.routine
  return levels.important  // run_failed / confirm
}

export function shouldSuppress(visibleActiveSessions: string[], payloadSessionId: string): boolean {
  return visibleActiveSessions.includes(payloadSessionId)
}

// Keep in sync with sw.js pushsubscriptionchange handler.
export function pickApplicationServerKey(oldKey: ArrayBuffer | null, fetchedB64: string): Uint8Array {
  if (oldKey && oldKey.byteLength > 0) return new Uint8Array(oldKey.slice(0))
  return vapidKeyToUint8Array(fetchedB64)
}

const ENABLED_KEY = 'zmx_push_enabled'

export type PushState = 'unsupported' | 'denied' | 'enabled' | 'disabled'

export async function getPushState(): Promise<PushState> {
  if (!('PushManager' in window) || !('serviceWorker' in navigator) || !('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  return sub ? 'enabled' : 'disabled'
}

export async function enablePush(): Promise<void> {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return
  const reg = await navigator.serviceWorker.ready
  const res = await api('/api/push/vapid-key')
  const { key } = await res.json()
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKeyToUint8Array(key),
  })
  const j = sub.toJSON()
  const levels = getLevels()
  await api('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, levels }),
  })
  localStorage.setItem(ENABLED_KEY, '1')
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await api('/api/push/unsubscribe', {
      method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }),
    })
    await sub.unsubscribe()
  }
  localStorage.removeItem(ENABLED_KEY)
}

export async function resyncPush(): Promise<void> {
  if (Notification.permission !== 'granted') return
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  const levels = getLevels()
  // Refresh the SW's level cache so it stays in sync even after cache eviction.
  try { const cache = await caches.open('zmx-push'); await cache.put('levels', new Response(JSON.stringify(levels))) } catch { /* cache write is best-effort */ }
  if (sub) {
    const j = sub.toJSON()
    await api('/api/push/subscribe', {
      method: 'POST', body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, levels }),
    }).catch(() => {})
    return
  }
  if (localStorage.getItem(ENABLED_KEY) === '1') {
    await enablePush().catch(() => {})
  }
}

export function shouldResyncNow(lastMs: number | null, nowMs: number): boolean {
  if (lastMs === null) return true
  return nowMs - lastMs >= 60 * 60_000
}

export async function sendTestPush(): Promise<void> {
  await api('/api/push/test', { method: 'POST' })
}

export async function setLevels(levels: PushLevels): Promise<void> {
  const cache = await caches.open('zmx-push')
  await cache.put('levels', new Response(JSON.stringify(levels)))
  localStorage.setItem('zmx_push_levels', JSON.stringify(levels))
  // Re-sync to server so send_to_user filtering reflects the new levels.
  await resyncPush().catch(() => {})
}

export function getLevels(): PushLevels {
  try { return JSON.parse(localStorage.getItem('zmx_push_levels') || '') } catch { return { important: true, routine: false } }
}
