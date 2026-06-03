# Group B-2 会话主动管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在 B-1 持久可恢复会话之上叠加主动生命周期管理：会话运行态可见、turn 完成红点、卡死计时、中断重发、侧栏 rename。

**Architecture:** 无新后台任务——fan-out 在 turn 边界经 `Weak<SessionManager>` 维护内存运行态字段，列表 API 暴露这些字段，前端 3s 轮询派生红点/卡死提示。中断重发引入 turn 级 `SessionInput::Interrupt` 原语（区别于杀进程的 `Cancel`），三端各实现一个 `interrupt()`（线路已 spike 实测）。

**Tech Stack:** Rust/Axum/tokio (broadcast+mpsc fan-out)、SQLite (rusqlite)、React 19/Vite/TS。

设计文档：`docs/superpowers/specs/2026-06-03-session-active-management-B2-design.md`

---

## File Structure

后端：
- `src/session_manager.rs` — `TurnState` 枚举、`RunningProcess` 三新字段、`Session` 两新字段、`mark_turn`、`SessionInfo` 扩展、`list_sessions` 扩展、`update_session_meta` 扩展 name、3 个 agent fan-out 的中断重发逻辑、`SessionInput::Interrupt`。
- `src/acp/process.rs` — `AcpProcess::interrupt()`（Claude control_request）。
- `src/acp/kiro_process.rs` — `Cmd::Cancel` 分支 + `KiroProcess::interrupt()`。
- `src/acp/codex_process.rs` — `CodexProcess::interrupt()` + `kill()` 改用 `Cmd::Stop`。
- `src/acp/ws_handler.rs` — `ClientMsg::Interrupt`。
- `src/web.rs` — `UpdateSessionReq` 加 `name`。

前端：
- `frontend/src/lib/api.ts` — `SessionInfo` 类型加新字段；`renameSession`、`interrupt` WS 消息。
- `frontend/src/App.tsx` — 3s 轮询、红点状态、侧栏增强、rename 接线。
- `frontend/src/components/AcpChatView.tsx` — 解禁 busy 发送、卡死计时提示、发 interrupt。
- `frontend/src/components/SessionInfoBar.tsx` — 可能复用展示状态（按需）。

---

## Task 1: 核心运行态字段 + mark_turn

**Files:**
- Modify: `src/session_manager.rs`（`RunningProcess` ~123、`Session` ~140、4 个构造点、新增 `mark_turn`）

**关键模式约束**：现有测试（`decide_spawn_tests`）从不构造 `SessionManager`（其 `new()` 是 async 且需 EventStore/SessionStore/CLI 配置）。它们测**作用于 `&mut Session` 的纯函数**（如 `decide_spawn`）。本任务遵循同一模式：把 turn 状态变更逻辑抽成纯函数 `apply_turn(session: &mut Session, state: TurnState, seq: u64)`，`mark_turn` 方法只负责「持锁 + 调 `apply_turn`」。测试只测 `apply_turn`，复用 `decide_spawn_tests` 已有的 `test_session()` helper 风格。

- [x] **Step 1: 写失败测试**（追加到 `session_manager.rs` 末尾，新建 mod）

