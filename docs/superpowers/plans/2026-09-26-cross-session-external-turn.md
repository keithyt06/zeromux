# Claude 跨会话消息外部 turn 支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ZeroMux 把 Claude CLI 因跨会话消息 / 后台任务通知而自开的 turn 当作一等 turn：可见、计数正确、busy 正确、可寻址、可中断。

**Architecture:** 进程层（`src/acp/process.rs`）开启 `--replay-user-messages`、`--name zmx-ai-<id6>`、按模式选 inbound，把 `user.origin.kind=="peer"` 翻成 `PeerMessage`、把 stdin 回显翻成内部标记 `StdinEcho`、把 `result.origin` 翻成内部标记 `TurnOrigin`、把 `system/informational` 翻成 `Notice`。Claude fan-out（`spawn_acp_fanout`，只有 Claude 用）用纯函数 `classify_claude_event` 决定每个事件是「开外部 turn / 跳过 boundary / 正常」，`TurnStarts` 条目记录 turn 来源与是否已回显。前端渲染 `peer_message` 气泡（反查会话名）、`notice` 提示、SessionInfoBar 的 peer 名、始终可见的中断键。

**Revision:** v3 —— 按 spec v3 刷新：peer 名 `zmx-ai-<id6>`（避开 tmux 的 `zmx-<id8>`）、冒烟加 `--tmux-socket`、行号按 tmux 合入后的 main（`ad42dda`）刷新；**所有位置以函数/符号为锚，行号仅供参考**。

v2 —— 按 spec v2（CTO + PM 终审）修订，并经 double check（在一次性 worktree 里按计划逐 Task 真实套用、编译、测试、验红）：新增 stdin 回显追踪修复 CTO BLOCKER（CLI 并入场景）；新增 Task 6（peer 名 / inbound 模式 / 中断键 / SessionInfoBar）；部署改为先 push 再 `./deploy.sh --build`。

**Tech Stack:** Rust（tokio、serde_json），React 19 + TypeScript，vitest。

**Spec:** `docs/superpowers/specs/2026-09-26-cross-session-external-turn-design.md`

## Global Constraints

- 只改 Claude 路径：`AcpProcess::spawn` / `spawn_titler` / `translate_event` / `spawn_acp_fanout`。Codex（`spawn_codex_fanout`）与 Crew（`spawn_crew_fanout`）行为不得变化。
- spawn 追加参数，原文：`--replay-user-messages`、`--name zmx-ai-<会话 id 前 6 字符>`、`--settings '{"crossSessionInbound":"accept"}'`（legacy 交互会话）或 `--settings '{"crossSessionInbound":"refuse"}'`（OAuth 模式或定时 run 会话）；titler 追加 `--settings '{"crossSessionInbound":"refuse"}'`。
- `TurnOrigin` 与 `StdinEcho` 永不 emit、永不写 scrollback、永不进 `log_result_event`。
- **不要单独跑 `cargo build --release`**：线上 systemd 带 `--watch-build …/target/release/zeromux`，release 产物一出现就可能被热更新到线上。release 构建只经 `./deploy.sh --build`，且先 `git push`。
- `Notice` 不得用 `ContentBlock` 承载（空闲期到达会被误判为外部 turn 开始）。
- 保持 broadcast fan-out 不变量：fan-out 是进程的唯一所有者；所有 turn 开始走 `turn_seq += 1` → `local_running = true` → `turn_starts.start*()` → `mark_turn(Running, turn_seq)` 四步。
- 代码注释英文，用户可见字符串中文（「来自 @{from_name}」）。
- 每个判定测试先注释掉对应守卫验红，再恢复验绿（项目 review 惯例）。
- 构建：前端须先 `cd frontend && npm run build`，Rust 才能编译；迭代用 `cargo test`（debug）。

## Review Focus

1. **CLI 把 ZeroMux 的 prompt 并进外部 turn**（外部 turn 用了工具，prompt 在其首个输出前写入）：唯一的 `result` 带 `origin`，必须正常结算用户 turn —— 否则会话永远 Running 直到 30 分钟 watchdog，排队 prompt 丢失（CTO BLOCKER，已实测）。→ Task 3 测试 `merged_race_settles_on_origin_result`、Task 2 测试 `mark_echoed_*`。
2. **空闲期的非输出事件**（`system/task_updated`、`background_tasks_changed`、hold 回执 `informational`）到达时不得开 turn —— 否则会话永远 Running 直到 watchdog。→ Task 3 测试 `idle_system_and_notice_do_not_start_turn`。
3. **队首为空时带 origin 的 boundary**（钳制后的多余边界、或外部 turn 已被前一个无 origin 的 Exit 结算）必须跳过，不能 settle 出 None 后又把 `boundary_count` 推过 `turn_seq`。→ Task 3 测试 `origin_boundary_with_empty_fifo_is_skipped`。
4. **外部 turn 进行中用户点 Interrupt**：Cancelled intent 必须打在外部条目上，且 `front_is_external()` 在 intent 打上后仍为 true。→ Task 2 测试 `set_live_intent_on_external_entry_keeps_source`。
5. **collect 窗口已 arm 时外部 turn 开始**：必须 `queue.disarm()` 且保留 `pending`，否则合并 prompt 会在外部 turn 进行中 flush（mid-turn 强打断）。→ Task 4 Step 3 代码 + 端到端第 2 项。
6. **peer body 超大**（接近 CLI 的 ~1M 字符上限）：必须经 `truncate_prompt_for_scrollback`，否则单帧撑爆 2MB scrollback。→ Task 4 测试 `peer_message_text_is_truncated_for_scrollback`。
7. **会话改名后旧气泡标签**：`TurnGroupView` 的自定义 memo 比较器必须比较 `peerNames`，否则已完成 turn 不重渲染。→ Task 6 Step 7 明文要求，Step 8 lint/test 后在 UI 手工改名确认。

---

## File Structure

