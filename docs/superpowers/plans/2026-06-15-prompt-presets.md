# Prompt Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global, backend-persisted prompt-preset library, quick-pickable at two entry points — session-create (`pick-prompt`) and the in-session Composer — letting users save and one-click reuse common agent instructions across devices.

**Architecture:** New `PromptPresetStore` (own `prompts.db` SQLite, mirrors `notes.rs` storage shape; no owner, no file mirror) behind 4 `/api/prompts` CRUD routes. Frontend: a thin `api.ts` layer → a shared `usePromptPresets` hook (data/CRUD/error) → a shared `<PromptManager>` add/edit/delete UI, consumed by both `Sidebar` (pick-prompt step + manage substep) and `AcpChatView` (Composer presets popover). Picking a preset replaces the target input's text via the existing controlled-value channel; nothing new is sent.

**Tech Stack:** Rust/Axum, rusqlite (`Mutex<Connection>`), React 19 + Vite + Tailwind v4, vitest, lucide-react icons.

**Source spec:** `docs/superpowers/specs/2026-06-15-prompt-presets-design.md`

---

## File Structure

**Backend**
- Create `src/prompts.rs` — `PromptPreset` struct + `PromptPresetStore` (open/list/create/update/delete) + `#[cfg(test)]` tests. Self-contained; copies `short_uuid`/`now_iso` (private in notes.rs).
- Modify `src/main.rs` — `mod prompts;`, `AppState.prompts` field, init alongside `notes_store`.
- Modify `src/web.rs` — 4 routes, 4 handlers, `CreatePromptReq`/`UpdatePromptReq`.

**Frontend**
- Modify `frontend/src/lib/api.ts` — `PromptPreset` interface + `listPrompts`/`createPrompt`/`updatePrompt`/`deletePrompt`.
- Create `frontend/src/lib/usePromptPresets.ts` — shared hook (presets/loading/error + reload/add/edit/remove).
- Create `frontend/src/components/PromptManager.tsx` — shared add/edit/delete list UI.
- Modify `frontend/src/components/Sidebar.tsx` — chips row in `pick-prompt`, new `manage-prompts` substep, `close()` reset.
- Modify `frontend/src/components/AcpChatView.tsx` — presets button in Composer `rightSlot` + anchored popover.
- Create tests: `frontend/src/lib/__tests__/prompts.test.ts`, `frontend/src/lib/__tests__/usePromptPresets.test.ts`.

---

## Task 1: Backend — `PromptPresetStore` with tests

**Files:**
- Create: `src/prompts.rs`
- Modify: `src/main.rs` (add `mod prompts;` near line 11–13)

- [ ] **Step 1: Create `src/prompts.rs` with struct, store, and helpers**

