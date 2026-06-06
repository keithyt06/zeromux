# Scheduled Tasks (Unattended Agent Runs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user schedule an unattended Claude Code run (e.g. "every weekday 09:00 Beijing, review this repo"); at fire time the server creates a Claude session, injects the goal, runs it to completion, and surfaces a one-line verdict.

**Architecture:** A single in-process tokio tick loop (single-binary app, no multi-instance) reads enabled task configs from SQLite each minute, evaluates cron in `Asia/Shanghai`, and triggers via the existing broadcast fan-out (`create_acp_session` + `SessionInput::Prompt`). Every run is tracked in an `agent_task_runs` table keyed by `scheduled_for_ms` with a UNIQUE constraint for dedup. A `run_id` threads through the prompt so the fan-out finalizes exactly the scheduled turn, mapping `Result`→succeeded, `Error`/abnormal `Exit`→failed. Scheduler core logic is pure functions with injected time for fake-clock tests.

**Tech Stack:** Rust/Axum, rusqlite (bundled), tokio, new deps `cron` + `chrono` + `chrono-tz`; React 19 + Vite + Tailwind, lucide `Clock` icon.

**Phasing:** v1 skeleton (Tasks 0–11) = can schedule + run + track reliably. v1.1 (Tasks 12–14) = verdict extraction + retention. Brand-logo cleanup is Task 15 (independent).

**Source of truth:** `docs/superpowers/specs/2026-06-06-scheduled-tasks-design.md`.

---

## Task 0: Spike — verify Claude CLI runs unattended (HARD GATE)

Nothing else matters if `claude -p` blocks on a permission/login prompt with no human watching. This task is verification only — no production code. **If it fails, stop and revisit the whole feature.**

