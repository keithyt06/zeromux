# Push Self-Heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop iOS Web Push from silently dying and needing manual re-enable, by moving notification-level filtering to the server (so iOS never receives a push it won't display → no "3-strike" revocation), plus adding client self-heal defenses and a self-test button.

**Architecture:** The root cause (verified) is Apple revoking a subscription after ~3 silent pushes; ZeroMux currently sends `turn_done` to every subscription unconditionally while the SW drops routine-level pushes without displaying them. Fix: persist per-subscription levels, filter in `send_to_user` so undisplayed pushes are never sent. Layer on `pushsubscriptionchange` + on-visible resync (defenses, not the cure) and a `POST /api/push/test` self-test.

**Tech Stack:** Rust/Axum, rusqlite (SQLite), `web-push-native` 0.4; React 19 + Vite, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-03-push-self-heal-design.md`.
- Do NOT change: SSRF guard (`endpoint_is_safe`), debounce algos (`should_push_turn_done`/`should_push_stuck`), deep-link behavior, the two-tier level *semantics* (only move the enforcement point).
- Level→kind mapping (single source of truth): `turn_done` requires `lvl_routine`; `run_failed`/`confirm`/`stuck` require `lvl_important`; `test` always sends (important-class).
- Column defaults preserve legacy rows: `lvl_important` default 1, `lvl_routine` default 0.
- `PUSH_MAX_SUBS_PER_USER = 5`.
- Backend tests: inline `#[cfg(test)]`, run with `cargo test`. Frontend tests: vitest.
- `sw.js` lives in `frontend/public/` (not bundled); testable logic must be duplicated into `lib/push.ts` with a "keep in sync with sw.js" comment (existing `levelAllows` already follows this pattern).

---

### Task 1: Persist per-subscription levels (schema + Subscription struct + upsert)

**Files:**
- Modify: `src/push.rs` (CREATE_SQL, migration, `Subscription`, `upsert`, `list_for_user`)
- Test: inline `#[cfg(test)]` in `src/push.rs`

**Interfaces:**
- Consumes: existing `PushStore { conn: Mutex<Connection> }`.
- Produces:
  - `Subscription { endpoint: String, p256dh: String, auth: String, lvl_important: bool, lvl_routine: bool }`
  - `PushStore::upsert(&self, user_id, endpoint, p256dh, auth, lvl_important: bool, lvl_routine: bool) -> Result<(), String>`
  - `PushStore::list_for_user(&self, user_id) -> Vec<Subscription>` (now includes levels)

- [ ] **Step 1: Write the failing test**

Add to `src/push.rs` tests module:

```rust
#[test]
fn upsert_persists_and_updates_levels() {
    let store = PushStore::open_in_memory().unwrap();
    store.upsert("u1", "https://ep/a", "p", "a", true, false).unwrap();
    let subs = store.list_for_user("u1");
    assert_eq!(subs.len(), 1);
    assert!(subs[0].lvl_important && !subs[0].lvl_routine);
    // upsert same endpoint flips routine on
    store.upsert("u1", "https://ep/a", "p", "a", true, true).unwrap();
    let subs = store.list_for_user("u1");
    assert_eq!(subs.len(), 1);
    assert!(subs[0].lvl_routine, "routine must update on re-upsert");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib push::tests::upsert_persists_and_updates_levels`
Expected: FAIL (compile error — `upsert` takes 4 args, `Subscription` has no `lvl_*`).

- [ ] **Step 3: Implement schema + struct + upsert**

In `src/push.rs`, extend `CREATE_SQL`:

```rust
const CREATE_SQL: &str = "
CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint      TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    p256dh        TEXT NOT NULL,
    auth          TEXT NOT NULL,
    created_ms    INTEGER NOT NULL,
    lvl_important INTEGER NOT NULL DEFAULT 1,
    lvl_routine   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
";
```

Add a migration in `init` (after `execute_batch(CREATE_SQL)`) so existing DBs gain the columns — `ALTER TABLE` errors if the column exists, so ignore the error:

```rust
fn init(conn: Connection) -> Result<Self, String> {
    conn.execute_batch(CREATE_SQL)
        .map_err(|e| format!("push_store init: {e}"))?;
    // Migrate pre-levels DBs; ADD COLUMN fails if already present → ignore.
    let _ = conn.execute("ALTER TABLE push_subscriptions ADD COLUMN lvl_important INTEGER NOT NULL DEFAULT 1", []);
    let _ = conn.execute("ALTER TABLE push_subscriptions ADD COLUMN lvl_routine INTEGER NOT NULL DEFAULT 0", []);
    Ok(PushStore { conn: Mutex::new(conn) })
}
```

