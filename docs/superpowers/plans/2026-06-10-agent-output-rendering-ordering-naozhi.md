# Agent 输出渲染 / 发收错位 / naozhi 选择性回复 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three coupled bugs in zeromux's agent chat — intermittent markdown misrender, send/receive vertical misalignment, and naozhi-style selective reply (input-side queue policy + output-side concise rendering).

**Architecture:** Backend introduces a single emit/persist helper (scrollback written once, unconditionally, by the fan-out task), a shared collect-queue helper extracted from three near-duplicate fan-outs, and `turn_id` on every event so the frontend groups by turn instead of trusting raw event order. Frontend adds streaming-markdown sanitize, mermaid cache fixes, turn-grouped message state, and a concise/full density filter.

**Tech Stack:** Rust (Axum, tokio broadcast/mpsc), React 19 + Vite + TypeScript, vitest, react-markdown.

**Spec:** `docs/superpowers/specs/2026-06-10-agent-output-rendering-ordering-naozhi-design.md`

**Implementation order (CTO+codex revised):** G0 → G2a → G3 → G1 → G2b. G1 is pure-frontend and may run in parallel with backend groups.

---

## File Structure

**Backend (`src/`):**
- `acp/process.rs` — `AcpEvent` enum: add `UserPrompt` variant + `turn_id` on `ContentBlock`/`Result`. (Modify)
- `session_manager.rs` — new `emit()` helper (G0), extracted `FanoutQueue`/`drive_prompt` collect helper (G2a), `UserPrompt` emit + turn_id threading (G3), `QueueMode` (G2b). (Modify)
- `acp/ws_handler.rs` — delete per-connection `push_scrollback` (G0); add `ClientMsg::Prompt{client_id}` + `ClientMsg::SetQueueMode` (G3/G2b). (Modify)

**Frontend (`frontend/src/`):**
- `components/markdown/sanitize.ts` — new pure fn `sanitizeStreamingMarkdown`. (Create)
- `components/markdown/__tests__/sanitize.test.ts` — tests. (Create)
- `components/markdown/MarkdownContent.tsx` — call sanitize when `!isComplete`. (Modify)
- `components/markdown/MermaidBlock.tsx` — hash cache key, no-write-on-error. (Modify)
- `components/AcpChatView.tsx` — turn-grouped message model, `user_prompt` handler, density filter. (Modify)
- `components/SessionInfoBar.tsx` — QueueMode dropdown. (Modify)
- `lib/transcript.ts` — new pure fn: fold event list → turn-grouped messages (testable without React). (Create)
- `components/__tests__/transcript.test.ts` — tests. (Create)

---

## G0 — 集中 emit/persist helper

**Why first:** every later backend change emits events. Centralizing the write fixes the multi-device double-write (D2) and no-subscriber data loss (T2) up front, and gives one place to add `UserPrompt` durability.

### Task G0.1: Add the `emit` helper with unconditional, send-decoupled scrollback write

**Files:**
- Modify: `src/session_manager.rs` (add free fn near `emit_queued`, ~line 1840)
- Test: `src/session_manager.rs` inline `#[cfg(test)]` module (~line 2600)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src/session_manager.rs`:

```rust
#[test]
fn is_ephemeral_event_only_matches_queued() {
    // queued is the only ephemeral (non-persisted) event.
    let queued = AcpEvent::System {
        subtype: std::borrow::Cow::Borrowed("queued"),
        session_id: None,
        count: Some(3),
    };
    assert!(is_ephemeral_event(&queued));

    let init = AcpEvent::System {
        subtype: std::borrow::Cow::Borrowed("init"),
        session_id: None,
        count: None,
    };
    assert!(!is_ephemeral_event(&init));
    assert!(!is_ephemeral_event(&AcpEvent::Result {
        text: "x".into(), session_id: "s".into(), cost_usd: None, turn_id: 1,
    }));
}
```

> Note: `Result` already gets a `turn_id` field in Task G3.1. If implementing G0 before G3, drop the `turn_id: 1` from this test's `Result` literal and re-add it in G3. Prefer doing G3.1's enum change first if executing out of order.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test is_ephemeral_event_only_matches_queued`
Expected: FAIL — `cannot find function is_ephemeral_event`

- [ ] **Step 3: Write the helper**

Add near `emit_queued` (~`src/session_manager.rs:1840`):

```rust
/// True for events that are forwarded live but NOT persisted to scrollback.
/// Currently only `System{subtype:"queued"}` (the collect enqueue hint): a
/// reconnect must not replay a phantom "已排队 N 条" for a batch already flushed.
fn is_ephemeral_event(evt: &AcpEvent) -> bool {
    matches!(
        evt,
        AcpEvent::System { subtype, .. } if subtype.as_ref() == "queued"
    )
}

/// Single emit/persist chokepoint for all fan-out events.
/// Invariant (T2): scrollback is written UNCONDITIONALLY, before and
/// independent of `event_tx.send`. `broadcast::send` returns Err when there
/// are zero subscribers (all clients disconnected) — gating persistence on
/// send success would drop output produced while the phone is backgrounded.
/// Invariant (D2): this is the ONLY scrollback write path for live events, so
/// multiple connected clients can never double-record (the per-connection
/// write in ws_handler is removed in Task G0.3).
fn emit(
    mgr: &Weak<SessionManager>,
    sid: &str,
    event_tx: &broadcast::Sender<String>,
    evt: &AcpEvent,
) {
    let json = match serde_json::to_string(evt) {
        Ok(j) => j,
        Err(_) => return,
    };
    if !is_ephemeral_event(evt) {
        if let Some(m) = mgr.upgrade() {
            m.push_scrollback(sid, json.clone());
        }
    }
    let _ = event_tx.send(json); // Err == zero subscribers; ignore (T2)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test is_ephemeral_event_only_matches_queued`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(emit): central emit/persist helper — unconditional scrollback write (G0, D2+T2)"
```

### Task G0.2: Route the Claude fan-out's event broadcast through `emit`

**Files:**
- Modify: `src/session_manager.rs:1656` (the `let _ = event_tx.send(json);` in `spawn_acp_fanout`)

- [ ] **Step 1: Replace the raw send with `emit`**

In `spawn_acp_fanout`, the event-receive arm currently does (around line 1652-1656):

```rust
                            let json = match serde_json::to_string(&evt) {
                                Ok(j) => j,
                                Err(_) => continue,
                            };
                            let _ = event_tx.send(json);
```

Replace with:

```rust
                            emit(&mgr, &sid, &event_tx, &evt);
