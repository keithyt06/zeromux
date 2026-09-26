# Claude 跨会话消息外部 turn 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ZeroMux 把 Claude CLI 因跨会话消息 / 后台任务通知而自开的 turn 当作一等 turn：可见、计数正确、busy 正确。

**Architecture:** 进程层（`src/acp/process.rs`）开启 `--replay-user-messages` + `accept`，把 `user.origin.kind=="peer"` 翻成 `PeerMessage`、把 `result.origin` 翻成内部标记 `TurnOrigin`、把 `system/informational` 翻成 `Notice`。Claude fan-out（`spawn_acp_fanout`，只有 Claude 用）用一个纯函数 `classify_claude_event` 决定每个事件是「开外部 turn / 跳过 boundary / 正常」，`TurnStarts` 条目记录 turn 来源。前端渲染 `peer_message` 气泡与 `notice` 提示。

**Tech Stack:** Rust（tokio、serde_json），React 19 + TypeScript，vitest。

**Spec:** `docs/superpowers/specs/2026-09-26-cross-session-external-turn-design.md`

## Global Constraints

- 只改 Claude 路径：`AcpProcess::spawn` / `spawn_titler` / `translate_event` / `spawn_acp_fanout`。Codex（`spawn_codex_fanout`）与 Crew（`spawn_crew_fanout`）行为不得变化。
- spawn 追加参数，原文：`--replay-user-messages`、`--settings '{"crossSessionInbound":"accept"}'`；titler 追加 `--settings '{"crossSessionInbound":"refuse"}'`。
- `TurnOrigin` 永不 emit、永不写 scrollback、永不进 `log_result_event`。
- `Notice` 不得用 `ContentBlock` 承载（空闲期到达会被误判为外部 turn 开始）。
- 保持 broadcast fan-out 不变量：fan-out 是进程的唯一所有者；所有 turn 开始走 `turn_seq += 1` → `local_running = true` → `turn_starts.start*()` → `mark_turn(Running, turn_seq)` 四步。
- 代码注释英文，用户可见字符串中文（「来自 @{from_name}」）。
- 每个判定测试先注释掉对应守卫验红，再恢复验绿（项目 review 惯例）。
- 构建：前端须先 `cd frontend && npm run build`，Rust 才能编译；迭代用 `cargo test`（debug）。

## Review Focus

1. **空闲期的非输出事件**（`system/task_updated`、`background_tasks_changed`、hold 回执 `informational`）到达时不得开 turn —— 否则会话永远 Running 直到 watchdog。→ Task 3 测试 `idle_system_and_notice_do_not_start_turn`。
2. **队首为空时带 origin 的 boundary**（钳制后的多余边界、或外部 turn 已被前一个无 origin 的 Exit 结算）必须跳过，不能 settle 出 None 后又把 `boundary_count` 推过 `turn_seq`。→ Task 3 测试 `origin_boundary_with_empty_fifo_is_skipped`。
3. **外部 turn 进行中用户点 Interrupt**：Cancelled intent 必须打在外部条目上，且 `front_is_external()` 在 intent 打上后仍为 true。→ Task 2 测试 `set_live_intent_on_external_entry_keeps_source`。
4. **collect 窗口已 arm 时外部 turn 开始**：必须 `queue.disarm()` 且保留 `pending`，否则合并 prompt 会在外部 turn 进行中 flush（mid-turn 强打断）。→ Task 4 Step 3 代码 + 端到端第 2 项。
5. **peer body 超大**（接近 CLI 的 ~1M 字符上限）：必须经 `truncate_prompt_for_scrollback`，否则单帧撑爆 2MB scrollback。→ Task 4 测试 `peer_message_text_is_truncated_for_scrollback`。

---

## File Structure

| 文件 | 改动 | 职责 |
|---|---|---|
| `src/acp/process.rs` | Modify | 3 个新 `AcpEvent` 变体；spawn/titler 参数；`translate_event` 三个分支；单元测试 |
| `src/session_manager.rs` | Modify | `TurnStarts` 加来源；新纯函数 `classify_claude_event` + `Step`；`spawn_acp_fanout` 接线；`with_turn_id`/`emit` 盖 `PeerMessage` 的 turn_id；单元测试 |
| `frontend/src/lib/transcript.ts` | Modify | `WireEvent.from_name`；`userPrompts[].fromName`；`peer_message` 归组；signature 含 fromName |
| `frontend/src/components/AcpChatView.tsx` | Modify | `ServerEvent.from_name/level`；`peer_message`、`notice` 分支；气泡渲染 |
| `frontend/src/components/__tests__/transcript.test.ts` | Modify | `peer_message` 归组测试 |

---

### Task 1: 进程层 —— 新事件变体、spawn 参数、`translate_event`

**Files:**
- Modify: `src/acp/process.rs`（enum `AcpEvent` 约 :27-130；`spawn` :143-173；`spawn_titler` :186-211；`translate_event` :293-401；`mod tests` :403+）

**Interfaces:**
- Consumes: 无
- Produces:
  - `AcpEvent::PeerMessage { from_name: String, text: String, turn_id: u64 }`（serde tag `peer_message`）
  - `AcpEvent::TurnOrigin { kind: StaticOrOwnedStr }`（serde tag `turn_origin`，仅内部）
  - `AcpEvent::Notice { text: String, level: StaticOrOwnedStr }`（serde tag `notice`）
  - `translate_event` 输出顺序：带 origin 的 `result` → `[TurnOrigin, Result|Error]`

- [ ] **Step 1: 写失败测试**（追加到 `src/acp/process.rs` 的 `mod tests`）

Fixture 取自 2026-09-26 实测 NDJSON（已删去无关字段）。