Extend the struct:

```rust
pub struct Subscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub lvl_important: bool,
    pub lvl_routine: bool,
}
```

Rewrite `upsert`:

```rust
pub fn upsert(&self, user_id: &str, endpoint: &str, p256dh: &str, auth: &str,
              lvl_important: bool, lvl_routine: bool) -> Result<(), String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let conn = self.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_ms, lvl_important, lvl_routine)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(endpoint) DO UPDATE SET
             user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth,
             created_ms=excluded.created_ms,
             lvl_important=excluded.lvl_important, lvl_routine=excluded.lvl_routine",
        params![endpoint, user_id, p256dh, auth, now_ms, lvl_important as i64, lvl_routine as i64],
    ).map_err(|e| format!("upsert: {e}"))?;
    Ok(())
}
```

Rewrite `list_for_user` SELECT to include levels:

```rust
let mut stmt = match conn.prepare(
    "SELECT endpoint, p256dh, auth, lvl_important, lvl_routine
     FROM push_subscriptions WHERE user_id = ?1",
) { Ok(s) => s, Err(_) => return vec![] };
stmt.query_map(params![user_id], |row| {
    Ok(Subscription {
        endpoint: row.get(0)?, p256dh: row.get(1)?, auth: row.get(2)?,
        lvl_important: row.get::<_, i64>(3)? != 0,
        lvl_routine:   row.get::<_, i64>(4)? != 0,
    })
}).map(|rows| rows.flatten().collect()).unwrap_or_default()
```

Update the three existing tests that call `upsert` with 4 args (`gone_outcome_removes_subscription`, `push_store_upsert_list_delete`, `delete_for_user_scopes_to_owner`) to pass `true, false`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib push::`
Expected: PASS (all push tests, including the updated legacy ones).

- [ ] **Step 5: Commit**

```bash
git add src/push.rs
git commit -m "feat(push): persist per-subscription notification levels"
```

---

### Task 2: Server-side level filtering in send_to_user (the root-cause fix)

**Files:**
- Modify: `src/push.rs` (`send_to_user`)
- Test: inline `#[cfg(test)]` in `src/push.rs`