```rust
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

/// Caps: guard against abuse / runaway payloads. body is generous (a preset
/// can be a long instruction) but bounded.
const TITLE_MAX: usize = 200;
const BODY_MAX: usize = 20_000;

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct PromptPreset {
    pub id: String,
    pub title: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub sort_order: i64,
}

pub struct PromptPresetStore {
    conn: Mutex<Connection>,
}

impl PromptPresetStore {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
        let db_path = data_dir.join("prompts.db");
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open prompts database: {}", e))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS prompt_presets (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                body        TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                sort_order  INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_prompt_presets_sort
                ON prompt_presets(sort_order, created_at);",
        )
        .map_err(|e| format!("Failed to create prompt_presets table: {}", e))?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn list(&self) -> Result<Vec<PromptPreset>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, body, created_at, updated_at, sort_order
                 FROM prompt_presets ORDER BY sort_order, created_at",
            )
            .map_err(|e| format!("Query error: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PromptPreset {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    body: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    sort_order: row.get(5)?,
                })
            })
            .map_err(|e| format!("Query error: {}", e))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("Row error: {}", e))?);
        }
        Ok(out)
    }

    /// Returns Err("empty") when title or body is blank, Err("too long")
    /// when over caps. Never logs the body (may hold secrets).
    pub fn create(&self, title: &str, body: &str) -> Result<PromptPreset, String> {
        let title = title.trim();
        let body = body.trim();
        if title.is_empty() || body.is_empty() {
            return Err("empty".into());
        }
        if title.chars().count() > TITLE_MAX || body.chars().count() > BODY_MAX {
            return Err("too long".into());
        }
        let id = short_uuid();
        let now = now_iso();
        let conn = self.conn.lock().unwrap();
        // Hold ONE lock across MAX + INSERT so concurrent creates don't race sort_order.
        let next: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM prompt_presets",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Query error: {}", e))?;
        conn.execute(
            "INSERT INTO prompt_presets (id, title, body, created_at, updated_at, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            params![id, title, body, now, next],
        )
        .map_err(|e| format!("Insert error: {}", e))?;
        Ok(PromptPreset {
            id,
            title: title.to_string(),
            body: body.to_string(),
            created_at: now.clone(),
            updated_at: now,
            sort_order: next,
        })
    }

    /// Updates only the provided fields. Both None (empty PUT) -> Ok(false),
    /// no row touched. Blank/over-cap field -> Err. Returns whether a row matched.
    pub fn update(
        &self,
        id: &str,
        title: Option<&str>,
        body: Option<&str>,
    ) -> Result<bool, String> {
        if title.is_none() && body.is_none() {
            return Ok(false);
        }
        let title = match title {
            Some(t) => {
                let t = t.trim();
                if t.is_empty() {
                    return Err("empty".into());
                }
                if t.chars().count() > TITLE_MAX {
                    return Err("too long".into());
                }
                Some(t.to_string())
            }
            None => None,
        };
        let body = match body {
            Some(b) => {
                let b = b.trim();
                if b.is_empty() {
                    return Err("empty".into());
                }
                if b.chars().count() > BODY_MAX {
                    return Err("too long".into());
                }
                Some(b.to_string())
            }
            None => None,
        };
        let now = now_iso();
        let conn = self.conn.lock().unwrap();
        let rows = match (title, body) {
            (Some(t), Some(b)) => conn.execute(
                "UPDATE prompt_presets SET title=?2, body=?3, updated_at=?4 WHERE id=?1",
                params![id, t, b, now],
            ),
            (Some(t), None) => conn.execute(
                "UPDATE prompt_presets SET title=?2, updated_at=?3 WHERE id=?1",
                params![id, t, now],
            ),
            (None, Some(b)) => conn.execute(
                "UPDATE prompt_presets SET body=?2, updated_at=?3 WHERE id=?1",
                params![id, b, now],
            ),
            (None, None) => unreachable!(),
        }
        .map_err(|e| format!("Update error: {}", e))?;
        Ok(rows > 0)
    }

    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let rows = conn
            .execute("DELETE FROM prompt_presets WHERE id = ?1", params![id])
            .map_err(|e| format!("Delete error: {}", e))?;
        Ok(rows > 0)
    }
}

// Private to notes.rs — duplicated here (two tiny fns, not worth a shared util).
fn short_uuid() -> String {
    uuid::Uuid::new_v4().to_string().replace('-', "")[..8].to_string()
}

fn now_iso() -> String {
    // Reuse notes.rs's epoch-to-ISO approach; delegate to chrono-free arithmetic
    // already proven there. For simplicity here, store RFC-ish UTC seconds string.
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", d.as_secs())
}
```

> **Note on `now_iso`:** notes.rs hand-rolls a full ISO formatter. The store only needs a monotonic, comparable timestamp string for `created_at`/`updated_at` (never parsed back, only displayed/ordered). A UTC-epoch-seconds string is sufficient and avoids copying ~40 lines of date math. If you prefer ISO display, copy notes.rs's `now_iso` + `is_leap` verbatim instead — both are acceptable; pick one and keep it.

- [ ] **Step 2: Add `mod prompts;` to `src/main.rs`**

In the module-declaration block (alphabetical, after `mod oauth;` line 12 / before `mod pty_bridge;` line 13):

```rust
mod oauth;
mod prompts;
mod pty_bridge;
```

