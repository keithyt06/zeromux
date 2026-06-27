// active session 上报:每个 client 通过 postMessage 告知它当前可见+active 的会话
let clientActives = {}  // clientId -> { sessionId, visible }

self.addEventListener('message', (e) => {
  const d = e.data || {}
  if (d.type === 'active_session' && e.source) {
    clientActives[e.source.id] = { sessionId: d.id, visible: d.visible !== false }
  }
})

function levelAllows(kind, levels) {
  if (kind === 'turn_done') return !!(levels && levels.routine)
  return !levels || levels.important !== false  // 默认 important 开
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {}
    try { payload = event.data ? event.data.json() : {} } catch (_) {}
    const { kind, session_id, title, body } = payload
    // 分级:读 IndexedDB/Cache 里前端写的 push_levels;读不到用默认(important 开 / routine 关)
    const levels = await readLevels()  // { important:true, routine:false } 默认
    if (!levelAllows(kind, levels)) return
    // 前台抑制:仅 turn_done。实时问所有可见 client 的 active
    if (kind === 'turn_done') {
      const wins = await self.clients.matchAll({ type: 'window' })
      const visibleActives = wins
        .filter(c => c.visibilityState === 'visible')
        .map(c => (clientActives[c.id] || {}).sessionId)
        .filter(Boolean)
      if (visibleActives.includes(session_id)) return  // 用户正看着 → 抑制
    }
    const tag = kind === 'turn_done' ? session_id : `${session_id}:${kind}`
    await self.registration.showNotification(title || 'zeromux', {
      body: body || '', tag, data: { session_id },
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const sid = (event.notification.data || {}).session_id
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (wins.length > 0) {
      await wins[0].focus()
      wins[0].postMessage({ type: 'open_session', id: sid })
    } else {
      await self.clients.openWindow(`/?session=${encodeURIComponent(sid || '')}`)
    }
  })())
})

// push_levels 存取(简单用 Cache API 存一个 JSON 响应)
async function readLevels() {
  try {
    const cache = await caches.open('zmx-push')
    const res = await cache.match('levels')
    if (res) return await res.json()
  } catch (_) {}
  return { important: true, routine: false }
}