```

(The `is_boundary` computation above it stays — it reads `evt` before this line.)

- [ ] **Step 2: Update `emit_queued` to go through the same path (optional consistency)**

Leave `emit_queued` as-is for now (it already only broadcasts, never persists — consistent with `is_ephemeral_event`). No change needed.

- [ ] **Step 3: Verify it compiles and existing tests pass**

Run: `cargo test`
Expected: PASS (no behavior change yet — scrollback still also written in ws_handler; G0.3 removes that)

- [ ] **Step 4: Commit**

```bash
git add src/session_manager.rs
git commit -m "refactor(claude-fanout): emit events via central helper (G0)"
```

### Task G0.3: Remove the per-connection scrollback write in ws_handler

**Files:**
- Modify: `src/acp/ws_handler.rs:124-144`

- [ ] **Step 1: Delete the persistence block, keep logging + live forward**

In `src/acp/ws_handler.rs`, the broadcast-receive arm currently parses the event, logs it, checks ephemeral, and calls `push_scrollback`. Replace the block (lines ~124-148) with:

```rust
                    Ok(json) => {
                        // Log ACP event (logging is per-connection by design —
                        // each client's ring buffer is independent).
                        if let Some(ref log) = logger {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json) {
                                log.log_acp_event(&session_id, &val);
                            }
                        }
                        // NOTE: scrollback is written once by the fan-out task
                        // (session_manager::emit), NOT here — see G0. Writing per
                        // connection double-recorded under multi-client (D2).
                        if ws_sink.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
```

This removes both the `is_ephemeral_queued` check and the `push_scrollback` call from ws_handler (both now live in `emit`).

- [ ] **Step 2: Verify it compiles**

Run: `cargo build`
Expected: builds. Unused `broadcast` import warning is fine if it appears; remove only if the import becomes fully unused.

- [ ] **Step 3: Manual smoke (two-client double-write gone)**

Run: `cargo build && ./target/release/zeromux --port 8099 --password t` (or debug binary), open a Claude session in two browser tabs, send one prompt, reconnect one tab. Expected: replay shows each event once, not twice.

- [ ] **Step 4: Commit**

```bash
git add src/acp/ws_handler.rs
git commit -m "fix(scrollback): remove per-connection write — fixes multi-device double-record (G0, D2)"
```

### Task G0.4: Route Kiro + Codex fan-outs through `emit`

**Files:**
- Modify: `src/session_manager.rs` — `spawn_kiro_fanout` (~line 1980 broadcast point) and `spawn_codex_fanout` (~line 2140 broadcast point)

- [ ] **Step 1: Find both raw sends**

Run: `grep -n "let _ = event_tx.send(json)" src/session_manager.rs`
Expected: two remaining hits (kiro, codex) — the acp one was changed in G0.2.

- [ ] **Step 2: Replace each with `emit`**

At each kiro/codex broadcast site, replace the `serde_json::to_string(&evt)` + `let _ = event_tx.send(json);` pattern with:

```rust
                            emit(&mgr, &sid, &event_tx, &evt);