**Files:** none (manual spike + notes appended to the spec's §0).

- [ ] **Step 1: Run Claude headless against a real repo, no TTY**

Run (from repo root, redirect stdin from /dev/null so there is no interactive terminal):

```bash
cd /home/ubuntu/s3-workspace/keith-space/github-search/ai/zeromux
printf '%s' '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"List the top-level files in this repo, then output exactly one final line: <<<VERDICT>>>ok<<<END>>>"}]}}' \
  | claude -p --output-format stream-json --input-format stream-json --verbose < /dev/null 2>&1 | tail -40
```

Expected: a stream of JSON events ending in a `result`-type event whose text contains `<<<VERDICT>>>ok<<<END>>>`. No hang waiting for a `y/n` permission prompt.

- [ ] **Step 2: Check tool-permission behavior**

If Step 1 hung or asked for permission to run a tool, find the non-interactive/trust flag (e.g. a `--permission-mode` / `--dangerously-skip-permissions` style flag) and re-run until it completes unattended. Record the exact working invocation.

- [ ] **Step 3: Verify prompt sent immediately after spawn is not dropped**

Confirm the single-shot invocation above (prompt delivered on stdin right after process start) produced output. This is the real-world check that replaces `wait_until_ready`. If early stdin is dropped, note it — Task 7 would then need a readiness wait.

- [ ] **Step 4: Record findings in the spec**

Append a short "§0 spike result" note to `docs/superpowers/specs/2026-06-06-scheduled-tasks-design.md`: the exact working `claude` invocation/flags, and whether early-stdin delivery is safe. Commit:

```bash
git add docs/superpowers/specs/2026-06-06-scheduled-tasks-design.md
git commit -m "docs(spec): record unattended-claude spike result"
```

---

## File Structure (v1)

- Create `src/scheduled_tasks.rs` — both tables (`agent_runs_config`, `agent_task_runs`), all DB ops, and the pure scheduler functions (`due_fire_points`, `should_skip_overlap`, `extract_verdict`, `is_safe_to_reclaim`). Mirrors `events.rs` (`Mutex<Connection>`).
- Modify `src/session_manager.rs` — `SessionInput::Prompt` → struct variant with `run_id`; fan-out finalizes the run; `source_task_id` on `Session`; helper to look up live runs.
- Modify `src/session_store.rs` — `source_task_id` column (ALTER TABLE) + struct field.
- Modify `src/main.rs` — open the store, startup reconcile, spawn the supervised scheduler loop.
- Modify `src/web.rs` — task CRUD + `/run` + `/runs` + `/scheduler/health` endpoints.
- Modify `src/acp/process.rs` (only if `send_prompt` signature needs the new variant — likely unchanged, it takes `&str`).
- Create `frontend/src/components/ScheduledTasksPanel.tsx` — overlay panel.
- Modify `frontend/src/lib/api.ts`, `frontend/src/App.tsx` (Clock entry + health poll), `frontend/src/components/Sidebar.tsx` (clock badge).

---

## Task 1: Add dependencies

**Files:** Modify `Cargo.toml`

- [ ] **Step 1: Add cron + chrono-tz**

Add under `[dependencies]` in `Cargo.toml`:

```toml
cron = "0.12"
chrono = "0.4"
chrono-tz = "0.9"
```

- [ ] **Step 2: Verify it builds**

Run: `cargo build`
Expected: compiles (slow first time as deps fetch). If `cron` 0.12 API differs, note the actual `Schedule::from_str` / `.after()` API for Task 3.

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "build: add cron, chrono, chrono-tz for scheduled tasks"
```

---

## Task 2: Pure function — `due_fire_points` (fake-clock testable)

The heart of correctness: given a cron spec, the last time we looked, and now, return the fire points that came due, evaluated in `Asia/Shanghai`. Pure — no `Utc::now()`, no DB.

**Files:**
- Create: `src/scheduled_tasks.rs`
- Test: inline `#[cfg(test)]` in the same file

- [ ] **Step 1: Write the failing test**

Create `src/scheduled_tasks.rs` with:

```rust
use chrono::{DateTime, Utc};
use chrono_tz::Asia::Shanghai;
use std::str::FromStr;

/// Return scheduled fire points in (last_seen, now], evaluated in Asia/Shanghai,
/// oldest→newest. Caller uses `.last()` to fire only the most recent (no backfill).
/// Pure: time is injected, never read from the clock.
pub fn due_fire_points(
    cron_spec: &str,
    last_seen: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<Vec<DateTime<Utc>>, String> {
    let schedule = cron::Schedule::from_str(cron_spec)
        .map_err(|e| format!("bad cron '{}': {}", cron_spec, e))?;
    let after = last_seen.with_timezone(&Shanghai);
    let mut out = Vec::new();
    for t in schedule.after(&after) {
        let t_utc = t.with_timezone(&Utc);
        if t_utc > now {
            break;
        }
        out.push(t_utc);
        if out.len() > 1000 {
            break; // safety bound against pathological specs
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    // 09:00 Asia/Shanghai == 01:00 UTC. cron crate uses 6 fields (with seconds).
    const DAILY_0900_CST: &str = "0 0 1 * * *"; // sec min hour(UTC) ... -> 01:00 UTC
    // NOTE: confirm whether cron evaluates the spec in the tz of `after`.
    // We pass an Asia/Shanghai datetime to `.after()`, so write the spec in
    // Shanghai local time and rely on tz-aware iteration:
    const DAILY_0900_LOCAL: &str = "0 0 9 * * *"; // 09:00 in the after-tz (Shanghai)

    #[test]
    fn fires_once_for_daily_at_0900_shanghai() {
        // last_seen 08:59 CST (00:59 UTC), now 09:01 CST (01:01 UTC)
        let last = Utc.with_ymd_and_hms(2026, 6, 6, 0, 59, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 1, 1, 0).unwrap();
        let fires = due_fire_points(DAILY_0900_LOCAL, last, now).unwrap();
        assert_eq!(fires.len(), 1, "exactly one 09:00 fire in the window");
        // The fire point is 01:00 UTC (= 09:00 Shanghai), proving no 8h skew.
        assert_eq!(fires[0], Utc.with_ymd_and_hms(2026, 6, 6, 1, 0, 0).unwrap());
    }

    #[test]
    fn empty_when_no_fire_in_window() {
        let last = Utc.with_ymd_and_hms(2026, 6, 6, 2, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 3, 0, 0).unwrap();
        assert!(due_fire_points(DAILY_0900_LOCAL, last, now).unwrap().is_empty());
    }

    #[test]
    fn multiple_due_points_when_loop_stalled() {
        // hourly; window spans 3 hours -> 3 due points, caller takes last.
        let hourly = "0 0 * * * *";
        let last = Utc.with_ymd_and_hms(2026, 6, 6, 0, 30, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 3, 30, 0).unwrap();
        let fires = due_fire_points(hourly, last, now).unwrap();
        assert_eq!(fires.len(), 3);
    }

    #[test]
    fn bad_cron_is_error_not_panic() {
        let now = Utc.with_ymd_and_hms(2026, 6, 6, 1, 1, 0).unwrap();
        assert!(due_fire_points("not a cron", now, now).is_err());
    }
}
```

- [ ] **Step 2: Wire the module + run tests to verify they fail/compile**

Add `mod scheduled_tasks;` to `src/main.rs` (near the other `mod` lines). Run:

`cargo test scheduled_tasks::tests`
Expected: tests run. The tz semantics test (`fires_once_for_daily_at_0900_shanghai`) is the one to watch — if `cron`'s `.after()` ignores the tz of the passed datetime and evaluates in UTC, the assertion will fail and you must adjust the spec to UTC hour `1` and document that conversion happens at store time. **Resolve this before moving on — it is the 8-hour-skew guard.**

- [ ] **Step 3: Make tz handling correct**

If Step 2 revealed `cron` evaluates in the datetime's own tz (Shanghai), keep `DAILY_0900_LOCAL`. If it forces UTC, change the approach: store specs in UTC and have Task 9 convert Beijing HH:MM → UTC cron, and update tests accordingly. Pick one, make all four tests green.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test scheduled_tasks::tests`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/scheduled_tasks.rs src/main.rs
git commit -m "feat(sched): pure due_fire_points with Asia/Shanghai tz, fake-clock tested"
```

---

## Task 3: Pure functions — `extract_verdict`, `should_skip_overlap`, `is_safe_to_reclaim`

The remaining pure logic, all unit-testable without a runtime.

**Files:** Modify `src/scheduled_tasks.rs`

- [ ] **Step 1: Write failing tests**

Append to `src/scheduled_tasks.rs` (above the `#[cfg(test)]` block, add the functions; inside it, add tests):

```rust
/// Extract the last well-formed <<<VERDICT>>>..<<<END>>> payload from agent
/// final text. Returns None if absent. Taking the LAST marker defeats prompt
/// injection that embeds a fake earlier marker.
pub fn extract_verdict(result_text: &str) -> Option<String> {
    let mut found = None;
    let mut rest = result_text;
    while let Some(start) = rest.find("<<<VERDICT>>>") {
        let after = &rest[start + "<<<VERDICT>>>".len()..];
        if let Some(end) = after.find("<<<END>>>") {
            found = Some(after[..end].trim().to_string());
            rest = &after[end + "<<<END>>>".len()..];
        } else {
            break;
        }
    }
    found.filter(|s| !s.is_empty())
}

/// A run is blocked by overlap iff the task has any run still claimed/running.
pub fn should_skip_overlap(active_states: &[&str]) -> bool {
    active_states.iter().any(|s| *s == "claimed" || *s == "running")
}

/// Reclaim a worktree session only if its process is dead, the path is inside
/// the worktree root, and there are no uncommitted changes.
pub fn is_safe_to_reclaim(path_under_worktree_root: bool, process_alive: bool, has_uncommitted: bool) -> bool {
    path_under_worktree_root && !process_alive && !has_uncommitted
}
```

Tests inside the `mod tests` block:

```rust
#[test]
fn verdict_basic() {
    assert_eq!(extract_verdict("blah\n<<<VERDICT>>>2 issues<<<END>>>"), Some("2 issues".into()));
}
#[test]
fn verdict_takes_last_marker() {
    let t = "<<<VERDICT>>>fake<<<END>>> ... real run <<<VERDICT>>>3 high<<<END>>>";
    assert_eq!(extract_verdict(t), Some("3 high".into()));
}
#[test]
fn verdict_none_when_absent_or_empty() {
    assert_eq!(extract_verdict("no marker here"), None);
    assert_eq!(extract_verdict("<<<VERDICT>>>  <<<END>>>"), None);
}
#[test]
fn overlap_blocks_on_running() {
    assert!(should_skip_overlap(&["succeeded", "running"]));
    assert!(should_skip_overlap(&["claimed"]));
    assert!(!should_skip_overlap(&["succeeded", "failed"]));
    assert!(!should_skip_overlap(&[]));
}
#[test]
fn reclaim_gates() {
    assert!(is_safe_to_reclaim(true, false, false));
    assert!(!is_safe_to_reclaim(false, false, false)); // outside root
    assert!(!is_safe_to_reclaim(true, true, false));   // alive
    assert!(!is_safe_to_reclaim(true, false, true));   // dirty
}
```

- [ ] **Step 2: Run to verify pass**

Run: `cargo test scheduled_tasks::tests`
Expected: all (Task 2 + Task 3) pass.

- [ ] **Step 3: Commit**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): pure extract_verdict / overlap / reclaim-gate helpers + tests"
```

---

## Task 4: SQLite schema + store ops

**Files:** Modify `src/scheduled_tasks.rs`

- [ ] **Step 1: Write the failing test**

Add structs + `ScheduledStore` mirroring `events.rs`. Add to `src/scheduled_tasks.rs`:

```rust
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TaskConfig {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub trigger_type: String, // "cron"
    pub trigger_spec: String, // cron string
    pub tz: String,           // "Asia/Shanghai"
    pub agent_type: String,   // "claude"
    pub work_dir: String,
    pub prompt: String,
    pub enabled: bool,
    pub retention_n: i64,
    pub created_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub scheduled_for_ms: i64,
    pub state: String, // claimed|running|succeeded|failed|skipped|aborted
    pub session_id: Option<String>,
    pub verdict: Option<String>,
    pub failure_kind: Option<String>,
    pub started_ms: Option<i64>,
    pub ended_ms: Option<i64>,
}