| 文件 | 改动 | 职责 |
|---|---|---|
| `src/acp/process.rs` | Modify | 4 个新 `AcpEvent` 变体；`Inbound`；`claude_args` 纯函数；spawn/titler 参数；`translate_event` 三个分支；单元测试 |
| `src/session_manager.rs` | Modify | `TurnStarts` 加来源与回显；纯函数 `classify_claude_event` + `ClaudeStep`；`spawn_acp_fanout` 接线；`with_turn_id`/`emit` 盖 `PeerMessage`；`peer_name_for` / `claude_inbound`；`oauth_mode` 字段；`SpawnPlan.source_task_id`；`SessionInfo.peer_name`；单元测试 |
| `src/main.rs` | Modify | 启动时 `set_oauth_mode(oauth_configured)` |
| `frontend/src/lib/api.ts` | Modify | `SessionInfo.peer_name` |
| `frontend/src/lib/peer.ts` + `__tests__/peer.test.ts` | Create | `peerLabel(fromName, peerNames)` 纯函数 |
| `frontend/src/components/SessionInfoBar.tsx` | Modify | 展开区 Peer 行（名 + 复制 + 在线/休眠） |
| `frontend/src/App.tsx` | Modify | 构造 `peerNames` 传给 `AcpChatView` |
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
  - `AcpEvent::StdinEcho`（serde tag `stdin_echo`，仅内部）
  - `translate_event` 输出顺序：带 origin 的 `result` → `[TurnOrigin, Result|Error]`
  - `pub enum Inbound { Accept, Refuse }`
  - `fn claude_args(resume: Option<&str>, peer_name: &str, inbound: Inbound) -> Vec<String>`
  - `AcpProcess::spawn(claude_path: &str, work_dir: &str, resume: Option<&str>, peer_name: &str, inbound: Inbound)`（新增后两个参数；唯一调用点 `session_manager.rs` `spawn_claude` 在本 Task 内同步更新为临时值 `&format!("zmx-ai-{}", &id[..6.min(id.len())])`、`Inbound::Accept`，Task 6 替换为正式逻辑）

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
    fn stdin_replay_becomes_stdin_echo() {
        // ZeroMux's own stdin prompt echoed back by --replay-user-messages: no
        // origin, isReplay:true. The fan-out uses it to learn which turn absorbed
        // the prompt (spec v2 §2d, CTO merged-race finding).
        let replay = serde_json::json!({
            "type": "user", "isReplay": true,
            "message": {"role": "user", "content": [{"type": "text", "text": "reply only: ok"}]}
        });
        let evts = translate_event(&replay);
        assert_eq!(evts.len(), 1);
        assert!(matches!(evts[0], AcpEvent::StdinEcho));
    }

    #[test]
    fn tool_result_user_event_is_dropped() {
        // tool_result echoes carry no isReplay (CTO probe) — must not be mistaken
        // for a stdin echo.
        let tool_result = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": [{"tool_use_id": "t1", "type": "tool_result", "content": "ok"}]}
        });
        assert!(translate_event(&tool_result).is_empty());
    }

    #[test]
    fn claude_args_include_replay_name_and_inbound() {
        let a = claude_args(None, "zmx-ai-ab12cd", Inbound::Accept);
        assert!(a.iter().any(|x| x == "--replay-user-messages"));
        let i = a.iter().position(|x| x == "--name").unwrap();
        assert_eq!(a[i + 1], "zmx-ai-ab12cd");
        let j = a.iter().position(|x| x == "--settings").unwrap();
        assert_eq!(a[j + 1], r#"{"crossSessionInbound":"accept"}"#);
        assert!(!a.iter().any(|x| x == "--resume"));

        let r = claude_args(Some("sid-1"), "zmx-ai-x", Inbound::Refuse);
        let j = r.iter().position(|x| x == "--settings").unwrap();
        assert_eq!(r[j + 1], r#"{"crossSessionInbound":"refuse"}"#);
        let k = r.iter().position(|x| x == "--resume").unwrap();
        assert_eq!(r[k + 1], "sid-1");
        // existing flags preserved
        assert!(r.iter().any(|x| x == "--dangerously-skip-permissions"));
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
Expected: 编译错误 `no variant named PeerMessage` / `TurnOrigin` / `Notice` / `StdinEcho`，`cannot find function claude_args`。

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
    /// Fan-out-internal marker: the CLI echoed a prompt ZeroMux wrote to stdin
    /// (`user`, isReplay, no origin). Lets the fan-out know that prompt has been
    /// taken into a turn — the CLI may merge it into a running CLI-started turn,
    /// whose single result then carries `origin` (spec v2 §2d). Never emitted.
    StdinEcho,
```

并在 `AcpEvent` enum 之后新增：

```rust
/// Whether this Claude session accepts Claude Code cross-session messages.
/// Refuse for OAuth mode (all tenants share one OS user, so CLI socket isolation
/// does not separate ZeroMux users) and for unattended scheduled runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inbound {
    Accept,
    Refuse,
}

/// Argument vector for an interactive/scheduled Claude session. Pure so the
/// flag set is unit-testable.
fn claude_args(resume: Option<&str>, peer_name: &str, inbound: Inbound) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(), "stream-json".into(),
        "--input-format".into(), "stream-json".into(),
        "--verbose".into(),
        "--dangerously-skip-permissions".into(),
        // Cross-session messaging (spec 2026-09-26): echo turn-driving inputs so
        // the fan-out can see peer messages and attribute CLI-started turns.
        "--replay-user-messages".into(),
        // Stable, readable peer address (default would be <cwd>-<2 chars>).
        "--name".into(), peer_name.to_string(),
        "--settings".into(),
        match inbound {
            Inbound::Accept => r#"{"crossSessionInbound":"accept"}"#,
            Inbound::Refuse => r#"{"crossSessionInbound":"refuse"}"#,
        }
        .into(),
    ];
    if let Some(sid) = resume {
        args.push("--resume".into());
        args.push(sid.to_string());
    }
    args
}
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
        // event. Peer messages are surfaced; our own stdin prompts become an
        // internal StdinEcho marker (ZeroMux already emitted its UserPrompt);
        // tool_result echoes (no isReplay) are noise. `origin` is structured, so
        // no parsing of the <cross-session-message> wrapper text is needed.
        "user" => {
            let Some(origin) = val.get("origin") else {
                if val.get("isReplay").and_then(|v| v.as_bool()) == Some(true) {
                    return vec![AcpEvent::StdinEcho];
                }
                return vec![];
            };
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

`spawn` 签名改为：

```rust
    pub async fn spawn(
        claude_path: &str,
        work_dir: &str,
        resume: Option<&str>,
        peer_name: &str,
        inbound: Inbound,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let args = claude_args(resume, peer_name, inbound);
```

删除原来构造 `args` 与追加 `--resume` 的代码（已移入 `claude_args`），其余不变。

更新唯一调用点 `src/session_manager.rs` 的 `spawn_claude`（约 :1065）为临时值（Task 6 替换）：

```rust
        let peer_name = format!("zmx-ai-{}", &id[..6.min(id.len())]);
        let process = AcpProcess::spawn(&self.claude_path, work_dir, resume,
                &peer_name, crate::acp::process::Inbound::Accept)
```

`spawn_titler` 的 `args` 向量里，`"--allowedTools".into(), "".into(),` 之后追加：

```rust
            // The titler reads the FIRST Result as the title; a peer message
            // starting a turn here would poison it. Refuse all inbound.
            "--settings".into(), r#"{"crossSessionInbound":"refuse"}"#.into(),
```

- [ ] **Step 6: 编译（其余 match 可能不穷尽）并跑测试**

Run: `cargo test --bin zeromux acp::process::tests 2>&1 | tail -20`
Expected: 10 个新测试 PASS，原有测试 PASS。CTO 已核实：全仓对 `AcpEvent` 的 `match` 都有通配臂，加变体不会报 non-exhaustive。

- [ ] **Step 7: 验红**：把 4b 中 `!= Some("peer")` 改成 `== Some("peer")`，跑 `peer_user_event_becomes_peer_message` 确认 FAIL；恢复。把 4c 的 `wrap(AcpEvent::Result {` 改回 `vec![AcpEvent::Result {`（配 `]`），确认 `result_with_origin_is_preceded_by_turn_origin` FAIL；恢复。

- [ ] **Step 8: 全量 Rust 测试 + 提交**

Run: `cargo test 2>&1 | grep -E "^test result|FAILED|panicked" | head`
Expected: 全部 `ok`。

```bash
git add src/acp/process.rs src/session_manager.rs
git commit -m "feat(acp): translate Claude cross-session peer messages, stdin echoes, turn origin, notices

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

> 注意：本 Task 提交后、Task 4 接线前，`TurnOrigin` / `StdinEcho` 会经 `emit` 被广播/写 scrollback（它们仍是普通事件）。**全部 Task 完成前不要部署**（`cargo build --release` 也不要跑，见 Global Constraints）。

---

### Task 2: `TurnStarts` 记录 turn 来源与回显

**Files:**
- Modify: `src/session_manager.rs`（`struct TurnStarts` / `impl TurnStarts`（现约 :3250）；三处 `settle().and_then(|(_, o)| o)` 调用签名不变；测试放 `turn_starts_fifo_pairs_each_boundary_with_its_own_turn` 所在模块）

**Interfaces:**
- Consumes: 无
- Produces:
  - `TurnStarts::start_external(&mut self, ms: i64)`
  - `TurnStarts::front_is_external(&self) -> bool`（空 FIFO 返回 false）
  - `TurnStarts::mark_echoed(&mut self)`（把最早一个 `echoed==false` 的条目置 true；没有则 no-op）
  - `TurnStarts::front_is_echoed(&self) -> bool`（空 FIFO 返回 false）
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

    #[test]
    fn mark_echoed_marks_oldest_unechoed_internal_entry() {
        // Spec v2 §2a: each stdin write is echoed once, in order. The echo tells
        // us that prompt has been taken into a CLI turn (possibly merged into a
        // running CLI-started turn — CTO merged-race finding).
        let mut ts = TurnStarts::default();
        assert!(!ts.front_is_echoed(), "empty FIFO is not echoed");
        ts.start(1_000);
        ts.start(2_000);
        assert!(!ts.front_is_echoed());
        ts.mark_echoed();
        assert!(ts.front_is_echoed(), "first echo marks the oldest entry");
        ts.settle();
        assert!(!ts.front_is_echoed(), "second entry not echoed yet");
        ts.mark_echoed();
        assert!(ts.front_is_echoed());
        ts.settle();
        ts.mark_echoed(); // nothing pending: no-op, no panic
        assert!(!ts.front_is_echoed());
    }

    #[test]
    fn external_entries_count_as_echoed_and_are_skipped_by_mark_echoed() {
        // An external turn has no stdin write, so it never waits for an echo;
        // mark_echoed must pass over it to the next internal entry.
        let mut ts = TurnStarts::default();
        ts.start_external(1_000);
        ts.start(2_000);
        assert!(ts.front_is_echoed());
        ts.mark_echoed();
        ts.settle();
        assert!(ts.front_is_echoed(), "the echo went to the internal entry");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin zeromux -- turn_starts_tracks_external mark_echoed external_entries_count 2>&1 | tail -5`
Expected: 编译错误 `no method named start_external`。

- [ ] **Step 3: 实现**——把 `TurnStarts` 的存储改成具名结构，公开方法签名保持不变：

```rust
#[derive(Default)]
struct TurnStarts {
    inner: VecDeque<TurnEntry>,
}

/// One pending turn: start stamp, outcome intent, whether the CLI started it on
/// its own (cross-session peer message / task notification), and whether the
/// CLI has echoed the stdin prompt that started it (spec 2026-09-26 v2).
struct TurnEntry {
    ms: i64,
    intent: Option<crate::run_metrics::RunOutcome>,
    external: bool,
    echoed: bool,
}

impl TurnStarts {
    /// A turn started at `ms`; enqueue its start-stamp with no intent yet.
    fn start(&mut self, ms: i64) {
        self.inner.push_back(TurnEntry { ms, intent: None, external: false, echoed: false });
    }

    /// A turn the CLI started by itself (no ZeroMux stdin write) began at `ms`.
    /// There is no stdin prompt to wait for, so it counts as already echoed.
    fn start_external(&mut self, ms: i64) {
        self.inner.push_back(TurnEntry { ms, intent: None, external: true, echoed: true });
    }

    /// Whether the oldest pending turn (the one the next boundary settles) was
    /// CLI-started. False on an empty FIFO.
    fn front_is_external(&self) -> bool {
        self.inner.front().is_some_and(|e| e.external)
    }

    /// The CLI echoed one of our stdin prompts. Every internal `start()` is
    /// paired with exactly one `send_prompt`, echoed in write order, so the echo
    /// belongs to the oldest entry still waiting for one. No-op if none.
    fn mark_echoed(&mut self) {
        if let Some(e) = self.inner.iter_mut().find(|e| !e.echoed) {
            e.echoed = true;
        }
    }

    /// Whether the oldest pending turn's prompt has been taken in by the CLI.
    /// False on an empty FIFO.
    fn front_is_echoed(&self) -> bool {
        self.inner.front().is_some_and(|e| e.echoed)
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
Expected: 新 4 个 + 原有 `turn_starts_*` / `intent_fifo_*` 全 PASS。另跑 `cargo test --bin zeromux -- mark_echoed external_entries_count` 确认 4 个新测试都在。

- [ ] **Step 5: 验红**（各自恢复）
  - `front_is_external` 改为恒 `false` → `turn_starts_tracks_external_source_per_entry` FAIL。
  - `mark_echoed` 的 `find(|e| !e.echoed)` 改为 `back_mut()` 置位 → `mark_echoed_marks_oldest_unechoed_internal_entry` FAIL。
  - `start_external` 的 `echoed: true` 改为 `false` → `external_entries_count_as_echoed_and_are_skipped_by_mark_echoed` FAIL。

- [ ] **Step 6: 提交**

```bash
git add src/session_manager.rs
git commit -m "feat(fanout): TurnStarts records CLI-started turns and stdin echoes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 纯函数 `classify_claude_event`

**Files:**
- Modify: `src/session_manager.rs`（紧挨 `impl TurnStarts` 之后新增；测试放同一 `mod tests`）

**Interfaces:**
- Consumes: Task 2 的 `TurnStarts`（仅测试里用来驱动序列）
- Produces:
  ```rust
  #[derive(Debug, PartialEq, Eq)]
  enum ClaudeStep { StartExternal, SkipBoundary, Normal }
  fn classify_claude_event(local_running: bool, evt: &AcpEvent,
                           has_pending_origin: bool, front_settles_on_origin: bool) -> ClaudeStep
  ```
  调用方传 `front_settles_on_origin = turn_starts.front_is_external() || turn_starts.front_is_echoed()`。
  调用方先处理 `TurnOrigin` 与 `StdinEcho`（各自更新状态并 `continue`），这两个标记不会传入此函数。

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
    fn origin_boundary_skipped_when_front_is_unechoed_user_turn() {
        // Serial race (spec v2 walkthrough A): the user's prompt counted turn N but
        // the CLI hasn't echoed it yet — it ran the peer turn first; that result
        // must not settle N.
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

    fn settles(ts: &TurnStarts) -> bool {
        ts.front_is_external() || ts.front_is_echoed()
    }

    #[test]
    fn serial_race_skips_peer_result_then_settles_user_turn() {
        // Walkthrough A (CTO b.log): peer turn has no tool use, so the CLI runs it
        // to completion, THEN takes our stdin prompt.
        let mut ts = TurnStarts::default();
        ts.start(1_000); // user prompt written to stdin (local_running = true)
        assert_eq!(classify_claude_event(true, &peer(), false, settles(&ts)), ClaudeStep::Normal);
        // peer turn's result (origin) arrives before our prompt's echo → skip
        assert_eq!(classify_claude_event(true, &res(), true, settles(&ts)), ClaudeStep::SkipBoundary);
        assert_eq!(ts.front(), Some(1_000), "FIFO untouched by the skipped boundary");
        ts.mark_echoed(); // StdinEcho for our prompt
        // our own result (no origin) → settles turn N
        assert_eq!(classify_claude_event(true, &res(), false, settles(&ts)), ClaudeStep::Normal);
        assert_eq!(ts.settle(), Some((1_000, None)));
    }

    #[test]
    fn merged_race_settles_on_origin_result() {
        // Walkthrough B (CTO a.log / c.log) — the v1 BLOCKER: peer turn uses a
        // tool, the CLI injects our stdin prompt after the tool_result, and emits
        // ONE result carrying origin:peer that answers our prompt. It must settle
        // turn N, or the session stays Running until the 30-min watchdog.
        let mut ts = TurnStarts::default();
        ts.start(1_000);
        assert_eq!(classify_claude_event(true, &peer(), false, settles(&ts)), ClaudeStep::Normal);
        ts.mark_echoed(); // StdinEcho arrives BEFORE the only result
        assert_eq!(classify_claude_event(true, &res(), true, settles(&ts)), ClaudeStep::Normal);
        assert_eq!(ts.settle(), Some((1_000, None)));
    }

    #[test]
    fn task_notification_merged_into_user_turn_settles() {
        // Walkthrough C (CTO hypothesis): a background-task notification merged
        // into a user turn yields a result with origin:task-notification. The user
        // prompt that opened the turn was echoed first, so it settles.
        let mut ts = TurnStarts::default();
        ts.start(1_000);
        ts.mark_echoed();
        assert_eq!(classify_claude_event(true, &res(), true, settles(&ts)), ClaudeStep::Normal);
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
    /// FIFO front is a ZeroMux turn whose prompt the CLI has not echoed yet (or
    /// nothing): the CLI ran a peer turn ahead of our prompt. Emit it but do not
    /// settle anything.
    SkipBoundary,
    /// Everything else: existing handling.
    Normal,
}

fn classify_claude_event(
    local_running: bool,
    evt: &AcpEvent,
    has_pending_origin: bool,
    front_settles_on_origin: bool,
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
    // An origin-tagged boundary ends a CLI-started turn. It settles the FIFO
    // front only if that front IS the CLI-started turn, or is our prompt that the
    // CLI already took in (echoed) — i.e. merged into that turn. Otherwise the
    // CLI ran the peer turn ahead of our not-yet-echoed prompt: skip it.
    if is_boundary && has_pending_origin && !front_settles_on_origin {
        return ClaudeStep::SkipBoundary;
    }
    ClaudeStep::Normal
}
```

- [ ] **Step 4: 跑测试**

Run: `cargo test --bin zeromux -- idle_ busy_peer origin_boundary plain_boundary serial_race merged_race task_notification_merged 2>&1 | grep -E "test |result"`
Expected: 11 个 PASS。

- [ ] **Step 5: 验红**（各自恢复）
  - 删掉 `!local_running &&` → `busy_peer_and_output_are_normal` FAIL。
  - `matches!` 里加 `| AcpEvent::System { .. } | AcpEvent::Notice { .. }` → `idle_system_and_notice_do_not_start_turn` FAIL。
  - 删掉 `&& !front_settles_on_origin` → `origin_boundary_settles_when_front_is_external` 与 `merged_race_settles_on_origin_result` FAIL。
  - 在测试 helper `settles()` 里去掉 `|| ts.front_is_echoed()`（即还原 v1 规则）→ `merged_race_settles_on_origin_result` FAIL —— 这条验红证明 v1 BLOCKER 被测试钉住。
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
  - `with_turn_id`（现约 :3491）
  - `emit`（现约 :3391）内 `ContentBlock | Result` 盖值分支
  - `spawn_acp_fanout`（现约 :2727-3581，自 v2 起**未改动**）事件分支 `Some(evt) => {` 起、`is_boundary` 计算、`if is_boundary {`

**Interfaces:**
- Consumes: Task 1 `AcpEvent::{PeerMessage, TurnOrigin, Notice, StdinEcho}`；Task 2 `start_external`/`front_is_external`/`mark_echoed`/`front_is_echoed`；Task 3 `classify_claude_event`/`ClaudeStep`
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
        // next boundary: that boundary ends a CLI-started turn.
        let mut pending_origin = false;
```

在 `Some(evt) => {` 分支的**最开头**（`log_result_event(...)` 之前）插入：

```rust
                            // TurnOrigin / StdinEcho are fan-out-internal markers:
                            // update attribution state and drop them (never emitted,
                            // persisted or logged — spec 2026-09-26 v2 §2d).
                            if let AcpEvent::TurnOrigin { kind } = &evt {
                                tracing::debug!("claude[{}]: next boundary ends a CLI-started turn ({})", sid, kind);
                                pending_origin = true;
                                continue;
                            }
                            if matches!(evt, AcpEvent::StdinEcho) {
                                turn_starts.mark_echoed();
                                continue;
                            }
                            let evt = cap_peer_message(evt);
                            let step = classify_claude_event(
                                local_running, &evt, pending_origin,
                                turn_starts.front_is_external() || turn_starts.front_is_echoed());
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
                                pending_origin = false;
                            }
                            let skip_boundary = step == ClaudeStep::SkipBoundary;
                            if skip_boundary {
                                tracing::debug!(
                                    "claude[{}]: origin-tagged boundary before our prompt was echoed; not settling",
                                    sid);
                            }
```

把 `if is_boundary {` 改为 `if is_boundary && !skip_boundary {`。

`continue` 在 `tokio::select!` 分支体内作用于外层 `loop`（CTO 已在仓库副本上编译验证）。两个标记分支都借用 `&evt` / `matches!`，不移动 `evt`。

- [ ] **Step 5: 编译 + 全量测试**

Run: `cargo test 2>&1 | grep -E "^test result|FAILED|panicked|^error" | head`
Expected: 全 `ok`。

- [ ] **Step 6: 验红**
  - 删掉 `with_turn_id` 新臂 → `with_turn_id_stamps_peer_message` FAIL；恢复。
  - `cap_peer_message` 直接返回 `evt` → `peer_message_text_is_truncated_for_scrollback` FAIL；恢复。
  - 接线层没有单元测试（fan-out 无假进程脚手架），其正确性由 Task 3 的序列测试 + 本 Task Step 7 冒烟 + Task 7 验收覆盖。实现者在 Step 7 必须同时验证串行与并入两种竞态（见下）。

- [ ] **Step 7: 本地冒烟（debug 构建，不碰生产）**

```bash
cd frontend && npm run build && cd ..
cargo build
mkdir -p /tmp/zmx-xs-smoke
./target/debug/zeromux --port 8097 --password smoke --data-dir /tmp/zmx-xs-smoke --tmux-socket zmx-xs-smoke > /tmp/zmx-xs-smoke/log 2>&1 &
echo $! > /tmp/zmx-xs-smoke/pid
```

`--data-dir` 已核实存在（`main.rs:109`）。**必须**同时带 `--tmux-socket zmx-xs-smoke`（`main.rs:115`，默认空 = 生产 default socket）：启动时会对 tmux server 做 `set-environment` 与 `reconcile_pending_kills`，不隔离会触碰生产终端。注意：run-metrics 与 runs 目录硬编码为 `$HOME/.zeromux`（`run_metrics.rs` 与 `append_run_event` 的 `$HOME/.zeromux`），**冒烟会在生产 `~/.zeromux/run-metrics/` 留下 `<冒烟会话id>.ndjson`**，结束后删除；不能改 `HOME`（claude 会丢认证）。

用浏览器或 `curl` 登录 `http://127.0.0.1:8097` 后建一个 Claude 会话（work_dir `/tmp/zmx-xs-smoke`），打开它（触发 `ensure_running`）。从开发会话 `ListAgents` 应看到 `zmx-ai-<该会话 id 前 6 位>`（Task 6 前名字已由 Task 1 的临时逻辑生成）。依次验证：

1. **空闲 peer**：`SendMessage` 一条「只回复 pong，不用工具」→ 日志出现 `CLI-started turn (external)`，`GET /api/sessions` 中该会话 `turn_state` 回到 `idle`。
2. **并入竞态**：`SendMessage` 一条「先用 Bash 执行 `sleep 8`，然后回复 done」，**消息发出后 2 秒内**在 UI 发一条 prompt「回复 USERPROMPT」→ 最终会话回到 `idle`（不能停在 `running`），UI 中两段输出都可见。
3. **串行竞态**：`SendMessage` 一条「只回复 PEERREPLY，不用工具」，发出后 1 秒内在 UI 发 prompt → 最终 `idle`，日志出现一次 `not settling`。

结束：`kill $(cat /tmp/zmx-xs-smoke/pid)`；`tmux -L zmx-xs-smoke kill-server 2>/dev/null`；`rm -f ~/.zeromux/run-metrics/<冒烟会话id>.ndjson`；`rm -rf /tmp/zmx-xs-smoke`。

- [ ] **Step 8: 提交**

```bash
git add src/session_manager.rs
git commit -m "feat(fanout): count Claude CLI-started turns; attribute origin boundaries via stdin echo

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

`stabilizeGroups(prev, next)` 参数顺序已核实（`transcript.ts:159`）。

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

`groupSignature` 的 prompts 行（:144）改为下面这样。**注意**：现有代码的 `join` 分隔符是控制字符 U+0001
（源码里是字面的 `'<U+0001>'`，终端/编辑器里看起来像 `''`），不要改掉它，也不要按「看起来是空串」去匹配替换 ——
直接编辑 `.map(...)` 里的箭头函数体即可：

```ts
  // before: g.userPrompts.map(p => p.text).join('\u0001')   (separator is a literal U+0001 in the source)
  const prompts = g.userPrompts.map(p => `${p.fromName ?? ''}:${p.text}`).join('\u0001')
```

（写成转义 `'\u0001'` 与原字面字符等价，二选一均可。）

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

`TurnGroupViewImpl` 的气泡改为（标签暂用原始 `from_name`；Task 6 换成会话名反查）：

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

- [ ] **Step 7: 验红**：`foldTranscript` 新分支里去掉 `fromName: ...` → 第一个用例 FAIL；恢复。`groupSignature` 的箭头函数改回 `p => p.text` → 第三个用例 FAIL；恢复。

- [ ] **Step 8: 提交**

```bash
git add frontend/src/lib/transcript.ts frontend/src/components/AcpChatView.tsx frontend/src/components/__tests__/transcript.test.ts
git commit -m "feat(frontend): render cross-session peer messages and CLI notices

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 可寻址 + inbound 模式 + 中断键

**Files:**
- Modify: `src/session_manager.rs`（行号为 `ad42dda` 参考值：`SessionManager` 字段区 `search` 字段之后、`set_search` :712 之后、`SpawnPlan` :519、`decide_spawn` :561、`ensure_running` 解构 :1721、`spawn_claude` :1147 及其三个调用点 :1214 / :1760 / :1801、`SessionInfo` :383（新字段加在 `other_clients` 之后）、`session_info_of` :630（加在 `other_clients: 0,` 之后）；测试模块）
- Modify: `src/main.rs`（`set_search` 调用 :569 之后）
- Modify: `frontend/src/lib/api.ts`（`SessionInfo` :5-23，加在 `other_clients` 之后）
- Create: `frontend/src/lib/peer.ts`、`frontend/src/lib/__tests__/peer.test.ts`
- Modify: `frontend/src/components/SessionInfoBar.tsx`（展开区 :174 之后）
- Modify: `frontend/src/components/AcpChatView.tsx`（`Props` :64、气泡标签、中断键 :839-853）
- Modify: `frontend/src/App.tsx`（`sessions` state :31、`<AcpChatView` :453）

**Interfaces:**
- Consumes: Task 1 `Inbound`、`AcpProcess::spawn(.., peer_name, inbound)`；Task 5 `TurnGroup.userPrompts[].fromName`
- Produces:
  - `fn peer_name_for(id: &str) -> String`（`"zmx-ai-" + id 前 6 字符`）
  - `fn claude_inbound(oauth_mode: bool, source_task_id: Option<&str>) -> Inbound`
  - `SessionManager::set_oauth_mode(&self, on: bool)`
  - `SessionInfo.peer_name: Option<String>`（仅 Claude 会话 `Some`）
  - 前端 `peerLabel(fromName: string, peerNames: Record<string, string>): string`
  - `AcpChatView` 新 prop `peerNames?: Record<string, string>`

- [ ] **Step 1: 写 Rust 失败测试**（`session_manager.rs` 的 `mod tests`）

```rust
    #[test]
    fn peer_name_is_stable_prefix_of_session_id() {
        assert_eq!(peer_name_for("3186986d-b29f-40d5-9cd3-20d8b9124d98"), "zmx-ai-318698");
        assert_eq!(peer_name_for("abc"), "zmx-ai-abc");
        // must not look like a tmux terminal name `zmx-<id8>` (tmux Own check uses starts_with("zmx-"))
        assert!(peer_name_for("3186986d").starts_with("zmx-ai-"));
    }

    #[test]
    fn inbound_refuses_oauth_and_scheduled_runs() {
        use crate::acp::process::Inbound;
        assert_eq!(claude_inbound(false, None), Inbound::Accept);
        assert_eq!(claude_inbound(true, None), Inbound::Refuse, "OAuth: tenants share one OS user");
        assert_eq!(claude_inbound(false, Some("task-1")), Inbound::Refuse, "unattended scheduled run");
    }

    #[test]
    fn session_info_exposes_peer_name_for_claude_only() {
        let s = running_session("3186986d-b29f");
        assert_eq!(session_info_of(&s).peer_name.as_deref(), Some("zmx-ai-318698"));
    }
```

`running_session` 已有（测试模块内），构造的是 Claude 会话；若其 `session_type` 不是 Claude，在测试内改 `s.session_type = SessionType::Claude`。再加一条 tmux 会话 → `None` 的断言：

```rust
    #[test]
    fn session_info_peer_name_none_for_non_claude() {
        let mut s = running_session("t1");
        s.session_type = SessionType::Tmux;
        assert_eq!(session_info_of(&s).peer_name, None);
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --bin zeromux -- peer_name inbound_refuses session_info_exposes session_info_peer_name 2>&1 | tail -5`
Expected: 编译错误 `cannot find function peer_name_for` 等。

- [ ] **Step 3: Rust 实现**

纯函数（放在 `session_info_of` 之前）：

```rust
/// Claude Code cross-session address for a ZeroMux Claude session. Derived from
/// the session id (stable across resume/respawn); ASCII-only so peers can type
/// it without quoting. `zmx-ai-` (not `zmx-`) so it can't be mistaken for a tmux
/// terminal name `zmx-<id8>` (spec 2026-09-26 v3 §1a).
fn peer_name_for(id: &str) -> String {
    let n = id.char_indices().nth(6).map(|(i, _)| i).unwrap_or(id.len());
    format!("zmx-ai-{}", &id[..n])
}

/// Accept peer messages only for interactive sessions in legacy (single-user)
/// mode. OAuth tenants share one OS user, so the CLI's socket isolation does not
/// separate them; scheduled runs are unattended.
fn claude_inbound(oauth_mode: bool, source_task_id: Option<&str>) -> crate::acp::process::Inbound {
    if oauth_mode || source_task_id.is_some() {
        crate::acp::process::Inbound::Refuse
    } else {
        crate::acp::process::Inbound::Accept
    }
}
```

`SessionInfo` 加字段 `pub peer_name: Option<String>,`；`session_info_of` 加：

```rust
        peer_name: (s.session_type == SessionType::Claude).then(|| peer_name_for(&s.id)),
```

`SessionManager` 字段区加（`search` 字段之后）：

```rust
    /// OAuth (multi-user) mode, wired at startup. Claude sessions refuse
    /// cross-session messages in this mode (spec 2026-09-26 v2).
    oauth_mode: std::sync::atomic::AtomicBool,
```

`SessionManager::new` 的结构体字面量里加 `oauth_mode: std::sync::atomic::AtomicBool::new(false),`（构造签名不变，现有 9 个调用点 —— main 1 + 测试 8 —— 都不用改）。`set_search` 之后加：

```rust
    /// Wire the auth mode (called once at startup).
    pub fn set_oauth_mode(&self, on: bool) {
        self.oauth_mode.store(on, std::sync::atomic::Ordering::Relaxed);
    }
```

`SpawnPlan` 加字段 `source_task_id: Option<String>,`；`decide_spawn` 里 `SpawnPlan { .. }` 加 `source_task_id: s.source_task_id.clone(),`；`ensure_running` 的解构改为 `let Some(SpawnPlan { stype, resume_token: token, work_dir, owner_id, cols, rows, source_task_id }) = plan else {`。

`spawn_claude` 签名加参数 `source_task_id: Option<&str>`，并把 Task 1 的临时值替换为：

```rust
        let peer_name = peer_name_for(id);
        let inbound = claude_inbound(
            self.oauth_mode.load(std::sync::atomic::Ordering::Relaxed), source_task_id);
        let process = AcpProcess::spawn(&self.claude_path, work_dir, resume, &peer_name, inbound)
```

三个调用点：`create_acp_session_tagged`（:1125）传 `source_task_id.as_deref()`；`ensure_running` 的两处（:1665、:1706）传 `source_task_id.as_deref()`。

`src/main.rs` 在 `state.sessions.set_search(state.search.clone());` 之后加：

```rust
    state.sessions.set_oauth_mode(oauth_configured);
```

（`oauth_configured` 在 `main` 顶部已定义，:251。）

- [ ] **Step 4: 跑 Rust 测试**

Run: `cargo test 2>&1 | grep -E "^test result|FAILED|panicked|^error" | head`
Expected: 全 `ok`。若 `SpawnPlan` 在测试里有字面量构造（`grep -n "SpawnPlan {" src/session_manager.rs`），补上 `source_task_id: None`。

- [ ] **Step 5: 验红**：`claude_inbound` 去掉 `oauth_mode ||` → `inbound_refuses_oauth_and_scheduled_runs` FAIL；恢复。

- [ ] **Step 6: 写前端失败测试** `frontend/src/lib/__tests__/peer.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { peerLabel } from '../peer'

describe('peerLabel (spec 2026-09-26 v2 §3d)', () => {
  const names = { 'zmx-ai-318698': '重构推送' }
  it('maps a known ZeroMux peer name to its session title', () => {
    expect(peerLabel('zmx-ai-318698', names)).toBe('重构推送')
  })
  it('falls back to the raw name for unknown or external senders', () => {
    expect(peerLabel('zmx-ai-ffffff', names)).toBe('zmx-ai-ffffff')
    expect(peerLabel('zmx-6c3596b8', names)).toBe('zmx-6c3596b8') // claude inside a tmux terminal
    expect(peerLabel('keith-laptop', names)).toBe('keith-laptop')
  })
})
```

Run: `cd frontend && npx vitest run src/lib/__tests__/peer.test.ts 2>&1 | tail -5`
Expected: FAIL（`Cannot find module '../peer'`）。

- [ ] **Step 7: 前端实现**

`frontend/src/lib/peer.ts`：

```ts
// Claude Code cross-session peer names (spec 2026-09-26 v2 §3d). ZeroMux names
// each Claude agent session `zmx-ai-<id6>`; show the session title for those.
export function peerLabel(fromName: string, peerNames: Record<string, string>): string {
  return peerNames[fromName] ?? fromName
}
```

`frontend/src/lib/api.ts` 的 `SessionInfo` 加 `peer_name?: string | null`（放在 `other_clients` 之后）。

`App.tsx`：在组件内 `sessions` state 之后加

```tsx
  const peerNames = useMemo(
    () => Object.fromEntries(sessions.filter(s => s.peer_name).map(s => [s.peer_name as string, s.name])),
    [sessions],
  )
```

（若 `useMemo` 未导入，加到 `react` 的 import。）`<AcpChatView` 加 prop `peerNames={peerNames}`。

`AcpChatView.tsx`：`Props` 加 `peerNames?: Record<string, string>`，解构时默认 `peerNames = EMPTY_PEERS`（模块级 `const EMPTY_PEERS: Record<string, string> = {}`，避免每次渲染新对象破坏 memo）；把 `peerNames` 作为 prop 传给 `<TurnGroupView`，`TurnGroupViewImpl` 的 props 类型加 `peerNames?: Record<string, string>`，气泡标签改为：

```tsx
            {p.fromName ? `来自 @${peerLabel(p.fromName, peerNames ?? {})}` : 'You'}
```

并 `import { peerLabel } from '../lib/peer'`。

**必须**同时更新 `TurnGroupView` 的自定义 memo 比较器（`AcpChatView.tsx` :1105-1117），在末尾加 `&& prev.peerNames === next.peerNames`：
`stabilizeGroups` 会保留已完成 turn 的对象身份，不比较这个 prop 的话，会话改名后旧气泡的标签永远不刷新（与比较器里 `resolvedApprovals` 的注释同理）。
`App.tsx` 的 `useMemo` 只在 `sessions` 变化时产生新对象，3 秒轮询返回相同内容时 `setSessions` 仍会换引用 —— 可接受（与 `sessions` 本身的重渲染频率相同）。

中断键（:839-853）改为 busy 时始终可见：

```tsx
        {busy && (
          <div className="flex items-center gap-2 px-2 pb-1 text-xs">
            {stuck ? (
              <span className="text-[var(--accent-red)]">已静默 {silenceSecs}s，可能卡住</span>
            ) : (
              <span className="text-[var(--text-muted)] italic">已运行 {elapsed}s…</span>
            )}
            {/* Always available while busy: a CLI-started (cross-session) turn is
                autonomous work the user did not start and must be able to stop
                from a phone (spec 2026-09-26 v2 §3e). */}
            <button
              onClick={interrupt}
              className={`px-2 py-0.5 text-[10px] font-semibold border rounded transition-colors ${
                stuck
                  ? 'text-[var(--accent-red)] border-[var(--accent-red)] hover:bg-[var(--accent-red)] hover:text-white'
                  : 'text-[var(--text-secondary)] border-[var(--border)] hover:text-[var(--text-primary)]'
              }`}
            >
              中断
            </button>
          </div>
        )}
```

`SessionInfoBar.tsx` 展开区（`{expanded && (` 内，Status 行之前）加：

```tsx
          {session.peer_name && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--text-muted)] uppercase w-12">Peer</span>
              <code className="text-[10px] text-[var(--text-primary)]">{session.peer_name}</code>
              <button
                onClick={() => navigator.clipboard?.writeText(session.peer_name as string)}
                className="px-1.5 py-0.5 text-[10px] rounded border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                title="复制跨会话消息地址"
              >
                复制
              </button>
              <span className="text-[10px] text-[var(--text-muted)]">
                {session.running ? '在线' : '休眠 · 打开会话后才能收到消息'}
              </span>
            </div>
          )}
```

- [ ] **Step 8: 前端测试 + lint + 构建**

Run: `cd frontend && npm run lint && npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -3`
Expected: 全 PASS。验红：`peerLabel` 改为直接 `return fromName` → 第一个用例 FAIL；恢复。

- [ ] **Step 9: 提交**

```bash
git add src/session_manager.rs src/main.rs frontend/src/lib/api.ts frontend/src/lib/peer.ts frontend/src/lib/__tests__/peer.test.ts frontend/src/components/SessionInfoBar.tsx frontend/src/components/AcpChatView.tsx frontend/src/App.tsx
git commit -m "feat: stable zmx-ai-<id6> peer names, per-mode inbound policy, always-available interrupt

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 端到端验收 + 部署

**Files:** 无代码改动（若验收发现问题，回到对应 Task 修）。

- [ ] **Step 1: 全量验证（debug）**

```bash
cd frontend && npm ci && npm run lint && npm test && npm run build && cd ..
cargo test 2>&1 | grep -E "^test result|FAILED"
```

Expected: 全绿。基线（2026-09-26 double check：在一次性 worktree 里按本计划套用 Task 1–6 实测）：Rust **480 passed**（当时 main 为 459；tmux 合入后 main 基数已变，以实施时 `cargo test` 为准，本特性增量 +21）；前端 **54 files / 331 passed**（同上，本特性增量 +20）；`tsc -b` 0 错；`npm run lint` 与 main 相同（main 已有 30 errors / 5 warnings，本特性不新增）；Rust 警告与 main 相同 3 条（`web.rs:2815` 等，非本特性）。**不要**在这里跑 `cargo build --release`（Global Constraints）。

- [ ] **Step 2: 先推送，再构建并部署**（本终端在 zeromux cgroup 内：deploy 时本终端掉线属预期）

```bash
git push origin main
./deploy.sh --build
```

掉线后从新终端 `systemctl is-active zeromux` 与 `journalctl -u zeromux-deploy-<pid> --no-pager | tail` 确认。

- [ ] **Step 3: 线上验收**（从一次性 `claude -p` 沙箱会话、开发会话或 UI 发消息，逐项勾选）
  1. 空闲 ZeroMux Claude 会话收到短消息：出现「来自 @…」气泡、busy 亮、结束后熄；日志有 `CLI-started turn (external)`；**不**推送（<60s，预期）。
  2. PushSettings 打开「常规」，发一条让它先 `sleep 70` 再回复的消息，锁屏：收到一次「✅ {name} 完成」。
  3. 外部 turn 进行中（让它执行 `sleep 20`）在 UI 发 prompt：显示「已排队」，外部 turn 结束后才执行；会话最终回到 Idle。
  4. 外部 turn 进行中点「中断」（非 stuck 状态也可见）：turn 停止，会话回到 Idle。
  5. 刷新页面：气泡与分组一致，busy 与后端 `turn_state` 一致。
  6. ZeroMux 会话 A、B：从 B 的 SessionInfoBar 复制 peer 名，在 A 里让它给 B 发消息，并让 B 回信给 A。两边气泡显示「来自 @{对方会话名}」，两边都不卡 Running。
  7. 从 SSH 里、以及从 **ZeroMux tmux 终端**里运行的交互式 `claude`（非 bypass）给 ZeroMux Claude 会话发消息：直接送达，未被 hold；`ListAgents` 里 `zmx-ai-…` 与 tmux 里的 claude（带 `tmux zmx-…` 标注）可区分。
  8. 让 ZeroMux 会话向一个 `crossSessionInbound: refuse` 的沙箱会话发消息：UI 出现灰色 notice。
  9. 部署后未打开的会话不在 `ListAgents` 中，SessionInfoBar 显示「休眠」；打开后出现，peer 名与部署前相同。
  10. 自动命名：新建会话首条 prompt 后标题正常生成（titler 未被 peer 干扰）。
  11. 定时任务会话（若有）的 `ps` 参数含 `"crossSessionInbound":"refuse"`：`ps -ef | grep crossSessionInbound`。

- [ ] **Step 4: 清理** 所有一次性沙箱会话（`kill`）、`/tmp/zmx-xs-*` 与 `/tmp/zmx-cto-probe/` 目录。