```rust
#[cfg(test)]
mod turn_state_tests {
    use super::*;

    // 复用 decide_spawn_tests 的构造风格，但带一个 running 进程。
    fn running_session(id: &str) -> Session {
        let (event_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (input_tx, _rx) = mpsc::channel(8);
        Session {
            id: id.into(), name: "t".into(),
            session_type: SessionType::Claude,
            cols: 80, rows: 24, work_dir: "/tmp".into(),
            owner_id: "u".into(), description: String::new(),
            status: SessionMeta::Running,
            resume_token: None, worktree_path: None, created_ms: 0,
            spawning: false,
            last_activity_ms: 0,
            turns_completed: 0,
            running: Some(RunningProcess {
                event_tx, input_tx, pty_pid: None,
                turn_state: TurnState::Idle,
                turn_started_ms: None,
                turn_seq: 0,
            }),
            scrollback: VecDeque::new(), scrollback_bytes: 0,
        }
    }

    #[test]
    fn apply_running_sets_started_and_seq() {
        let mut s = running_session("s");
        apply_turn(&mut s, TurnState::Running, 1);
        let rp = s.running.as_ref().unwrap();
        assert_eq!(rp.turn_state, TurnState::Running);
        assert!(rp.turn_started_ms.is_some());
        assert_eq!(rp.turn_seq, 1);
    }

    #[test]
    fn apply_idle_matching_seq_clears_and_counts() {
        let mut s = running_session("s");
        apply_turn(&mut s, TurnState::Running, 1);
        apply_turn(&mut s, TurnState::Idle, 1);
        assert_eq!(s.turns_completed, 1);
        assert_eq!(s.running.as_ref().unwrap().turn_state, TurnState::Idle);
        assert!(s.running.as_ref().unwrap().turn_started_ms.is_none());
    }

    #[test]
    fn apply_idle_stale_seq_ignored() {
        // 旧 turn（seq=1）的迟到 Idle 不能翻掉新 turn（seq=2）的 Running。
        let mut s = running_session("s");
        apply_turn(&mut s, TurnState::Running, 2);
        apply_turn(&mut s, TurnState::Idle, 1); // stale → ignore
        assert_eq!(s.turns_completed, 0);
        assert_eq!(s.running.as_ref().unwrap().turn_state, TurnState::Running);
    }

    #[test]
    fn apply_on_hibernated_is_noop() {
        let mut s = running_session("s");
        s.running = None;
        apply_turn(&mut s, TurnState::Running, 1); // 无 running，仅更新 last_activity
        assert!(s.running.is_none());
        assert!(s.last_activity_ms > 0 || s.last_activity_ms == now_millis());
    }
}
```

- [x] **Step 2: 运行测试确认失败**

Run: `cargo test turn_state_tests 2>&1 | tail -20`
Expected: 编译失败（`TurnState`、新字段、`mark_turn` 不存在）

- [x] **Step 3: 加 `TurnState` 枚举 + 字段**

在 `RunningProcess`（~123）：

```rust
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TurnState { Idle, Running }

struct RunningProcess {
    event_tx: broadcast::Sender<String>,
    input_tx: mpsc::Sender<SessionInput>,
    pty_pid: Option<u32>,
    turn_state: TurnState,
    turn_started_ms: Option<i64>,
    turn_seq: u64,
}
```

在 `Session`（~140，`spawning: bool,` 后、`running` 前）：

```rust
    last_activity_ms: i64,
    turns_completed: u32,
```

- [x] **Step 4: 4 个 RunningProcess 构造点补字段**

在 `spawn_tmux`/`spawn_claude`(spawn_acp)/`spawn_kiro`/`spawn_codex` 各自的 `Ok(RunningProcess { event_tx, input_tx, pty_pid })`（grep `Ok(RunningProcess`）改为：

```rust
        Ok(RunningProcess {
            event_tx,
            input_tx,
            pty_pid: /* 原值 */,
            turn_state: TurnState::Idle,
            turn_started_ms: None,
            turn_seq: 0,
        })
```

并在所有 `Session { ... }` 字面量构造点（`create_*` + `load_persisted`）补 `last_activity_ms: now_millis(), turns_completed: 0,`（load_persisted 用 `created_ms` 或 `now_millis()` 均可——休眠 session 无 turn 历史，用 `now_millis()`）。grep `Session {` 找全部构造点（应为 4 个 create + 1 个 load）。

- [x] **Step 5: 加纯函数 `apply_turn` + 方法 `mark_turn`**

纯函数（模块级，放 `decide_spawn` 附近，便于单测）：

```rust
/// turn 边界状态变更（纯函数，便于单测）。Running 置 started_ms 并采纳新 seq；
/// Idle 仅当 seq 与当前一致才生效（忽略被中断旧 turn 的迟到事件）并 +1 完成计数。
fn apply_turn(session: &mut Session, state: TurnState, seq: u64) {
    let now = now_millis();
    session.last_activity_ms = now;
    if let Some(rp) = session.running.as_mut() {
        match state {
            TurnState::Running => {
                rp.turn_state = TurnState::Running;
                rp.turn_started_ms = Some(now);
                rp.turn_seq = seq;
            }
            TurnState::Idle => {
                if rp.turn_seq == seq {
                    rp.turn_state = TurnState::Idle;
                    rp.turn_started_ms = None;
                    session.turns_completed = session.turns_completed.wrapping_add(1);
                }
            }
        }
    }
}
```

