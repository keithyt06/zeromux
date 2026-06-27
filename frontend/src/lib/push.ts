export function vapidKeyToUint8Array(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4)
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

export type PushLevels = { important: boolean; routine: boolean }

export function levelAllows(kind: string, levels: PushLevels): boolean {
  if (kind === 'turn_done') return levels.routine
  return levels.important  // run_failed / confirm
}

export function shouldSuppress(visibleActiveSessions: string[], payloadSessionId: string): boolean {
  return visibleActiveSessions.includes(payloadSessionId)
}

export type PushState = 'unsupported' | 'denied' | 'enabled' | 'disabled'

export async function getPushState(): Promise<PushState> {
  if (!('PushManager' in window) || !('serviceWorker' in navigator)) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  return sub ? 'enabled' : 'disabled'
}

export async function enablePush(): Promise<void> {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return
  const reg = await navigator.serviceWorker.ready
  const res = await fetch('/api/push/vapid-key')
  const { key } = await res.json()
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: vapidKeyToUint8Array(key),
  })
  const j = sub.toJSON()
  await fetch('/api/push/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
  })
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await fetch('/api/push/unsubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    })
    await sub.unsubscribe()
  }
}

export async function setLevels(levels: PushLevels): Promise<void> {
  const cache = await caches.open('zmx-push')
  await cache.put('levels', new Response(JSON.stringify(levels)))
  localStorage.setItem('zmx_push_levels', JSON.stringify(levels))
}

export function getLevels(): PushLevels {
  try { return JSON.parse(localStorage.getItem('zmx_push_levels') || '') } catch { return { important: true, routine: false } }
}