pub struct ScheduledStore { conn: Mutex<Connection> }

impl ScheduledStore {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        let conn = Connection::open(data_dir.join("scheduled.db")).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_runs_config (
                id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
                trigger_type TEXT NOT NULL, trigger_spec TEXT NOT NULL, tz TEXT NOT NULL,
                agent_type TEXT NOT NULL, work_dir TEXT NOT NULL, prompt TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1, retention_n INTEGER NOT NULL DEFAULT 20,
                created_ms INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS agent_task_runs (
                id TEXT PRIMARY KEY, task_id TEXT NOT NULL, scheduled_for_ms INTEGER NOT NULL,
                state TEXT NOT NULL, session_id TEXT, verdict TEXT, failure_kind TEXT,
                started_ms INTEGER, ended_ms INTEGER,
                UNIQUE(task_id, scheduled_for_ms));
            CREATE INDEX IF NOT EXISTS idx_runs_task_state ON agent_task_runs(task_id, state);",
        ).map_err(|e| e.to_string())?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn upsert_config(&self, c: &TaskConfig) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO agent_runs_config
             (id,owner_id,name,trigger_type,trigger_spec,tz,agent_type,work_dir,prompt,enabled,retention_n,created_ms)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(id) DO UPDATE SET name=?3,trigger_spec=?5,work_dir=?8,prompt=?9,enabled=?10,retention_n=?11",
            params![c.id,c.owner_id,c.name,c.trigger_type,c.trigger_spec,c.tz,c.agent_type,
                    c.work_dir,c.prompt,c.enabled as i64,c.retention_n,c.created_ms],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_enabled(&self) -> Result<Vec<TaskConfig>, String> {
        self.query_configs("WHERE enabled=1", params![])
    }
    pub fn list_for_owner(&self, owner: &str) -> Result<Vec<TaskConfig>, String> {
        self.query_configs("WHERE owner_id=?1", params![owner])
    }
    fn query_configs(&self, where_clause: &str, p: impl rusqlite::Params) -> Result<Vec<TaskConfig>, String> {
        let conn = self.conn.lock().unwrap();
        let sql = format!("SELECT id,owner_id,name,trigger_type,trigger_spec,tz,agent_type,work_dir,prompt,enabled,retention_n,created_ms FROM agent_runs_config {}", where_clause);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(p, |r| Ok(TaskConfig {
            id: r.get(0)?, owner_id: r.get(1)?, name: r.get(2)?, trigger_type: r.get(3)?,
            trigger_spec: r.get(4)?, tz: r.get(5)?, agent_type: r.get(6)?, work_dir: r.get(7)?,
            prompt: r.get(8)?, enabled: r.get::<_, i64>(9)? != 0, retention_n: r.get(10)?, created_ms: r.get(11)?,
        })).map_err(|e| e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e| e.to_string())
    }