方法（impl SessionManager，靠近 `update_session_meta`）——仅持锁转调，绝不跨 `.await` / 不调 store：

```rust
    fn mark_turn(&self, sid: &str, state: TurnState, seq: u64) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(sid) {
            apply_turn(s, state, seq);
        }
    }
```

> `turn_seq` 由 `apply_turn(Running)` 采纳 fan-out 传入的 seq（fan-out 自增后传入，见 Task 4），无需 fan-out 再单独写回 `rp.turn_seq`。

- [x] **Step 6: 运行测试确认通过**

Run: `cargo test turn_state_tests 2>&1 | tail -20`
Expected: 4 passed

- [x] **Step 7: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(b2): TurnState + per-process turn fields + mark_turn"
```

---

## Task 2: SessionInfo 扩展 + list_sessions

**Files:**
- Modify: `src/session_manager.rs`（`SessionInfo` ~183、`list_sessions` ~940）

**模式约束**：同 Task 1，不构造 `SessionManager`。把 `Session → SessionInfo` 的映射抽成纯函数 `session_info_of(&Session) -> SessionInfo`，`list_sessions` 的 map 闭包改调它，测试只测纯函数。

- [x] **Step 1: 写失败测试**（turn_state_tests mod 内追加）

```rust
    #[test]
    fn session_info_reports_turn_fields() {
        let mut s = running_session("s");
        apply_turn(&mut s, TurnState::Running, 1);
        let info = session_info_of(&s);
        assert_eq!(info.running, true);
        assert_eq!(info.turn_state, Some("running"));
        assert!(info.turn_started_ms.is_some());
    }

    #[test]
    fn hibernated_session_turn_state_none() {
        let mut s = running_session("h");
        s.running = None; // 休眠
        let info = session_info_of(&s);
        assert_eq!(info.running, false);
        assert_eq!(info.turn_state, None);
    }
```

- [x] **Step 2: 运行确认失败**

Run: `cargo test turn_state_tests 2>&1 | tail`
Expected: 编译失败（`session_info_of` 不存在 / SessionInfo 无新字段）

- [x] **Step 3: 扩展 `SessionInfo`**（~183）

```rust
#[derive(serde::Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub session_type: SessionType,
    pub cols: u16,
    pub rows: u16,
    pub work_dir: String,
    pub description: String,
    pub status: SessionMeta,
    pub running: bool,
    pub turn_state: Option<&'static str>,
    pub turn_started_ms: Option<i64>,
    pub last_activity_ms: i64,
    pub turns_completed: u32,
}
```

- [x] **Step 4: 加纯函数 `session_info_of` + `list_sessions` 改调它**

纯函数（模块级，`apply_turn` 附近）：

```rust
fn session_info_of(s: &Session) -> SessionInfo {
    SessionInfo {
        id: s.id.clone(),
        name: s.name.clone(),
        session_type: s.session_type,
        cols: s.cols,
        rows: s.rows,
        work_dir: s.work_dir.clone(),
        description: s.description.clone(),
        status: s.status,
        running: s.running.is_some(),
        turn_state: s.running.as_ref().map(|rp| match rp.turn_state {
            TurnState::Idle => "idle",
            TurnState::Running => "running",
        }),
        turn_started_ms: s.running.as_ref().and_then(|rp| rp.turn_started_ms),
        last_activity_ms: s.last_activity_ms,
        turns_completed: s.turns_completed,
    }
}
```

`list_sessions`（~940）的 `.map(|s| SessionInfo { ... })` 整体替换为 `.map(session_info_of)`（注意 filter 后是 `&Session`，签名匹配）。

- [x] **Step 5: 运行确认通过**

Run: `cargo test turn_state_tests 2>&1 | tail -20`
Expected: 6 passed（Task1 的 4 个 + Task2 的 2 个）

- [x] **Step 6: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(b2): expose turn state + activity in SessionInfo/list_sessions"
```

---

## Task 3: 三端 interrupt() 原语

**Files:**
- Modify: `src/acp/process.rs`（Claude）、`src/acp/kiro_process.rs`、`src/acp/codex_process.rs`

实测线路（spec §6.2）：Claude=stdin control_request；Kiro=session/cancel 通知；Codex=Cmd::Cancel。