- [ ] **Step 3: Append `#[cfg(test)]` tests to `src/prompts.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // Mirror session_store.rs: return the TempDir guard so it isn't dropped
    // (which would delete the DB out from under the store mid-test).
    fn tmp_store() -> (PromptPresetStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = PromptPresetStore::open(dir.path()).unwrap();
        (store, dir)
    }

    #[test]
    fn create_then_list_orders_by_sort() {
        let (s, _d) = tmp_store();
        let a = s.create("first", "body1").unwrap();
        let b = s.create("second", "body2").unwrap();
        let all = s.list().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, a.id);
        assert_eq!(all[1].id, b.id);
        assert!(b.sort_order > a.sort_order);
    }

    #[test]
    fn create_rejects_empty() {
        let (s, _d) = tmp_store();
        assert!(s.create("", "body").is_err());
        assert!(s.create("title", "   ").is_err());
        assert_eq!(s.list().unwrap().len(), 0);
    }

    #[test]
    fn create_rejects_too_long() {
        let (s, _d) = tmp_store();
        let long_title: String = "x".repeat(TITLE_MAX + 1);
        assert!(s.create(&long_title, "body").is_err());
        let long_body: String = "y".repeat(BODY_MAX + 1);
        assert!(s.create("title", &long_body).is_err());
    }

    #[test]
    fn update_title_only_keeps_body_and_bumps_updated_at() {
        let (s, _d) = tmp_store();
        let p = s.create("t", "b").unwrap();
        let hit = s.update(&p.id, Some("t2"), None).unwrap();
        assert!(hit);
        let row = s.list().unwrap().into_iter().next().unwrap();
        assert_eq!(row.title, "t2");
        assert_eq!(row.body, "b");
        assert!(row.updated_at >= p.updated_at);
    }

    #[test]
    fn update_missing_id_returns_false() {
        let (s, _d) = tmp_store();
        assert_eq!(s.update("nope", Some("x"), None).unwrap(), false);
    }

    #[test]
    fn update_empty_put_is_noop_false() {
        let (s, _d) = tmp_store();
        let p = s.create("t", "b").unwrap();
        assert_eq!(s.update(&p.id, None, None).unwrap(), false);
        let row = s.list().unwrap().into_iter().next().unwrap();
        assert_eq!(row.updated_at, p.updated_at); // untouched
    }

    #[test]
    fn update_blank_field_errors() {
        let (s, _d) = tmp_store();
        let p = s.create("t", "b").unwrap();
        assert!(s.update(&p.id, Some("   "), None).is_err());
        let row = s.list().unwrap().into_iter().next().unwrap();
        assert_eq!(row.title, "t"); // not changed
    }

    #[test]
    fn delete_hit_then_miss() {
        let (s, _d) = tmp_store();
        let p = s.create("t", "b").unwrap();
        assert_eq!(s.delete(&p.id).unwrap(), true);
        assert_eq!(s.list().unwrap().len(), 0);
        assert_eq!(s.delete(&p.id).unwrap(), false);
    }
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `cargo test prompts::`
Expected: all 8 tests pass. (If `now_iso` returns epoch seconds, `updated_at >= created_at` holds since they're equal on create; the `>=` assertion is intentional to tolerate same-second updates.)

- [ ] **Step 5: Commit**

```bash
git add src/prompts.rs src/main.rs
git commit -m "feat(prompts): PromptPresetStore — SQLite-backed global preset CRUD + tests"
```

---

## Task 2: Backend — wire store into AppState

**Files:**
- Modify: `src/main.rs` (`AppState` struct ~line 129; init ~line 223; struct build ~line 268)

- [ ] **Step 1: Add field to `AppState`**

After `pub notes: notes::NotesStore,` (line 129):

```rust
    pub notes: notes::NotesStore,
    pub prompts: prompts::PromptPresetStore,
```

- [ ] **Step 2: Initialize the store**

After the `notes_store` init (line 223–224), add:

```rust
    let prompts_store = prompts::PromptPresetStore::open(std::path::Path::new(&data_dir_str))
        .expect("Failed to open prompts store");
```

- [ ] **Step 3: Add to the `AppState { ... }` builder**

After `notes: notes_store,` (line 268):

```rust
        notes: notes_store,
        prompts: prompts_store,
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo check`
Expected: compiles clean (no unused-field warning — handlers in Task 3 use it; if checking before Task 3, a `dead_code` warning on the field is acceptable and goes away after Task 3).

- [ ] **Step 5: Commit**

```bash
git add src/main.rs
git commit -m "feat(prompts): wire PromptPresetStore into AppState"
```

---

## Task 3: Backend — `/api/prompts` routes + handlers

**Files:**
- Modify: `src/web.rs` (routes in `build_router` ~line 39–41 area; req structs near line 563; handlers near line 569–617)

- [ ] **Step 1: Add request structs near `CreateNoteReq` (after line ~566)**

```rust
#[derive(serde::Deserialize)]
struct CreatePromptReq {
    title: String,
    body: String,
}