    pub fn get_config(&self, id: &str) -> Result<Option<TaskConfig>, String> {
        Ok(self.query_configs("WHERE id=?1", params![id])?.into_iter().next())
    }
    pub fn delete_config(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM agent_runs_config WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Atomic claim: INSERT OR IGNORE. Returns true iff this caller inserted
    /// (i.e. won the scheduled_for slot). Side effects happen only after this.
    pub fn claim_run(&self, run: &TaskRun) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "INSERT OR IGNORE INTO agent_task_runs
             (id,task_id,scheduled_for_ms,state,started_ms) VALUES (?1,?2,?3,'claimed',?4)",
            params![run.id, run.task_id, run.scheduled_for_ms, run.started_ms],
        ).map_err(|e| e.to_string())?;
        Ok(n == 1)
    }

    pub fn set_run_state(&self, run_id: &str, state: &str, session_id: Option<&str>,
                         verdict: Option<&str>, failure_kind: Option<&str>, ended_ms: Option<i64>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE agent_task_runs SET state=?2, session_id=COALESCE(?3,session_id),
             verdict=COALESCE(?4,verdict), failure_kind=COALESCE(?5,failure_kind),
             ended_ms=COALESCE(?6,ended_ms) WHERE id=?1",
            params![run_id, state, session_id, verdict, failure_kind, ended_ms],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn active_states_for_task(&self, task_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT state FROM agent_task_runs WHERE task_id=?1 AND state IN ('claimed','running')").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![task_id], |r| r.get::<_,String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e| e.to_string())
    }

    /// Startup + watchdog: mark all claimed/running as aborted (optionally only
    /// those older than `cutoff_ms` for the timeout watchdog; pass None at startup).
    pub fn reconcile_orphans(&self, cutoff_ms: Option<i64>) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap();
        let n = match cutoff_ms {
            None => conn.execute("UPDATE agent_task_runs SET state='aborted' WHERE state IN ('claimed','running')", params![]),
            Some(c) => conn.execute("UPDATE agent_task_runs SET state='aborted' WHERE state IN ('claimed','running') AND started_ms < ?1", params![c]),
        }.map_err(|e| e.to_string())?;
        Ok(n)
    }

    pub fn runs_for_task(&self, task_id: &str, limit: i64) -> Result<Vec<TaskRun>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id,task_id,scheduled_for_ms,state,session_id,verdict,failure_kind,started_ms,ended_ms FROM agent_task_runs WHERE task_id=?1 ORDER BY scheduled_for_ms DESC LIMIT ?2").map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![task_id, limit], |r| Ok(TaskRun {
            id: r.get(0)?, task_id: r.get(1)?, scheduled_for_ms: r.get(2)?, state: r.get(3)?,
            session_id: r.get(4)?, verdict: r.get(5)?, failure_kind: r.get(6)?, started_ms: r.get(7)?, ended_ms: r.get(8)?,
        })).map_err(|e| e.to_string())?;
        rows.collect::<Result<_,_>>().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod store_tests {
    use super::*;
    fn store() -> ScheduledStore { ScheduledStore::open(tempfile::tempdir().unwrap().path()).unwrap() }

    #[test]
    fn claim_is_unique_per_scheduled_for() {
        let s = store();
        let run = TaskRun { id: "r1".into(), task_id: "t1".into(), scheduled_for_ms: 1000,
            state: "claimed".into(), session_id: None, verdict: None, failure_kind: None, started_ms: Some(1), ended_ms: None };
        assert!(s.claim_run(&run).unwrap(), "first claim wins");
        let dup = TaskRun { id: "r2".into(), ..run.clone() };
        assert!(!s.claim_run(&dup).unwrap(), "same scheduled_for second claim ignored");
    }

    #[test]
    fn reconcile_marks_orphans_aborted() {
        let s = store();
        s.claim_run(&TaskRun { id:"r1".into(),task_id:"t1".into(),scheduled_for_ms:1,state:"claimed".into(),session_id:None,verdict:None,failure_kind:None,started_ms:Some(1),ended_ms:None }).unwrap();
        assert_eq!(s.reconcile_orphans(None).unwrap(), 1);
        assert!(s.active_states_for_task("t1").unwrap().is_empty());
    }
}
```

- [ ] **Step 2: Run tests to verify pass**

Run: `cargo test scheduled_tasks::store_tests`
Expected: 2 passed. (`tempfile` is already a dev-dependency.)

- [ ] **Step 3: Commit**

```bash
git add src/scheduled_tasks.rs
git commit -m "feat(sched): agent_runs_config + agent_task_runs schema, claim/reconcile ops + tests"
```

---

## Task 5: Add `source_task_id` to session metadata

**Files:** Modify `src/session_store.rs`, `src/session_manager.rs`

- [ ] **Step 1: Migrate the table + struct (session_store.rs)**

In `SessionStore::open`'s table setup, add the column to the persisted-sessions schema, then add a best-effort migration right after (mirroring the `events.rs` owner_id ALTER pattern):

```rust
let _ = conn.execute("ALTER TABLE sessions ADD COLUMN source_task_id TEXT", []);
```

Add `pub source_task_id: Option<String>,` to the `PersistedSession` struct, include it in the `INSERT ... ON CONFLICT` (`upsert`) column list and params, and read it in `load_all` (default `None` for legacy rows).

- [ ] **Step 2: Thread through Session (session_manager.rs)**

Add `source_task_id: Option<String>` to the `Session` struct. In every `Session { .. }` literal (there are 4 — tmux/claude/kiro/codex create paths, plus the load-persisted path), set it: default `None`. Include it when building `PersistedSession` in `persist_meta`, and surface it in `SessionInfo` (the list API DTO) so the frontend can read it.

- [ ] **Step 3: Build**

Run: `cargo build`
Expected: compiles. Fix any missing-field errors in `Session`/`PersistedSession` literals.

- [ ] **Step 4: Commit**

```bash
git add src/session_store.rs src/session_manager.rs
git commit -m "feat(sched): add source_task_id to session metadata (manual=None)"
```

---

## Task 6: Change `SessionInput::Prompt` to carry `run_id`

This is the core enabler of exactly-once run finalization. Touches all four fan-outs.

**Files:** Modify `src/session_manager.rs` (+ anywhere that constructs `SessionInput::Prompt`: `src/acp/ws_handler.rs`, `src/ws_handler.rs`)

- [ ] **Step 1: Change the enum**

In `src/session_manager.rs`, change variant at line ~116:

```rust
    /// ACP/Kiro: prompt text + optional scheduled-run id for finalization.
    Prompt { text: String, run_id: Option<String> },