```rust
    // ── cross-session external turn (spec 2026-09-26) ──
    // Fixtures are trimmed copies of real CLI 2.1.282 stream-json lines.

    #[test]
    fn peer_user_event_becomes_peer_message() {
        let v = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": "Another Claude session sent a message:\n<cross-session-message from=\"uds:/tmp/cc-socks/39894.sock\" from-name=\"zeromux-98\" from-mode=\"bypass\">\nIDLE-PROBE\n</cross-session-message>"},
            "isSynthetic": true, "isReplay": true,
            "origin": {"kind": "peer", "from": "uds:/tmp/cc-socks/39894.sock", "name": "zeromux-98",
                       "fromMode": "bypass", "msg_id": "m1", "body": "IDLE-PROBE"}
        });
        let evts = translate_event(&v);
        assert_eq!(evts.len(), 1);
        match &evts[0] {
            AcpEvent::PeerMessage { from_name, text, turn_id } => {
                assert_eq!(from_name, "zeromux-98");
                assert_eq!(text, "IDLE-PROBE");
                assert_eq!(*turn_id, 0);
            }
            other => panic!("expected PeerMessage, got {other:?}"),
        }
    }

    #[test]
    fn peer_user_event_without_name_uses_unknown() {
        let v = serde_json::json!({
            "type": "user", "message": {"role": "user", "content": "x"},
            "origin": {"kind": "peer", "body": "hi"}
        });
        match &translate_event(&v)[0] {
            AcpEvent::PeerMessage { from_name, text, .. } => {
                assert_eq!(from_name, "unknown");
                assert_eq!(text, "hi");
            }
            other => panic!("expected PeerMessage, got {other:?}"),
        }
    }

    #[test]
    fn stdin_replay_and_tool_result_user_events_are_dropped() {
        let replay = serde_json::json!({
            "type": "user", "isReplay": true,
            "message": {"role": "user", "content": [{"type": "text", "text": "reply only: ok"}]}
        });
        assert!(translate_event(&replay).is_empty());
        let tool_result = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": [{"tool_use_id": "t1", "type": "tool_result", "content": "ok"}]}
        });
        assert!(translate_event(&tool_result).is_empty());
    }

    #[test]
    fn result_with_origin_is_preceded_by_turn_origin() {
        let v = serde_json::json!({
            "type": "result", "subtype": "success", "is_error": false,
            "result": "pong", "session_id": "s1",
            "origin": {"kind": "peer", "name": "zeromux-98", "body": "x"}
        });
        let evts = translate_event(&v);
        assert_eq!(evts.len(), 2);
        match &evts[0] {
            AcpEvent::TurnOrigin { kind } => assert_eq!(kind, "peer"),
            other => panic!("expected TurnOrigin, got {other:?}"),
        }
        assert!(matches!(evts[1], AcpEvent::Result { .. }));
    }

    #[test]
    fn error_result_with_origin_is_preceded_by_turn_origin() {
        let v = serde_json::json!({
            "type": "result", "subtype": "error_during_execution", "is_error": true,
            "session_id": "s1", "origin": {"kind": "task-notification"}
        });
        let evts = translate_event(&v);
        assert_eq!(evts.len(), 2);
        match &evts[0] {
            AcpEvent::TurnOrigin { kind } => assert_eq!(kind, "task-notification"),
            other => panic!("expected TurnOrigin, got {other:?}"),
        }
        assert!(matches!(evts[1], AcpEvent::Error { .. }));
    }

    #[test]
    fn result_without_origin_has_no_turn_origin() {
        let v = serde_json::json!({
            "type": "result", "subtype": "success", "is_error": false,
            "result": "ok", "session_id": "s1"
        });
        let evts = translate_event(&v);
        assert_eq!(evts.len(), 1);
        assert!(matches!(evts[0], AcpEvent::Result { .. }));
    }

    #[test]
    fn informational_system_becomes_notice() {
        let v = serde_json::json!({
            "type": "system", "subtype": "informational", "level": "warning",
            "content": "Cross-session message held for approval (recipient: uds:/tmp/cc-socks/1.sock)."
        });
        let evts = translate_event(&v);
        assert_eq!(evts.len(), 1);
        match &evts[0] {
            AcpEvent::Notice { text, level } => {
                assert!(text.starts_with("Cross-session message held"));
                assert_eq!(level, "warning");
            }
            other => panic!("expected Notice, got {other:?}"),
        }
    }

    #[test]
    fn new_events_serialize_with_expected_tags() {
        let p = serde_json::to_string(&AcpEvent::PeerMessage {
            from_name: "a".into(), text: "b".into(), turn_id: 3 }).unwrap();
        assert!(p.contains("\"type\":\"peer_message\""));
        assert!(p.contains("\"from_name\":\"a\""));
        assert!(p.contains("\"turn_id\":3"));
        let n = serde_json::to_string(&AcpEvent::Notice {
            text: "t".into(), level: StaticOrOwnedStr::Borrowed("info") }).unwrap();
        assert!(n.contains("\"type\":\"notice\""));
        assert!(n.contains("\"level\":\"info\""));
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin zeromux acp::process::tests 2>&1 | tail -20`
Expected: 编译错误 `no variant named PeerMessage` / `TurnOrigin` / `Notice`。

- [ ] **Step 3: 加 enum 变体**（`AcpEvent` 里 `ContextUsage { .. },` 之后、闭合 `}` 之前）

