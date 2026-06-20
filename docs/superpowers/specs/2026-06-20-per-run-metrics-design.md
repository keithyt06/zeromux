# Per-run 耗时度量 + outcome + 聚合 — 设计 spec

- 日期：2026-06-20
- 范围：PR 1（A）。为普通（交互式）agent 会话的「一次 run（一轮对话）」自测 wall-clock 耗时与 outcome，落盘成可统计历史，dashboard 展示实时计时 + 历史时间轴 + 单会话汇总（次数/均值/P50/P95/最长/各 outcome 计数）。
- 灵感：naozhi `docs/rfc/session-run-metrics.md`（PR #2154）。核心产品命题：**能否长时间稳定运行 agent 且按要求完成任务。**
- 已过 CTO + PM 双重评审（2026-06-20），本 spec 已吸收其 P0/P1 结论。

## 0. 一句话

在已有的 turn 边界（`session_manager.rs` 的 `turn_started_ms` + `AcpEvent::Result/Error/Exit`）这一个 fan-out 单一出口处，记一条 wall-clock + outcome 的 `RunMetric` 落盘，REST 暴露给前端面板。不新建采集机制，不碰广播扇出不变量。

## 1. 背景与现状（已核实 file:line）

- `RunningProcess`（`session_manager.rs:184`）已有 `turn_state: TurnState{Idle,Running}`、`turn_started_ms: Option<i64>`、`turn_seq: u64`，全部在 `sessions: Mutex<HashMap>` 锁内。
- `apply_turn`（`:449`）是纯函数状态机；`mark_turn`（`:1472`）由 fan-out 调用。
- 边界事件在 fan-out 的 `select!` loop 内处理（`:1790-1862`）：`Result→finalize_run(succeeded[/no_verdict])`、`Error→failed/cli_error`、`Exit→failed/cli_exited`。
- `cost_usd` 仅 Claude 上报（`acp/process.rs:336` 取 `total_cost_usd`）；`kiro_process.rs:356`/`codex_process.rs:712` 硬编码 `None`。**token 数当前未解析**（stream-json `result.usage` 里有，只是没取）。
- `Cancel`（`:1983`）走 `process.kill()`；`Interrupt`（`:1972`）走 `process.interrupt()`。
- idle/watchdog 超时只在 `scheduled_tasks.rs:541` 的 SQLite 侧轮询 `events.ndjson` mtime，**不经过 fan-out loop、不发 AcpEvent**，且只对 scheduled run 生效——交互会话当前**无任何卡死/超时检测**。
- `now_millis()`（`:196`）直接读墙钟，不可注入（测试需参数化）。
- 重连：`event_tx` 是 broadcast，**不回放订阅前历史**；scrollback 是独立 `VecDeque<String>` 单独重放。

## 2. 一次 run 的定义

一次 run = 一个 turn = `turn_state` 从 Idle→Running 到 Running→Idle。

- **开始**：`Prompt` 注入、`turn_seq += 1`、`turn_started_ms = now`（已存在）。
- **结束**：该 turn 的终端事件到达（Result/Error/Exit）或被 TimeoutKill 终结。
- 以 `turn_seq` 为 run 归属键，沿用现有 `boundary_count >= turn_seq` 的 stale-boundary 守卫。

## 3. outcome 语义（评审 P0 核心——本 spec 的命门）

### 3.1 四态，描述「这轮怎么结束的」，不假装判定「任务对不对」

```
enum RunOutcome { Completed, Errored, Timeout, Cancelled }
```

- **判定从「看到哪个终端事件」挪到「是什么意图导致的」**（naozhi 核心教训）。fan-out loop 内维护 `pending_outcome: Option<RunOutcome>`：
  - `Cancel` 输入分支：`pending_outcome = Some(Cancelled)` **再** `kill()`。（修 P0：否则 kill→Exit 必被误记成 Errored。）
  - `Interrupt` 输入分支（针对被打断的 turn_seq）：`pending_outcome = Some(Cancelled)`。
  - TimeoutKill 输入分支（见 §3.3）：`pending_outcome = Some(Timeout)`。
  - 边界 handler：`outcome = pending_outcome.take().unwrap_or_else(|| match evt { Result→Completed, Error→Errored, Exit→Errored })`。