```

- [ ] **Step 2: Fix all construction sites**

Find every `SessionInput::Prompt(` constructor:

Run: `grep -rn "SessionInput::Prompt(" src/`

For each WS-handler send (manual user prompts in `src/acp/ws_handler.rs` and `src/ws_handler.rs`), change to:

```rust
SessionInput::Prompt { text, run_id: None }
```

- [ ] **Step 3: Fix all match arms**

Run: `grep -rn "SessionInput::Prompt(text)" src/`
The three agent fan-outs match `Some(SessionInput::Prompt(text))`. Change each to `Some(SessionInput::Prompt { text, run_id })`. In the tmux/kiro/codex fan-outs that ignore run_id, use `Some(SessionInput::Prompt { text, run_id: _ })`. In the **claude** fan-out (`spawn_acp_fanout`), bind `run_id` and store it (next task uses it).

- [ ] **Step 4: Build**

Run: `cargo build`
Expected: compiles after all arms/sites updated.

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs src/acp/ws_handler.rs src/ws_handler.rs
git commit -m "feat(sched): SessionInput::Prompt carries optional run_id (manual=None)"
```

---

## Task 7: Fan-out finalizes the scheduled run (exactly once, event-specific)

**Files:** Modify `src/session_manager.rs` (the `spawn_acp_fanout` function, ~line 1344-1402)

- [ ] **Step 1: Hold active_run_id and a finalize callback**

In `spawn_acp_fanout`, add a local `let mut active_run_id: Option<String> = None;` before the `select!` loop. On the input arm for `Prompt { text, run_id }`: set `active_run_id = run_id.clone();` (in addition to the existing interrupt/turn_seq logic), then send the prompt.

- [ ] **Step 2: Finalize on boundary events, by event type**

In the output arm, where `is_boundary` is computed (matching `Result/Error/Exit`), add — after the existing `event_tx.send`/`mark_turn` logic — finalization keyed on `active_run_id`:

```rust
if let Some(rid) = active_run_id.take() {
    if let Some(m) = mgr.upgrade() {
        match &evt {
            AcpEvent::Result { text, .. } => {
                let verdict = crate::scheduled_tasks::extract_verdict(text);
                m.finalize_run(&rid, "succeeded", verdict.as_deref(),
                    if verdict.is_some() { None } else { Some("no_verdict") });
            }
            AcpEvent::Error { .. } => m.finalize_run(&rid, "failed", None, Some("cli_error")),
            AcpEvent::Exit { .. } => m.finalize_run(&rid, "failed", None, Some("cli_exited")),
            _ => { active_run_id = Some(rid); } // not a finalizing event, keep waiting
        }
    }
}
```

Note: `Result`-then-`Exit` is naturally handled — `active_run_id` is already taken/cleared by the `Result`, so the later `Exit` finds `None` and is ignored.

- [ ] **Step 3: Add `finalize_run` on SessionManager**

Add a method on `SessionManager` that writes through to the store (the manager already holds `events`; give it an `Arc<ScheduledStore>` too — add the field in Task 8's wiring, but declare the method now):

```rust
pub fn finalize_run(&self, run_id: &str, state: &str, verdict: Option<&str>, failure_kind: Option<&str>) {
    if let Some(store) = &self.scheduled {
        let ended = now_millis();
        if let Err(e) = store.set_run_state(run_id, state, None, verdict, failure_kind, Some(ended)) {
            tracing::warn!("finalize_run {} failed: {}", run_id, e);
        }
    }
}
```

- [ ] **Step 4: Build (will fail until Task 8 adds the field)**

Run: `cargo build`
Expected: error about missing `self.scheduled` field — that's fine, Task 8 adds it. If you want green here, add `pub scheduled: Option<Arc<crate::scheduled_tasks::ScheduledStore>>,` to `SessionManager` now and default it in `SessionManager::new`.

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(sched): fan-out finalizes scheduled run by event type (Result/Error/Exit)"
```

---

## Task 8: Trigger + scheduler tick loop + supervision + watchdog

**Files:** Modify `src/scheduled_tasks.rs` (trigger + loop), `src/session_manager.rs` (`scheduled` field + a `trigger_run` helper), `src/main.rs` (wiring)

- [ ] **Step 1: Add the scheduled store to AppState + SessionManager**

In `src/main.rs`: open the store next to `event_store`:

```rust
let scheduled_store = Arc::new(
    scheduled_tasks::ScheduledStore::open(std::path::Path::new(&data_dir_str))
        .expect("Failed to initialize scheduled store"),
);
```

Pass it into `SessionManager::new` (add a param + `scheduled: Some(scheduled_store.clone())` field) and add `pub scheduled_tasks: Arc<scheduled_tasks::ScheduledStore>` to `AppState`.

- [ ] **Step 2: Add a trigger helper on SessionManager**

```rust
/// Create a Claude session for a scheduled run and inject the goal with run_id.
pub async fn trigger_run(&self, run_id: &str, name: String, work_dir: &str, owner_id: &str, task_id: &str, prompt: String) -> Result<String, String> {
    let sid = self.create_acp_session_tagged(name, work_dir, owner_id, Some(task_id.to_string())).await?;
    if let Some(store) = &self.scheduled {
        let _ = store.set_run_state(run_id, "running", Some(&sid), None, None, None);
    }
    let goal = format!("{}\n\n完成后，最后单独输出一行：\n<<<VERDICT>>>一句话结论<<<END>>>", prompt);
    if let Some(tx) = self.input_tx(&sid) {
        tx.send(SessionInput::Prompt { text: goal, run_id: Some(run_id.to_string()) }).await
            .map_err(|e| { if let Some(s)=&self.scheduled { let _=s.set_run_state(run_id,"failed",None,None,Some("prompt_send_failed"),Some(now_millis())); } e.to_string() })?;
    }
    Ok(sid)
}
```

Add `create_acp_session_tagged` = the existing `create_acp_session` with an extra `source_task_id: Option<String>` arg threaded into the `Session` literal (refactor `create_acp_session` to delegate with `None`). Add `pub fn input_tx(&self, id:&str) -> Option<mpsc::Sender<SessionInput>>` returning a clone of the session's `input_tx`.

- [ ] **Step 2b: `process_alive` + reclaim helpers** (used by watchdog/Task 13)

Add `pub fn session_exists(&self, id:&str) -> bool` (HashMap contains). The watchdog treats "session no longer in registry" as dead.

- [ ] **Step 3: Scheduler loop (in scheduled_tasks.rs)**

```rust
pub fn spawn_scheduler(mgr: std::sync::Arc<crate::session_manager::SessionManager>,
                       store: std::sync::Arc<ScheduledStore>,
                       events: std::sync::Arc<crate::events::EventStore>,
                       heartbeat: std::sync::Arc<std::sync::atomic::AtomicI64>) {
    use std::sync::atomic::Ordering;
    tokio::spawn(async move {
        // supervised: this outer task respawns the inner loop on panic
        loop {
            let m = mgr.clone(); let s = store.clone(); let e = events.clone(); let hb = heartbeat.clone();
            let inner = tokio::spawn(async move {
                let mut last_seen = chrono::Utc::now();
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
                loop {
                    tick.tick().await;
                    let now = chrono::Utc::now();
                    hb.store(now.timestamp_millis(), Ordering::Relaxed);
                    // watchdog: abort runs exceeding max runtime (30 min)
                    let cutoff = now.timestamp_millis() - 30*60*1000;
                    let _ = s.reconcile_orphans(Some(cutoff));
                    let tasks = match s.list_enabled() { Ok(t)=>t, Err(_)=>{ continue; } };
                    for task in tasks {
                        let fires = match due_fire_points(&task.trigger_spec, last_seen, now) { Ok(f)=>f, Err(err)=>{ tracing::warn!("cron {}: {}", task.id, err); continue; } };
                        if let Some(fire) = fires.last() {
                            let active = s.active_states_for_task(&task.id).unwrap_or_default();
                            let active_refs: Vec<&str> = active.iter().map(|x| x.as_str()).collect();
                            if should_skip_overlap(&active_refs) { continue; }
                            let run = TaskRun { id: uuid::Uuid::new_v4().to_string(), task_id: task.id.clone(),
                                scheduled_for_ms: fire.timestamp_millis(), state:"claimed".into(), session_id:None,
                                verdict:None, failure_kind:None, started_ms: Some(now.timestamp_millis()), ended_ms:None };
                            if s.claim_run(&run).unwrap_or(false) {
                                let nm = format!("{} · {}", task.name, fire.with_timezone(&chrono_tz::Asia::Shanghai).format("%H:%M"));
                                if let Err(err) = m.trigger_run(&run.id, nm, &task.work_dir, &task.owner_id, &task.id, task.prompt.clone()).await {
                                    let _ = s.set_run_state(&run.id, "failed", None, None, Some("spawn_failed"), Some(now.timestamp_millis()));
                                    tracing::warn!("trigger {} failed: {}", task.id, err);
                                }
                            }
                        }
                    }
                    last_seen = now;
                }
            });
            match inner.await {
                Ok(_) => break, // inner returned (shouldn't); stop
                Err(_) => { tracing::error!("scheduler loop panicked; reconciling + respawning"); let _ = store.reconcile_orphans(None); }
            }
        }
    });
}
```

- [ ] **Step 4: Wire startup in main.rs**

After `state.sessions.load_persisted();` add:

```rust
// Scheduled tasks: reconcile orphans from prior run, then start the loop.
let _ = state.scheduled_tasks.reconcile_orphans(None);
let sched_heartbeat = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0));
scheduled_tasks::spawn_scheduler(state.sessions.clone(), state.scheduled_tasks.clone(), state.events.clone(), sched_heartbeat.clone());
```

Store `sched_heartbeat` in `AppState` (add field `pub sched_heartbeat: Arc<AtomicI64>`) so the health endpoint can read it.

- [ ] **Step 5: Build**

Run: `cargo build`
Expected: compiles. Resolve `input_tx`/`create_acp_session_tagged` signature mismatches.

- [ ] **Step 6: Commit**

```bash
git add src/scheduled_tasks.rs src/session_manager.rs src/main.rs
git commit -m "feat(sched): supervised tick loop + trigger + runtime watchdog + heartbeat"
```

---

## Task 9: HTTP API — task CRUD, run-now, runs, health

**Files:** Modify `src/web.rs`, `src/scheduled_tasks.rs` (Beijing-time↔cron conversion helper)

- [ ] **Step 1: Schedule conversion helper + test (scheduled_tasks.rs)**

```rust
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ScheduleInput {
    Daily { hour: u32, minute: u32 },
    Weekly { weekdays: Vec<u32>, hour: u32, minute: u32 }, // 0=Sun..6=Sat
    Cron { expr: String },
}