- [x] **Step 1: Claude `AcpProcess::interrupt()`**（`process.rs`，紧接 `send_prompt` 后）

```rust
    /// Turn-level interrupt: tell Claude to abort the current turn but keep the
    /// process alive (verified: stdin control_request {subtype:"interrupt"}).
    pub async fn interrupt(&mut self) -> Result<(), std::io::Error> {
        let msg = serde_json::json!({
            "type": "control_request",
            "request_id": format!("zmx-int-{}", now_seq()),
            "request": { "subtype": "interrupt" }
        });
        let mut line = serde_json::to_string(&msg).unwrap();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await
    }
```

`now_seq()`：Claude 不要求 request_id 全局唯一，用进程内自增即可。在 `AcpProcess` 加一个字段 `int_seq: u64`（构造时 0），方法体改 `self.int_seq += 1;` 并用 `self.int_seq`。或简单用一个 `static AtomicU64`。实现者选最小：

```rust
// 文件顶部
use std::sync::atomic::{AtomicU64, Ordering};
static INT_SEQ: AtomicU64 = AtomicU64::new(0);
fn now_seq() -> u64 { INT_SEQ.fetch_add(1, Ordering::Relaxed) }
```

- [x] **Step 2: Kiro `Cmd::Cancel` + `interrupt()`**（`kiro_process.rs`）

枚举（~67）加变体：

```rust
enum Cmd {
    Prompt(String),
    Cancel,
    Stop,
}
```

`run_event_loop` 的 `cmd` 分支（~291）加 `Cmd::Cancel`：

```rust
                    Some(Cmd::Cancel) => {
                        // ACP session/cancel is a notification (no id). Verified:
                        // aborts the in-flight session/prompt turn, process lives.
                        let req = serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": "session/cancel",
                            "params": { "sessionId": session_id }
                        });
                        let mut buf = serde_json::to_string(&req).unwrap();
                        buf.push('\n');
                        if stdin.write_all(buf.as_bytes()).await.is_err() { return; }
                        let _ = stdin.flush().await;
                    }
```

`KiroProcess` impl 加方法（紧接 `send_prompt`）：

```rust
    pub async fn interrupt(&mut self) -> Result<(), std::io::Error> {
        self.cmd_tx.send(Cmd::Cancel).await.map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "kiro event loop exited")
        })
    }
```

`kill()` 不变（仍 `Cmd::Stop` + `child.kill()`）。

- [x] **Step 3: Codex `interrupt()` + `kill()` 改 Stop**（`codex_process.rs` ~327-338）

```rust
    pub async fn interrupt(&mut self) -> Result<(), std::io::Error> {
        // Turn-level cancel: drop in-flight call_fut, keep thread_id (verified).
        self.cmd_tx.send(Cmd::Cancel).await.map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "codex event loop exited")
        })
    }

    pub async fn kill(&mut self) {
        // Process teardown: Stop ends the loop (was Cmd::Cancel — turn-level —
        // which only worked because Drop later closed cmd_tx).
        let _ = self.cmd_tx.send(Cmd::Stop).await;
    }
```

> 检查：codex 的 idle-cancel 分支（H4 fix，~581）`Some(Cmd::Cancel) => { ...ignoring }` 仍正确（idle 时 interrupt 无在途 turn，忽略即可）。`Drop`（~349）try_send `Cmd::Stop` 不变。

- [x] **Step 4: 编译**

Run: `cargo build 2>&1 | tail -20`
Expected: 编译通过（这 3 个方法暂未被调用，会有 dead_code 警告——Task 4 接线后消除；本步只验证签名/类型正确）

- [x] **Step 5: Commit**

```bash
git add src/acp/process.rs src/acp/kiro_process.rs src/acp/codex_process.rs
git commit -m "feat(b2): per-backend interrupt() turn-cancel primitives (spike-verified)"
```

---

## Task 4: SessionInput::Interrupt + fan-out 中断重发

**Files:**
- Modify: `src/session_manager.rs`（`SessionInput` ~110、3 个 agent fan-out ~1227/1284/1344）

- [x] **Step 1: 加 `SessionInput::Interrupt`**（~118）

```rust
pub enum SessionInput {
    PtyData(Vec<u8>),
    PtyResize(u16, u16),
    Prompt(String),
    Cancel,
    Interrupt,
}
```

