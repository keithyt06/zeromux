# Group B-2：会话主动管理 — 设计文档

**日期**：2026-06-03
**状态**：已定稿，待实现。取代 2026-06-02 占位版。
**依赖**：[B-1 持久可恢复会话](2026-06-02-session-persistence-B1-design.md)（已上线并生产验证）。

---

## 1. 背景与范围调整

占位版（2026-06-02）原定四件事：中央轮询 watchdog 两级超时、Idle 容量驱逐、中断重发、tmux 红线。在细化时基于**线上事实**重新评估：

- zeromux 进程常驻 **32MB**，自身拥有的 agent 子进程 **0 个**，sessions 表 **0 行**——这是一个**单用户、并发≈0** 的部署。
- 因此 **Idle 容量驱逐（MAX_LIVE）是 YAGNI**（在解一个不存在的内存压力问题）；**自动杀进程**在单用户下弊大于利（可能正等一个慢任务）。两者**砍掉**。

调整后的 B-2 主题从「容量管理」转为「**会话多了怎么管 + turn 跑完怎么知道 + 跑着时怎么改主意**」，四个功能：

1. **会话运行态可见**：列表 API 暴露每个 session 的运行/turn 状态、最后活动时间、完成计数。
2. **完成提示（页内红点）**：未在看的 session turn 跑完后，列表项上打未读红点。
3. **卡死计时提示**：当前会话 turn 跑太久时，busy 区显示计时；超阈值升级措辞并给取消入口。**永不自动动作。**
4. **中断重发**：turn 进行中发新 prompt → 中断当前 turn（保进程、保上下文）→ 立即发新 prompt。
5. **会话管理增强**：侧栏列表显示状态点/红点/最后活动时间，支持 inline rename（接线 B-1 遗留的 `SessionStore::update_name` dead code）。

**不做**：Idle 驱逐、自动杀进程、Web/桌面通知、中央后台轮询任务、naozhi 的消息 coalesce / 多平台 IM / Cron / 多节点。

---

## 2. 架构决策：无后台任务，全部前端派生

占位版假设需要一个「中央轮询后台 tokio 任务」。细化后**整个砍掉**，因为四个功能都能由「fan-out 在 turn 边界维护内存状态 + 前端 3s 轮询列表 API」派生：

| 功能 | 实现位置 | 不需要后台任务的原因 |
|---|---|---|
| 卡死提示 | 前端 | 前端拿到 `turn_started_ms` 自己算 `now - started`，本地计时器实时走 |
| 完成红点 | 前端 | 前端比较两次轮询间 `turns_completed` 增量 |
| 中断重发 | fan-out 内（WS prompt 路径） | turn_state 由 fan-out 独占，收到 prompt 当场判断 |
| rename / 状态展示 | REST + 列表轮询 | 纯请求-响应 |

净后端改动收敛为：**fan-out 在 turn 边界回调维护几个内存字段 → 塞进 `GET /api/sessions` → 新增 PATCH rename + 新增 `SessionInput::Interrupt` 原语**。无新长连接、无新后台循环。

---

## 3. 核心状态与上报

### 3.1 新增字段

在 B-1 的 `Option<RunningProcess>` 基础上叠加（**全部内存运行态，不持久化**）：

```rust
#[derive(Clone, Copy, PartialEq)]
enum TurnState { Idle, Running }

struct RunningProcess {
    // ... B-1 既有：event_tx / input_tx / pty_pid ...
    turn_state: TurnState,           // 默认 Idle
    turn_started_ms: Option<i64>,    // Running 时置 now_millis()，Idle 时清 None
    turn_seq: u64,                   // 单调 turn 序号，中断重发正确性所需（见 3.3）
}

struct Session {
    // ... B-1 既有 ...
    last_activity_ms: i64,           // turn 边界更新；展示/排序用
    turns_completed: u32,            // turn 完成计数；完成红点所需（见 3.4）
}
```

**砍掉**占位版的 `timeout_strikes`（不自动杀）和 `MAX_LIVE`（不驱逐）。

类型统一 `i64`，对齐现有 `now_millis() -> i64` 与 `created_ms: i64`。

### 3.2 不持久化的理由

`turn_state` / `turn_started_ms` / `turn_seq` 是**进程的瞬时态**：进程没了，turn 必然不在跑。重启后 B-1 的 `running = None` 已经表达「未运行」，无需额外落盘。持久化反而会重新引入 B-1 当初消除的「两处状态不一致」坑。`last_activity_ms` / `turns_completed` 同理仅活在内存——重启后从 0 / created_ms 起算可接受（完成红点本就是「本次会话期间」的未读概念）。

