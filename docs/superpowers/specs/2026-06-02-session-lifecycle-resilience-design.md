# Group B：会话生命周期韧性 — 设计文档

**日期**：2026-06-02
**范围**：zeromux agent 会话的持久化与生命周期管理（`session_manager.rs` 为主，三个 agent process 各加 resume 入口，新增 `session_store.rs`）
**不在本轮范围**：naozhi 的多平台 IM、Cron、多节点反向拨入、外部进程发现/接管（这些是 IM 网关定位特性，与 zeromux「web 终端多路复用器」定位无关）。

灵感来源：[KevinZhao/naozhi](https://github.com/KevinZhao/naozhi) 的进程生命周期韧性。但本设计**不照搬其四个 bolt-on 特性**，而是识别出它们的共同根因——zeromux 当前 `Session == Process`、纯内存、Drop 即彻底销毁——并用**一个连贯的「持久可恢复 session」基石**统一解决，watchdog / 驱逐 / 重启存活 / 中断重发都从这一个模型自然导出，且全部**非破坏性**（不丢对话上下文）。

---

## 目标（job-to-be-done）

> **「我的 agent 上下文永远不要丢，我永远知道它在干什么。」**

当前 zeromux 的真实脆弱点：
1. **服务器重启 = 所有 session 连同上下文静默蒸发**（`zeromux.service` 重启即发生）。这是最严重的、且不在 naozhi 清单里的问题。
2. 卡死的 agent turn 无超时保护，会一直占用进程和 broadcast 通道。
3. 并发 agent 进程无上限，无内存压力管理。
4. 用户无法中途改方向（打断在途 turn 重发）。

## 核心洞察

`--resume`（恢复对话上下文）不是一个并列特性，而是让其他改动都「非破坏性」的**基石原语**。三后端均实测支持恢复：
- **Claude**：CLI `--resume <session_id>`（`claude --help` 确认）。
- **Kiro**：ACP `session/load` 方法（实测 `initialize` 返回 `agentCapabilities.loadSession: true`，kiro-cli 2.3.0）。
- **Codex**：`codex-reply` + `threadId`（zeromux 已实现 intra-process，扩展为跨进程）。

一旦持久化 ResumeToken，进程崩溃 / 服务器重启 / watchdog 杀死 / 容量驱逐都能从「丢上下文」变成「重生上下文在」。

## 设计原则

- **保住 Drop 不变量**：fan-out 任务仍是 `RunningProcess` 的唯一所有者；让进程消失的唯一方式仍是 drop 它。本设计只是让「drop 进程」不再等于「删除 session 元数据」。
- **单一事实源**：`RunningProcess` 是 `Session` 的 `Option` 字段，不是平行的第二张表——消除两表不一致的可能。
- **红线（硬约束）**：
  - tmux session 的 `resume_token` 永远 `None` → **永不被休眠/驱逐**（PTY 无 resume 语义，休眠=纯数据丢失）。
  - 只有 `turn_state == Idle` 的 agent session 可被动休眠/驱逐。
  - resume 只恢复**对话上下文**，**不**恢复进程副作用（后台进程、env 变更、cwd）；spec 与用户文档明示。
- **失败降级**：resume 失败一律回落到全新 session + 发 `resume_failed` 事件，绝不卡死。
- **YAGNI**：不做 naozhi 的消息 coalesce（合并多条）；中断重发只做「打断旧的、发新的」。

---

## 第 1 节：核心模型 —— Session/Process 解耦

`Session` 单一结构体、单一事实源：

```rust
struct Session {
    // 持久化元数据（写入 SQLite）
    id: String, name: String, session_type: SessionType,
    work_dir: String, owner_id: String, description: String,
    resume_token: Option<ResumeToken>,
    last_activity_ms: u64, created_ms: u64,
    status: SessionMeta,             // 现有字段保留
    // 运行时（仅内存）
    running: Option<RunningProcess>, // None = 休眠；Some = 活
    scrollback: VecDeque<String>,    // 留在 Session，跨休眠保留（重连重放）
    scrollback_bytes: usize,
}

struct RunningProcess {
    event_tx: broadcast::Sender<String>,
    input_tx: mpsc::Sender<SessionInput>,
    worktree_path: Option<PathBuf>,
    pty_pid: Option<u32>,
    // 生命周期观测（普通字段，受 SessionManager 的 HashMap Mutex 保护，非热路径不用原子）
    turn_state: TurnState,           // Idle | Running
    turn_started_ms: Option<u64>,
    timeout_strikes: u8,
}

enum TurnState { Idle, Running }

enum ResumeToken {
    Claude(String),  // --resume <session_id>
    Kiro(String),    // session/load <sessionId>
    Codex(String),   // codex-reply threadId
}
```

**状态派生**（不设独立 lifecycle 枚举字段，避免与 `running` 不一致）：
- Live：`running.is_some()`
- Hibernated：`running.is_none() && resume_token.is_some()`
- 删除：从 HashMap + SQLite 移除（现有 `remove_session`）。

**操作语义**：
- **休眠** = `session.running = None`（drop 掉内部 channel → fan-out 任务的 `input_rx.recv()` 返回 None → 任务退出 → 进程 Drop）。Drop 不变量原样。
- **重生** = `session.running = Some(spawn_or_resume(...))`（第 4 节）。

`SessionManager` 仍是单张 `Mutex<HashMap<String, Session>>`，外加一个 `Arc<SessionStore>`（第 2 节）。

---

## 第 2 节：持久化 + 重启存活

**新模块 `src/session_store.rs`**，仿 `EventStore`/`NotesStore` 的「总是 open」模式（**不**依赖 OAuth 模式——线上正是 legacy 密码模式）：

```rust
pub struct SessionStore { conn: Mutex<rusqlite::Connection> }

// 复用 ~/.zeromux/zeromux.db，新表：
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT, type TEXT, work_dir TEXT, owner_id TEXT, description TEXT,
  resume_kind TEXT, resume_value TEXT,   -- ResumeToken 拆 kind+value 两列；NULL=无
  last_activity_ms INTEGER, created_ms INTEGER
);
```

方法：`upsert(meta)`、`update_resume_token(id, Option<ResumeToken>)`、`touch_activity(id, ms)`、`update_description/name(...)`、`delete(id)`、`load_all() -> Vec<PersistedSession>`。

在 `main.rs` 的 AppState 构造里 `SessionStore::open(data_dir)`，与 `EventStore::open`/`NotesStore::open` 并列（总是开），注入 SessionManager。

**写入时机**（SessionManager 内调用）：
| 时机 | 调用 |
|---|---|
| 创建 agent session | `upsert` |
| fan-out 首见带 id 的事件 | `update_resume_token` |
| turn 结束 | `touch_activity` |
| 改名/改描述 | `update_*` |
| 删除 | `delete` |

tmux session **不持久化**（PTY 无 resume；进程随重启已死）。`upsert` 仅对 agent 类型调用。

**重启存活（懒重生，不预热）**：
- 启动时 `load_all()`，把每个 agent PersistedSession 装回内存 HashMap，`running = None`（全部 Hibernated 装载，**不**在启动时 spawn 任何进程——避免启动风暴，只为真正被访问的 session 付代价）。
- scrollback 不持久化（2MB/session 不值得落盘；重生后从空 scrollback 开始，对话上下文由 resume_token 保证，不是 scrollback 保证）。
- 用户 WS 连入或发 prompt 时，若 `running.is_none()` → `ensure_running`（第 4 节）触发重生。

---

## 第 3 节：生命周期观测 + 中央轮询任务

**观测字段**放在 `RunningProcess`（见第 1 节），普通字段 + HashMap 的 `Mutex` 保护。轮询每 `TICK` 秒一次、事件以人/agent 速度到达，非热路径，可读性优先，不用原子。

**fan-out 上报**（对 fan-out 边界的最小扩展）：
三个 `spawn_*_fanout` 额外接收 `Arc<SessionManager>` + `sid`，仅在 **turn 边界**调两个 setter（不是每个 content_block）：
- 转发 `SessionInput::Prompt` 给进程时 → `mark_turn_running(sid)`：`turn_state=Running`、`turn_started_ms=now`。
- 收到 `AcpEvent::Result`/`Error`/`Exit` 时 → `mark_turn_idle(sid)`：`turn_state=Idle`、`touch_activity`、`timeout_strikes=0`。

fan-out 仍**不碰进程所有权**，只上报自己的 turn 状态。每 turn 仅 2 次调用，开销可忽略。

**实现注意（避免 Arc 环）**：`SessionManager` 持有 `HashMap<Session>`，`Session` 持有 `RunningProcess`，fan-out 任务又需引用回 `SessionManager` 调 setter——若 fan-out 持 `Arc<SessionManager>` 会形成强引用环导致 SessionManager 永不析构。实现时 fan-out 持 `Weak<SessionManager>`（在 setter 调用点 `upgrade()`，失败则 SessionManager 已销毁、静默跳过），或抽出一个只含 `Mutex<HashMap>` + `Arc<SessionStore>` 的轻量内部句柄供 fan-out 持有。计划阶段需明确选其一。

**中央轮询任务**（`SessionManager::spawn_lifecycle_monitor`，启动时起一个 tokio 任务）：

```
每 TICK（10s）：
  锁 HashMap，遍历 session：
    A. watchdog（仅 running 且 turn_state==Running）：
       now - turn_started_ms > SOFT_TIMEOUT(120s)：
         → input_tx.send(Cancel)              // 软超时，复用现有通道
         → timeout_strikes += 1
         → 若 strikes >= MAX_STRIKES(2)：硬超时 → running=None（drop 进程，保留 Session 可 resume）
    B. 驱逐（Live agent 数 > MAX_LIVE）：
       候选 = running 且 turn_state==Idle 的 session，按 last_activity_ms 升序
       淘汰最久者：发 Exit 事件 → running=None（休眠）
       （tmux resume_token=None，且通常无 running 的 Idle agent 语义→ 天然跳过；显式过滤 agent 类型）
  解锁
```

所有动作走现有原语：软超时 `input_tx.send(Cancel)`；硬超时/休眠 `running=None`（drop → fan-out 退出）。轮询任务**只读状态 + 发 Cancel + 置 None**，从不直接 touch 进程。

阈值常量：`TICK=10s`、`SOFT_TIMEOUT=120s`、`MAX_STRIKES=2`、`MAX_LIVE`（CLI 可配，默认如 20）。

---

## 第 4 节：`spawn_or_resume` —— 跨三后端重生

**统一入口**：
```rust
async fn ensure_running(&self, id: &str) -> Result<(), String>
  若 session.running.is_some() → Ok（已活）
  否则按 type + resume_token 选 spawn 策略，建 RunningProcess，running=Some(...)，重启 fan-out
```
触发点：WS handler 在 subscribe / 转发 Prompt 前，若 `running.is_none()` 先 `ensure_running`。

**per-backend 策略**（各 process 的 spawn 加可选 resume 参数）：

- **Claude** (`process.rs`)：`AcpProcess::spawn(claude_path, work_dir, resume: Option<&str>)`。有则注入 `--resume <id>`。session_id 来自 Claude 已发的 `System{session_id}`/`Result{session_id}` 事件，fan-out 首见即回填 `ResumeToken::Claude(id)` 持久化。
- **Codex** (`codex_process.rs`)：`CodexProcess::spawn(..., resume_thread: Option<String>)`。有则 event loop 初始 `thread_id=Some(...)`，首个 prompt 直接走 `codex-reply`。thread_id 已在内部捕获，回填 `ResumeToken::Codex(tid)` 持久化。
- **Kiro** (`kiro_process.rs`)：握手第 2 步——有 resume_token 则发 `session/load {sessionId, cwd, mcpServers}` 而非 `session/new`；无则维持 `session/new`。`session/new` 返回的 sessionId 回填 `ResumeToken::Kiro(id)` 持久化。

**失败降级**：resume 失败（token 过期 / CLI 版本变 / `session/load` 报错）→ 回落全新 session（等价无 token spawn）+ 发 `AcpEvent::System{subtype:"resume_failed"}` 告知前端「上下文已重置」。绝不卡死。

**fan-out 回填 token**：三个 fan-out 在首见带 id 事件时调 `SessionManager::set_resume_token(sid, token)`（内部 upsert SQLite）。每会话回填一次。

---

## 第 5 节：中断重发（正交特性）

当 session `turn_state==Running` 时收到新 `SessionInput::Prompt`：
- 统一语义：先 `input_tx.send(Cancel)` 打断在途 turn，短暂等 `turn_state` 回 Idle（或超时兜底），再转发新 Prompt。
- 实现在 fan-out 的 input 分支（它已 select 在 input_rx，能读 turn 状态）。
- **不做** naozhi 的消息合并（coalesce）——YAGNI；只做「打断旧的、发新的」，对应「我想中途改方向」的真实诉求。
- 现状对比：Codex 已有「in-flight 时 drop 新 prompt + warn」，改为打断重发；Claude/Kiro 现状是直接转发（可能并发两 turn），改为打断重发，语义统一。

---

## 第 6 节：测试 + 验证

**单元/纯函数**：
- `ResumeToken` ↔ (resume_kind, resume_value) 序列化往返。
- `SessionStore` CRUD（临时 db）：upsert/update_resume_token/touch/load_all/delete。
- 驱逐候选选择逻辑：给定一组 session（含 Running/Idle/tmux/不同 last_activity），断言只选 Idle agent 且最久者，tmux 与 Running 被排除。
- watchdog 两级计数：Running 超时 → strikes 累加 → 达 MAX_STRIKES 触发硬超时。

**状态机**：`ensure_running` 的「已活直接返回 / 休眠则按 token 重生 / 无 token 全新」三分支。

**手动验证**（真实 CLI，线上 zeromux）——三后端各一遍：
1. 发 prompt 建立上下文（如「记住数字 42」）。
2. 触发重生：a) `systemctl restart zeromux`（重启存活）；b) 等待 watchdog 硬超时；c) 手动触发驱逐。
3. 重连 + 发 prompt（「我刚让你记的数字是多少」）→ 确认上下文还在（resume 成功）或收到 `resume_failed`（降级正确）。