- [x] **Step 2: 改三个 agent fan-out 的 Prompt/事件分支**

对 `spawn_acp_fanout` / `spawn_kiro_fanout` / `spawn_codex_fanout` 三者做**相同结构**的改动。每个 fan-out 的 `tokio::spawn(async move { ... })` 顶部、`loop` 之前加本地状态：

```rust
        let mut turn_seq: u64 = 0;
        let mut local_running = false;
```

事件分支（收到 process 事件后，在 `event_tx.send(json)` 之后）加 turn 边界检测——根据事件类型翻 Idle。三端事件都是 `AcpEvent`，判断方式统一：

```rust
                            // turn 边界：Result/Error/Exit → 回 Idle
                            if matches!(evt, AcpEvent::Result { .. } | AcpEvent::Error { .. } | AcpEvent::Exit { .. }) {
                                local_running = false;
                                if let Some(m) = mgr.upgrade() {
                                    m.mark_turn(&sid, TurnState::Idle, turn_seq);
                                }
                            }
```

> 放置位置：在 `let _ = event_tx.send(json);` 之后、`match` 的 `Some(evt)` 分支结尾前。注意 `evt` 在被 `serde_json::to_string(&evt)` 借用后仍可 `matches!`（不 move）。若所有权有问题，在序列化前先算 `let is_boundary = matches!(...);`。

Prompt 分支改为中断重发：

```rust
                        Some(SessionInput::Prompt(text)) => {
                            if local_running {
                                if let Err(e) = process.interrupt().await {
                                    tracing::warn!("interrupt before resend failed for {}: {}", sid, e);
                                }
                            }
                            turn_seq += 1;
                            local_running = true;
                            if let Some(m) = mgr.upgrade() {
                                m.mark_turn(&sid, TurnState::Running, turn_seq);
                            }
                            if let Err(e) = process.send_prompt(&text).await {
                                tracing::warn!("send_prompt failed for {}: {}", sid, e);
                            }
                        }
```

加 Interrupt 分支（在 Cancel 分支旁）：

```rust
                        Some(SessionInput::Interrupt) => {
                            if local_running {
                                if let Err(e) = process.interrupt().await {
                                    tracing::warn!("interrupt failed for {}: {}", sid, e);
                                }
                                // 旧 turn 的 Result/Error 会照常到达并经 mark_turn(Idle,seq) 翻 Idle
                            }
                        }
```

> **注意 Codex 的 `interrupt()`/`send_prompt()` 返回 `Result`**，Claude/Kiro 同。三端 `interrupt()` 签名一致（`async fn interrupt(&mut self) -> Result<(), io::Error>`），上面代码三端通用。Cancel 分支保持原样（`process.kill().await`）。

- [x] **Step 3: 编译 + 既有测试**

Run: `cargo test 2>&1 | tail -25`
Expected: 全部通过（含 Task1/2 的 5 个），无 dead_code 警告（interrupt 已被调用）

- [x] **Step 4: Commit**

```bash
git add src/session_manager.rs
git commit -m "feat(b2): interrupt-resend in agent fan-outs + turn boundary reporting"
```

---

## Task 5: WS ClientMsg::Interrupt 接线

**Files:**
- Modify: `src/acp/ws_handler.rs`（`ClientMsg` ~20、消息映射 ~129）

- [x] **Step 1: 加 `ClientMsg::Interrupt`**（~20）

```rust
#[derive(serde::Deserialize)]
#[serde(tag = "type")]
enum ClientMsg {
    #[serde(rename = "prompt")]
    Prompt { text: String },
    #[serde(rename = "cancel")]
    Cancel,
    #[serde(rename = "interrupt")]
    Interrupt,
}
```

- [x] **Step 2: 映射到 SessionInput**（~136，Cancel 分支后）

```rust
                                ClientMsg::Interrupt => {
                                    let _ = input_tx.send(SessionInput::Interrupt).await;
                                }
```

- [x] **Step 3: 编译**

Run: `cargo build 2>&1 | tail -10`
Expected: 通过

- [x] **Step 4: Commit**

```bash
git add src/acp/ws_handler.rs
git commit -m "feat(b2): wire ClientMsg::Interrupt → SessionInput::Interrupt"
```

---

## Task 6: rename — 扩展 update_session_meta 接 name