```

(Each fan-out has `mgr`, `sid`, `event_tx` in scope — verify by reading the fn signature.)

- [ ] **Step 3: Verify**

Run: `cargo test && grep -c "let _ = event_tx.send(json)" src/session_manager.rs`
Expected: tests PASS; grep count `0`.

- [ ] **Step 4: Commit**

```bash
git add src/session_manager.rs
git commit -m "refactor(kiro,codex-fanout): emit events via central helper (G0)"
```

---

## G2a — 抽象三个 fan-out 的 collect 共享 helper

**Why before G3:** G3 must touch the prompt-handling code in all three fan-outs. Extracting it to one helper first means G3 (and G2b) edit one place, not three. This task is pure refactor — **no behavior change**, existing `merge_pending` test and runtime behavior must be unchanged.

### Task G2a.1: Define a `PromptQueue` struct holding the collect state

**Files:**
- Modify: `src/session_manager.rs` (add struct near `PendingPrompt`, ~line 1831)
- Test: inline `#[cfg(test)]`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn prompt_queue_enqueue_and_drain() {
    let mut q = PromptQueue::new();
    assert!(q.pending.is_empty());
    q.enqueue("a".into());
    q.enqueue("b".into());
    assert_eq!(q.pending.len(), 2);
    let merged = q.drain_merged();
    assert!(q.pending.is_empty());
    assert!(merged.contains("a") && merged.contains("b"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test prompt_queue_enqueue_and_drain`
Expected: FAIL — `cannot find type PromptQueue`

- [ ] **Step 3: Implement the struct**

Add near `PendingPrompt` (~`src/session_manager.rs:1831`):

```rust
/// Shared collect-queue state for all three fan-outs (was duplicated ~3×).
/// Holds the pending appended prompts and the two debounce/hard-cap timers.
/// Behavior is identical to the prior inline logic; this is an extraction only.
struct PromptQueue {
    pending: Vec<PendingPrompt>,
    debounce: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
    hard_cap: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
}

impl PromptQueue {
    const DEBOUNCE_MS: u64 = 500;
    const MAX_MS: u64 = 3000;

    fn new() -> Self {
        Self { pending: Vec::new(), debounce: None, hard_cap: None }
    }

    fn enqueue(&mut self, text: String) {
        self.pending.push(PendingPrompt { text, ts_ms: now_millis() });
    }

    /// Reset the debounce timer (called on each new enqueue inside the window).
    fn bump_debounce(&mut self) {
        self.debounce = Some(Box::pin(tokio::time::sleep(
            std::time::Duration::from_millis(Self::DEBOUNCE_MS))));
    }

    /// Arm both timers when a turn ends with items queued.
    fn arm(&mut self) {
        if !self.pending.is_empty() && self.debounce.is_none() {
            self.bump_debounce();
            self.hard_cap = Some(Box::pin(tokio::time::sleep(
                std::time::Duration::from_millis(Self::MAX_MS))));
        }
    }

    fn disarm(&mut self) {
        self.debounce = None;
        self.hard_cap = None;
    }

    fn clear(&mut self) {
        self.pending.clear();
        self.disarm();
    }

    fn drain_merged(&mut self) -> String {
        let merged = merge_pending(&self.pending);
        self.pending.clear();
        merged
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test prompt_queue_enqueue_and_drain`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs
git commit -m "refactor(collect): extract PromptQueue struct (G2a, no behavior change)"
```

### Task G2a.2: Replace inline collect state in `spawn_acp_fanout` with `PromptQueue`

**Files:**
- Modify: `src/session_manager.rs:1628-1632, 1693-1698, 1752-1759, 1786-1788, 1799-1822`

- [ ] **Step 1: Replace the state declarations**

In `spawn_acp_fanout`, replace (lines ~1628-1632):

```rust
        let mut pending: Vec<PendingPrompt> = Vec::new();
        let mut collect_deadline: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
        let mut collect_hard_deadline: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
        const COLLECT_DEBOUNCE_MS: u64 = 500;
        const COLLECT_MAX_MS: u64 = 3000;
```

with:

```rust
        let mut queue = PromptQueue::new();
```

- [ ] **Step 2: Update the arm site (turn-end)**

Replace the `if !local_running && !pending.is_empty() && collect_deadline.is_none()` block (~1693-1698) with:

```rust
                                if !local_running {
                                    queue.arm();
                                }
```

- [ ] **Step 3: Update the enqueue sites**

The `local_running` enqueue branch (~1752-1753):

```rust
                            } else if local_running {
                                queue.enqueue(text);
                                emit_queued(&event_tx, queue.pending.len());
```

The collect-window enqueue branch (~1754-1759):

```rust
                            } else if queue.debounce.is_some() {
                                queue.enqueue(text);
                                queue.bump_debounce();
                                emit_queued(&event_tx, queue.pending.len());
```

- [ ] **Step 4: Update interrupt clear (~1786-1788)**

```rust
                            queue.clear();
```

- [ ] **Step 5: Update the flush select arm (~1799-1822)**

Replace the `_ = async { match (collect_deadline.as_mut(), collect_hard_deadline.as_mut()) {...} }, if collect_deadline.is_some() => {...}` arm with:

```rust
                _ = async {
                    match (queue.debounce.as_mut(), queue.hard_cap.as_mut()) {
                        (Some(d), Some(h)) => { tokio::select! { _ = d.as_mut() => {}, _ = h.as_mut() => {} } }
                        (Some(d), None) => d.as_mut().await,
                        (None, Some(h)) => h.as_mut().await,
                        (None, None) => std::future::pending::<()>().await,
                    }
                }, if queue.debounce.is_some() => {
                    queue.disarm();
                    if !queue.pending.is_empty() {
                        let merged = queue.drain_merged();
                        active_run_id = None;
                        turn_seq += 1;
                        local_running = true;
                        if let Some(m) = mgr.upgrade() {
                            m.mark_turn(&sid, TurnState::Running, turn_seq);
                        }
                        if let Err(e) = process.send_prompt(&merged).await {
                            tracing::warn!("collect flush send_prompt failed for {}: {}", sid, e);
                        }
                    }
                }
```

Also replace the run_id-prompt and idle-prompt branches' `pending.clear(); collect_deadline = None; collect_hard_deadline = None;` with `queue.clear();`.

- [ ] **Step 6: Verify no behavior change**

Run: `cargo test`
Expected: PASS — `merge_pending_formats_with_header_and_timestamps` and all turn-state tests still green.

- [ ] **Step 7: Commit**

```bash
git add src/session_manager.rs
git commit -m "refactor(claude-fanout): use PromptQueue (G2a)"
```

### Task G2a.3: Apply the same `PromptQueue` replacement to Kiro + Codex fan-outs

**Files:**
- Modify: `src/session_manager.rs` — `spawn_kiro_fanout`, `spawn_codex_fanout`

- [ ] **Step 1: Repeat G2a.2 steps 1-5 in `spawn_kiro_fanout`**

Same mechanical replacement. The kiro/codex flush arms and enqueue branches are byte-identical to acp's (verified in review). Apply the exact same edits.

- [ ] **Step 2: Repeat in `spawn_codex_fanout`**

Same.

- [ ] **Step 3: Verify**

Run: `cargo test && grep -c "collect_deadline" src/session_manager.rs`
Expected: tests PASS; grep count `0` (all replaced by `queue.debounce`).

- [ ] **Step 4: Commit**

```bash
git add src/session_manager.rs
git commit -m "refactor(kiro,codex-fanout): use PromptQueue (G2a)"
```

---

## G3 — turn_id + UserPrompt 事件 + 前端按 turn 分组

### Task G3.1: Add `turn_id` to `ContentBlock`/`Result` and the new `UserPrompt` variant

**Files:**
- Modify: `src/acp/process.rs:27-77` (the `AcpEvent` enum)
- Test: inline `#[cfg(test)]` in `src/acp/process.rs` (add module if absent)

- [ ] **Step 1: Write the failing test**

Add (create a `#[cfg(test)] mod tests` if none exists in `process.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_prompt_serializes_with_turn_and_client_id() {
        let evt = AcpEvent::UserPrompt {
            text: "hello".into(),
            turn_id: 7,
            client_id: Some("c1".into()),
        };
        let j = serde_json::to_string(&evt).unwrap();
        assert!(j.contains("\"type\":\"user_prompt\""));
        assert!(j.contains("\"turn_id\":7"));
        assert!(j.contains("\"client_id\":\"c1\""));
    }

    #[test]
    fn user_prompt_omits_client_id_when_none() {
        let evt = AcpEvent::UserPrompt { text: "x".into(), turn_id: 1, client_id: None };
        let j = serde_json::to_string(&evt).unwrap();
        assert!(!j.contains("client_id"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test user_prompt_serializes`
Expected: FAIL — no `UserPrompt` variant.

- [ ] **Step 3: Add the variant + turn_id fields**

In `src/acp/process.rs`, add to the `AcpEvent` enum:

```rust
    /// 用户 prompt 回显。每条用户 prompt 入队即 emit 一个（collect 合并成一个
    /// turn 时仍 N 个事件，见 spec P1）。turn_id 标识它归属的 turn，前端据此分组，
    /// 避免「边流边发」时新 prompt 插进上一个回答中间（spec T1）。
    UserPrompt {
        text: String,
        turn_id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
    },
```

Add `turn_id: u64` to the `ContentBlock` struct variant and the `Result` struct variant. For `ContentBlock`, place it as a required field (all emit sites must supply it):

```rust
    ContentBlock {
        block_type: StaticOrOwnedStr,
        turn_id: u64,
        // ... existing fields unchanged ...
    },
    Result {
        text: String,
        session_id: String,
        turn_id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
    },
```

- [ ] **Step 4: Fix all `ContentBlock`/`Result` construction sites**

Run: `cargo build 2>&1 | grep -A2 "missing field"`
This lists every emit site (in `process.rs translate_event`, `kiro_process.rs`, `codex_process.rs`). Each must now pass a `turn_id`. Since the CLI process layer doesn't know the fan-out's `turn_seq`, **emit with `turn_id: 0` at the process layer and stamp the real turn_id in the fan-out** (Task G3.2). Add `turn_id: 0` to each construction site.

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test user_prompt_serializes && cargo build`
Expected: PASS + builds.

- [ ] **Step 6: Commit**

```bash
git add src/acp/process.rs src/acp/kiro_process.rs src/acp/codex_process.rs
git commit -m "feat(events): add UserPrompt variant + turn_id on ContentBlock/Result (G3, T1)"
```

### Task G3.2: Stamp the live `turn_id` in the fan-out before emit

**Files:**
- Modify: `src/session_manager.rs` — `emit` call sites in all three fan-outs

- [ ] **Step 1: Add a turn_id stamper in `emit`**

Change `emit` to accept and apply the current turn_id (events arrive from the process with `turn_id: 0`):

```rust
fn emit(
    mgr: &Weak<SessionManager>,
    sid: &str,
    event_tx: &broadcast::Sender<String>,
    turn_id: u64,
    evt: &AcpEvent,
) {
    // Stamp the fan-out's live turn_id onto turn-bearing events (the process
    // layer emits turn_id: 0 since it doesn't track turn_seq).
    let stamped;
    let evt = match evt {
        AcpEvent::ContentBlock { .. } | AcpEvent::Result { .. } => {
            stamped = with_turn_id(evt.clone(), turn_id);
            &stamped
        }
        _ => evt,
    };
    let json = match serde_json::to_string(evt) {
        Ok(j) => j,
        Err(_) => return,
    };
    if !is_ephemeral_event(evt) {
        if let Some(m) = mgr.upgrade() {
            m.push_scrollback(sid, json.clone());
        }
    }
    let _ = event_tx.send(json);
}

fn with_turn_id(mut evt: AcpEvent, tid: u64) -> AcpEvent {
    match &mut evt {
        AcpEvent::ContentBlock { turn_id, .. } => *turn_id = tid,
        AcpEvent::Result { turn_id, .. } => *turn_id = tid,
        _ => {}
    }
    evt
}
```

- [ ] **Step 2: Update the three `emit(...)` calls to pass `turn_seq`**

Each fan-out's event arm: `emit(&mgr, &sid, &event_tx, turn_seq, &evt);`

> The boundary's turn_id should be the turn that produced it. `turn_seq` is the live turn counter; for streaming ContentBlocks of the in-flight turn this is correct. (Interrupt-resend stale-boundary case keeps the existing `boundary_count` settle logic untouched — turn_id stamping is orthogonal to idle-settling.)

- [ ] **Step 3: Verify**

Run: `cargo test && cargo build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(fanout): stamp live turn_id on streamed events (G3, T1)"
```

### Task G3.3: Thread `client_id` through `SessionInput::Prompt` and `ClientMsg::Prompt`

**Files:**
- Modify: `src/session_manager.rs:121` (`SessionInput::Prompt`)
- Modify: `src/acp/ws_handler.rs:24` (`ClientMsg::Prompt`), `:162-166` (send site)

- [ ] **Step 1: Add `client_id` to the enums**

`src/session_manager.rs:121`:

```rust
    Prompt { text: String, run_id: Option<String>, client_id: Option<String> },
```

`src/acp/ws_handler.rs:24`:

```rust
    #[serde(rename = "prompt")]
    Prompt { text: String, #[serde(default)] client_id: Option<String> },
```

- [ ] **Step 2: Update the ws send site (`ws_handler.rs:162-166`)**

```rust
                                    ClientMsg::Prompt { text, client_id } => {
                                        if let Some(ref log) = logger {
                                            log.log_acp_input(&session_id, &text);
                                        }
                                        let _ = input_tx.send(SessionInput::Prompt {
                                            text, run_id: None, client_id,
                                        }).await;
                                    }
```

- [ ] **Step 3: Fix all other `SessionInput::Prompt` construction sites**

Run: `cargo build 2>&1 | grep -B1 "missing field \`client_id\`"`
Expected sites: scheduled-run trigger (`session_manager.rs:856` area) — pass `client_id: None` there (scheduled runs have no client). Fix each.

- [ ] **Step 4: Update the three fan-out `Some(SessionInput::Prompt { text, run_id })` match arms**

Change each pattern to `Some(SessionInput::Prompt { text, run_id, client_id })`.

- [ ] **Step 5: Verify**

Run: `cargo build`
Expected: builds (client_id unused warning in fan-outs OK until G3.4 consumes it).

- [ ] **Step 6: Commit**

```bash
git add src/session_manager.rs src/acp/ws_handler.rs
git commit -m "feat(prompt): thread client_id through SessionInput + ClientMsg (G3)"
```

### Task G3.4: Emit one `UserPrompt` per enqueued prompt, in all three fan-outs

**Files:**
- Modify: `src/session_manager.rs` — the prompt-handling branches in all three fan-outs
- Test: inline `#[cfg(test)]`

- [ ] **Step 1: Write the failing test (truncation helper + per-prompt emit semantics)**

The emit is inside an async tokio task and hard to unit-test directly; test the **truncation helper** (T3) and document the per-prompt invariant as an integration smoke. Add:

```rust
#[test]
fn truncate_prompt_for_scrollback_caps_and_marks() {
    let short = "hello";
    assert_eq!(truncate_prompt_for_scrollback(short), "hello");

    let big = "x".repeat(70_000);
    let out = truncate_prompt_for_scrollback(&big);
    assert!(out.len() < 70_000);
    assert!(out.contains("已截断"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test truncate_prompt_for_scrollback`
Expected: FAIL — fn not found.

- [ ] **Step 3: Implement the truncation helper (T3)**

Add near `emit`:

```rust
/// Cap a user prompt before it enters scrollback (T3). A single huge paste
/// must not blow the 2MB scrollback ring. NOT redaction — see spec P3 TODO.
const USER_PROMPT_SCROLLBACK_CAP: usize = 64 * 1024;
fn truncate_prompt_for_scrollback(text: &str) -> String {
    if text.len() <= USER_PROMPT_SCROLLBACK_CAP {
        return text.to_string();
    }
    let cut = text
        .char_indices()
        .take_while(|(i, _)| *i < USER_PROMPT_SCROLLBACK_CAP)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    let dropped = text.len() - cut;
    format!("{}\n[已截断 {} 字节]", &text[..cut], dropped)
}
```

- [ ] **Step 4: Add a `UserPrompt` emit at each enqueue/send point**

In `spawn_acp_fanout`'s `Some(SessionInput::Prompt { text, run_id, client_id })` arm, emit a `UserPrompt` for **every** prompt the moment it arrives, before the run_id/running/collect branching. The `turn_id` is the turn this prompt will belong to:
- run_id branch and idle branch → `turn_seq + 1` (the turn about to start).
- `local_running` enqueue branch and collect-window branch → the turn the queued batch will flush into. Since collect merges into the **next** started turn, use `turn_seq + 1` consistently (the merged flush does `turn_seq += 1`, so all queued prompts share that next turn_id).

Concretely, at the top of the prompt arm:

```rust
                        Some(SessionInput::Prompt { text, run_id, client_id }) => {
                            // Emit one UserPrompt per message (P1) for transcript
                            // fidelity; turn_id = the turn this prompt belongs to.
                            let prompt_turn = turn_seq + 1;
                            emit(&mgr, &sid, &event_tx, prompt_turn, &AcpEvent::UserPrompt {
                                text: truncate_prompt_for_scrollback(&text),
                                turn_id: prompt_turn,
                                client_id: client_id.clone(),
                            });
                            // ... existing run_id / local_running / collect / idle branches ...
```

> Subtlety: in the idle branch and run_id branch, `turn_seq` is incremented to start the turn — that increment now matches `prompt_turn`. In the collect path, multiple queued prompts each emit with the same `prompt_turn` only if `turn_seq` hasn't advanced between them; since enqueue happens while `local_running` (turn_seq fixed) or in the collect window (turn_seq fixed until flush), all queued prompts correctly share the same `turn_seq + 1`. Verify this holds against the merged-flush `turn_seq += 1`.

- [ ] **Step 5: Verify truncation test + build**

Run: `cargo test truncate_prompt_for_scrollback && cargo build`
Expected: PASS + builds.

- [ ] **Step 6: Apply the same `UserPrompt` emit to kiro + codex fan-outs**

Same edit at the top of each prompt arm.

- [ ] **Step 7: Verify all tests**

Run: `cargo test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(fanout): emit UserPrompt per message with turn_id + size cap (G3, P1+T1+T3)"
```

### Task G3.5: Frontend — pure transcript folder (event list → turn-grouped messages)

**Files:**
- Create: `frontend/src/lib/transcript.ts`
- Test: `frontend/src/components/__tests__/transcript.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/__tests__/transcript.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { foldTranscript, type WireEvent } from '../../lib/transcript'

describe('foldTranscript — turn grouping (T1)', () => {
  it('keeps a streaming turn together when a new prompt arrives mid-stream', () => {
    // ContentBlocks of turn 1 interleaved with a UserPrompt for turn 2.
    const events: WireEvent[] = [
      { type: 'content_block', block_type: 'text', text: 'answer part 1', turn_id: 1 },
      { type: 'content_block', block_type: 'text', text: ' part 2', turn_id: 1 },
      { type: 'user_prompt', text: 'new question', turn_id: 2, client_id: 'c2' },
      { type: 'content_block', block_type: 'text', text: ' part 3', turn_id: 1 },
    ]
    const groups = foldTranscript(events)
    // Turn 1 assistant text is contiguous; turn 2 prompt is its own group AFTER.
    const t1 = groups.find(g => g.turnId === 1)!
    const t2 = groups.find(g => g.turnId === 2)!
    expect(t1.assistantText()).toBe('answer part 1 part 2 part 3')
    expect(groups.indexOf(t1)).toBeLessThan(groups.indexOf(t2))
    expect(t2.userPrompts.map(p => p.text)).toEqual(['new question'])
  })

  it('orders user→assistant→user across turns', () => {
    const events: WireEvent[] = [
      { type: 'user_prompt', text: 'q1', turn_id: 1, client_id: 'c1' },
      { type: 'content_block', block_type: 'text', text: 'a1', turn_id: 1 },
      { type: 'result', text: '', turn_id: 1 },
      { type: 'user_prompt', text: 'q2', turn_id: 2, client_id: 'c2' },
      { type: 'content_block', block_type: 'text', text: 'a2', turn_id: 2 },
    ]
    const groups = foldTranscript(events)
    expect(groups.map(g => g.turnId)).toEqual([1, 2])
    expect(groups[0].userPrompts[0].text).toBe('q1')
    expect(groups[0].assistantText()).toBe('a1')
  })

  it('dedupes a user_prompt that matches an existing optimistic client_id', () => {
    const events: WireEvent[] = [
      { type: 'user_prompt', text: 'q1', turn_id: 1, client_id: 'c1' },
    ]
    const groups = foldTranscript(events, new Set(['c1']))
    // optimistic bubble c1 already shown → not re-added
    expect(groups.find(g => g.turnId === 1)?.userPrompts ?? []).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/__tests__/transcript.test.ts`
Expected: FAIL — cannot resolve `../../lib/transcript`.

- [ ] **Step 3: Implement `foldTranscript`**

Create `frontend/src/lib/transcript.ts`:

```typescript
// Pure transcript folder: a flat list of wire events → turn-grouped view.
// Grouping by turn_id (not raw arrival order) is what fixes the "send while
// streaming" misalignment (spec T1): a new prompt's UserPrompt carries the
// NEXT turn_id, so it lands in its own group rather than splicing into the
// still-streaming prior turn's ContentBlocks.

export interface WireEvent {
  type: string
  block_type?: string
  text?: string
  name?: string
  input?: unknown
  summary?: string
  streaming?: boolean
  turn_id?: number
  client_id?: string
  cost_usd?: number
}

export interface Block {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text?: string
  name?: string
  input?: unknown
  summary?: string
}

export interface TurnGroup {
  turnId: number
  userPrompts: { text: string; clientId?: string }[]
  blocks: Block[]
  complete: boolean
  cost?: number
  assistantText: () => string
}

export function foldTranscript(
  events: WireEvent[],
  seenClientIds: Set<string> = new Set(),
): TurnGroup[] {
  const byTurn = new Map<number, TurnGroup>()
  const order: number[] = []

  const group = (tid: number): TurnGroup => {
    let g = byTurn.get(tid)
    if (!g) {
      g = {
        turnId: tid,
        userPrompts: [],
        blocks: [],
        complete: false,
        assistantText() {
          return this.blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
        },
      }
      byTurn.set(tid, g)
      order.push(tid)
    }
    return g
  }

  for (const e of events) {
    const tid = e.turn_id ?? 0
    if (e.type === 'user_prompt') {
      if (e.client_id && seenClientIds.has(e.client_id)) continue // dedupe optimistic
      group(tid).userPrompts.push({ text: e.text ?? '', clientId: e.client_id })
    } else if (e.type === 'content_block') {
      const g = group(tid)
      const bt = (e.block_type ?? 'text') as Block['type']
      const last = g.blocks[g.blocks.length - 1]
      const mergeable = bt === 'text' || bt === 'thinking'
      if (e.streaming && mergeable && last && last.type === bt) {
        last.text = (last.text ?? '') + (e.text ?? '')
      } else {
        g.blocks.push({ type: bt, text: e.text, name: e.name, input: e.input, summary: e.summary })
      }
    } else if (e.type === 'result') {
      const g = group(tid)
      g.complete = true
      if (typeof e.cost_usd === 'number') g.cost = e.cost_usd
      const finalText = (e.text ?? '').trim()
      const hasStreamed = g.blocks.some(b => b.type === 'text' && (b.text ?? '').length > 0)
      if (finalText && !hasStreamed) g.blocks.push({ type: 'text', text: finalText })
    }
  }

  // Stable sort by turnId so cross-turn order is deterministic regardless of
  // raw event interleaving.
  return order.sort((a, b) => a - b).map(tid => byTurn.get(tid)!)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/__tests__/transcript.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/transcript.ts frontend/src/components/__tests__/transcript.test.ts
git commit -m "feat(transcript): pure turn-grouping folder (G3, T1)"
```

### Task G3.6: Wire `foldTranscript` into AcpChatView + send `client_id`

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx`

- [ ] **Step 1: Accumulate raw events, derive grouped view**

Replace the `messages`/`currentAssistant` ad-hoc state with a raw-event list + `seenClientIds`, and derive groups via `foldTranscript`. Minimal shape:

```typescript
const [events, setEvents] = useState<WireEvent[]>([])
const seenClientIds = useRef<Set<string>>(new Set())
const groups = useMemo(() => foldTranscript(events, seenClientIds.current), [events])
```

Replace `handleEvent`'s per-type `setMessages` mutations with a single `setEvents(prev => [...prev, evt as WireEvent])` for `content_block` / `result` / `user_prompt`, keeping `system`/`error`/`exit`/`replay_done`/`queued` handling as-is (those drive `busy`/`queuedCount`, not the transcript). On reconnect `onopen`, `setEvents([])` and `seenClientIds.current.clear()` (replacing `setMessages([])`).

> This is the largest single edit. Keep the existing busy/turn-timer/scroll logic; only the message-list derivation changes. Render `groups` instead of `messages` in the JSX (user bubbles from `g.userPrompts`, assistant blocks from `g.blocks`, gated by density in G2b).

- [ ] **Step 2: Optimistic insert + client_id on send**

In `sendPrompt`:

```typescript
const cid = newId()
seenClientIds.current.add(cid)
setEvents(prev => [...prev, { type: 'user_prompt', text: full, turn_id: Number.MAX_SAFE_INTEGER, client_id: cid }])
wsRef.current.send(JSON.stringify({ type: 'prompt', text: full, client_id: cid }))
```

> Optimistic bubble uses `turn_id: Number.MAX_SAFE_INTEGER` so it sorts last (newest) until the real `user_prompt` event arrives with the true turn_id and dedupes via `client_id`. When the real event arrives it's skipped (seen), but its turn_id is authoritative for the assistant grouping.

> Edge: the optimistic event keeps MAX_SAFE_INTEGER and is deduped only if the server echo shares client_id — but the server echo is SKIPPED (seen), so the optimistic one with the wrong turn_id stays. Fix: on receiving a `user_prompt` whose client_id is seen, **replace** the optimistic event's turn_id rather than skip. Implement in foldTranscript: track seen client_ids that arrive from server and rewrite the optimistic entry's turnId. Simpler: in the WS handler, when a `user_prompt` with a seen client_id arrives, `setEvents(prev => prev.map(e => e.client_id === cid ? { ...e, turn_id: evt.turn_id } : e))` and do not append. Add this branch.

- [ ] **Step 3: Verify frontend builds + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: builds, no lint errors.

- [ ] **Step 4: Manual smoke**

Send while streaming: start a long Claude turn, send a second message mid-stream. Expected: second bubble appears after the first answer's group, not spliced into it. Reconnect: order preserved.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "feat(chat): turn-grouped transcript + client_id dedupe (G3, T1+P1)"
```

---

## G1 — markdown sanitize + mermaid 缓存 (pure frontend, parallelizable)

### Task G1.1: `sanitizeStreamingMarkdown` pure function

**Files:**
- Create: `frontend/src/components/markdown/sanitize.ts`
- Test: `frontend/src/components/markdown/__tests__/sanitize.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/markdown/__tests__/sanitize.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { sanitizeStreamingMarkdown } from '../sanitize'

describe('sanitizeStreamingMarkdown', () => {
  it('closes an unclosed code fence', () => {
    const out = sanitizeStreamingMarkdown('text\n```rust\nfn main() {')
    // odd number of ``` → one appended
    expect((out.match(/```/g) || []).length % 2).toBe(0)
  })

  it('leaves balanced fences untouched', () => {
    const src = 'a\n```js\nx\n```\nb'
    expect(sanitizeStreamingMarkdown(src)).toBe(src)
  })

  it('demotes a half-written table row so it is not parsed as a table', () => {
    const out = sanitizeStreamingMarkdown('intro\n| col a | col')
    // the dangling pipe row must not start with a bare | that gfm reads as table
    expect(out.split('\n').pop()!.startsWith('| col a')).toBe(false)
  })

  it('balances an unclosed $$ math block', () => {
    const out = sanitizeStreamingMarkdown('see $$x = 1')
    expect((out.match(/\$\$/g) || []).length % 2).toBe(0)
  })

  it('does not corrupt shell text with single $ (currency/var)', () => {
    const src = 'run `echo $HOME` costs $5'
    expect(sanitizeStreamingMarkdown(src)).toBe(src)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/markdown/__tests__/sanitize.test.ts`
Expected: FAIL — cannot resolve `../sanitize`.

- [ ] **Step 3: Implement the heuristic sanitizer**

Create `frontend/src/components/markdown/sanitize.ts`:

```typescript
// Heuristic sanitizer for STREAMING (incomplete) markdown only. Narrowed to the
// three high-frequency breakages that make react-markdown misrender mid-stream:
// unclosed code fences, half-written table rows, unbalanced $$ math. NOT a full
// parser — once isComplete, MarkdownContent uses the raw text so final render is
// always exact (spec G1). Single-$ is deliberately left alone to avoid corrupting
// shell/currency text.

export function sanitizeStreamingMarkdown(text: string): string {
  let out = text

  // 1. Unclosed code fence: odd count of ``` → append a closing fence.
  const fences = (out.match(/```/g) || []).length
  if (fences % 2 === 1) {
    out += (out.endsWith('\n') ? '' : '\n') + '```'
  }

  // 2. Unbalanced $$ block math: odd count → append closing $$.
  const blockMath = (out.match(/\$\$/g) || []).length
  if (blockMath % 2 === 1) {
    out += '$$'
  }

  // 3. Half-written final table row: a last line that begins with `|` but has no
  // trailing newline (still streaming) AND no separator row above → escape the
  // leading pipe so gfm doesn't try to parse a malformed table. Only touch the
  // LAST line, only when we're mid-stream (no trailing newline).
  if (!text.endsWith('\n')) {
    const lines = out.split('\n')
    const last = lines[lines.length - 1]
    if (/^\s*\|/.test(last)) {
      lines[lines.length - 1] = last.replace(/^(\s*)\|/, '$1\\|')
      out = lines.join('\n')
    }
  }

  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/markdown/__tests__/sanitize.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/markdown/sanitize.ts frontend/src/components/markdown/__tests__/sanitize.test.ts
git commit -m "feat(markdown): sanitizeStreamingMarkdown pure fn (G1)"
```

### Task G1.2: Call sanitize from MarkdownContent when streaming

**Files:**
- Modify: `frontend/src/components/markdown/MarkdownContent.tsx:34-66`

- [ ] **Step 1: Apply sanitize for the incomplete case**

In `MarkdownContent.tsx`, import and use it:

```typescript
import { sanitizeStreamingMarkdown } from './sanitize'
// ...
export default function MarkdownContent({ text, isComplete, className }: Props) {
  const deferredText = useDeferredValue(text)
  const rendered = isComplete ? deferredText : sanitizeStreamingMarkdown(deferredText)
  const needsKatex = useMemo(() => hasMathSyntax(rendered), [rendered])
  // ... pass {rendered} to <ReactMarkdown> instead of {deferredText}
```

Update the `hasMathSyntax(deferredText)` call and the `<ReactMarkdown>{deferredText}</ReactMarkdown>` to use `rendered`.

- [ ] **Step 2: Verify build + existing markdown tests**

Run: `cd frontend && npx vitest run src/components/markdown/ && npm run build`
Expected: PASS + builds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/markdown/MarkdownContent.tsx
git commit -m "feat(markdown): sanitize streaming text before parse (G1)"
```

### Task G1.2b: Confirm mermaid stays pending while streaming (spec G1 ②)

**Files:**
- Verify only: `frontend/src/components/markdown/CodeBlock.tsx:22-32`

- [ ] **Step 1: Confirm the existing guard**

Read `CodeBlock.tsx`. Confirm the `lang === 'mermaid'` branch already returns `.mermaid-pending` `<pre>` when `!isComplete` and only renders `<MermaidBlock>` when `isComplete`. This is **already implemented** — spec G1 ② is a confirmation, not a change. No edit needed.

- [ ] **Step 2: Note in commit if a regression test is worth adding**

If `CodeBlock.test.tsx` does not already assert the pending-while-streaming behavior, this is a no-op task — the behavior is correct in source. Do not add code. Move on to G1.3.

### Task G1.3: MermaidBlock — hash cache key, no write on error

**Files:**
- Modify: `frontend/src/components/markdown/MermaidBlock.tsx`
- Test: `frontend/src/components/markdown/__tests__/MermaidBlock.test.tsx` (extend existing)

- [ ] **Step 1: Write the failing test**

Add to `MermaidBlock.test.tsx` (or create a cache-focused test). Since rendering needs the mermaid lib, test the **cache key contract** by asserting the cache is keyed by hash and not written on parse failure. If the existing test file mocks `mermaid`, extend that mock to throw and assert `mermaidCache` stays empty:

```typescript
import { mermaidCache } from '../cache'
import { fnv1a } from '../hash'
// ... within a test, after rendering an invalid diagram that makes m.parse throw:
it('does not cache on render error', async () => {
  mermaidCache.clear()
  // render <MermaidBlock code="!!!invalid!!!" /> with mermaid mocked to throw
  // ... await error state ...
  expect(mermaidCache.has(fnv1a('!!!invalid!!!'))).toBe(false)
  expect(mermaidCache.size).toBe(0)
})
```

> If the existing test harness doesn't already mock `mermaid`, follow the mocking pattern already in `MermaidBlock.test.tsx`. If none exists, add `vi.mock('mermaid', ...)` returning an object whose `parse` rejects.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/markdown/__tests__/MermaidBlock.test.tsx`
Expected: FAIL — current code caches by raw `code` string, and the assertion on `fnv1a` key fails.

- [ ] **Step 3: Change the cache key to the hash + keep error out of cache**

In `MermaidBlock.tsx`:

```typescript
import { fnv1a } from './hash'
// ...
export default function MermaidBlock({ code }: Props) {
  const key = fnv1a(code)
  const cached = mermaidCache.get(key)
  const [state, setState] = useState<State>(
    cached ? { kind: 'svg', svg: cached } : { kind: 'pending' }
  )

  useEffect(() => {
    if (state.kind === 'svg') return
    let cancel = false
    ;(async () => {
      try {
        const m = (await import('mermaid')).default
        m.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
        await m.parse(code)
        const id = `mid-${key}`
        const { svg } = await m.render(id, code)
        if (cancel) return
        mermaidCache.set(key, svg)   // only on success
        setState({ kind: 'svg', svg })
      } catch (e) {
        if (cancel) return
        setState({ kind: 'error', msg: String(e).slice(0, 200) })
        // do NOT write cache on error (was already the case; key change makes
        // partial-prefix collisions impossible since keys are content hashes)
      }
    })()
    return () => { cancel = true }
  }, [code, key, state.kind])
  // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/markdown/__tests__/MermaidBlock.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/markdown/MermaidBlock.tsx frontend/src/components/markdown/__tests__/MermaidBlock.test.tsx
git commit -m "fix(mermaid): hash cache key, success-only cache write (G1)"
```

---

## G2b — QueueMode (backend) + density 精简 (frontend)

### Task G2b.1: `QueueMode` enum + per-session field

**Files:**
- Modify: `src/session_manager.rs` (enum + session struct field + setter)
- Test: inline `#[cfg(test)]`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn queue_mode_parses_and_defaults_collect() {
    assert_eq!(QueueMode::from_str("collect"), QueueMode::Collect);
    assert_eq!(QueueMode::from_str("interrupt"), QueueMode::Interrupt);
    assert_eq!(QueueMode::from_str("passthrough"), QueueMode::Passthrough);
    assert_eq!(QueueMode::from_str("garbage"), QueueMode::Collect); // default
}

#[test]
fn passthrough_falls_back_to_collect_for_acp() {
    // Kiro (ACP) has no concurrent-turn semantics → passthrough degrades.
    assert_eq!(QueueMode::Passthrough.effective_for_acp(true), QueueMode::Collect);
    assert_eq!(QueueMode::Passthrough.effective_for_acp(false), QueueMode::Passthrough);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test queue_mode`
Expected: FAIL — no `QueueMode`.

- [ ] **Step 3: Implement the enum**

Add to `src/session_manager.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueMode {
    Collect,
    Interrupt,
    Passthrough,
}

impl QueueMode {
    fn from_str(s: &str) -> Self {
        match s {
            "interrupt" => QueueMode::Interrupt,
            "passthrough" => QueueMode::Passthrough,
            _ => QueueMode::Collect,
        }
    }
    /// ACP backends (Kiro) lack independent concurrent-turn semantics, so
    /// passthrough degrades to collect there (spec, matches naozhi).
    fn effective_for_acp(self, is_acp: bool) -> QueueMode {
        if is_acp && self == QueueMode::Passthrough { QueueMode::Collect } else { self }
    }
}
```

- [ ] **Step 4: Verify**

Run: `cargo test queue_mode`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(queue): QueueMode enum + ACP passthrough fallback (G2b)"
```

### Task G2b.2: Apply QueueMode in the shared prompt-handling path

**Files:**
- Modify: `src/session_manager.rs` — the prompt arm in the three fan-outs (or the shared helper if G2a centralized it), `ClientMsg::SetQueueMode`, `SessionInput::SetQueueMode`

- [ ] **Step 1: Add the control-plane plumbing**

`ClientMsg` (ws_handler.rs:24):

```rust
    #[serde(rename = "set_queue_mode")]
    SetQueueMode { mode: String },
```

`SessionInput`:

```rust
    SetQueueMode(QueueMode),
```

ws send site:

```rust
                                    ClientMsg::SetQueueMode { mode } => {
                                        let _ = input_tx.send(
                                            SessionInput::SetQueueMode(QueueMode::from_str(&mode))
                                        ).await;
                                    }
```

- [ ] **Step 2: Hold `queue_mode` as fan-out local state + handle the input**

In each fan-out, add `let mut queue_mode = QueueMode::Collect;` near `queue`. Add an input arm:

```rust
                        Some(SessionInput::SetQueueMode(m)) => {
                            queue_mode = m.effective_for_acp(IS_ACP);
                            // Mode change applies to FUTURE inputs only; in-flight
                            // pending batch keeps its current policy (no reflush).
                        }
```

(`IS_ACP` = `true` in kiro fan-out, `false` in claude/codex.)

- [ ] **Step 3: Branch the prompt arm on `queue_mode`**

In the prompt arm, after the `UserPrompt` emit, branch:

```rust
                            match queue_mode {
                                QueueMode::Interrupt if local_running => {
                                    // interrupt current turn, then send immediately
                                    if let Err(e) = process.interrupt().await {
                                        tracing::warn!("interrupt (queue mode) failed for {}: {}", sid, e);
                                    }
                                    queue.clear();
                                    turn_seq += 1;
                                    local_running = true;
                                    if let Some(m) = mgr.upgrade() { m.mark_turn(&sid, TurnState::Running, turn_seq); }
                                    let _ = process.send_prompt(&text).await;
                                }
                                QueueMode::Passthrough => {
                                    // each prompt sent independently, no queueing
                                    turn_seq += 1;
                                    local_running = true;
                                    if let Some(m) = mgr.upgrade() { m.mark_turn(&sid, TurnState::Running, turn_seq); }
                                    let _ = process.send_prompt(&text).await;
                                }
                                _ => {
                                    // Collect (default) — existing run_id/running/window/idle branches
                                }
                            }
```

> Keep the existing collect branches under the `_ =>` arm (run_id bypass still first). This is the one place the policy lives now (thanks to G2a).

- [ ] **Step 4: Verify**

Run: `cargo test && cargo build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/session_manager.rs src/acp/ws_handler.rs
git commit -m "feat(queue): apply QueueMode in prompt path (collect/interrupt/passthrough) (G2b)"
```

### Task G2b.3: Frontend QueueMode dropdown in SessionInfoBar

**Files:**
- Modify: `frontend/src/components/SessionInfoBar.tsx`, `frontend/src/components/AcpChatView.tsx`

- [ ] **Step 1: Add a dropdown that sends `set_queue_mode`**

In `SessionInfoBar.tsx` add a `<select>` (Collect / Interrupt / Passthrough) whose onChange calls a passed-in `onQueueMode(mode)` prop. In `AcpChatView`, implement `onQueueMode = (mode) => wsRef.current?.send(JSON.stringify({ type: 'set_queue_mode', mode }))`. Default display: Collect.

- [ ] **Step 2: Verify build + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: builds, no lint errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/SessionInfoBar.tsx frontend/src/components/AcpChatView.tsx
git commit -m "feat(queue): per-session QueueMode dropdown (G2b)"
```

### Task G2b.4: Density filter (concise/full) with trust guardrails

**Files:**
- Create: `frontend/src/lib/density.ts`
- Test: `frontend/src/components/__tests__/density.test.ts`
- Modify: `frontend/src/components/AcpChatView.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/__tests__/density.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { partitionBlocks } from '../../lib/density'
import type { Block } from '../../lib/transcript'

const blocks: Block[] = [
  { type: 'text', text: 'the answer' },
  { type: 'thinking', text: 'hmm' },
  { type: 'tool_use', name: 'Read', input: { path: '/x' }, summary: 'x/y' },
]

describe('partitionBlocks density', () => {
  it('concise: shows text + tool summary, hides thinking + raw input', () => {
    const { visible, collapsedCount } = partitionBlocks(blocks, 'concise')
    expect(visible.map(b => b.type)).toEqual(['text', 'tool_use'])
    expect(visible.find(b => b.type === 'tool_use')?.input).toBeUndefined() // raw input stripped
    expect(collapsedCount).toBe(1) // the thinking block
  })

  it('full: shows everything', () => {
    const { visible, collapsedCount } = partitionBlocks(blocks, 'full')
    expect(visible).toHaveLength(3)
    expect(collapsedCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/__tests__/density.test.ts`
Expected: FAIL — cannot resolve `../../lib/density`.

- [ ] **Step 3: Implement the partition**

Create `frontend/src/lib/density.ts`:

```typescript
// Output-side density filter (spec G2b). concise = mobile triage: show signal
// (text, errors, tool "what" summary), collapse noise (thinking, raw tool input).
// Lossless: nothing is dropped from the underlying data — collapsedCount drives a
// visible "+N · 展开" placeholder so users never think the agent skipped steps (P2).
import type { Block } from './transcript'

export type { Block }
export type Density = 'concise' | 'full'

export function partitionBlocks(blocks: Block[], density: Density): {
  visible: Block[]
  collapsedCount: number
} {
  if (density === 'full') return { visible: blocks, collapsedCount: 0 }

  let collapsed = 0
  const visible: Block[] = []
  for (const b of blocks) {
    if (b.type === 'thinking') { collapsed++; continue }
    if (b.type === 'tool_use') {
      // keep the one-line "what" (name · summary), drop raw input
      visible.push({ type: 'tool_use', name: b.name, summary: b.summary })
      continue
    }
    visible.push(b) // text, tool_result, etc. = signal
  }
  return { visible, collapsedCount: collapsed }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/__tests__/density.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into AcpChatView with default concise + placeholder + first-use hint**

In `AcpChatView`:
- `const [density, setDensity] = useState<Density>('concise')`.
- When rendering a turn group's blocks, run `partitionBlocks(g.blocks, density)`; render `visible`, and if `collapsedCount > 0` render a clickable `+{collapsedCount} 条思考/工具 · 展开` chip that toggles that bubble (or the session) to full.
- First-use hint: on first mount, if `localStorage.getItem('zeromux:density-hint') == null`, show a one-time toast/line「已为你精简显示，可切完整」, then `localStorage.setItem('zeromux:density-hint','1')`.

- [ ] **Step 6: Verify build + all frontend tests**

Run: `cd frontend && npx vitest run && npm run build && npm run lint`
Expected: PASS + builds + clean lint.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/density.ts frontend/src/components/__tests__/density.test.ts frontend/src/components/AcpChatView.tsx
git commit -m "feat(chat): concise/full density filter with visible collapse + first-use hint (G2b, P2)"
```

---

## Final verification

- [ ] **Backend full test + build**

Run: `cargo test && cargo build`
Expected: all PASS, builds.

- [ ] **Frontend full test + build + lint**

Run: `cd frontend && npx vitest run && npm run build && npm run lint`
Expected: all PASS.

- [ ] **Manual end-to-end checklist (the three reported bugs)**

1. **错位**: send 3 messages fast while busy → 3 user bubbles in one turn group, 1 answer. Reconnect → same. Send while streaming → new bubble after the answer, not spliced in. Two devices → no doubled events.
2. **渲染**: stream a long code block + a table + `$x$` math → no mid-stream misrender; mermaid renders once, no stuck pending.
3. **naozhi**: switch QueueMode to interrupt/passthrough → behavior changes; concise default hides thinking/tool-input with a visible "+N" chip; expand works.

- [ ] **Deploy** (only when asked): `./deploy.sh --build` (never hand-run systemctl from a zeromux terminal — see CLAUDE.md cgroup trap).