/// Build a 6-field cron string (sec min hour dom mon dow) interpreted in the
/// schedule's tz by the scheduler. No UTC offset baked in here.
pub fn schedule_to_cron(s: &ScheduleInput) -> String {
    match s {
        ScheduleInput::Daily { hour, minute } => format!("0 {} {} * * *", minute, hour),
        ScheduleInput::Weekly { weekdays, hour, minute } => {
            let dows = weekdays.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(",");
            format!("0 {} {} * * {}", minute, hour, if dows.is_empty(){"*".into()}else{dows})
        }
        ScheduleInput::Cron { expr } => expr.clone(),
    }
}

#[cfg(test)]
mod sched_input_tests {
    use super::*;
    #[test]
    fn daily_to_cron() { assert_eq!(schedule_to_cron(&ScheduleInput::Daily{hour:9,minute:0}), "0 0 9 * * *"); }
    #[test]
    fn weekly_to_cron() { assert_eq!(schedule_to_cron(&ScheduleInput::Weekly{weekdays:vec![1,2,3,4,5],hour:9,minute:0}), "0 0 9 * * 1,2,3,4,5"); }
}
```

Run: `cargo test sched_input_tests` → 2 passed.

- [ ] **Step 2: Add routes (web.rs)**

In `build_router`, in the authed `api` group (after the `/api/events` lines ~41-42):

```rust
.route("/api/scheduled-tasks", get(list_scheduled).post(create_scheduled))
.route("/api/scheduled-tasks/{id}", put(update_scheduled).delete(delete_scheduled))
.route("/api/scheduled-tasks/{id}/run", post(run_scheduled_now))
.route("/api/scheduled-tasks/{id}/runs", get(list_scheduled_runs))
.route("/api/scheduler/health", get(scheduler_health))
```

- [ ] **Step 3: Handlers (web.rs)**

Mirror `list_events`/`create_event` for auth + owner stamping. Key rules: `owner_id` stamped from `CurrentUser` (never trusted from body); `list_scheduled` filters by owner; `update/delete/run/runs` first `get_config` and 403 if `owner_id != current_user`; validate cron with `cron::Schedule::from_str` (400 on error). `run_scheduled_now` builds a TaskRun with `scheduled_for_ms = now` (a distinct slot from the cron schedule so it won't UNIQUE-collide), checks overlap, claims, and calls `trigger_run`. `scheduler_health` returns `{ heartbeat_ms, healthy: now - heartbeat_ms < 180_000 }`.

- [ ] **Step 4: Build + smoke**

Run: `cargo build` then `cargo test` (full suite stays green).
Expected: compiles, all prior tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/web.rs src/scheduled_tasks.rs
git commit -m "feat(sched): task CRUD + run-now + runs + health endpoints (owner-scoped)"
```