**Files:**
- Modify: `src/session_manager.rs`（`update_session_meta` ~1016）、`src/web.rs`（`UpdateSessionReq` ~465）

**模式约束**：`update_session_meta_named` 是触碰 store 的方法，难做纯函数单测。把**内存改动 + 决定落盘什么**抽成纯函数 `apply_meta(session, name, description, status) -> (Option<String>, Option<String>)`（返回要落盘的 name/desc），方法负责持锁调它 + 锁外落盘。测试只测 `apply_meta`。

- [x] **Step 1: 写失败测试**（turn_state_tests mod）

```rust
    #[test]
    fn apply_meta_changes_name_and_reports_persist() {
        let mut s = running_session("s");
        let (pn, pd) = apply_meta(&mut s, Some("renamed".into()), None, None);
        assert_eq!(s.name, "renamed");
        assert_eq!(pn.as_deref(), Some("renamed"));
        assert_eq!(pd, None);
    }
```

- [x] **Step 2: 确认失败**

Run: `cargo test turn_state_tests::apply_meta 2>&1 | tail`
Expected: `apply_meta` 不存在，编译失败

- [x] **Step 3: 实现**（`session_manager.rs`）

决策：不改 `update_session_meta` 现有签名（避免大面积改调用点），**新增** `update_session_meta_named`，旧 `update_session_meta` 转调它（name=None）。内存逻辑抽到纯函数 `apply_meta`。

纯函数（模块级）：

```rust
/// 应用 meta 改动到内存 Session，返回需落盘的 (name, description)。纯函数，便于单测。
fn apply_meta(
    session: &mut Session,
    name: Option<String>,
    description: Option<String>,
    status: Option<SessionMeta>,
) -> (Option<String>, Option<String>) {
    let mut pn = None;
    let mut pd = None;
    if let Some(n) = name { session.name = n.clone(); pn = Some(n); }
    if let Some(d) = description { session.description = d.clone(); pd = Some(d); }
    if let Some(s) = status { session.status = s; }
    (pn, pd)
}
```

方法：

```rust
    pub fn update_session_meta(
        &self,
        id: &str,
        description: Option<String>,
        status: Option<SessionMeta>,
    ) -> bool {
        self.update_session_meta_named(id, None, description, status)
    }

    pub fn update_session_meta_named(
        &self,
        id: &str,
        name: Option<String>,
        description: Option<String>,
        status: Option<SessionMeta>,
    ) -> bool {
        let persist = {
            let mut map = self.sessions.lock().unwrap();
            map.get_mut(id).map(|s| apply_meta(s, name, description, status))
        };
        match persist {
            Some((pn, pd)) => {
                if let Some(n) = pn { let _ = self.store.update_name(id, &n); }
                if let Some(d) = pd { let _ = self.store.update_description(id, &d); }
                true
            }
            None => false,
        }
    }
```

> 这同时清理 B-1 遗留的 `SessionStore::update_name` dead code。

- [x] **Step 4: web.rs `UpdateSessionReq` 加 name**（~465）

```rust
#[derive(serde::Deserialize)]
struct UpdateSessionReq {
    name: Option<String>,
    description: Option<String>,
    status: Option<crate::session_manager::SessionMeta>,
}
```

handler 改调用：

```rust
    if state.sessions.update_session_meta_named(&id, req.name, req.description, req.status) {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
```

> 空 name 校验：在 handler 里若 `req.name.as_deref() == Some("")` 返回 `StatusCode::BAD_REQUEST`。

- [x] **Step 5: 运行测试 + 编译**

Run: `cargo test turn_state_tests 2>&1 | tail; cargo build 2>&1 | tail -5`
Expected: 全通过

- [x] **Step 6: Commit**

```bash
git add src/session_manager.rs src/web.rs
git commit -m "feat(b2): session rename via PATCH name; retires update_name dead code"
```

---

## Task 7: 前端 — 类型 + 3s 轮询 + WS interrupt

**Files:**
- Modify: `frontend/src/lib/api.ts`、`frontend/src/App.tsx`

- [x] **Step 1: api.ts — 扩展 SessionInfo 类型 + renameSession**

在 `SessionInfo`（或对应 interface）加：

```typescript
  running: boolean
  turn_state: 'idle' | 'running' | null
  turn_started_ms: number | null
  last_activity_ms: number
  turns_completed: number
```