#[derive(serde::Deserialize)]
struct UpdatePromptReq {
    title: Option<String>,
    body: Option<String>,
}
```

- [ ] **Step 2: Add the four handlers (after `delete_note`, ~line 617)**

```rust
// ── Prompt presets (global, not session-scoped) ──

async fn list_prompts(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let presets = state
        .prompts
        .list()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(serde_json::json!({ "presets": presets })))
}

async fn create_prompt(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreatePromptReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    match state.prompts.create(&req.title, &req.body) {
        Ok(p) => Ok(Json(serde_json::json!(p))),
        // "empty"/"too long" are user-input validation -> 400 (not notes' 500).
        Err(e) => Err((StatusCode::BAD_REQUEST, e)),
    }
}

async fn update_prompt(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(req): Json<UpdatePromptReq>,
) -> StatusCode {
    match state
        .prompts
        .update(&id, req.title.as_deref(), req.body.as_deref())
    {
        Ok(true) => StatusCode::OK,
        Ok(false) => StatusCode::NOT_FOUND, // missing id OR empty PUT
        Err(_) => StatusCode::BAD_REQUEST,  // blank/over-cap field
    }
}

async fn delete_prompt(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> StatusCode {
    match state.prompts.delete(&id) {
        Ok(true) => StatusCode::OK,
        Ok(false) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}
```

- [ ] **Step 3: Register routes in `build_router` (after the notes routes, ~line 41)**

```rust
        .route("/api/sessions/{id}/notes/{note_id}", delete(delete_note))
        .route("/api/prompts", get(list_prompts).post(create_prompt))
        .route("/api/prompts/{id}", put(update_prompt).delete(delete_prompt))
```

(`put`, `get`, `post`, `delete` are all already imported at line 6.)

- [ ] **Step 4: Verify it compiles**

Run: `cargo check`
Expected: compiles clean, no dead_code warning on `AppState.prompts`.

- [ ] **Step 5: Manual smoke (optional but recommended)**

```bash
cargo build && ./target/debug/zeromux --port 8099 --password test &
sleep 2
TOKEN=$(curl -s -X POST localhost:8099/api/login -H 'content-type: application/json' -d '{"password":"test"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
curl -s -X POST localhost:8099/api/prompts -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"title":"审查 PR","body":"审查这个 PR 的改动"}'
curl -s localhost:8099/api/prompts -H "authorization: Bearer $TOKEN"
kill %1
```
Expected: create returns the preset JSON; list returns `{"presets":[{...}]}`. (Exact login route/shape may differ — skip if uncertain; Task-1 unit tests already cover store logic.)

- [ ] **Step 6: Commit**

```bash
git add src/web.rs
git commit -m "feat(prompts): /api/prompts CRUD routes + handlers (400 on bad input)"
```

---

## Task 4: Frontend — `api.ts` preset functions + tests

**Files:**
- Modify: `frontend/src/lib/api.ts` (add near the Notes API block, ~line 250)
- Create: `frontend/src/lib/__tests__/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/__tests__/prompts.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listPrompts, createPrompt, updatePrompt, deletePrompt } from '../api'

describe('prompt presets api', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ presets: [{ id: 'p1', title: 't', body: 'b', created_at: '1', updated_at: '1', sort_order: 1 }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('listPrompts unwraps data.presets', async () => {
    const out = await listPrompts()
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('p1')
  })

  it('listPrompts returns [] when presets missing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    expect(await listPrompts()).toEqual([])
  })

  it('createPrompt posts title + body', async () => {
    await createPrompt('审查 PR', '审查这个 PR')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/prompts')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({ title: '审查 PR', body: '审查这个 PR' })
  })

  it('updatePrompt sends only provided fields', async () => {
    await updatePrompt('p1', { body: 'new' })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/prompts/p1')
    expect(opts.method).toBe('PUT')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({ body: 'new' })
    expect('title' in body).toBe(false)
  })

  it('deletePrompt issues DELETE', async () => {
    await deletePrompt('p1')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/api/prompts/p1')
    expect(opts.method).toBe('DELETE')
  })

  it('listPrompts throws on !ok (caller/hook catches)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'err' })
    await expect(listPrompts()).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/__tests__/prompts.test.ts`
Expected: FAIL — `listPrompts` etc. not exported.

- [ ] **Step 3: Add the interface + functions to `api.ts`**

Add after the Notes API block (after `deleteNote`, ~line 252):

```ts
// Prompt presets API (global, not session-scoped)
export interface PromptPreset {
  id: string
  title: string
  body: string
  created_at: string
  updated_at: string
  sort_order: number
}

export async function listPrompts(): Promise<PromptPreset[]> {
  const res = await api('/api/prompts')
  if (!res.ok) throw new Error('Failed to list prompts')
  const data = await res.json()
  return data.presets || []
}

export async function createPrompt(title: string, body: string): Promise<PromptPreset> {
  const res = await api('/api/prompts', {
    method: 'POST',
    body: JSON.stringify({ title, body }),
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function updatePrompt(
  id: string,
  fields: { title?: string; body?: string },
): Promise<void> {
  const res = await api(`/api/prompts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(await res.text())
}

export async function deletePrompt(id: string): Promise<void> {
  const res = await api(`/api/prompts/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error('Failed to delete prompt')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/__tests__/prompts.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/lib/__tests__/prompts.test.ts
git commit -m "feat(fe): prompt presets api client + tests"
```

---

## Task 5: Frontend — `usePromptPresets` hook + tests

**Files:**
- Create: `frontend/src/lib/usePromptPresets.ts`
- Create: `frontend/src/lib/__tests__/usePromptPresets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/__tests__/usePromptPresets.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { usePromptPresets } from '../usePromptPresets'

describe('usePromptPresets', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ presets: [{ id: 'p1', title: 't', body: 'b', created_at: '1', updated_at: '1', sort_order: 1 }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reload populates presets', async () => {
    const { result } = renderHook(() => usePromptPresets())
    await act(async () => { await result.current.reload() })
    expect(result.current.presets).toHaveLength(1)
    expect(result.current.error).toBeNull()
  })

  it('reload failure sets error and keeps presets empty (no throw)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, text: async () => 'boom' })
    const { result } = renderHook(() => usePromptPresets())
    await act(async () => { await result.current.reload() })
    expect(result.current.presets).toEqual([])
    expect(result.current.error).not.toBeNull()
  })
})
```

> If `@testing-library/react` is not a dev dependency, check `frontend/package.json`. If absent, this test downgrades to a manual-verification note (the hook is thin); skip steps 2/4 and mark the hook covered by the Task 4 api tests + manual checklist. Verify with: `cd frontend && node -e "require('@testing-library/react')"` (PASS = present).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/__tests__/usePromptPresets.test.ts`
Expected: FAIL — `usePromptPresets` not found.

- [ ] **Step 3: Create the hook**

Create `frontend/src/lib/usePromptPresets.ts`:

```ts
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

  const add = useCallback(async (title: string, body: string) => {
    try {
      await createPrompt(title, body)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create preset')
    }
  }, [reload])

  const edit = useCallback(async (id: string, fields: { title?: string; body?: string }) => {
    try {
      await updatePrompt(id, fields)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update preset')
    }
  }, [reload])

  const remove = useCallback(async (id: string) => {
    try {
      await deletePrompt(id)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete preset')
    }
  }, [reload])

  return { presets, loading, error, reload, add, edit, remove }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/__tests__/usePromptPresets.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/usePromptPresets.ts frontend/src/lib/__tests__/usePromptPresets.test.ts
git commit -m "feat(fe): usePromptPresets hook — shared data/CRUD/error, degrade-safe"
```

---

## Task 6: Frontend — shared `<PromptManager>` component

**Files:**
- Create: `frontend/src/components/PromptManager.tsx`

This is the add/edit/delete list UI shared by both entry points. It is **presentational** — it receives presets + callbacks, owns only its local form draft state. It does NOT pick/insert presets (that's each caller's `onPick`).

- [ ] **Step 1: Create the component**

Create `frontend/src/components/PromptManager.tsx`:

```tsx
import { useState } from 'react'
import { Pencil, Trash2, Plus, X } from 'lucide-react'
import type { PromptPreset } from '../lib/api'

interface Props {
  presets: PromptPreset[]
  error: string | null
  onAdd: (title: string, body: string) => void
  onEdit: (id: string, fields: { title?: string; body?: string }) => void
  onRemove: (id: string) => void
  onClose: () => void
}

const inputCls =
  'w-full rounded bg-[var(--bg-secondary)] border border-[var(--border)] p-2 text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]'

export default function PromptManager({ presets, error, onAdd, onEdit, onRemove, onClose }: Props) {
  // editingId === null && formOpen === true => new; editingId set => editing that row.
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftBody, setDraftBody] = useState('')

  const openNew = () => {
    setEditingId(null); setDraftTitle(''); setDraftBody(''); setFormOpen(true)
  }
  const openEdit = (p: PromptPreset) => {
    setEditingId(p.id); setDraftTitle(p.title); setDraftBody(p.body); setFormOpen(true)
  }
  const cancelForm = () => { setFormOpen(false); setEditingId(null); setDraftTitle(''); setDraftBody('') }
  const save = () => {
    const t = draftTitle.trim(), b = draftBody.trim()
    if (!t || !b) return
    if (editingId) onEdit(editingId, { title: t, body: b })
    else onAdd(t, b)
    cancelForm()
  }

  return (
    <div className="p-2 flex flex-col gap-2">
      {error && <div className="text-[10px] text-[var(--accent-red)]">{error}</div>}

      {!formOpen && (
        <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
          {presets.length === 0 && (
            <div className="text-[10px] text-[var(--text-muted)] px-1 py-2">还没有常用 prompt，点下面新建。</div>
          )}
          {presets.map(p => (
            <div key={p.id} className="flex items-center gap-1 rounded px-2 py-1 hover:bg-[var(--bg-secondary)]">
              <span className="flex-1 truncate text-xs text-[var(--text-primary)]" title={p.body}>{p.title}</span>
              <button onClick={() => openEdit(p)} aria-label="edit"
                className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><Pencil size={12} /></button>
              <button onClick={() => onRemove(p.id)} aria-label="delete"
                className="p-1 text-[var(--text-muted)] hover:text-[var(--accent-red)]"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}

      {formOpen ? (
        <div className="flex flex-col gap-2">
          <input value={draftTitle} onChange={e => setDraftTitle(e.target.value)}
            placeholder="标题，如「审查 PR」" autoFocus className={inputCls} />
          <textarea value={draftBody} onChange={e => setDraftBody(e.target.value)}
            placeholder="prompt 全文" className={`${inputCls} h-24 resize-none`} />
          <div className="flex justify-end gap-2">
            <button onClick={cancelForm}
              className="px-2 py-1 text-[10px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)]">取消</button>
            <button onClick={save} disabled={!draftTitle.trim() || !draftBody.trim()}
              className="px-3 py-1 text-[10px] font-semibold bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] disabled:opacity-40 text-white rounded">保存</button>
          </div>
        </div>
      ) : (
        <div className="flex justify-between">
          <button onClick={openNew}
            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-[var(--accent-blue)] hover:opacity-80">
            <Plus size={12} /> 新建
          </button>
          <button onClick={onClose} aria-label="close manager"
            className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"><X size={12} /></button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify it builds (typecheck)**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: no type errors. (Component is unused until Tasks 7–8 import it; tsc on an exported-but-unused component is fine.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PromptManager.tsx
git commit -m "feat(fe): shared PromptManager add/edit/delete UI"
```

---

## Task 7: Frontend — Sidebar pick-prompt chips + manage substep

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx`

- [ ] **Step 1: Add imports + hook + state**

At the top imports, add `PromptManager` and the hook (match existing import style):

```tsx
import PromptManager from './PromptManager'
import { usePromptPresets } from '../lib/usePromptPresets'
```

Extend the step union type (line 48):

```tsx
type NewSessionStep = 'closed' | 'pick-type' | 'pick-terminal-mode' | 'pick-dir' | 'pick-tmux' | 'pick-prompt' | 'manage-prompts'
```

Inside the component (after line 67, near `pendingDir`), add the hook. **Note `editingId` already exists at line 71 for session rename — do NOT reuse it;** the manager owns its own edit state internally, so no new edit state is needed here:

```tsx
  const presetStore = usePromptPresets()
```

- [ ] **Step 2: Load presets when entering pick-prompt**

Modify `selectDir` (line 170–180) — reload presets when an agent lands on pick-prompt:

```tsx
  const selectDir = (path: string) => {
    if (!pendingType) { setStep('closed'); return }
    if (pendingType === 'tmux') {
      onCreate('tmux', path)
      setStep('closed')
    } else {
      setPendingDir(path)
      setPromptDraft('')
      presetStore.reload()
      setStep('pick-prompt')
    }
  }
```

- [ ] **Step 3: Render chips row in the `pick-prompt` step**

In the `step === 'pick-prompt'` block, inside the `<div className="p-2 flex flex-col gap-2">` (after line 634), **before** the `<textarea>`, insert a chips row:

```tsx
                    {/* Always render the row so "✎ 管理" is reachable even with 0 presets / load failure. */}
                    <div className="flex flex-wrap items-center gap-1">
                      {presetStore.presets.map(p => (
                          <button
                            key={p.id}
                            onClick={() => setPromptDraft(p.body)}
                            title={p.body}
                            className="px-2 py-0.5 text-[10px] rounded-full bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-blue)] transition-colors truncate max-w-[120px]"
                          >
                            {p.title}
                          </button>
                        ))}
                      <button
                        onClick={() => setStep('manage-prompts')}
                        className="px-2 py-0.5 text-[10px] rounded-full text-[var(--accent-blue)] hover:opacity-80"
                      >
                        ✎ 管理
                      </button>
                    </div>
```

> Chip click sets `promptDraft` (whole-replace, per spec decision 8). The existing empty/non-empty button toggle below reacts automatically. The `|| true` keeps the "✎ 管理" entry visible even with zero presets / load failure.

- [ ] **Step 4: Render the `manage-prompts` step**

After the entire `step === 'pick-prompt'` block (after its closing `)}` ~line 673), add:

```tsx
              {step === 'manage-prompts' && (
                <>
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
                    <button
                      onClick={() => setStep('pick-prompt')}
                      className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
                      title="Back"
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">管理常用 prompt</span>
                  </div>
                  <PromptManager
                    presets={presetStore.presets}
                    error={presetStore.error}
                    onAdd={presetStore.add}
                    onEdit={presetStore.edit}
                    onRemove={presetStore.remove}
                    onClose={() => setStep('pick-prompt')}
                  />
                </>
              )}
```

(`ChevronLeft` is already imported — it's used in the pick-prompt back button at line 630.)

- [ ] **Step 5: Reset on close**

The `close()` fn (line 182) already resets `promptDraft`/`pendingDir`. The manager's edit state is internal to `<PromptManager>` and unmounts when leaving `manage-prompts`, so no extra reset is needed. **Verify** `close()` sets `setStep('closed')` (it does, line 183) — leaving `manage-prompts` via close unmounts the manager, clearing its draft. No change required; this step is a confirmation check.

- [ ] **Step 6: Typecheck + lint**

Run: `cd frontend && npx tsc -b --noEmit && npm run lint`
Expected: no new errors. (Pre-existing lint errors unrelated to these files are acceptable — note them, don't fix.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/Sidebar.tsx
git commit -m "feat(fe): pick-prompt chips + manage-prompts substep (shared PromptManager)"
```

---

## Task 8: Frontend — Composer presets popover in AcpChatView

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx`

- [ ] **Step 1: Add imports + hook + popover state**

Add to imports (match existing lucide import on line with `Paperclip, FileText`):

```tsx
import { ListPlus } from 'lucide-react'
import PromptManager from './PromptManager'
import { usePromptPresets } from '../lib/usePromptPresets'
```

Inside the component, near the existing `const [input, setInput] = useState('')` (line 69), add:

```tsx
  const presetStore = usePromptPresets()
  const [presetOpen, setPresetOpen] = useState(false)
  const [presetManaging, setPresetManaging] = useState(false)
```

- [ ] **Step 2: Add the presets button to the Composer `rightSlot`**

In the `rightSlot` button cluster (line 418, inside `<div className="flex items-end gap-1">`), add as the FIRST button (before the image button):

```tsx
              <button
                onClick={() => {
                  setPresetManaging(false)
                  setPresetOpen(o => { if (!o) presetStore.reload(); return !o })
                }}
                aria-label="prompt presets"
                className="self-end p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg transition-colors"
                title="常用 prompt"
              >
                <ListPlus size={16} />
              </button>
```

- [ ] **Step 3: Add the anchored popover above the Composer**

Find the Composer wrapper. The Composer is rendered inside a container div (the input area near line 411). Wrap the input region so the popover can anchor above it. Add this popover block **immediately before** the `<Composer ... />` element (line 411), as a sibling, inside a `relative` parent:

First ensure the Composer's parent div is `relative` (the `<div>` that contains the `<input type="file">` hidden inputs + `<Composer>`, around line 406–411). If it's not already positioned, add `relative` to its className.

Then insert before `<Composer`:

```tsx
        {presetOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-2 mx-2 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] shadow-lg z-20">
            {presetManaging ? (
              <PromptManager
                presets={presetStore.presets}
                error={presetStore.error}
                onAdd={presetStore.add}
                onEdit={presetStore.edit}
                onRemove={presetStore.remove}
                onClose={() => setPresetManaging(false)}
              />
            ) : (
              <div className="p-2 flex flex-col gap-2">
                <div className="flex flex-wrap gap-1">
                  {presetStore.presets.length === 0 && (
                    <span className="text-[10px] text-[var(--text-muted)] px-1 py-1">还没有常用 prompt</span>
                  )}
                  {presetStore.presets.map(p => (
                    <button
                      key={p.id}
                      onClick={() => { setInput(p.body); setPresetOpen(false) }}
                      title={p.body}
                      className="px-2 py-0.5 text-[10px] rounded-full bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-blue)] transition-colors truncate max-w-[160px]"
                    >
                      {p.title}
                    </button>
                  ))}
                </div>
                <div className="flex justify-between">
                  <button
                    onClick={() => setPresetManaging(true)}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold text-[var(--accent-blue)] hover:opacity-80"
                  >
                    ✎ 管理
                  </button>
                  <button
                    onClick={() => setPresetOpen(false)}
                    className="px-2 py-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    关闭
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
```

> Picking a chip does `setInput(p.body)` (whole-replace) + closes the popover. Management reuses the same `<PromptManager>` as Sidebar. The popover anchors above the input via `absolute bottom-full` on a `relative` parent — no layout reflow of the chat transcript.

- [ ] **Step 4: Typecheck + lint**

Run: `cd frontend && npx tsc -b --noEmit && npm run lint`
Expected: no new errors. If the Composer's parent isn't `relative`, the popover will mis-anchor — verify the `relative` class landed on the correct wrapping div (the one directly containing `<Composer>`).

- [ ] **Step 5: Build the frontend (required before any backend run)**

Run: `cd frontend && npm run build`
Expected: `tsc -b && vite build` succeeds → `frontend/dist/` regenerated (rust-embed reads it).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "feat(fe): Composer prompt-presets popover (chips + inline manage)"
```

---

## Task 9: Full verification

- [ ] **Step 1: Backend tests + check**

Run: `cargo test prompts:: && cargo check`
Expected: 8 prompts tests pass; clean compile.

- [ ] **Step 2: Frontend tests + build**

Run: `cd frontend && npx vitest run src/lib/__tests__/prompts.test.ts src/lib/__tests__/usePromptPresets.test.ts && npm run build`
Expected: all pass; build succeeds.

- [ ] **Step 3: Manual acceptance (debug binary)**

Run: `cargo build && ./target/debug/zeromux --port 8099 --password test` then in a browser at `localhost:8099`:
- Create a claude session → at pick-prompt, click "✎ 管理" → add presets ("审查 PR" / "写单测"). Back → chips appear.
- Click a chip → textarea fills with its body; edit → Create & send → agent receives the edited text (no verdict line).
- Open the session → Composer → click the presets (ListPlus) button → popover shows chips → click one → message box fills → edit → send works.
- Manage from Composer popover (edit a title) → reopen Sidebar pick-prompt → updated title shows (shared store).
- Empty prompt at pick-prompt → still shows single [Create] (startup-prompt behavior intact).
- A tmux session → no pick-prompt step at all.
- A terminal/PTY Composer (if reachable) → NO presets button.

- [ ] **Step 4: Final commit (if any acceptance fixups)**

```bash
git add -A
git commit -m "test(prompts): verification fixups"   # only if changes were needed
```

---

## Notes for the implementer

- **Build order matters:** the Rust binary embeds `frontend/dist/` at compile time. Run `cd frontend && npm run build` before any `cargo build` that you intend to run/serve. Task 8 Step 5 covers this.
- **Iterate with `cargo check` / `cargo build` (debug)**, never `--release` (size-optimized, slow).
- **Do NOT touch `TerminalView.tsx`** — presets are agent instructions only (spec decision 9).
- **`AcpChatView.tsx` line numbers are approximate** — anchor on the `rightSlot={...}` block (the image/file/mic button cluster) and the `<Composer value={input} onChange={setInput} ...>` element, both verified present.
- **Don't add `owner_id`, a `kind` column, drag-reorder, or scheduled-task integration** — all explicitly deferred (spec YAGNI + 未来工作).
- **Never log preset `body`** in any backend/frontend error path (may contain secrets).