`cargo test` 全绿；`cd frontend && npm run build` 通过（前端仅需识别新的 `resume_failed` system 事件，渲染为现有 system 文本即可，无新组件）。

---

## 数据流（改动后）

```
启动：SessionStore.load_all() → 内存 HashMap（agent sessions, running=None）
用户连入 /ws/acp/{id} 或发 prompt：
  ensure_running(id)：running.is_none() → 按 resume_token spawn_or_resume → running=Some
  fan-out 启动，turn 边界上报 turn_state；首见 id 事件回填 resume_token → SQLite
中央轮询(10s)：
  watchdog：Running 超时 → Cancel；连续超时 → running=None（保留 Session）
  驱逐：Live 超额 → 休眠最久 Idle agent（running=None）
新 prompt 且 Running：Cancel 旧 turn → 等 Idle → 发新 prompt
删除：HashMap.remove + SessionStore.delete + worktree 清理（现有路径）
```

## 影响面 / 风险

| 改动 | 文件 | 风险 |
|---|---|---|
| `SessionStore` 新模块 + SQLite 表 | 新增 `src/session_store.rs`，`main.rs` 注入 | 低（独立模块 + 临时 db 单测） |
| Session 加 `running: Option<RunningProcess>` + 字段迁移 | `session_manager.rs`（结构重组） | **中高**（核心结构重组；但单一事实源、Drop 不变量保留） |
| 三 process 加 resume 入口 | `process.rs`/`codex_process.rs`/`kiro_process.rs` | 中（per-backend，有降级安全网） |
| fan-out 接 `Arc<SessionManager>` 上报 turn 状态 | `session_manager.rs` 三个 fanout | 中（边界扩展，仅 turn 边界 2 次调用） |
| 中央轮询任务 | `session_manager.rs` | 中（新 tokio 任务；只读+Cancel+置 None） |
| 中断重发 | 三 fanout input 分支 | 中（打断-等待-重发时序） |
| 重启存活懒装载 | `main.rs` + SessionManager | 低（装载即建元数据，不 spawn） |

不碰：broadcast fan-out 的「单一所有者」语义、`SessionInput` 路由、scrollback 重放机制、auth、worktree 创建/清理逻辑、Group A 的渲染层。

## 验证标准

- `cargo test` 全绿（含 SessionStore CRUD、驱逐选择、watchdog 计数、ensure_running 分支单测）。
- `cargo build` + `cd frontend && npm run build` 通过。
- 手动三后端 × 三重生路径（重启 / watchdog / 驱逐）：上下文恢复成功，或 resume_failed 降级正确。
- 红线验证：tmux session 在容量压力下不被休眠；Running 的 agent 不被驱逐。