```rust
    /// A message delivered by Claude Code cross-session messaging (another
    /// local/remote Claude session's `SendMessage`). Emitted from the CLI's
    /// `--replay-user-messages` echo when `origin.kind == "peer"`. `text` is the
    /// peer's body only (not the CLI's wrapper prose). `turn_id` is stamped by the
    /// fan-out, like ContentBlock. Frontend renders a 「来自 @from_name」 bubble.
    PeerMessage {
        from_name: String,
        text: String,
        turn_id: u64,
    },
    /// Fan-out-internal marker: the NEXT event (Result/Error) ends a turn the CLI
    /// started on its own (`result.origin.kind`, e.g. "peer" / "task-notification").
    /// Consumed by `spawn_acp_fanout`; never emitted, persisted, or logged.
    TurnOrigin {
        kind: StaticOrOwnedStr,
    },
    /// CLI `system/informational` notice (e.g. a cross-session message this
    /// session sent was held / refused / expired). Rendered as a grey notice line.
    /// Deliberately NOT a ContentBlock: arriving while idle it must not look like
    /// agent output (which would start an external turn).
    Notice {
        text: String,
        level: StaticOrOwnedStr,
    },
```

- [ ] **Step 4: `translate_event` 三处改动**

4a. `"system"` 分支：在 `IGNORED_SUBTYPES` 判断之后、`vec![AcpEvent::System {..}]` 之前插入：

```rust
            if subtype == "informational" {
                let text = val.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let level = match val.get("level").and_then(|v| v.as_str()).unwrap_or("info") {
                    "warning" => StaticOrOwnedStr::Borrowed("warning"),
                    "info" => StaticOrOwnedStr::Borrowed("info"),
                    other => StaticOrOwnedStr::Owned(other.to_string()),
                };
                return vec![AcpEvent::Notice { text, level }];
            }
```

4b. 在 `"result" => {` 分支之前新增 `"user"` 分支：

```rust
        // `--replay-user-messages` echoes every turn-driving input as a `user`
        // event. Only cross-session peer messages are surfaced: ZeroMux already
        // emits its own UserPrompt for stdin prompts, and tool_result echoes are
        // noise. `origin` is structured, so no parsing of the
        // <cross-session-message> wrapper text is needed.
        "user" => {
            let Some(origin) = val.get("origin") else { return vec![] };
            if origin.get("kind").and_then(|v| v.as_str()) != Some("peer") {
                return vec![];
            }
            vec![AcpEvent::PeerMessage {
                from_name: origin.get("name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string(),
                text: origin.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                turn_id: 0,
            }]
        }
```

4c. `"result"` 分支：把整个分支体改为先算 `terminal: AcpEvent`，再按 origin 包装。在分支最开头加：

```rust
            // A result carrying `origin` ends a turn the CLI started by itself
            // (peer message, background task notification). Precede the terminal
            // event with a TurnOrigin marker so the fan-out can attribute the
            // boundary (spec §2d).
            let origin_kind = val
                .get("origin")
                .and_then(|o| o.get("kind"))
                .and_then(|v| v.as_str())
                .map(|k| match k {
                    "peer" => StaticOrOwnedStr::Borrowed("peer"),
                    "task-notification" => StaticOrOwnedStr::Borrowed("task-notification"),
                    other => StaticOrOwnedStr::Owned(other.to_string()),
                });
            let wrap = |terminal: AcpEvent| -> Vec<AcpEvent> {
                match origin_kind.clone() {
                    Some(kind) => vec![AcpEvent::TurnOrigin { kind }, terminal],
                    None => vec![terminal],
                }
            };
```

然后把分支里的两处返回改为经过 `wrap`：
- `return vec![AcpEvent::Error { message }];` → `return wrap(AcpEvent::Error { message });`
- 末尾 `vec![AcpEvent::Result { ... }]` → `wrap(AcpEvent::Result { ... })`（字段内容不变）

- [ ] **Step 5: spawn 参数**

`spawn` 的 `args` 向量里，`"--dangerously-skip-permissions".into(),` 之后追加：

```rust
            // Cross-session messaging (spec 2026-09-26): echo peer messages on
            // stdout so the fan-out can see and attribute CLI-started turns, and
            // accept messages from non-bypass senders too (a `-p` session has no
            // approval dialog; held messages would silently expire).
            "--replay-user-messages".into(),
            "--settings".into(), r#"{"crossSessionInbound":"accept"}"#.into(),
```

`spawn_titler` 的 `args` 向量里，`"--allowedTools".into(), "".into(),` 之后追加：

```rust
            // The titler reads the FIRST Result as the title; a peer message
            // starting a turn here would poison it. Refuse all inbound.
            "--settings".into(), r#"{"crossSessionInbound":"refuse"}"#.into(),
```

- [ ] **Step 6: 编译（其余 match 可能不穷尽）并跑测试**

Run: `cargo test --bin zeromux acp::process::tests 2>&1 | tail -20`
Expected: 8 个新测试 PASS，原有测试 PASS。若报 `non-exhaustive patterns`，在报错的 match 加 `AcpEvent::PeerMessage { .. } | AcpEvent::TurnOrigin { .. } | AcpEvent::Notice { .. } => {}`（或对应的空/默认臂），不改其他行为。

- [ ] **Step 7: 验红**：把 4b 中 `!= Some("peer")` 改成 `== Some("peer")`，跑 `peer_user_event_becomes_peer_message` 确认 FAIL；恢复。把 4c 的 `wrap(AcpEvent::Result {` 改回 `vec![AcpEvent::Result {`（配 `]`），确认 `result_with_origin_is_preceded_by_turn_origin` FAIL；恢复。

- [ ] **Step 8: 全量 Rust 测试 + 提交**

Run: `cargo test 2>&1 | grep -E "^test result|FAILED|panicked" | head`
Expected: 全部 `ok`。

