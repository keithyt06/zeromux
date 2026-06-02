# Group B-1：持久可恢复会话（基石层）— 设计文档

**日期**：2026-06-02
**范围**：zeromux 会话的持久化与崩溃/重启恢复。`session_manager.rs` 结构重组，新增 `session_store.rs`，三个 agent process + tmux 各加 resume 入口。
**本轮范围（B-1，基石）**：Session/Process 解耦 · SQLite 持久化 · 重启存活（含 tmux） · 三后端 + tmux 的 resume。
**下一轮范围（B-2，主动管理，独立 spec）**：中央轮询任务 · watchdog 两级超时 · Idle 容量驱逐 · 中断重发。B-2 依赖 B-1 已证明 resume 可靠，故拆分先后。占位文档：`2026-06-02-session-active-management-B2-design.md`。

灵感来源 [KevinZhao/naozhi](https://github.com/KevinZhao/naozhi) 的进程生命周期韧性，但不照搬其 bolt-on 特性——识别共同根因（zeromux `Session == Process`、纯内存、Drop 即彻底销毁）后，用一个连贯的「持久可恢复 session」基石统一解决。

---

## 目标（job-to-be-done）

> **「我的会话上下文永远不要丢。」**

当前最严重的脆弱点：**服务器重启 = 所有 session 连同上下文静默蒸发**（`zeromux.service` 重启即发生，本项目部署时就重启过）。这不在 naozhi 清单里，却是 zeromux 用户最痛的点。

## 核心洞察

恢复对话上下文（resume）是让一切「非破坏性」的**基石原语**。四类会话均有恢复机制：
- **Claude**：CLI `--resume <session_id>`（`claude --help` 确认存在；**实际 headless 行为待 spike 验证**，见任务 0）。
- **Kiro**：ACP `session/load`（实测 `initialize` 返回 `agentCapabilities.loadSession: true`，kiro-cli 2.3.0；**实际回灌行为待 spike 验证**）。
- **Codex**：`codex-reply` + `threadId`（zeromux 已实现 intra-process，扩展为跨进程持久化）。
- **tmux**：会话状态活在 tmux server 里，天然跨 zeromux 重启存活——重连只需 `tmux attach -t <target>`。tmux 的「resume token」就是它的 target 名。

> **Review 修正（PM 定位）**：tmux 是 zeromux（terminal **multiplexer**）的核心身份，且最容易做重启存活。早稿把 tmux 排除在存活之外是定位错误。本稿将 tmux 纳入重启存活。

## 设计原则

- **保住 Drop 不变量**：fan-out 任务仍是 `RunningProcess` 的唯一所有者；让进程消失的唯一方式仍是 drop 它。本设计只是让「drop 进程」不再等于「删除 session 元数据」。
- **单一事实源**：`RunningProcess` 是 `Session` 的 `Option` 字段，不是平行的第二张表——消除两表不一致的可能。
- **失败降级**：resume 失败一律回落到全新 session + 发 `resume_failed` 事件，绝不卡死。
- **YAGNI**：B-1 不做任何「主动杀/休眠进程」的行为（那是 B-2）。B-1 只做「进程没了能重生」，不主动让进程消失。

---

## 任务 0（前置）：resume 可行性 spike —— 写代码前必须验证

> **Review 修正（CTO 高风险假设先验证）**：`--resume` / `session/load` 的 flag/capability 存在 ≠ 在 headless 流式模式下真能回灌对话上下文。这是整个基石的承重假设，必须在写任何生产代码前用真实 CLI 验证。

**Spike 步骤**（手动，丢弃式脚本，不进生产代码）：
1. **Claude**：`claude -p --output-format stream-json --input-format stream-json` 起进程，发「记住数字 42」，捕获其 `session_id`。杀进程。新进程加 `--resume <session_id>`，发「我刚让你记的数字是多少」，确认回答含 42。
2. **Kiro**：`kiro-cli acp` 起进程，`session/new` 取 sessionId，prompt 记数字。杀进程。新进程 `initialize` 后发 `session/load {sessionId, cwd, mcpServers}`，prompt 问数字，确认回灌。
3. **Codex**：已知 `codex-reply` intra-process 可用；验证 threadId 在新进程中 `codex-reply` 是否跨进程有效。

**判定**：
- 三者都回灌 → 按本 spec 进行。
- 某后端不回灌 → 该后端降级为「重启后重建为全新 session（上下文丢，发 resume_failed）」，并在 spec/plan 标注；不阻塞其他后端。
- Spike 结果写入计划文档的一节，作为后续实现的事实依据。

---

## 第 1 节：核心模型 —— Session/Process 解耦

`Session` 单一结构体、单一事实源：

```rust
struct Session {
    // 持久化元数据（写入 SQLite）
    id: String, name: String, session_type: SessionType,
    work_dir: String, owner_id: String, description: String,
    resume_token: Option<ResumeToken>,
    worktree_path: Option<PathBuf>,   // ← 留在 Session（见 Review 修正），跨重生复用
    created_ms: u64,
    status: SessionMeta,              // 现有字段保留
    // 运行时（仅内存）
    running: Option<RunningProcess>,  // None = 未运行；Some = 活
    scrollback: VecDeque<String>,     // 留在 Session（重连重放）
    scrollback_bytes: usize,
    spawning: bool,                   // 并发重生互斥标志（仅锁内访问，见第 3 节）
}

struct RunningProcess {
    event_tx: broadcast::Sender<String>,
    input_tx: mpsc::Sender<SessionInput>,
    pty_pid: Option<u32>,
}

enum ResumeToken {
    Claude(String),  // --resume <session_id>
    Kiro(String),    // session/load <sessionId>
    Codex(String),   // codex-reply threadId
    Tmux(String),    // tmux attach -t <target>
}
```

> **Review 修正（CTO 正确性）**：`worktree_path` 必须留在 `Session`（持久化、跨重生复用），不能挪进 `RunningProcess`——否则休眠/重生会建新 worktree，使 resume 的对话上下文与文件状态分离。删除时才清理 worktree。

**状态派生**（不设独立 lifecycle 枚举，避免与 `running` 不一致）：
- 运行中：`running.is_some()`
- 未运行可恢复：`running.is_none() && resume_token.is_some()`
- 删除：从 HashMap + SQLite 移除（现有 `remove_session` + `delete`）。

**操作语义**：
- **重生** = `session.running = Some(spawn_or_resume(...))`（第 4 节）。
- B-1 不主动把 `running` 置 None（那是 B-2 的休眠/驱逐）；B-1 只在进程**自己**退出（fan-out 任务结束）时把 `running` 置 None，并保留 Session 元数据。

`SessionManager` 仍是单张 `Mutex<HashMap<String, Session>>`，外加 `Arc<SessionStore>`。

> **TurnState / 观测字段不在 B-1**：watchdog 需要的 `turn_state`/`turn_started_ms`/`timeout_strikes` 属于 B-2，B-1 的 `RunningProcess` 不含这些。

---

## 第 2 节：持久化 + 重启存活

**新模块 `src/session_store.rs`**，仿 `EventStore`/`NotesStore` 的「总是 open」模式（**不**依赖 OAuth 模式——线上正是 legacy 密码模式）：

```rust
pub struct SessionStore { conn: Mutex<rusqlite::Connection> }

// 复用 ~/.zeromux/zeromux.db，新表：
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT, type TEXT, work_dir TEXT, owner_id TEXT, description TEXT,
  resume_kind TEXT, resume_value TEXT,   -- ResumeToken 拆 kind+value；NULL=无
  worktree_path TEXT,                    -- NULL=无 worktree
  created_ms INTEGER
);
```

方法：`upsert(meta)`、`update_resume_token(id, Option<ResumeToken>)`、`update_name/description(...)`、`delete(id)`、`load_all() -> Vec<PersistedSession>`。

在 `main.rs` AppState 构造里 `SessionStore::open(data_dir)`，与 `EventStore::open`/`NotesStore::open` 并列（总是开），注入 `SessionManager::new(events, session_store)`。

**写入时机**：
| 时机 | 调用 |
|---|---|
| 创建任意 session（含 tmux） | `upsert` |
| 拿到 resume_token（agent: fan-out 首见带 id 事件；tmux: 创建时即知 target） | `update_resume_token` |
| 改名/改描述 | `update_*` |
| 删除 | `delete` |

**重启存活（懒重生，不预热）**：
- 启动时 `load_all()`，把每个 PersistedSession 装回内存 HashMap，`running = None`（全部以「未运行」装载，**不**在启动时 spawn 任何进程——避免启动风暴，只为真正被访问的 session 付代价）。
- **tmux 也装载**：其 `resume_token = Tmux(target)`；重连时 `tmux attach -t <target>` 懒重生。
- scrollback 不持久化（重生后从空开始；对话上下文由 resume_token 保证，不靠 scrollback；tmux 重连后 tmux 自身重绘）。
- 用户 WS 连入或发 prompt 时，若 `running.is_none()` → `ensure_running`（第 4 节）。

> **tmux target 的存活前提**：tmux server 本身需存活（systemd 重启 zeromux 不影响独立的 tmux server）。若 target 已不存在（tmux server 也重启了），`attach` 失败 → resume_failed 降级（提示用户/可删除该 session）。spike 任务 0 不含 tmux（其行为已知），但实现时 attach 失败路径需覆盖。

---

## 第 3 节：fan-out 退出语义 + 并发安全

**fan-out 退出通知**：当前四类 fan-out 任务在进程结束（output/event channel 关闭）时直接 `break` 退出，session 随后靠 Drop 消失。B-1 改为：fan-out 退出时通知 SessionManager 把该 session 的 `running` 置 `None`（保留元数据），而非整个 session 蒸发。实现：fan-out 持有回引用（见下）。

**Review 修正（CTO 死锁/竞态）—— `ensure_running` 的并发模式**：
`sessions` 是 **`std::sync::Mutex`**（非 tokio）。`spawn_or_resume` 是 async（进程启动）。**绝不能持 `std MutexGuard` 跨 `.await`**（guard 非 Send，且阻塞执行器）。`ensure_running` 必须：

```
1. 锁内：检查 running.is_some() → 已活，返回；
         否则检查 spawning 标志防止并发双 spawn：
           若 spawning==true → 解锁，锁外短等后重试（轮询直到 running 出现或超时）；
           否则取出 spawn 所需数据（type, resume_token.clone(), work_dir, worktree_path），置 spawning=true。解锁。
2. 锁外：await spawn_or_resume(...) 建 RunningProcess。
3. 锁内：running = Some(rp)，spawning=false。解锁。
（spawn 失败：锁内 spawning=false，返回 Err，不留半状态。）
```
`spawning: bool` 在 Session 上、仅锁内访问。这解决两个并发请求同时重生同一未运行 session 的双重 spawn 竞态。

**Arc 环避免**：fan-out 需回调 SessionManager（退出置 None、回填 token）。若持 `Arc<SessionManager>` 形成强引用环导致 SessionManager 永不析构。实现用 `Weak<SessionManager>`（调用点 `upgrade()`，失败则已销毁、静默跳过）。计划阶段明确此点。

---

## 第 4 节：`spawn_or_resume` —— 跨四类重生

**统一入口**：
```rust
async fn ensure_running(&self, id: &str) -> Result<(), String>
  （并发模式见第 3 节）按 type + resume_token 选 spawn 策略，建 RunningProcess + 重启 fan-out。
```
触发点：WS handler 在 subscribe / 转发 Prompt 前，若 `running.is_none()` 先 `ensure_running`。

**per-backend 策略**（各 process 的 spawn 加可选 resume 参数；具体策略以任务 0 spike 结论为准）：

- **Claude** (`process.rs`)：`AcpProcess::spawn(claude_path, work_dir, resume: Option<&str>)`。有则注入 `--resume <id>`。session_id 来自 Claude 的 `System{session_id}`/`Result{session_id}` 事件，fan-out 首见即回填 `ResumeToken::Claude(id)` 持久化。
- **Codex** (`codex_process.rs`)：`CodexProcess::spawn(..., resume_thread: Option<String>)`。有则 event loop 初始 `thread_id=Some(...)`，首个 prompt 走 `codex-reply`。thread_id 已内部捕获，回填 `ResumeToken::Codex(tid)`。
- **Kiro** (`kiro_process.rs`)：握手第 2 步——有 token 则发 `session/load {sessionId, cwd, mcpServers}` 而非 `session/new`；无则维持 `session/new`。`session/new` 返回 sessionId 回填 `ResumeToken::Kiro(id)`。
- **tmux** (`session_manager` 现有 create_tmux 路径)：有 `Tmux(target)` → `tmux attach -t <target>`（现有 `:228` 路径本就支持 attach）。创建时即知 target，立即持久化。

**失败降级**：resume 失败（token 过期 / CLI 版本变 / `session/load` 报错 / `attach` 找不到 target）→ 回落全新 session（等价无 token spawn）+ 发 `AcpEvent::System{subtype:"resume_failed"}` 告知前端「上下文已重置」。绝不卡死。前端把该 subtype 渲染为现有 system 文本即可（无新组件）。

---

## 第 5 节：测试 + 验证

**单元/纯函数**：
- `ResumeToken` ↔ (resume_kind, resume_value) 序列化往返（四种变体）。
- `SessionStore` CRUD（临时 db）：upsert / update_resume_token / update_* / load_all / delete；含 worktree_path 与 resume NULL 情况。

**状态机**：
- `ensure_running` 三分支：已活直接返回 / 未运行有 token 按 type 重生 / 无 token 全新。
- 并发安全：两个并发 `ensure_running` 同一未运行 session，只 spawn 一次（spawning 标志）。

**手动验证**（真实 CLI，线上 zeromux）——四类各一遍：
1. 发 prompt 建立上下文（「记住数字 42」），tmux 则在终端里设个变量/开个程序。
2. `systemctl restart zeromux`（重启存活）。
3. 重连 + 发 prompt（「我刚让你记的数字是多少」），tmux 则看变量/程序是否还在 → 确认上下文/会话还在（resume 成功）或收到 resume_failed（降级正确）。

`cargo test` 全绿；`cd frontend && npm run build` 通过（前端仅需识别 `resume_failed` system 事件）。

---

## 数据流（B-1 改动后）

```
启动：SessionStore.load_all() → 内存 HashMap（所有 session, running=None）
用户连入 /ws/{term|acp}/{id} 或发 prompt：
  ensure_running(id)：running.is_none() → 按 resume_token spawn_or_resume → running=Some
  （并发：spawning 标志防双 spawn；锁外 await spawn）
  fan-out 启动；agent 首见 id 事件回填 resume_token → SQLite
进程自行退出：fan-out 通知 → running=None（保留 Session 元数据，可再重生）
删除：HashMap.remove + SessionStore.delete + worktree 清理（现有路径）
```

## 影响面 / 风险

| 改动 | 文件 | 风险 |
|---|---|---|
| 任务 0 resume 可行性 spike | 丢弃式脚本 | 低（但承重，必须先做） |
| `SessionStore` 新模块 + SQLite 表 | 新增 `src/session_store.rs`，`main.rs` 注入 | 低（独立模块 + 临时 db 单测） |
| Session 加 `running: Option<RunningProcess>` + 字段重组（worktree 留 Session） | `session_manager.rs` | **中高**（核心结构重组；单一事实源、Drop 不变量保留） |
| `ensure_running` 并发模式（std Mutex + async + spawning 标志） | `session_manager.rs` | **中高**（死锁/竞态必须按第 3 节实现） |
| 四类加 resume 入口 | `process.rs`/`codex_process.rs`/`kiro_process.rs`/create_tmux | 中（per-backend，有降级安全网；以 spike 结论为准） |
| fan-out 退出置 None + Weak 回引用 | 四个 fanout | 中（Arc 环避免） |
| 重启存活懒装载（含 tmux） | `main.rs` + SessionManager | 低（装载即建元数据，不 spawn） |

不碰：broadcast fan-out 的「单一所有者」语义、`SessionInput` 路由、scrollback 重放机制、auth、worktree 创建/清理逻辑、Group A 渲染层。**主动管理（watchdog/驱逐/中断重发）全部留给 B-2。**

## 验证标准

- 任务 0 spike 结论明确（哪些后端真支持 headless resume）。
- `cargo test` 全绿（SessionStore CRUD、ResumeToken 往返、ensure_running 分支与并发单测）。
- `cargo build` + `cd frontend && npm run build` 通过。
- 手动四类 × 重启存活：上下文/会话恢复成功，或 resume_failed 降级正确。