### 3.3 上报路径（复用 B-1 的 `Weak<SessionManager>`）

fan-out 在两个 turn 边界通过 `Weak<SessionManager>` 回调 SessionManager 更新字段。新增一个方法：

```rust
impl SessionManager {
    /// fan-out 在 turn 边界回调。仅锁内做标量赋值，绝不跨 .await、不调 store。
    fn mark_turn(&self, sid: &str, state: TurnState, seq: u64) {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(sid) {
            let now = now_millis();
            s.last_activity_ms = now;
            if let Some(rp) = s.running.as_mut() {
                match state {
                    TurnState::Running => {
                        rp.turn_state = TurnState::Running;
                        rp.turn_started_ms = Some(now);
                    }
                    TurnState::Idle => {
                        // 只有 seq 与当前一致才翻 Idle（忽略被中断的旧 turn 的迟到 Result）
                        if rp.turn_seq == seq {
                            rp.turn_state = TurnState::Idle;
                            rp.turn_started_ms = None;
                            s.turns_completed = s.turns_completed.wrapping_add(1);
                        }
                    }
                }
            }
        }
    }
}
```

**锁纪律**（B-1 既定）：`sessions` 是 `std::sync::Mutex`，回调只做标量赋值，**不跨 `.await`、不调 `store.*()` / `push_scrollback`**。

**turn_seq 为何必要**（review 时新发现）：中断重发会在旧 turn 尚未真正吐 `Result` 时就开了新 turn。若旧 turn 的迟到 `Result` 用来翻 `turn_state→Idle`，会把新 turn 的 Running 误清。解法：fan-out 转发 prompt 时 `turn_seq += 1` 并记下本 turn 的 seq；翻 Idle 的回调带上该 seq，只有 `seq == rp.turn_seq` 才生效。`turns_completed` 也在此处 +1，保证「被中断的旧 turn 不计入完成」。

fan-out 维护的本地 `turn_seq` 镜像：每个 fan-out 任务持一个 `let mut turn_seq: u64 = 0;`，与 RunningProcess.turn_seq 同步推进（转发 prompt 前自增并写回）。

### 3.4 turn 边界的定义（每个 fan-out 一致）

- **进入 Running**：fan-out 转发 `Prompt`（或中断重发的 resend）到 agent 之前 → 自增 `turn_seq` → `mark_turn(Running, turn_seq)`。
- **回到 Idle**：fan-out 从 `process.event_rx` 收到 `AcpEvent::Result | Error | Exit` → `mark_turn(Idle, turn_seq)`（带当前 seq）。

---

## 4. 列表 API 扩展

`SessionInfo` 增加四个字段，`list_sessions` 从内存运行态读出（短暂持锁拷标量，不跨 await）：

```rust
pub struct SessionInfo {
    // ... 既有 id/name/type/cols/rows/work_dir/description/status ...
    pub running: bool,                  // running.is_some()
    pub turn_state: Option<&'static str>, // "idle" | "running"；None = 未运行（休眠）
    pub turn_started_ms: Option<i64>,
    pub last_activity_ms: i64,
    pub turns_completed: u32,
}
```

`GET /api/sessions` 响应自动带上（serde 派生）。无新端点。

---

## 5. PATCH rename

接线 B-1 遗留的 dead code `SessionStore::update_name`。

- 新增路由：`PATCH /api/sessions/{id}`，body `{ "name": "..." }`（预留 `description`，本次只实现 name）。
- handler：校验 owner（复用 `is_owner`）→ 改内存 `Session.name`（持锁）→ 调 `store.update_name(id, &name)`（**不持锁**，B-1 两段式）→ 返回 200。
- 空 name 拒绝（400）。

清掉 B-1 review 标记的「update_name dead code」follow-up。

---

## 6. 中断重发（本次主菜）

### 6.1 新原语 `SessionInput::Interrupt`

现状（review 实测）：`SessionInput::Cancel` 在三端语义不一致——Codex 是 turn-cancel（保进程、保 thread_id），Claude/Kiro 是 `child.kill()`（杀进程）。中断重发需要的是**统一的 turn 级中断**，故引入新原语，与 `Cancel`（杀进程，保留现有语义不动）并列：

```rust
pub enum SessionInput {
    PtyData(Vec<u8>), PtyResize(u16,u16), Prompt(String),
    Cancel,            // 既有：杀进程（前端「关闭/停止会话」语义，不动）
    Interrupt,         // 新增：取消当前 turn，保进程、保上下文
}
```

### 6.2 三端 interrupt 实现（线路均已 spike 实测验证，2026-06-03）