---

## Task 10: Frontend — API client + ScheduledTasksPanel

**Files:** Create `frontend/src/components/ScheduledTasksPanel.tsx`; Modify `frontend/src/lib/api.ts`

- [ ] **Step 1: API client (api.ts)**

Add the `ScheduledTask` / `ScheduleInput` / `TaskRun` types and functions `listScheduledTasks`, `createScheduledTask`, `updateScheduledTask`, `deleteScheduledTask`, `runScheduledTaskNow`, `listTaskRuns`, `getSchedulerHealth` — each calling `api('/api/scheduled-tasks...')` mirroring existing `createSession`. Add `source_task_id?: string | null` to `interface SessionInfo`.

- [ ] **Step 2: Panel component (ScheduledTasksPanel.tsx)**

Mirror `AdminPanel.tsx` structure (overlay + close). Render the task list (name · Beijing time · work_dir · enable toggle · last-run state · buttons: Run now / Edit / Delete / History). New/edit form: name input, schedule picker (dropdown daily/weekly + HH:MM, advanced cron textbox), directory picker (reuse `listDirectories`), prompt textarea. History subview reads `listTaskRuns`.

- [ ] **Step 3: Lint + typecheck**

Run: `cd frontend && npm run lint && npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/components/ScheduledTasksPanel.tsx
git commit -m "feat(sched): frontend API client + ScheduledTasksPanel overlay"
```

---

## Task 11: Frontend — Clock entry (with health red-dot) + sidebar badge

**Files:** Modify `frontend/src/App.tsx`, `frontend/src/components/Sidebar.tsx`

- [ ] **Step 1: Clock button + panel toggle + health poll (App.tsx)**

Add a `Clock` (lucide) button in the top toolbar right side. Clicking toggles `ScheduledTasksPanel`. Poll `getSchedulerHealth` every 60s; if `!healthy`, render a red warning dot on the Clock button ("调度器异常"). Also surface a red-dot when an unseen scheduled run completed (reuse the B-2 red-dot state keyed off new completed runs).