- **判定逻辑留在 fan-out loop**（它持有意图）；`run_metrics` 模块只接收算好的 `(outcome, failure_kind)`，是纯 sink。

### 3.2 「干净 EOF ≠ 有见证完成」——诚实优先

- `outcome=Completed` 在 UI 上**必须显示「完成（已退出）」而非「成功」**。`Result` 事件只证明 CLI 干净结束一轮，不证明任务做对。
- **MVP 不做自动判定任务对错**（LLM 二次评审是幻觉来源，留接缝）。
- `failure_kind: Option<String>` 透传现有值（`cli_error/cli_exited/...`），允许 `(Completed, Some("no_verdict"))` 这一合法组合——但 **no_verdict 只对 scheduled run（`active_run_id.is_some()` 且有 verdict 语义）有意义**；纯交互 turn 的 `Result` 即 `Completed`，**不强加 no_verdict 噪音**（评审 P0 修正）。

### 3.3 timeout 统一出口（评审 P0——决定 A 的整体架构）

- 新增 `SessionInput::TimeoutKill { run_id }`。watchdog 检测到超时后，不再独立写 SQLite outcome，而是向该 session 的 `input_tx` 发 `TimeoutKill`；fan-out loop 收到后打 `pending_outcome=Timeout` 再 kill。
- 效果：**完成/错/取消/超时全部从 fan-out 这一个 owner 出口走**，run_metrics 与 finalize_run 天然一致、无双写、无两套真相打架。
- **副作用（高杠杆，PM/CTO 一致认定为最大价值点）**：交互会话由此获得今天完全没有的卡死/超时保护。MVP 给交互会话接入一个保守的 idle 检测（复用 watchdog 机制，阈值写常量，自整定留接缝见 §8）。

### 3.4 人工 verdict（PM 强烈建议，已采纳）

- run 记录带 `verdict: Option<String>`（👍/👎 + 可选短文字）与 `verdict_source: agent_marker | human | none`。
- 交互 run 默认 `none`；若最终文本含 `<<<VERDICT>>>` 标记，复用现有 `extract_verdict`（零成本）填 `agent_marker`；用户在面板上点 👍/👎 → `human`（覆盖）。
- 这是 MVP 阶段**唯一可信的「任务做对没」来源**，也是手机用户最自然的动作（扫一眼点个赞）。

## 4. 数据模型（叶子模块 `src/run_metrics.rs`，不依赖 scheduled_tasks）

```rust
struct RunMetric {
    run_id: String,          // 16-char hex
    session_id: String,
    work_dir: String,        // 跨会话聚合接缝
    agent_type: String,      // claude|kiro|codex —— watchdog 自整定分桶接缝
    turn_seq: u64,
    started_ms: i64,
    ended_ms: i64,
    duration_ms: i64,        // 单调钳零：if < 0 { 0 }
    outcome: RunOutcome,
    failure_kind: Option<String>,
    verdict: Option<String>,
    verdict_source: VerdictSource,
    cost_usd: Option<f64>,   // 仅 Claude
    tokens_in: Option<u64>,  // 三家都可能有（评审：token > cost，能反推成本）
    tokens_out: Option<u64>,
    input_snapshot_ref: Option<String>, // 失败 replay 接缝；存引用名不存正文
}
```

- **不存 prompt/响应正文**（防跨租户泄漏 + 控体积）。
- `RunOutcome` / `failure_kind` 常量集合定义在本叶子模块；scheduled_tasks 若复用则反向依赖本模块。**无菱形依赖**（评审裁定）。
- schema 一次铺全（agent_type/cost/token/input_snapshot_ref）：MVP 不用全部字段，但为 think-big 留接缝，避免日后数据迁移。

## 5. 落盘与内存

- **落盘**：`~/.zeromux/run-metrics/<session_id>.ndjson`，与 scheduled 的 `~/.zeromux/runs/` 磁盘命名空间分开。
- **单个全局异步 worker**，挂 `SessionManager`，持 `mpsc::Sender<RunMetric>`。fan-out 在 finalize 处持锁只做 VecDeque push + clone metric，**出锁后 `try_send` 给 worker**——**绝不在 select! loop 里同步写盘/fsync**（`append_run_event` 的同步写是既有技术债，不复制扩大）。worker 用 `spawn_blocking`/`tokio::fs` 批量 append。
- **内存**：每 session 一个 `VecDeque<RunMetric>`（cap 50），放 `Session`（非 `RunningProcess`）——进程死后历史保留，重连看得到。
- **Drop 不做 I/O**：metric 在 finalize 那刻（进程还活着）已 try_send；Drop 只关 channel 杀进程。worker 在 SessionManager Drop 时做最后 drain。
- **GC**：keepCount=50 / keepWindow=30d，纯函数（给定 runs + now → 保留集）。
- **first_byte 砍掉（MVP）**：评审一致认为对「能否跑完」杠杆极低，且单 fan-out task 串行无并发（原「CAS」是过度设计）。埋点位置（turn_started→首个 `ContentBlock`，跳过 System/UserPrompt）写进注释留接缝。