```bash
git add src/acp/process.rs
git commit -m "feat(acp): translate Claude cross-session peer messages, turn origin, informational notices

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

> 注意：本 Task 提交后、Task 4 接线前，`TurnOrigin` 会经 `emit` 被广播/写 scrollback（它仍是普通事件）。若分开部署会有前端未知事件；**不要在 Task 4 完成前部署**。

---

### Task 2: `TurnStarts` 记录 turn 来源

**Files:**
- Modify: `src/session_manager.rs`（`struct TurnStarts` / `impl TurnStarts` 约 :2926-2964；其三处 `settle().and_then(|(_, o)| o)` 调用 :2612、:3346、:3642；测试模块 :4412 附近）

**Interfaces:**
- Consumes: 无
- Produces:
  - `TurnStarts::start_external(&mut self, ms: i64)`
  - `TurnStarts::front_is_external(&self) -> bool`（空 FIFO 返回 false）
  - `settle()` 返回类型**不变**：`Option<(i64, Option<RunOutcome>)>`（外部调用点无需改）

- [ ] **Step 1: 写失败测试**（放在 `turn_starts_fifo_pairs_each_boundary_with_its_own_turn` 同一个 `mod tests` 内，紧随其后）

```rust
    #[test]
    fn turn_starts_tracks_external_source_per_entry() {
        // Spec 2026-09-26 §2a: each FIFO entry records whether the turn was
        // started by the CLI itself (peer message / task notification) so the
        // boundary-attribution rule can tell an external turn's result from a
        // user turn's.
        let mut ts = TurnStarts::default();
        assert!(!ts.front_is_external(), "empty FIFO is not external");
        ts.start_external(1_000);
        ts.start(2_000);
        assert!(ts.front_is_external());
        assert_eq!(ts.settle(), Some((1_000, None)));
        assert!(!ts.front_is_external(), "user turn is internal");
        assert_eq!(ts.settle(), Some((2_000, None)));
        assert!(!ts.front_is_external());
    }

    #[test]
    fn set_live_intent_on_external_entry_keeps_source() {
        use crate::run_metrics::RunOutcome;
        // Review focus 3: Interrupt during an external turn stamps Cancelled on
        // the external entry without losing its source flag.
        let mut ts = TurnStarts::default();
        ts.start_external(1_000);
        ts.set_live_intent(RunOutcome::Cancelled);
        assert!(ts.front_is_external());
        assert_eq!(ts.front_intent(), Some(RunOutcome::Cancelled));
        assert_eq!(ts.settle(), Some((1_000, Some(RunOutcome::Cancelled))));
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin zeromux turn_starts_tracks_external 2>&1 | tail -5`
Expected: 编译错误 `no method named start_external`。

- [ ] **Step 3: 实现**——把 `TurnStarts` 的存储改成具名结构，公开方法签名保持不变：

```rust
#[derive(Default)]
struct TurnStarts {
    inner: VecDeque<TurnEntry>,
}

/// One pending turn: start stamp, outcome intent, and whether the CLI started it
/// on its own (cross-session peer message / task notification — spec 2026-09-26).
struct TurnEntry {
    ms: i64,
    intent: Option<crate::run_metrics::RunOutcome>,
    external: bool,
}

impl TurnStarts {
    /// A turn started at `ms`; enqueue its start-stamp with no intent yet.
    fn start(&mut self, ms: i64) {
        self.inner.push_back(TurnEntry { ms, intent: None, external: false });
    }

    /// A turn the CLI started by itself (no ZeroMux stdin write) began at `ms`.
    fn start_external(&mut self, ms: i64) {
        self.inner.push_back(TurnEntry { ms, intent: None, external: true });
    }

    /// Whether the oldest pending turn (the one the next boundary settles) was
    /// CLI-started. False on an empty FIFO.
    fn front_is_external(&self) -> bool {
        self.inner.front().is_some_and(|e| e.external)
    }

    fn set_live_intent(&mut self, outcome: crate::run_metrics::RunOutcome) {
        if let Some(back) = self.inner.back_mut() {
            back.intent = Some(outcome);
        }
    }

    fn front(&self) -> Option<i64> {
        self.inner.front().map(|e| e.ms)
    }

    fn front_intent(&self) -> Option<crate::run_metrics::RunOutcome> {
        self.inner.front().and_then(|e| e.intent)
    }

    fn settle(&mut self) -> Option<(i64, Option<crate::run_metrics::RunOutcome>)> {
        self.inner.pop_front().map(|e| (e.ms, e.intent))
    }
}
```

保留原有每个方法上的 doc 注释（只替换方法体）。

- [ ] **Step 4: 跑测试**

Run: `cargo test --bin zeromux turn_starts 2>&1 | grep -E "test |result"`
Expected: 新 2 个 + 原有 `turn_starts_*` / `intent_fifo_*` 全 PASS。

- [ ] **Step 5: 验红**：`front_is_external` 改为恒 `false`，确认 `turn_starts_tracks_external_source_per_entry` FAIL；恢复。

- [ ] **Step 6: 提交**

```bash
git add src/session_manager.rs
git commit -m "feat(fanout): TurnStarts records whether a turn was CLI-started

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 纯函数 `classify_claude_event`

**Files:**
- Modify: `src/session_manager.rs`（紧挨 `impl TurnStarts` 之后新增；测试放同一 `mod tests`）

**Interfaces:**
- Consumes: 无（纯函数，入参是布尔与事件引用）
- Produces:
  ```rust
  #[derive(Debug, PartialEq, Eq)]
  enum ClaudeStep { StartExternal, SkipBoundary, Normal }
  fn classify_claude_event(local_running: bool, evt: &AcpEvent,
                           has_pending_origin: bool, front_is_external: bool) -> ClaudeStep
  ```
  调用方先处理 `TurnOrigin`（置 `pending_origin` 并 `continue`），`TurnOrigin` 不会传入此函数。

- [ ] **Step 1: 写失败测试**

```rust
    // ── spec 2026-09-26 §2b/§2d: Claude external-turn classification ──
    fn cb() -> AcpEvent {
        AcpEvent::ContentBlock { block_type: "text".into(), turn_id: 0, text: Some("x".into()),
            name: None, input: None, streaming: None, summary: None }
    }
    fn res() -> AcpEvent {
        AcpEvent::Result { text: "r".into(), turn_id: 0, session_id: "s".into(),
            cost_usd: None, tokens_in: None, tokens_out: None }
    }
    fn peer() -> AcpEvent {
        AcpEvent::PeerMessage { from_name: "a".into(), text: "b".into(), turn_id: 0 }
    }

    #[test]
    fn idle_peer_message_starts_external_turn() {
        assert_eq!(classify_claude_event(false, &peer(), false, false), ClaudeStep::StartExternal);
    }

    #[test]
    fn idle_content_block_starts_external_turn() {
        // task-notification turns have no `user` event: first sign is output.
        assert_eq!(classify_claude_event(false, &cb(), false, false), ClaudeStep::StartExternal);
    }

    #[test]
    fn busy_peer_and_output_are_normal() {
        assert_eq!(classify_claude_event(true, &peer(), false, false), ClaudeStep::Normal);
        assert_eq!(classify_claude_event(true, &cb(), false, true), ClaudeStep::Normal);
    }

    #[test]
    fn idle_system_and_notice_do_not_start_turn() {
        // Review focus 1: lifecycle events arrive while idle (task_updated,
        // background_tasks_changed, hold receipts) and must not open a turn.
        let sys = AcpEvent::System { subtype: "task_updated".into(), session_id: None, count: None };
        let notice = AcpEvent::Notice { text: "held".into(), level: "warning".into() };
        let exit = AcpEvent::Exit { code: 0 };
        assert_eq!(classify_claude_event(false, &sys, false, false), ClaudeStep::Normal);
        assert_eq!(classify_claude_event(false, &notice, false, false), ClaudeStep::Normal);
        assert_eq!(classify_claude_event(false, &exit, false, false), ClaudeStep::Normal);
    }

    #[test]
    fn origin_boundary_settles_when_front_is_external() {
        assert_eq!(classify_claude_event(true, &res(), true, true), ClaudeStep::Normal);
        let err = AcpEvent::Error { message: "e".into() };
        assert_eq!(classify_claude_event(true, &err, true, true), ClaudeStep::Normal);
    }

    #[test]
    fn origin_boundary_skipped_when_front_is_user_turn() {
        // Race (spec §2d walkthrough): the user's prompt already counted turn N,
        // the CLI processed a peer message first; that result must not settle N.
        assert_eq!(classify_claude_event(true, &res(), true, false), ClaudeStep::SkipBoundary);
    }

    #[test]
    fn origin_boundary_with_empty_fifo_is_skipped() {
        // Review focus 2: nothing pending (front_is_external=false on empty FIFO).
        assert_eq!(classify_claude_event(false, &res(), true, false), ClaudeStep::SkipBoundary);
    }

    #[test]
    fn plain_boundary_is_normal() {
        assert_eq!(classify_claude_event(true, &res(), false, false), ClaudeStep::Normal);
        assert_eq!(classify_claude_event(true, &AcpEvent::Exit { code: 1 }, false, true), ClaudeStep::Normal);
    }

    #[test]
    fn race_sequence_end_to_end_on_turn_starts() {
        // Drive TurnStarts + classifier through the race: user prompt counted,
        // peer turn processed first by the CLI, then the user's own result.
        let mut ts = TurnStarts::default();
        let mut local_running = false;
        // user prompt written to stdin
        ts.start(1_000);
        local_running = true;
        // peer message echo arrives while busy → shown only
        assert_eq!(classify_claude_event(local_running, &peer(), false, ts.front_is_external()), ClaudeStep::Normal);
        // peer turn's result (with origin) → skipped, FIFO untouched
        assert_eq!(classify_claude_event(local_running, &res(), true, ts.front_is_external()), ClaudeStep::SkipBoundary);
        assert_eq!(ts.front(), Some(1_000));
        // user's result (no origin) → settles the user turn
        assert_eq!(classify_claude_event(local_running, &res(), false, ts.front_is_external()), ClaudeStep::Normal);
        assert_eq!(ts.settle(), Some((1_000, None)));
        let _ = local_running;
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin zeromux classify_claude 2>&1 | tail -5`（以及 `origin_boundary`、`race_sequence`）
Expected: 编译错误 `cannot find function classify_claude_event`。

- [ ] **Step 3: 实现**（`impl TurnStarts { .. }` 之后）

```rust
/// Per-event decision for the Claude fan-out's handling of CLI-started turns
/// (spec 2026-09-26 §2b/§2d). Pure so it is unit-testable without a process.
#[derive(Debug, PartialEq, Eq)]
enum ClaudeStep {
    /// Idle and the agent produced a peer message / output: the CLI started a
    /// turn on its own. Run the same four turn-start steps as a stdin prompt.
    StartExternal,
    /// A boundary whose `result.origin` says it ends a CLI-started turn, but the
    /// FIFO front is a ZeroMux turn (or nothing): the CLI processed a peer
    /// message ahead of our prompt. Emit it but do not settle anything.
    SkipBoundary,
    /// Everything else: existing handling.
    Normal,
}

fn classify_claude_event(
    local_running: bool,
    evt: &AcpEvent,
    has_pending_origin: bool,
    front_is_external: bool,
) -> ClaudeStep {
    // ZeroMux sets local_running BEFORE writing stdin, so output arriving while
    // idle can only come from a turn the CLI started itself. System / Notice /
    // Exit are lifecycle noise and never open a turn.
    if !local_running
        && matches!(evt, AcpEvent::PeerMessage { .. } | AcpEvent::ContentBlock { .. })
    {
        return ClaudeStep::StartExternal;
    }
    let is_boundary = matches!(
        evt,
        AcpEvent::Result { .. } | AcpEvent::Error { .. } | AcpEvent::Exit { .. }
    );
    if is_boundary && has_pending_origin && !front_is_external {
        return ClaudeStep::SkipBoundary;
    }
    ClaudeStep::Normal
}
```

- [ ] **Step 4: 跑测试**

Run: `cargo test --bin zeromux -- classify_claude idle_ busy_peer origin_boundary plain_boundary race_sequence 2>&1 | grep -E "test |result"`
Expected: 9 个 PASS。

- [ ] **Step 5: 验红**（各自恢复）
  - 删掉 `!local_running &&` → `busy_peer_and_output_are_normal` FAIL。
  - `matches!` 里加 `| AcpEvent::System { .. } | AcpEvent::Notice { .. }` → `idle_system_and_notice_do_not_start_turn` FAIL。
  - 删掉 `&& !front_is_external` → `origin_boundary_settles_when_front_is_external` FAIL。
  - 删掉 `has_pending_origin &&` → `plain_boundary_is_normal` FAIL。

- [ ] **Step 6: 提交**

```bash
git add src/session_manager.rs
git commit -m "feat(fanout): pure classifier for Claude CLI-started turns and origin boundaries

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `spawn_acp_fanout` 接线 + `PeerMessage` 的 turn_id 与截断

**Files:**
- Modify: `src/session_manager.rs`
  - `with_turn_id` :3167-3174
  - `emit` 内 `ContentBlock | Result` 盖值分支约 :3078-3084
  - `spawn_acp_fanout` 事件分支 `Some(evt) => {` :2452 起（`is_boundary` 计算 :2465-2468、`if is_boundary {` :2476）

**Interfaces:**
- Consumes: Task 1 `AcpEvent::{PeerMessage, TurnOrigin, Notice}`；Task 2 `start_external`/`front_is_external`；Task 3 `classify_claude_event`/`ClaudeStep`
- Produces: 无新接口（行为接线）

- [ ] **Step 1: 写失败测试**（`with_turn_id` 与截断）

```rust
    #[test]
    fn with_turn_id_stamps_peer_message() {
        let e = with_turn_id(AcpEvent::PeerMessage { from_name: "a".into(), text: "b".into(), turn_id: 0 }, 7);
        match e {
            AcpEvent::PeerMessage { turn_id, .. } => assert_eq!(turn_id, 7),
            other => panic!("expected PeerMessage, got {other:?}"),
        }
    }

    #[test]
    fn peer_message_text_is_truncated_for_scrollback() {
        // Review focus 5: a huge peer body must be capped like a UserPrompt.
        let big = "y".repeat(USER_PROMPT_SCROLLBACK_CAP + 10);
        let e = cap_peer_message(AcpEvent::PeerMessage { from_name: "a".into(), text: big, turn_id: 0 });
        match e {
            AcpEvent::PeerMessage { text, .. } => {
                assert!(text.len() < USER_PROMPT_SCROLLBACK_CAP + 64);
                assert!(text.contains("[已截断"));
            }
            other => panic!("expected PeerMessage, got {other:?}"),
        }
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin zeromux -- with_turn_id_stamps_peer peer_message_text_is_truncated 2>&1 | tail -5`
Expected: 第一个 FAIL（turn_id 仍为 0），第二个编译错误 `cannot find function cap_peer_message`。

- [ ] **Step 3: 实现 helper**

`with_turn_id` 加一臂：

```rust
        AcpEvent::PeerMessage { turn_id, .. } => *turn_id = tid,
```

`emit` 的盖值 match 改为：

```rust
        AcpEvent::ContentBlock { .. } | AcpEvent::Result { .. } | AcpEvent::PeerMessage { .. } => {
```

`truncate_prompt_for_scrollback` 之后新增：

```rust
/// Cap a peer message body before it enters scrollback — same budget as a
/// UserPrompt (a peer can send ~1M chars; spec 2026-09-26 review focus 5).
fn cap_peer_message(evt: AcpEvent) -> AcpEvent {
    match evt {
        AcpEvent::PeerMessage { from_name, text, turn_id } => AcpEvent::PeerMessage {
            from_name,
            text: truncate_prompt_for_scrollback(&text),
            turn_id,
        },
        other => other,
    }
}
```

- [ ] **Step 4: fan-out 接线**。在 `spawn_acp_fanout` 的局部变量区（`let mut turn_starts = TurnStarts::default();` 之后）加：

```rust
        // Spec 2026-09-26 §2d: set by a TurnOrigin marker, consumed by the very
        // next boundary. Some(kind) = that boundary ends a CLI-started turn.
        let mut pending_origin: Option<crate::acp::process::StaticOrOwnedStr> = None;
```

在 `Some(evt) => {` 分支的**最开头**（`log_result_event(...)` 之前）插入：

```rust
                            // TurnOrigin is a fan-out-internal marker: record it
                            // for the next boundary and drop it (never emitted,
                            // persisted or logged — spec 2026-09-26).
                            if let AcpEvent::TurnOrigin { kind } = evt {
                                pending_origin = Some(kind);
                                continue;
                            }
                            let evt = cap_peer_message(evt);
                            let step = classify_claude_event(
                                local_running, &evt, pending_origin.is_some(),
                                turn_starts.front_is_external());
                            if step == ClaudeStep::StartExternal {
                                // The CLI started a turn on its own (peer message or
                                // background-task notification). Same four steps as a
                                // stdin prompt so busy/metrics/push/queue all see a
                                // real turn.
                                tracing::info!("claude[{}]: CLI-started turn (external)", sid);
                                turn_seq += 1;
                                local_running = true;
                                turn_starts.start_external(now_millis());
                                if let Some(m) = mgr.upgrade() {
                                    m.mark_turn(&sid, TurnState::Running, turn_seq);
                                }
                                // Flush-only-while-Idle invariant: a collect window armed
                                // after the previous turn must not fire mid external turn.
                                // Pending prompts are kept; this turn's boundary re-arms.
                                queue.disarm();
                            }
```

把原 `let is_boundary = matches!(...)` 改为：

```rust
                            let is_boundary = matches!(
                                evt,
                                AcpEvent::Result { .. } | AcpEvent::Error { .. } | AcpEvent::Exit { .. }
                            );
                            // The origin marker belongs to exactly this boundary.
                            if is_boundary {
                                pending_origin = None;
                            }
                            let skip_boundary = step == ClaudeStep::SkipBoundary;
                            if skip_boundary {
                                tracing::debug!(
                                    "claude[{}]: origin-tagged boundary with non-external FIFO front; not settling",
                                    sid);
                            }
```

把 `if is_boundary {` 改为 `if is_boundary && !skip_boundary {`。

`continue` 在 `tokio::select!` 分支体内作用于外层 `loop`（同一分支里已有 `None => break`，已核实可行）。`if let AcpEvent::TurnOrigin { kind } = evt { ...; continue; }` 只在匹配臂移动 `evt`，该臂发散，后续使用 `evt` 可通过借用检查。

- [ ] **Step 5: 编译 + 全量测试**

Run: `cargo test 2>&1 | grep -E "^test result|FAILED|panicked|^error" | head`
Expected: 全 `ok`。

- [ ] **Step 6: 验红**
  - 删掉 `with_turn_id` 新臂 → `with_turn_id_stamps_peer_message` FAIL；恢复。
  - `cap_peer_message` 直接返回 `evt` → `peer_message_text_is_truncated_for_scrollback` FAIL；恢复。

- [ ] **Step 7: 本地冒烟（debug 构建，不碰生产）**

```bash
cd frontend && npm run build && cd ..
cargo build
mkdir -p /tmp/zmx-xs-smoke
./target/debug/zeromux --port 8097 --password smoke --data-dir /tmp/zmx-xs-smoke > /tmp/zmx-xs-smoke/log 2>&1 &
echo $! > /tmp/zmx-xs-smoke/pid
```

若 `--data-dir` 不存在，先 `./target/debug/zeromux --help | grep -i dir` 找到等价参数；**不得**用默认数据目录（会挂载生产 `~/.zeromux`）。用浏览器或 `curl` 登录后建一个 Claude 会话（work_dir `/tmp/zmx-xs-smoke`），然后从本（开发）会话 `ListAgents` 找到它并 `SendMessage` 一条「只回复 pong，不用工具」。检查 `/tmp/zmx-xs-smoke/log` 出现 `CLI-started turn (external)`，且会话 `turn_state` 回到 Idle（`GET /api/sessions`）。结束 `kill $(cat /tmp/zmx-xs-smoke/pid)`。

- [ ] **Step 8: 提交**

```bash
git add src/session_manager.rs
git commit -m "feat(fanout): count Claude CLI-started turns and skip mis-attributed origin boundaries

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 前端 —— `peer_message` 气泡与 `notice` 提示

**Files:**
- Modify: `frontend/src/lib/transcript.ts`（`WireEvent` :7-20、`TurnGroup.userPrompts` :40、`foldTranscript` user_prompt 分支 :83-89、`groupSignature` :144）
- Modify: `frontend/src/components/AcpChatView.tsx`（`ServerEvent` :35-50、`case 'system'` 之后、`case 'content_block'` 之前；`TurnGroupViewImpl` 气泡 :1070-1075）
- Test: `frontend/src/components/__tests__/transcript.test.ts`

**Interfaces:**
- Consumes: 后端 wire 事件 `{"type":"peer_message","from_name":string,"text":string,"turn_id":number}`、`{"type":"notice","text":string,"level":string}`
- Produces: `TurnGroup.userPrompts: { text: string; clientId?: string; fromName?: string }[]`

- [ ] **Step 1: 写失败测试**（追加到 `transcript.test.ts` 末尾）

```ts
describe('foldTranscript — cross-session peer message (spec 2026-09-26)', () => {
  it('puts a peer_message into its turn group with fromName', () => {
    const events: WireEvent[] = [
      { type: 'peer_message', from_name: 'zeromux-98', text: 'ping', turn_id: 3 },
      { type: 'content_block', block_type: 'text', text: 'pong', turn_id: 3 },
      { type: 'result', text: 'pong', turn_id: 3 },
    ]
    const groups = foldTranscript(events)
    expect(groups).toHaveLength(1)
    expect(groups[0].turnId).toBe(3)
    expect(groups[0].userPrompts).toEqual([{ text: 'ping', fromName: 'zeromux-98' }])
    expect(groups[0].assistantText()).toBe('pong')
    expect(groups[0].complete).toBe(true)
  })

  it('keeps a busy-time peer_message in the running turn alongside the user prompt', () => {
    const events: WireEvent[] = [
      { type: 'user_prompt', text: 'do x', turn_id: 5, client_id: 'c1' },
      { type: 'content_block', block_type: 'tool_use', name: 'Bash', turn_id: 5 },
      { type: 'peer_message', from_name: 'other', text: 'fyi', turn_id: 5 },
    ]
    const g = foldTranscript(events)[0]
    expect(g.userPrompts.map(p => p.fromName)).toEqual([undefined, 'other'])
  })

  it('changes the group signature when only the sender differs', () => {
    const a = foldTranscript([{ type: 'peer_message', from_name: 'a', text: 't', turn_id: 1 }])
    const b = foldTranscript([{ type: 'peer_message', from_name: 'b', text: 't', turn_id: 1 }])
    const out = stabilizeGroups(a, b)
    expect(out[0]).toBe(b[0]) // not reused: signature differs
  })
})
```

`stabilizeGroups(prev, next)` 的参数顺序以 `transcript.ts` 中现有签名为准；若为 `(next, prev)`，调换实参。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/transcript.test.ts 2>&1 | tail -15`
Expected: 新 3 个 FAIL（peer_message 未归组 / TS 类型错误 `from_name`）。

- [ ] **Step 3: `transcript.ts` 实现**

`WireEvent` 加字段：

```ts
  /** 仅 peer_message：发送方会话名（Claude Code 跨会话消息）。 */
  from_name?: string
```

`TurnGroup.userPrompts` 类型改为：

```ts
  userPrompts: { text: string; clientId?: string; fromName?: string }[]
```

`foldTranscript` 中 `if (e.type === 'user_prompt') { ... }` 之后新增分支：

```ts
    } else if (e.type === 'peer_message') {
      // A message from another Claude session (spec 2026-09-26). Rendered in the
      // user-side slot of its turn, tagged with the sender.
      group(tid).userPrompts.push({ text: e.text ?? '', fromName: e.from_name ?? 'unknown' })
```

`groupSignature` 的 prompts 行改为：

```ts
  const prompts = g.userPrompts.map(p => `${p.fromName ?? ''}:${p.text}`).join('')
```

- [ ] **Step 4: 跑测试**

Run: `cd frontend && npx vitest run src/components/__tests__/transcript.test.ts 2>&1 | tail -8`
Expected: 全 PASS（含原有用例）。

- [ ] **Step 5: `AcpChatView.tsx` 实现**

`ServerEvent` 加：

```ts
  from_name?: string
  level?: string
```

在 `case 'user_prompt': {` 之前新增两个 case：

```tsx
      case 'peer_message': {
        // Another Claude session's message (spec 2026-09-26). The backend has
        // already counted the turn; mirror content_block's observer-tab seeding
        // so busy + the turn clock light up even without a local sendPrompt.
        if (typeof evt.turn_id === 'number') activeTurnIdRef.current = evt.turn_id
        appendEvent(evt as unknown as WireEvent)
        setBusy(true)
        const pmNow = Date.now()
        setTurnStartedMs(prev => prev ?? pmNow)
        setNowMs(pmNow)
        setLastEventMs(pmNow)
        break
      }

      case 'notice': {
        // CLI informational line (e.g. our cross-session message was held/refused).
        if (evt.text) pushNotice({ id: newId(), kind: 'system', text: evt.text })
        break
      }
```

`TurnGroupViewImpl` 的气泡改为：

```tsx
      {group.userPrompts.map((p, i) => (
        <div key={p.clientId ?? i}>
          <p className={`text-[11px] font-semibold mb-0.5 ${p.fromName ? 'text-[var(--accent-purple)]' : 'text-[var(--accent-blue)]'}`}>
            {p.fromName ? `来自 @${p.fromName}` : 'You'}
          </p>
          <p className="text-sm text-[var(--text-primary)] whitespace-pre-wrap">{p.text}</p>
        </div>
      ))}
```

- [ ] **Step 6: lint + 全量前端测试 + 构建**

Run: `cd frontend && npm run lint && npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -3`
Expected: lint 无错；测试全 PASS；build 成功。

- [ ] **Step 7: 验红**：`foldTranscript` 新分支里去掉 `fromName: ...` → 第一个用例 FAIL；恢复。`groupSignature` 改回旧行 → 第三个用例 FAIL；恢复。

- [ ] **Step 8: 提交**

```bash
git add frontend/src/lib/transcript.ts frontend/src/components/AcpChatView.tsx frontend/src/components/__tests__/transcript.test.ts
git commit -m "feat(frontend): render cross-session peer messages and CLI notices

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 端到端验收 + 部署

**Files:** 无代码改动（若验收发现问题，回到对应 Task 修）。

- [ ] **Step 1: 全量验证**

```bash
cd frontend && npm ci && npm run lint && npm test && npm run build && cd ..
cargo test 2>&1 | grep -E "^test result|FAILED" 
cargo build --release
```

Expected: 全绿；记录 Rust / 前端通过数（基线：Rust 400+、前端 268+）。

- [ ] **Step 2: 推送再部署**（本终端在 zeromux cgroup 内：先 push，再 deploy；deploy 时本终端掉线属预期）

```bash
git push origin main
./deploy.sh
```

掉线后从新终端 `systemctl is-active zeromux` 与 `journalctl -u zeromux-deploy-<pid> --no-pager | tail` 确认。

- [ ] **Step 3: 线上验收**（从一个一次性 `claude -p` 沙箱会话或开发会话发消息，逐项勾选）
  1. 空闲 ZeroMux Claude 会话收到消息：出现「来自 @…」气泡、busy 亮、结束后熄；日志有 `CLI-started turn (external)`；离开页面时收到一次 `turn_done` 推送。
  2. 外部 turn 进行中（发一条让它执行 `sleep 20` 的消息）在 UI 发 prompt：显示「已排队」，外部 turn 结束后才执行。
  3. 刷新页面：气泡与分组一致，busy 与后端 `turn_state` 一致。
  4. 让 ZeroMux 会话向一个 `crossSessionInbound: refuse` 的沙箱会话发消息：UI 出现灰色 notice。
  5. 自动命名：新建会话首条 prompt 后标题正常生成（titler 未被 peer 干扰）。

- [ ] **Step 4: 清理** 所有一次性沙箱会话（`kill`）与 `/tmp/zmx-xs-*` 目录。