- [ ] **Step 2: Sidebar clock badge (Sidebar.tsx)**

In the session list row, when `session.source_task_id` is set, render a small `Clock` badge next to the type icon, with `title` = the source task name (look up from the scheduled-tasks list, or just show "定时任务").

- [ ] **Step 3: Lint + typecheck + build**

Run: `cd frontend && npm run lint && npm run build`
Expected: builds to `frontend/dist/`.

- [ ] **Step 4: Full build + commit**

Run: `cargo build` (embeds the new frontend).

```bash
git add frontend/src/App.tsx frontend/src/components/Sidebar.tsx
git commit -m "feat(sched): Clock entry with health red-dot + sidebar source-task badge"
```

---

## Task 12 (v1.1): Verdict display polish

Verdict capture already lands in `agent_task_runs.verdict` (Task 7). This task surfaces it.

**Files:** Modify `src/web.rs` (verdict in runs DTO — already there), `frontend/src/components/ScheduledTasksPanel.tsx`, `frontend/src/App.tsx`

- [ ] **Step 1: Show verdict next to the red-dot + in the row**

In the panel row "last-run state" cell, show the latest run's `verdict` (or "完成，无摘要" when `failure_kind=no_verdict`). In App.tsx, when the completion red-dot shows, include the verdict one-liner in the tooltip/popover.

- [ ] **Step 2: Write a verdict-event** (optional, reuse events)

When `finalize_run` writes `succeeded` with a verdict, also call `events.create` with `event="scheduled_verdict"`, `summary=verdict`, `session_id`, owner = task owner. This makes verdicts queryable + permanent independent of session retention. Look up the owner inside `finalize_run` (the store already has the run's `task_id` → `get_config(task_id)?.owner_id`); do NOT add an owner param — keep the Task 7 `finalize_run(run_id, state, verdict, failure_kind)` signature stable.

- [ ] **Step 3: Lint + build + commit**

```bash
cd frontend && npm run build && cd .. && cargo build
git add -A && git commit -m "feat(sched): surface run verdict in panel + verdict event"
```

---

## Task 13 (v1.1): Retention + worktree reclaim with safety gate

**Files:** Modify `src/scheduled_tasks.rs` (reclaim driver), `src/session_manager.rs` (delete-session + uncommitted check helpers)

- [ ] **Step 1: Uncommitted-changes check helper (session_manager.rs)**

Add `fn worktree_has_uncommitted(path: &Path) -> bool` running `git -C <path> status --porcelain` and returning true if output is non-empty. Add `fn worktree_root_ok(path: &Path) -> bool` that canonicalizes and checks the path is under `<base>/.zeromux-worktrees/`.

- [ ] **Step 2: Reclaim driver (called after a successful run)**

After `finalize_run` marks `succeeded`, look up the task's `retention_n`; list that task's runs ordered by `ended_ms` desc; for runs beyond N with a `session_id`, gate with `is_safe_to_reclaim(worktree_root_ok, session_exists, worktree_has_uncommitted)`. If safe: `remove_worktree` + delete the session (reuse existing delete path) + leave the run row (verdict stays). If a worktree is dirty: skip + `events.create(event="retention_skipped", summary="保留：有未提交改动")`.

- [ ] **Step 3: Test the gate composition**

The pure `is_safe_to_reclaim` is already tested (Task 3). Add one integration-ish test that a dirty worktree path makes the driver skip (mock the three booleans). Keep it a unit test on a small extracted decision function.

- [ ] **Step 4: Build + commit**

```bash
cargo build && cargo test
git add src/scheduled_tasks.rs src/session_manager.rs
git commit -m "feat(sched): retention reclaim with worktree safety gate (v1.1)"
```

---

## Task 14 (v1.1): agent_task_runs prune (future-proof, low priority)

**Files:** Modify `src/main.rs`

- [ ] **Step 1: Daily prune of very old non-active runs**

Mirror the existing 30-day events prune block in `main.rs`. Add a daily task that deletes `agent_task_runs` rows older than e.g. 365 days in a terminal state (keeps verdicts ~a year). Single-user scale makes this optional; include it so the table is bounded.

- [ ] **Step 2: Commit**

```bash
git add src/main.rs
git commit -m "feat(sched): daily prune of old terminal task runs"
```

---

## Task 15: Brand logo cleanup (independent, already in progress)

**Files:** `frontend/src/components/BrandIcons.tsx` (new, present), `frontend/src/components/Sidebar.tsx` (modified, present)

- [ ] **Step 1: Verify build + commit the existing uncommitted logo swap**

Run: `cd frontend && npm run build && cd .. && cargo build`

```bash
git add frontend/src/components/BrandIcons.tsx frontend/src/components/Sidebar.tsx .gitignore
git commit -m "feat(ui): official brand logos for Claude Code / Kiro / Codex"
```

---

## Final verification

- [ ] **Run full backend test suite**

Run: `cargo test`
Expected: all pass including new `scheduled_tasks` tests.

- [ ] **Run frontend tests + build**

Run: `cd frontend && npm run lint && npm test && npm run build`
Expected: green.

- [ ] **Manual end-to-end (v1)**

Start the binary, create a task scheduled for `now + 2 min` (Beijing), confirm: a Claude session auto-appears at the minute with a clock badge, runs, run row goes `claimed→running→succeeded`; stop the binary mid-run and restart → the orphan run becomes `aborted`, not stuck; "Run now" while one is running → skipped + event. Verify no 8-hour offset.

- [ ] **Map acceptance criteria → tasks**

Cross-check spec §验收标准 1–14 against Tasks 0–14. Every criterion has a task.