| Backend | interrupt 线路 | 实测结果 |
|---|---|---|
| **Claude** | 向 stdin 写 NDJSON 控制消息 `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt"}}` | ✅ turn 6s 时发送 → `control_response` 秒回 → turn 立即 `result/error_during_execution` 结束；进程存活；同进程 resend「7×8」→ 答 56 success。无重启 |
| **Kiro** | 向 stdin 写 JSON-RPC **通知**（无 id）`{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<sid>"}}` | ✅ cancel 后在途 `session/prompt` 的 RESP 立即返回（turn 停）；同进程 resend → 新 RESP 答出。无重启 |
| **Codex** | 复用既有 `Cmd::Cancel`（drop call_fut，保 thread_id） | ✅ B-1 已实现并验证 |

各 `*Process` 新增方法：

- `AcpProcess::interrupt(&mut self)`：写上述 control_request 到 `self.stdin`（需要一个 request_id；用自增计数或固定前缀+序号即可，Claude 不要求唯一性跨重启）。
- `KiroProcess::interrupt(&mut self)`：经 `cmd_tx` 发新 `Cmd::Cancel`（在 `run_event_loop` 的命令分支里 write `session/cancel` 通知到 stdin）。**注意 Kiro 当前 `Cmd` 枚举只有 `Prompt | Stop`，需新增 `Cmd::Cancel` 分支**；`kill()` 仍走 `Cmd::Stop`+`child.kill()` 不变。
- `CodexProcess::interrupt(&mut self)`：发 `Cmd::Cancel`（已存在；当前 `kill()` 误用了 `Cmd::Cancel`——见 6.4 修正）。

### 6.3 fan-out 的中断重发逻辑

三个 agent fan-out 的 `SessionInput::Prompt` 分支改为：

```rust
Some(SessionInput::Prompt(text)) => {
    // 中断重发：turn 在跑就先打断当前 turn（保进程），再发新 prompt。
    // turn_state 由本 fan-out 独占的本地镜像判断，无需查 manager。
    if local_turn_state == TurnState::Running {
        process.interrupt().await;   // 不等待旧 turn 真正结束
    }
    turn_seq += 1;
    if let Some(m) = mgr.upgrade() { m.mark_turn(&sid, TurnState::Running, turn_seq); }
    local_turn_state = TurnState::Running;
    if let Err(e) = process.send_prompt(&text).await {
        tracing::warn!("send_prompt failed for {}: {}", sid, e);
    }
}
Some(SessionInput::Interrupt) => {
    if local_turn_state == TurnState::Running {
        process.interrupt().await;
        // 旧 turn 的 Result/Error 会照常到达并经 mark_turn(Idle, 同 seq) 翻 Idle
    }
}
```

fan-out 收到 `Result|Error|Exit` 事件时：`local_turn_state = Idle;` + `mark_turn(Idle, turn_seq)`。

**「不等待立即重发」的取舍**（用户已确认）：不等旧 turn 真正停。Claude/Kiro 实测 interrupt 后 turn 即时结束，resend 干净。Codex 的 drop-cancel 不真正通知服务端停，旧调用可能服务端续跑，但因为我们不等待、直接 `codex-reply` 发新调用，用户感知是「立刻响应新指令」；旧 turn 的迟到 Result 被 `turn_seq` 不匹配丢弃，不会污染新 turn 状态。

### 6.4 顺带修正 Codex kill/cancel 命名（不改行为，仅澄清）

当前 `CodexProcess::kill()` 发的是 `Cmd::Cancel`（语义其实是 turn-cancel，不杀进程，靠 Drop 关 cmd_tx 才真正结束）。引入 `interrupt()` 后：`interrupt()` 发 `Cmd::Cancel`（turn 级），`kill()` 改发 `Cmd::Stop`（真正终止 loop）。这让三端 `kill()`=杀进程、`interrupt()`=停 turn 语义统一。**需同步检查 codex idle-cancel 分支（H4 fix）仍成立**。

### 6.5 前端解禁 busy 时发送

当前 `AcpChatView.tsx:295` `disabled={busy || !input.trim()}` —— turn 跑着时 Send 禁用，中断重发**无触发入口**。改为 `disabled={!input.trim()}`：busy 时也允许发送，触发中断重发。busy 时按钮文案/提示可保持，但允许点击。这是**有意的 UX 改动**，是中断重发的前置条件。

---

## 7. 前端：完成红点 + 卡死计时 + 侧栏增强

### 7.1 轮询

`App.tsx` 已持有 session list。新增 `setInterval` **每 3s** 拉 `GET /api/sessions`，只合并这几个状态字段。单用户场景零压力（一个 REST GET）。