**Interfaces:**
- Consumes: `Subscription.lvl_important/lvl_routine` (Task 1), `PushPayload.kind`.
- Produces: `pub fn kind_allowed_by_levels(kind: &str, lvl_important: bool, lvl_routine: bool) -> bool` (pure, testable). `send_to_user` uses it to skip subscriptions before any network send.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn kind_level_gating() {
    // turn_done needs routine
    assert!(!kind_allowed_by_levels("turn_done", true, false));
    assert!(kind_allowed_by_levels("turn_done", false, true));
    // important-class needs important
    assert!(kind_allowed_by_levels("run_failed", true, false));
    assert!(!kind_allowed_by_levels("run_failed", false, false));
    assert!(kind_allowed_by_levels("confirm", true, false));
    assert!(kind_allowed_by_levels("stuck", true, false));
    // test always sends
    assert!(kind_allowed_by_levels("test", false, false));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib push::tests::kind_level_gating`
Expected: FAIL (`kind_allowed_by_levels` not defined).

- [ ] **Step 3: Implement the gate + wire into send_to_user**

Add near the payload helpers in `src/push.rs`:

```rust
/// Single source of truth for level→kind gating (mirrors spec's mapping).
/// `test` always sends (self-test must reach the device to be meaningful).
pub fn kind_allowed_by_levels(kind: &str, lvl_important: bool, lvl_routine: bool) -> bool {
    match kind {
        "test" => true,
        "turn_done" => lvl_routine,
        _ => lvl_important, // run_failed / confirm / stuck
    }
}
```

In `send_to_user`, inside the `for sub in subs` loop, before the `endpoint_is_safe` check:

```rust
for sub in subs {
    if !kind_allowed_by_levels(&payload.kind, sub.lvl_important, sub.lvl_routine) {
        continue; // never send a push the device would not display → no iOS 3-strike revoke
    }
    if !endpoint_is_safe(&sub.endpoint) { /* unchanged */ }
    // ... unchanged delivery
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib push::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/push.rs
git commit -m "feat(push): filter by subscription level in send_to_user (root-cause fix for iOS silent-push revocation)"
```

---

### Task 3: Stale-subscription cap (keep newest 5 per user)

**Files:**
- Modify: `src/push.rs` (`upsert` — prune after insert)
- Test: inline `#[cfg(test)]` in `src/push.rs`

**Interfaces:**
- Consumes: `PushStore` conn.
- Produces: after any `upsert`, a user has ≤ `PUSH_MAX_SUBS_PER_USER` rows, newest by `created_ms`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn upsert_caps_subscriptions_per_user() {
    let store = PushStore::open_in_memory().unwrap();
    for i in 0..7 {
        // distinct endpoints; created_ms is set inside upsert (monotonic enough per call)
        store.upsert("u1", &format!("https://ep/{i}"), "p", "a", true, false).unwrap();
    }
    assert!(store.list_for_user("u1").len() <= 5, "must cap at PUSH_MAX_SUBS_PER_USER");
    // other users unaffected
    store.upsert("u2", "https://ep/u2", "p", "a", true, false).unwrap();
    assert_eq!(store.list_for_user("u2").len(), 1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib push::tests::upsert_caps_subscriptions_per_user`
Expected: FAIL (7 rows kept, not ≤5). Note: if all 7 share an identical `created_ms`, the DELETE's ORDER BY tiebreaks by endpoint — acceptable; the test only asserts ≤5.

- [ ] **Step 3: Implement prune in upsert**

Add const near top of `src/push.rs`: `pub const PUSH_MAX_SUBS_PER_USER: usize = 5;`

At the end of `upsert` (still holding `conn`), after the INSERT:

```rust
    // Prune stale subscriptions: keep newest PUSH_MAX_SUBS_PER_USER per user.
    // created_ms is refreshed by resyncPush() on each app foreground, so a
    // low-frequency-but-active device (e.g. rarely-opened iPad) is not wrongly evicted.
    conn.execute(
        "DELETE FROM push_subscriptions
         WHERE user_id = ?1 AND endpoint NOT IN (
             SELECT endpoint FROM push_subscriptions WHERE user_id = ?1
             ORDER BY created_ms DESC, endpoint DESC LIMIT ?2
         )",
        params![user_id, PUSH_MAX_SUBS_PER_USER as i64],
    ).ok();
    Ok(())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib push::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/push.rs
git commit -m "feat(push): cap stored subscriptions to newest 5 per user"
```

---

### Task 4: subscribe endpoint accepts levels + POST /api/push/test

**Files:**
- Modify: `src/web.rs` (`SubscribeReq`, `push_subscribe`, add `push_test` + route)
- Modify: `src/push.rs` (`payload_for` — add `test` arm)
- Test: inline `#[cfg(test)]` in `src/push.rs` for the payload arm; endpoint wiring verified by `cargo build` + real-device checklist.

**Interfaces:**
- Consumes: `PushService::send_to_user` (Task 2), `CurrentUser`, `state.push`.
- Produces:
  - `SubscribeReq { endpoint, keys, levels: Option<LevelsReq> }`, `LevelsReq { important: bool, routine: bool }`
  - Route `POST /api/push/test` → sends a `test` payload to the current user.
  - `payload_for("test", name, sid, None)` returns a titled test notification.

- [ ] **Step 1: Write the failing test (payload arm)**

Add to `src/push.rs` tests:

```rust
#[test]
fn test_payload_shape() {
    let p = payload_for("test", "ZeroMux", "", None);
    assert_eq!(p.kind, "test");
    assert!(!p.title.is_empty());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --lib push::tests::test_payload_shape`
Expected: FAIL (test arm falls into `_ =>` giving empty title).

- [ ] **Step 3: Implement**

In `src/push.rs` `payload_for`, add before the `_ =>` arm:

```rust
        "test" => (
            "🔔 测试推送".to_string(),
            "如果你看到这条,推送链路正常".to_string(),
        ),
```

In `src/web.rs`, extend the subscribe request types:

```rust
#[derive(serde::Deserialize)]
struct SubscribeReq {
    endpoint: String,
    keys: SubKeys,
    levels: Option<LevelsReq>,
}

#[derive(serde::Deserialize)]
struct LevelsReq { important: bool, routine: bool }
```

Update `push_subscribe` to pass levels (default important=on/routine=off):

```rust
    let (imp, rout) = req.levels.map(|l| (l.important, l.routine)).unwrap_or((true, false));
    p.store()
        .upsert(&user.id, &req.endpoint, &req.keys.p256dh, &req.keys.auth, imp, rout)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
```

Add the test handler:

```rust
async fn push_test(
    State(state): State<Arc<AppState>>,
    user: axum::Extension<CurrentUser>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let p = state.push.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let payload = crate::push::payload_for("test", "ZeroMux", "", None);
    p.send_to_user(&user.id, &payload).await;
    Ok(Json(serde_json::json!({ "ok": true })))
}
```

Register route in the authed group (next to the other push routes, ~`web.rs:66-68`):

```rust
        .route("/api/push/test", post(push_test))
```

- [ ] **Step 4: Run tests + build**

Run: `cargo test --lib push:: && cargo build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add src/push.rs src/web.rs
git commit -m "feat(push): subscribe stores levels; add POST /api/push/test self-test"
```

---

### Task 5: Frontend push lib — levels sync, resync, auth'd fetch, enabled marker

**Files:**
- Modify: `frontend/src/lib/api.ts` (export `api` helper)
- Modify: `frontend/src/lib/push.ts` (`enablePush`, `disablePush`, `setLevels`, add `resyncPush`, `sendTestPush`, `pickApplicationServerKey`)
- Test: `frontend/src/lib/__tests__/push.test.ts`

**Interfaces:**
- Consumes: `api()` from api.ts (authed fetch), `getLevels()`.
- Produces:
  - `resyncPush(): Promise<void>` — 3 branches (local sub → re-POST; no sub + marker → subscribe; else no-op).
  - `sendTestPush(): Promise<void>` — `POST /api/push/test`.
  - `pickApplicationServerKey(oldKey: ArrayBuffer|null, fetchedB64: string): Uint8Array` — SW key-selection logic, duplicated for sw.js sync + testable.
  - `enablePush`/`disablePush` maintain `localStorage['zmx_push_enabled']`.
  - All push fetches go through `api()` (Authorization header for legacy mode).

- [ ] **Step 1: Write failing tests**

In `frontend/src/lib/__tests__/push.test.ts`, add:

```ts
import { pickApplicationServerKey } from '../push'

describe('pickApplicationServerKey', () => {
  it('prefers oldSubscription key when present', () => {
    const old = new Uint8Array([1,2,3]).buffer
    const out = pickApplicationServerKey(old, 'BQ') // fetched ignored
    expect(Array.from(out)).toEqual([1,2,3])
  })
  it('falls back to fetched base64url when old key absent', () => {
    const out = pickApplicationServerKey(null, 'AQID') // base64url AQID = [1,2,3]
    expect(Array.from(out)).toEqual([1,2,3])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/__tests__/push.test.ts`
Expected: FAIL (`pickApplicationServerKey` not exported).

- [ ] **Step 3: Implement**

In `frontend/src/lib/api.ts`, change `async function api(` to `export async function api(`.

In `frontend/src/lib/push.ts`:

```ts
import { api } from './api'

// Keep in sync with sw.js pushsubscriptionchange handler.
export function pickApplicationServerKey(oldKey: ArrayBuffer | null, fetchedB64: string): Uint8Array {
  if (oldKey && oldKey.byteLength > 0) return new Uint8Array(oldKey.slice(0))
  return vapidKeyToUint8Array(fetchedB64)
}

const ENABLED_KEY = 'zmx_push_enabled'

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

export async function sendTestPush(): Promise<void> {
  await api('/api/push/test', { method: 'POST' })
}
```

Update `setLevels` to also push levels to the server (so the change takes effect server-side), best-effort:

```ts
export async function setLevels(levels: PushLevels): Promise<void> {
  const cache = await caches.open('zmx-push')
  await cache.put('levels', new Response(JSON.stringify(levels)))
  localStorage.setItem('zmx_push_levels', JSON.stringify(levels))
  // Re-sync to server so send_to_user filtering reflects the new levels.
  await resyncPush().catch(() => {})
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/lib/__tests__/push.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/push.ts frontend/src/lib/__tests__/push.test.ts
git commit -m "feat(push): authed fetch, level sync, resync, test-push in push lib"
```

---

### Task 6: sw.js — pushsubscriptionchange handler + display-on-receive

**Files:**
- Modify: `frontend/public/sw.js`
- Test: none direct (static file); logic mirrored in Task 5's `pickApplicationServerKey` test.

**Interfaces:**
- Consumes: `/api/push/vapid-key`, `/api/push/subscribe` (cookie-auth in SW context).
- Produces: SW re-subscribes on `pushsubscriptionchange`; still displays every received push (level filtering now server-side).

- [ ] **Step 1: Add pushsubscriptionchange handler**

Append to `frontend/public/sw.js`:

```js
// Subscription rotation/revocation recovery. Note: Chrome rarely fires this and
// Safari is unreliable, so the oldSubscription key is usually absent → the
// vapid-key fetch is effectively the main path. This is a defense; the real fix
// for iOS "3-strike" revocation is server-side level filtering. Auth in SW is
// cookie-only; on failure we leave a marker for the app's on-visible resync.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const oldKey = event.oldSubscription && event.oldSubscription.options
        ? event.oldSubscription.options.applicationServerKey : null
      let appKey = oldKey
      if (!appKey) {
        const res = await fetch('/api/push/vapid-key')
        const { key } = await res.json()
        appKey = urlB64ToUint8Array(key)
      }
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: appKey,
      })
      const j = sub.toJSON()
      const levels = await readLevels()
      const r = await fetch('/api/push/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, levels }),
      })
      if (!r.ok) throw new Error('subscribe ' + r.status)
    } catch (_) {
      // Cookie likely expired → let the app's on-visible resync retry.
      try { const c = await caches.open('zmx-push'); await c.put('resync-needed', new Response('1')) } catch (_) {}
    }
  })())
})

function urlB64ToUint8Array(b64url) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4)
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}
```

- [ ] **Step 2: Keep display-on-receive; keep levelAllows only as Chrome backstop**

In the existing `push` handler, leave `if (!levelAllows(kind, levels)) return` in place (it is now redundant on iOS because server filters, but harmless as a Chrome-only backstop — Chrome silently drops without revoking). Add a comment above line 23:

```js
    // Level filtering is now enforced server-side (send_to_user) so iOS never
    // receives an undisplayed push. This client check is only a Chrome backstop.
```

Keep the foreground-suppression `return` (line 31) unchanged — verified acceptable in spec (real-device checklist item ①).

- [ ] **Step 3: Manual verification (build)**

Run: `cd frontend && npm run build`
Expected: build succeeds (sw.js is copied from public/ verbatim).

- [ ] **Step 4: Commit**

```bash
git add frontend/public/sw.js
git commit -m "feat(push): sw.js pushsubscriptionchange re-subscribe + server-side-filter note"
```

---

### Task 7: Wire resync into app lifecycle (load + on-visible, throttled)

**Files:**
- Modify: `frontend/src/main.tsx` (call `resyncPush` on load)
- Modify: `frontend/src/App.tsx` (throttled `visibilitychange` resync)
- Test: `frontend/src/lib/__tests__/push.test.ts` (throttle helper)

**Interfaces:**
- Consumes: `resyncPush()` (Task 5).
- Produces: `shouldResyncNow(lastMs: number|null, nowMs: number): boolean` (≥ 1h throttle), exported from `lib/push.ts`.

- [ ] **Step 1: Write failing test**

```ts
import { shouldResyncNow } from '../push'
describe('shouldResyncNow', () => {
  it('allows first resync and after 1h, blocks within 1h', () => {
    expect(shouldResyncNow(null, 1_000_000)).toBe(true)
    expect(shouldResyncNow(1_000_000, 1_000_000 + 59*60_000)).toBe(false)
    expect(shouldResyncNow(1_000_000, 1_000_000 + 61*60_000)).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/lib/__tests__/push.test.ts`
Expected: FAIL (`shouldResyncNow` not exported).

- [ ] **Step 3: Implement**

In `frontend/src/lib/push.ts`:

```ts
export function shouldResyncNow(lastMs: number | null, nowMs: number): boolean {
  if (lastMs === null) return true
  return nowMs - lastMs >= 60 * 60_000
}
```

In `frontend/src/main.tsx`, after SW registration:

```ts
import { resyncPush } from './lib/push'
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(() => resyncPush())
    .catch(() => { /* push is non-critical */ })
}
```

In `frontend/src/App.tsx`, add an effect (near the existing serviceWorker `useEffect` around line 102):

```tsx
useEffect(() => {
  let last: number | null = null
  const onVis = () => {
    if (document.visibilityState !== 'visible') return
    const now = Date.now()
    if (!shouldResyncNow(last, now)) return
    last = now
    resyncPush().catch(() => {})
  }
  document.addEventListener('visibilitychange', onVis)
  return () => document.removeEventListener('visibilitychange', onVis)
}, [])
```

Add imports to App.tsx: `import { resyncPush, shouldResyncNow } from './lib/push'`.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/lib/__tests__/push.test.ts && npm run build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/main.tsx frontend/src/App.tsx frontend/src/lib/push.ts frontend/src/lib/__tests__/push.test.ts
git commit -m "feat(push): resync on load + throttled on-visible resync"
```

---

### Task 8: Test-push button in PushSettings

**Files:**
- Modify: `frontend/src/components/PushSettings.tsx`
- Test: `frontend/src/components/__tests__/PushSettings.test.tsx`

**Interfaces:**
- Consumes: `sendTestPush()` (Task 5).
- Produces: a "发送测试推送" button shown when `state === 'enabled'`, calls `sendTestPush`, shows transient "已发送" feedback.

- [ ] **Step 1: Write failing test**

Add to `PushSettings.test.tsx` (mock `sendTestPush`):

```tsx
it('shows test-push button when enabled and calls sendTestPush', async () => {
  // getPushState mocked to resolve 'enabled', sendTestPush mocked
  render(<PushSettings onClose={() => {}} />)
  const btn = await screen.findByRole('button', { name: /测试推送/ })
  fireEvent.click(btn)
  expect(sendTestPushMock).toHaveBeenCalled()
})
```

(Follow the existing mock setup in this test file for `getPushState`/`../lib/push`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/components/__tests__/PushSettings.test.tsx`
Expected: FAIL (no such button).

- [ ] **Step 3: Implement**

Import `sendTestPush` in `PushSettings.tsx`. Add inside the `state === 'enabled'` block (after the level toggles):

```tsx
<div className="border-t border-[var(--border)] pt-3">
  <TestPushButton />
</div>
```

Add component at file end:

```tsx
function TestPushButton() {
  const [sent, setSent] = useState(false)
  return (
    <button
      onClick={async () => { try { await sendTestPush(); setSent(true); setTimeout(() => setSent(false), 2000) } catch { /* noop */ } }}
      className="text-xs px-2 py-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:opacity-80"
    >
      {sent ? '已发送 ✓' : '发送测试推送'}
    </button>
  )
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd frontend && npx vitest run src/components/__tests__/PushSettings.test.tsx && npm run build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PushSettings.tsx frontend/src/components/__tests__/PushSettings.test.tsx
git commit -m "feat(push): send-test-push button in settings for link self-verification"
```

---

### Task 9: Full test sweep + real-device checklist doc

**Files:**
- Modify: none (verification task); optionally append checklist results to the PR.

- [ ] **Step 1: Backend sweep**

Run: `cargo test`
Expected: PASS (all, incl. push).

- [ ] **Step 2: Frontend sweep**

Run: `cd frontend && npm run lint && npx vitest run && npm run build`
Expected: lint clean (or only pre-existing warnings), tests pass, build succeeds.

- [ ] **Step 3: Record real-device checklist (manual, on live after deploy — do NOT block merge)**

Document in PR body:
1. routine OFF + ≥3 consecutive long turns complete → `run_failed`/`confirm` still delivered (proves no 3-strike revoke).
2. iOS PWA push ON → idle ≥24h → important-class still delivered, no manual re-enable.
3. "发送测试推送" delivers immediately.

- [ ] **Step 4: Commit (if any doc)**

```bash
git commit --allow-empty -m "test(push): full sweep green; real-device checklist recorded in PR"
```

---

## Self-Review

**Spec coverage:**
- 改动1 服务端级别过滤 → Tasks 1,2,4 (schema, filter, subscribe levels). ✓
- 改动2 pushsubscriptionchange → Task 6. ✓
- 改动3 resync (load + on-visible) → Tasks 5,7. ✓
- 改动4 test-push button → Tasks 4,5,8. ✓
- 改动5 stale cleanup cap=5 → Task 3. ✓
- 接口/鉴权 (authed fetch, SW cookie + resync fallback marker) → Tasks 5,6. ✓
- SW testability via duplicated pure fn → Task 5 (`pickApplicationServerKey`). ✓
- Real-device checklist → Task 9. ✓
- Do-not-change items respected (SSRF/debounce/deep-link untouched). ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete code. ✓

**Type consistency:** `upsert(user_id,endpoint,p256dh,auth,lvl_important,lvl_routine)` used consistently (Tasks 1,3,4); `kind_allowed_by_levels` (Task 2) reused nowhere else by different name; `resyncPush`/`sendTestPush`/`pickApplicationServerKey`/`shouldResyncNow` names stable across Tasks 5,7,8. ✓