## 6. API

`GET /api/sessions/{id}/runs?limit=&before=` → `{ runs: [RunMetric...], stats: SessionRunStats }`

```
SessionRunStats { count, avg_ms, p50_ms, p95_ms, max_ms,
                  completed_count, errored_count, timeout_count, cancelled_count }
```

`POST /api/sessions/{id}/runs/{run_id}/verdict` → body `{ verdict, note? }`，写回 `human` verdict。

- 鉴权走现有 authed `/api/*` 组，注入 `CurrentUser`，校验 owner。
- **REST 为唯一真相源**（历史 + 当前 turn 的 `started_ms`，重连后 GET 一次即可算 elapsed）。**不把 RunMetric 塞进 broadcast/scrollback**（否则污染对话重放）。

## 7. 前端

- 宿主：`SessionInfoBar` 已有 Files/Git/Events 切换 + 展开面板的结构，新增「运行记录」可折叠 `<details>` 面板（移动端默认折叠）。
- 内容：运行中用 `started_ms` 本地计时（不依赖 WS）；展开显示历史时间轴（状态圆点 + outcome 文案 + 时间 + 右对齐耗时 + 👍/👎）+ 汇总胶囊（次数/均值/P95/最长 + 各 outcome 计数）。
- 刷新信号：前端收到既有 turn 边界事件（Result/Error/Exit）→ 防抖 re-GET runs。**不轮询。**
- 诚实标注：`Completed` 显示「完成（已退出）」；成本行显示「成本（仅 Claude）」，非 Claude run 的 cost 列显示「—」+ tooltip「该后端不上报成本」。**不给 Kiro/Codex 估算成本。**
- 全设计系统 token，零 px 字面量；canceled 用紫色 token（沿用现有约定）。

## 8. think-big 接缝（现在不做，schema/结构留位）

- **watchdog 阈值自整定**：按 `agent_type + work_dir` 攒 P95 → 喂回 idle-watchdog（现在写死 idle 60/total 300）。schema 已带 agent_type 分桶。
- **跨会话 dashboard / 成本预算告警**：字段已铺（session_id/work_dir/cost/token），后续是一个 `GROUP BY` + 新视图。
- **失败 run 一键 replay**：`input_snapshot_ref` 对齐已有 `agent_task_runs.input_snapshot` + `replay_of`，交互 run 与定时 run 共享 run-record 模型。
- **明确别做**：LLM 自动判定任务对错；给非 Claude 估成本；时序数据库；per-tool 耗时拆分。

## 9. 测试策略

**P0：**
- **outcome 判定纯函数**矩阵（A 的命根子）：Result+verdict、Result+interactive、Error、Exit(crash)、**Cancel→kill→Exit 必出 Cancelled 不是 Errored**、Interrupt→Result、**TimeoutKill→Exit 必出 Timeout**。
- **假时钟**：duration / GC / p50/p95 计算参数化 `now: i64`，无 sleep。
- **并发**：N 个 turn 边界 + 并发 GET runs，断言无 panic、`stats.count == runs.len()`；验证「重连 broadcast 不回放、REST 兜底」不变量。
- duration 负值钳零。

**P1：**
- watchdog→TimeoutKill 往返集成测试：assert SQLite 终态与 run_metrics outcome 一致、不双写。
- worker：大量 try_send 不阻塞 fan-out select! loop。

**P2：** GC keepCount/keepWindow 纯函数边界（假时钟）。

## 10. 交付

- 分支 `feat/per-run-metrics`，worktree 隔离，subagent-driven TDD，执行用 opus。
- 完成后双评审（我 + codex）→ 合并 main + push → 部署 live 需用户点头。