### 7.2 完成红点（计数器版）

前端记住每个 session 上一轮的 `turns_completed`。当某 session 的 `turns_completed` **增量 > 0**、**且它不是当前正在看的那个** → 打未读红点。切到该 session 时记下其当前 `turns_completed` 作为「已读基线」、清红点。

**为何用计数器而非 running→idle 跃迁**（review 新发现）：3s 轮询有盲区——一个 turn 在两次轮询间起+完（<3s）的 running 态会被完全错过，跃迁检测永不触发、红点不亮。计数器只看完成次数增量，能捕获 sub-3s 快 turn。

### 7.3 卡死计时提示

当前打开的会话若 `turn_state == "running"`：
- busy 区**始终**显示中性计时「已运行 {Xs}」，`Xs` 由本地 `setInterval(1s)` 基于 `turn_started_ms` 实时算，不依赖 3s 轮询粒度。
- 当 `now - turn_started_ms > 180s`（阈值，可后调）：措辞升级为「已运行 {Xs}，可能卡住 — 取消？」，取消按钮发送 `Interrupt`（turn 级，保会话）或既有 Cancel——**取消按钮发 `Interrupt`**，使「卡死取消」也不丢会话。
- **永不自动动作**。

**阈值 180s 而非占位版 120s**（review 调整）：Codex 带 reasoning、Claude 大任务合法 >120s 常见，120s 会「狼来了」。180s（可调）更稳，且中性计时一直在，不会让用户以为卡死。

### 7.4 侧栏列表增强

复用现有 App.tsx 侧栏 session 列表（**不新建独立面板**，信息密度更高、无需切视图），每项基于 7.1 的轮询字段展示：

| 元素 | 数据来源 | 动作 |
|---|---|---|
| 状态点（绿=running / 灰=idle / 空心=休眠 running=false） | turn_state + running | — |
| 完成红点 | 7.2 计数器 | 进入即清 |
| 最后活动时间（相对，如「3m ago」） | last_activity_ms | — |
| 重命名 | — | inline 编辑 → PATCH §5 |
| 删除 / resume | 既有 | 既有 |

**不碰** untracked 的 `AgentDashboard.tsx` WIP——那是 agent 自报事件流，与本功能正交，留作独立轨道。

---

## 8. 阈值常量汇总

| 常量 | 值 | 位置 | 说明 |
|---|---|---|---|
| 列表轮询间隔 | 3s | 前端 | 状态刷新 |
| 卡死计时器 | 1s | 前端 | 本地实时计时 |
| 卡死措辞升级阈值 | 180s | 前端常量 | 仅改措辞 + 给取消，永不自动动作 |

后端无阈值常量（无后台任务）。

---

## 9. 测试策略

**Rust 单元测试**（inline `#[cfg(test)]`）：
- `mark_turn`：Running 置 started_ms、Idle 清空并 `turns_completed+1`；seq 不匹配时**不**翻 Idle、**不**计数（中断重发正确性核心）。
- `SessionInfo` 序列化含新字段、休眠 session 的 `turn_state == None`。

**协议 spike（已完成，2026-06-03）**：Claude control_request interrupt、Kiro session/cancel 均已实测验证中断+同进程 resend 成功，结论入 §6.2 表。

**手动验证（部署后）**：
1. 长 turn 跑着 → 发新 prompt → 旧 turn 停、新 prompt 立即被回答（三端各一次）。
2. 切到另一 session，让原 session turn 跑完 → 原 session 列表项亮红点 → 点进去红点消失。
3. 长 turn >180s → 措辞升级为「可能卡住」+ 取消按钮 → 点取消 → turn 停、会话存活、可继续发。
4. inline rename → 刷新页面/重启服务后名字仍在（落盘验证）。

---

## 10. 对 B-1 不变量的保持

- **fan-out 独占进程**不变：interrupt 经 fan-out 的 input 通道，仍由 fan-out 转发到 process，无旁路。
- **Drop 清理**不变：未新增手动 kill 路径（`Interrupt` 不 drop 进程）。
- **锁纪律**不变：`mark_turn` / rename 改内存持锁、调 store 不持锁、绝不跨 await。
- **`Weak<SessionManager>`** 复用 B-1 已建回引用，无新 Arc 循环。

---

## 11. 后续修复项（继承自 B-1 review，本次不做）

- **tmux 服务器已死时 resume_failed 不触发**：`PtyHandle::spawn` 不检查 exec 后退出，`tmux attach -t <死target>` 假成功→僵尸。仅 zeromux+tmux server 同时重启时触发，非阻塞。修复方向：`spawn_tmux` attach 前 `tmux has-session` 探测。