加 rename 函数（仿现有 PATCH 调用风格）：

```typescript
export async function renameSession(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`rename failed: ${res.status}`)
}
```

> 校验现有 api.ts 是否已有 PATCH session 的 helper（updateSession?）；若有则复用/扩展，不新建。

- [x] **Step 2: App.tsx — 3s 轮询合并状态**

在持有 session list 的组件加：

```typescript
useEffect(() => {
  const tick = setInterval(async () => {
    try {
      const list = await listSessions()  // 现有拉列表函数
      setSessions(list)                    // 现有 setter
    } catch { /* ignore transient */ }
  }, 3000)
  return () => clearInterval(tick)
}, [])
```

> 若现有已有轮询/刷新机制，复用之并确保新字段被纳入 state，不重复建 interval。

- [x] **Step 3: api.ts — WS interrupt 消息**

WS 发送处（现有 sendPrompt/cancel 旁）加 interrupt sender，或在 AcpChatView 直接 `ws.send(JSON.stringify({ type: 'interrupt' }))`（Task 8 用）。本步只确保协议字符串 `{ type: 'interrupt' }` 与后端 `#[serde(rename="interrupt")]` 对齐。

- [x] **Step 4: 构建验证**

Run: `cd frontend && npm run build 2>&1 | tail -15`
Expected: tsc + vite 通过

- [x] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/App.tsx
git commit -m "feat(b2): frontend session-state types + 3s polling + rename api"
```

---

## Task 8: 前端 — 解禁 busy 发送 + 卡死计时 + interrupt

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx`

- [x] **Step 1: 解禁 busy 时发送**（~295）

```tsx
            disabled={!input.trim()}
```

并改 `sendPrompt`：发送前若 `busy`，先发 interrupt（中断重发由后端处理，但前端也可仅发 prompt——后端 fan-out 已自动中断在途 turn）。**简洁做法：前端只发 prompt，中断重发完全由后端 fan-out 处理**（Task 4 已实现 Prompt 分支自动 interrupt）。因此本步仅解禁按钮，`sendPrompt` 逻辑不变。

- [x] **Step 2: 卡死计时提示**

加本地 1s 计时器，当当前会话 `turn_state==='running'` 显示已运行时长。从 props/state 拿当前 session 的 `turn_started_ms`：

```tsx
const [nowMs, setNowMs] = useState(() => Date.now())
useEffect(() => {
  if (!busy) return
  const t = setInterval(() => setNowMs(Date.now()), 1000)
  return () => clearInterval(t)
}, [busy])

// 渲染 busy 区：
const elapsed = turnStartedMs ? Math.floor((nowMs - turnStartedMs) / 1000) : 0
const stuck = elapsed > 180
// busy 指示文案：
//   普通： `已运行 ${elapsed}s`
//   stuck： `已运行 ${elapsed}s，可能卡住 — 取消？` + 取消按钮
```

> `turnStartedMs` 来源：当前会话的 `turn_started_ms`（从轮询的 session list 找当前 id；或若 AcpChatView 不持 list，由 App 下传 prop）。实现者按现有 prop 链选最小路径——优先由 App 把当前 session 的 `turn_started_ms` 作为 prop 传入。`Date.now()` 与后端 `now_millis()` 同为 epoch ms，可直接相减。

取消按钮（stuck 时显示）发 interrupt：

```tsx
onClick={() => ws.send(JSON.stringify({ type: 'interrupt' }))}
```

> 复用现有 ws 引用；若现有有 cancel 按钮，stuck 取消按钮发 `interrupt`（保会话），不发 `cancel`（杀进程）。

- [x] **Step 3: 构建验证**

Run: `cd frontend && npm run build 2>&1 | tail -15`
Expected: 通过

- [x] **Step 4: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "feat(b2): unlock busy-send + stuck-turn timer + interrupt button"
```

---

## Task 9: 前端 — 侧栏状态点 + 完成红点 + inline rename

**Files:**
- Modify: `frontend/src/App.tsx`（侧栏 session 列表渲染）

- [x] **Step 1: 完成红点状态（计数器版）**

维护「已读基线」map：

```typescript
// session id → 已读到的 turns_completed
const [readCounts, setReadCounts] = useState<Record<string, number>>({})

// 某 session 有红点的判定（非当前激活 且 turns_completed > 已读基线）
const hasUnread = (s: SessionInfo) =>
  s.id !== activeSessionId && s.turns_completed > (readCounts[s.id] ?? 0)

// 切到某 session 时清红点（记下当前计数为已读）
useEffect(() => {
  if (!activeSessionId) return
  const s = sessions.find(x => x.id === activeSessionId)
  if (s) setReadCounts(prev => ({ ...prev, [activeSessionId]: s.turns_completed }))
}, [activeSessionId, sessions])
```

> 首次见到某 session（基线缺失）以其当前 `turns_completed` 为基线？否——新完成应亮红点。基线缺省 0，但**初次加载已有历史的 session 不应全亮**：在首次拉到 list 时，对所有非激活 session 用其当前 `turns_completed` 初始化 readCounts（视作「加载前的都已读」）。实现者加一个 `initializedRef` 守卫，仅首帧做基线初始化。

- [x] **Step 2: 侧栏每项渲染状态点 + 红点 + 最后活动 + rename**

每个 session 列表项：

```tsx
{/* 状态点 */}
<span className={
  !s.running ? 'w-2 h-2 rounded-full border border-[var(--text-secondary)]' // 空心=休眠
  : s.turn_state === 'running' ? 'w-2 h-2 rounded-full bg-green-400'         // 绿=running
  : 'w-2 h-2 rounded-full bg-[var(--text-secondary)]'                        // 灰=idle
} />
{/* 完成红点 */}
{hasUnread(s) && <span className="w-2 h-2 rounded-full bg-red-500" />}
{/* 最后活动相对时间 */}
<span className="text-xs text-[var(--text-secondary)]">{relativeTime(s.last_activity_ms)}</span>
```

`relativeTime(ms)`：简单实现（`<60s` → `刚刚`，`<60m` → `Xm`，`<24h` → `Xh`，else `Xd`）。放 utils 或就地。

inline rename：双击名字进入编辑态 `<input>`，回车/失焦调 `renameSession(id, value)` 后刷新 list：

```tsx
{editingId === s.id ? (
  <input
    autoFocus
    defaultValue={s.name}
    onBlur={e => commitRename(s.id, e.target.value)}
    onKeyDown={e => { if (e.key === 'Enter') commitRename(s.id, (e.target as HTMLInputElement).value) }}
  />
) : (
  <span onDoubleClick={() => setEditingId(s.id)}>{s.name}</span>
)}
```

```typescript
const commitRename = async (id: string, name: string) => {
  setEditingId(null)
  if (name.trim() && name !== sessions.find(s=>s.id===id)?.name) {
    try { await renameSession(id, name.trim()); /* 刷新 list */ } catch { /* toast */ }
  }
}
```

- [x] **Step 3: 构建 + lint**

Run: `cd frontend && npm run build 2>&1 | tail -15 && npm run lint 2>&1 | tail -15`
Expected: 均通过（注意 lucide 图标若用，按既往用 `createElement` 避免 react-hooks/static-components）

- [x] **Step 4: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(b2): sidebar status dots + completion red-dot + inline rename"
```

---

## Final Verification（全部任务后）

- [x] **后端全测**：`cargo test 2>&1 | tail -25`（B-1 的 57 + B-2 新增全过）
- [x] **前端全测**：`cd frontend && npm run build && npm run lint && npm test 2>&1 | tail`
- [x] **部署**（按 [[zeromux-deploy]]）：`sudo systemctl stop zeromux` → `cargo build --release` → `cp target/release/zeromux /usr/local/bin/zeromux` → `sudo systemctl start zeromux`
- [x] **手动验证**（spec §9.手动验证 四项）：中断重发三端各一次、完成红点、卡死计时+取消、rename 重启存活
- [x] **通知用户**

---

## 风险与回退

- **中断重发**：三端线路已 spike 实测（2026-06-03）。最大不确定性是 Codex drop-cancel 旧调用服务端续跑——`turn_seq` 已兜底迟到 Result，用户感知是「立刻响应」，可接受。
- **3s 轮询**：单用户零压力；若未来多用户需评估，但本次明确不优化。
- **不变量**：未新增手动 kill 路径（Interrupt 不 drop 进程）；锁纪律未变；fan-out 仍独占进程。
