# Per-run Metrics Implementation Plan (PR1 / Feature A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为交互式 agent 会话的每一次 turn（run）记录 wall-clock 耗时 + outcome（completed/errored/timeout/cancelled）+ 人工 verdict，落盘成单会话历史，REST 暴露给前端面板。

**Architecture:** outcome 判定从「看到哪个终端事件」改为「什么意图导致」——fan-out loop 维护 `pending_outcome`，在 Cancel/Interrupt/TimeoutKill 输入分支打标，边界处 `take()`。新增 `SessionInput::TimeoutKill` 让所有终结从 fan-out 单一出口走。`run_metrics.rs` 是叶子模块（不依赖 scheduled_tasks），核心判定/统计/GC 全是纯函数。内存 `VecDeque<RunMetric>`（cap 50）挂 `Session`，异步单 worker 落盘 `~/.zeromux/run-metrics/<sid>.ndjson`。REST 为唯一真相源；WS 边界事件仅作前端刷新信号。

**Tech Stack:** Rust / Axum / tokio（broadcast + mpsc fan-out）；前端 React 19 + Vite + Tailwind v4 + vitest。

## Global Constraints

- 不碰广播扇出不变量：fan-out 任务是 session 进程的唯一 owner；所有 client→process 走 `SessionInput`。
- 不在 fan-out `select!` loop 里做同步 I/O / fsync（`append_run_event` 的同步写是既有技术债，不复制扩大）。
- `run_metrics.rs` 是叶子模块，**不依赖 `scheduled_tasks`**；outcome/failure_kind 类型定义在本模块。
- 不存 prompt/响应正文（防跨租户泄漏 + 控体积）。
- 时间源参数化（纯函数收 `now: i64` 入参），测试用假时钟，不 sleep。
- duration 单调钳零：`if d < 0 { 0 }`。
- 不把 RunMetric 塞进 broadcast / scrollback。
- 代码注释/标识英文，用户可见字符串中文（沿用项目双语规范）。
- 后端测试：`cargo test`；执行用 opus；频繁提交。

---

## File Structure

- **Create** `src/run_metrics.rs` — 叶子模块：`RunOutcome` / `VerdictSource` / `RunMetric` / `SessionRunStats` 类型 + 纯函数（`classify_outcome`、`compute_stats`、`gc_retain`、`duration_ms`）+ 异步 writer worker。
- **Modify** `src/session_manager.rs`:
  - `SessionInput` 枚举（`:114`）+ `TimeoutKill { run_id: Option<String> }`。
  - `RunningProcess`（`:184`）/ fan-out loop（`:1746-2019`）：`pending_outcome` 局部状态 + 边界处记 metric。
  - `Session`（`:204`）：`run_metrics: VecDeque<RunMetric>` 字段。
  - `SessionManager`（`:515`）：writer worker 的 `mpsc::Sender<RunMetric>` + `record_run_metric()` + `runs_for_session()`。
- **Modify** `src/acp/process.rs`（`:331-338`）：result 解析多取 `usage.input_tokens/output_tokens`；`AcpEvent::Result` 加 `tokens_in/tokens_out: Option<u64>`。
- **Modify** `src/web.rs`：新增 `GET /api/sessions/{id}/runs`、`POST /api/sessions/{id}/runs/{run_id}/verdict`。
- **Modify** `src/scheduled_tasks.rs`（`reconcile_timeouts_per_task` `:541` 附近）：检测到 interactive 会话超时 → 发 `TimeoutKill` 而非仅写 SQLite。
- **Modify** `src/main.rs` / 模块声明处：`mod run_metrics;`。
- **Frontend Create** `frontend/src/components/RunMetricsPanel.tsx`。
- **Frontend Modify** `frontend/src/components/SessionInfoBar.tsx`（新 toggle）、`frontend/src/components/AcpChatView.tsx`（边界事件触发 re-GET）、`frontend/src/lib/api.ts`（`getSessionRuns`、`postRunVerdict`）。

---

## Task 1: 叶子模块类型 + outcome 分类纯函数

**Files:**
- Create: `src/run_metrics.rs`
- Modify: `src/main.rs`（或 `src/lib.rs` 模块根，加 `mod run_metrics;`）
- Test: inline `#[cfg(test)] mod tests`（沿用 `src/acp/process.rs:347` 风格）

**Interfaces:**
- Produces:
  - `pub enum RunOutcome { Completed, Errored, Timeout, Cancelled }`（`#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Deserialize)]`，`#[serde(rename_all="snake_case")]`）
  - `pub enum VerdictSource { None, AgentMarker, Human }`（同 derive + snake_case）
  - `pub enum TerminalEvt { Result, Error, Exit }` — 边界事件类型的轻量镜像（避免依赖 AcpEvent）
  - `pub fn classify_outcome(evt: TerminalEvt, pending: Option<RunOutcome>) -> RunOutcome`

- [ ] **Step 1: 写失败测试**（覆盖评审 P0 矩阵）

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_prefers_pending_intent_over_terminal_event() {
        // P0: Cancel→kill→Exit 必须出 Cancelled,不是 Errored
        assert_eq!(classify_outcome(TerminalEvt::Exit, Some(RunOutcome::Cancelled)), RunOutcome::Cancelled);
        // P0: TimeoutKill→Exit 必须出 Timeout
        assert_eq!(classify_outcome(TerminalEvt::Exit, Some(RunOutcome::Timeout)), RunOutcome::Timeout);
        // Interrupt→Result 仍记 Cancelled(被打断的 turn 不算 completed)
        assert_eq!(classify_outcome(TerminalEvt::Result, Some(RunOutcome::Cancelled)), RunOutcome::Cancelled);
    }

    #[test]
    fn classify_falls_back_to_terminal_event_when_no_intent() {
        assert_eq!(classify_outcome(TerminalEvt::Result, None), RunOutcome::Completed);
        assert_eq!(classify_outcome(TerminalEvt::Error, None), RunOutcome::Errored);
        assert_eq!(classify_outcome(TerminalEvt::Exit, None), RunOutcome::Errored);
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test run_metrics::tests::classify -- --nocapture`
Expected: 编译失败 / `classify_outcome` not found。

- [ ] **Step 3: 写最小实现**

```rust
//! Per-run metrics —— 交互式会话每轮对话的耗时/结果度量。叶子模块,不依赖 scheduled_tasks。
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome { Completed, Errored, Timeout, Cancelled }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictSource { None, AgentMarker, Human }

/// 终端事件类型的轻量镜像,避免本叶子模块依赖 acp::AcpEvent。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalEvt { Result, Error, Exit }

/// outcome 判定:意图(pending)优先于终端事件类型。这是评审 P0 的核心——
/// Cancel/Interrupt/TimeoutKill 在输入分支打 pending,边界处用它覆盖事件推断。
pub fn classify_outcome(evt: TerminalEvt, pending: Option<RunOutcome>) -> RunOutcome {
    if let Some(p) = pending {
        return p;
    }
    match evt {
        TerminalEvt::Result => RunOutcome::Completed,
        TerminalEvt::Error | TerminalEvt::Exit => RunOutcome::Errored,
    }
}
```

并在模块根加 `mod run_metrics;`（`src/main.rs` 顶部其他 `mod` 声明旁）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cargo test run_metrics::tests::classify`
Expected: 2 passed。

- [ ] **Step 5: 提交**

```bash
git add src/run_metrics.rs src/main.rs
git commit -m "feat(metrics): run_metrics leaf module + outcome classification (intent over event)"
```

---

## Task 2: RunMetric 结构 + duration 钳零 + stats(P50/P95) + GC 纯函数

**Files:**
- Modify: `src/run_metrics.rs`
- Test: inline tests

**Interfaces:**
- Produces:
  - `pub struct RunMetric { run_id, session_id, work_dir, agent_type, turn_seq, started_ms, ended_ms, duration_ms, outcome, failure_kind: Option<String>, verdict: Option<String>, verdict_source, cost_usd: Option<f64>, tokens_in: Option<u64>, tokens_out: Option<u64>, input_snapshot_ref: Option<String> }`（`#[derive(Debug,Clone,Serialize,Deserialize)]`）
  - `pub struct SessionRunStats { count, avg_ms, p50_ms, p95_ms, max_ms, completed_count, errored_count, timeout_count, cancelled_count }`
  - `pub fn duration_ms(started_ms: i64, ended_ms: i64) -> i64`（钳零）
  - `pub fn compute_stats(runs: &VecDeque<RunMetric>) -> SessionRunStats`
  - `pub fn gc_retain(runs: &mut VecDeque<RunMetric>, now_ms: i64, keep_count: usize, keep_window_ms: i64)`

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn duration_clamps_negative_to_zero() {
    assert_eq!(duration_ms(1000, 900), 0); // 单调时钟回拨保护
    assert_eq!(duration_ms(1000, 1500), 500);
}

#[test]
fn stats_computes_percentiles_and_outcome_counts() {
    let mk = |dur: i64, oc: RunOutcome| RunMetric {
        run_id: "r".into(), session_id: "s".into(), work_dir: "/w".into(),
        agent_type: "claude".into(), turn_seq: 1, started_ms: 0, ended_ms: dur,
        duration_ms: dur, outcome: oc, failure_kind: None, verdict: None,
        verdict_source: VerdictSource::None, cost_usd: None,
        tokens_in: None, tokens_out: None, input_snapshot_ref: None,
    };
    let mut runs = VecDeque::new();
    for d in [100, 200, 300, 400, 500] { runs.push_back(mk(d, RunOutcome::Completed)); }
    runs.push_back(mk(999, RunOutcome::Timeout));
    let s = compute_stats(&runs);
    assert_eq!(s.count, 6);
    assert_eq!(s.max_ms, 999);
    assert_eq!(s.completed_count, 5);
    assert_eq!(s.timeout_count, 1);
    assert_eq!(s.p50_ms, 300);   // nearest-rank: ceil(0.5*6)=3 → 第3个(升序100,200,300...)
    assert_eq!(s.p95_ms, 999);   // ceil(0.95*6)=6 → 第6个
}

#[test]
fn gc_retains_by_count_and_window() {
    let mk = |id: &str, ts: i64| RunMetric {
        run_id: id.into(), session_id: "s".into(), work_dir: "/w".into(),
        agent_type: "claude".into(), turn_seq: 1, started_ms: ts, ended_ms: ts,
        duration_ms: 0, outcome: RunOutcome::Completed, failure_kind: None,
        verdict: None, verdict_source: VerdictSource::None, cost_usd: None,
        tokens_in: None, tokens_out: None, input_snapshot_ref: None,
    };
    let now = 100 * 86_400_000; // day 100
    let mut runs: VecDeque<RunMetric> = VecDeque::new();
    runs.push_back(mk("old", 1));                  // 远超 30d 窗口
    runs.push_back(mk("fresh", now - 1000));       // 窗口内
    gc_retain(&mut runs, now, 50, 30 * 86_400_000);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].run_id, "fresh");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test run_metrics::tests`
Expected: 编译失败（`RunMetric` / `compute_stats` 未定义）。

- [ ] **Step 3: 写最小实现**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunMetric {
    pub run_id: String,
    pub session_id: String,
    pub work_dir: String,
    pub agent_type: String,
    pub turn_seq: u64,
    pub started_ms: i64,
    pub ended_ms: i64,
    pub duration_ms: i64,
    pub outcome: RunOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
    pub verdict_source: VerdictSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_in: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_out: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_snapshot_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SessionRunStats {
    pub count: usize,
    pub avg_ms: i64,
    pub p50_ms: i64,
    pub p95_ms: i64,
    pub max_ms: i64,
    pub completed_count: usize,
    pub errored_count: usize,
    pub timeout_count: usize,
    pub cancelled_count: usize,
}

pub fn duration_ms(started_ms: i64, ended_ms: i64) -> i64 {
    let d = ended_ms - started_ms;
    if d < 0 { 0 } else { d }
}

fn percentile(sorted: &[i64], p: f64) -> i64 {
    if sorted.is_empty() { return 0; }
    // nearest-rank: rank = ceil(p * n), 1-indexed
    let rank = (p * sorted.len() as f64).ceil() as usize;
    let idx = rank.clamp(1, sorted.len()) - 1;
    sorted[idx]
}

pub fn compute_stats(runs: &VecDeque<RunMetric>) -> SessionRunStats {
    let mut s = SessionRunStats::default();
    s.count = runs.len();
    if runs.is_empty() { return s; }
    let mut durs: Vec<i64> = runs.iter().map(|r| r.duration_ms).collect();
    let total: i64 = durs.iter().sum();
    s.avg_ms = total / s.count as i64;
    durs.sort_unstable();
    s.max_ms = *durs.last().unwrap();
    s.p50_ms = percentile(&durs, 0.50);
    s.p95_ms = percentile(&durs, 0.95);
    for r in runs {
        match r.outcome {
            RunOutcome::Completed => s.completed_count += 1,
            RunOutcome::Errored => s.errored_count += 1,
            RunOutcome::Timeout => s.timeout_count += 1,
            RunOutcome::Cancelled => s.cancelled_count += 1,
        }
    }
    s
}

/// 先按时间窗淘汰,再按条数上限保留最新 keep_count 条。
pub fn gc_retain(runs: &mut VecDeque<RunMetric>, now_ms: i64, keep_count: usize, keep_window_ms: i64) {
    let cutoff = now_ms - keep_window_ms;
    runs.retain(|r| r.ended_ms >= cutoff);
    while runs.len() > keep_count {
        runs.pop_front();
    }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test run_metrics::tests`
Expected: 全部 passed（含 Task 1 的 classify）。

- [ ] **Step 5: 提交**

```bash
git add src/run_metrics.rs
git commit -m "feat(metrics): RunMetric + stats(P50/P95) + GC pure fns with fake-clock tests"
```

---

## Task 3: 异步落盘 worker

**Files:**
- Modify: `src/run_metrics.rs`
- Test: inline async test（`#[tokio::test]`）

**Interfaces:**
- Consumes: `RunMetric`（Task 2）
- Produces:
  - `pub fn spawn_writer() -> tokio::sync::mpsc::Sender<RunMetric>` — 起单 worker,返回 sender。
  - `pub fn metrics_dir() -> std::path::PathBuf` — `~/.zeromux/run-metrics/`
  - worker 行为:收到 metric → append 一行 NDJSON 到 `<session_id>.ndjson`。

- [ ] **Step 1: 写失败测试**

```rust
#[tokio::test]
async fn writer_appends_ndjson_line() {
    // 用临时 HOME 隔离
    let tmp = std::env::temp_dir().join(format!("zmtest-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    std::env::set_var("HOME", &tmp);

    let tx = spawn_writer();
    let m = RunMetric {
        run_id: "r1".into(), session_id: "sessA".into(), work_dir: "/w".into(),
        agent_type: "claude".into(), turn_seq: 1, started_ms: 0, ended_ms: 100,
        duration_ms: 100, outcome: RunOutcome::Completed, failure_kind: None,
        verdict: None, verdict_source: VerdictSource::None, cost_usd: Some(0.01),
        tokens_in: Some(5), tokens_out: Some(9), input_snapshot_ref: None,
    };
    tx.send(m).await.unwrap();
    // 给 worker 落盘时间
    for _ in 0..50 {
        let p = metrics_dir().join("sessA.ndjson");
        if p.exists() && std::fs::read_to_string(&p).unwrap().contains("\"r1\"") { return; }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("ndjson line not written");
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test run_metrics::tests::writer_appends_ndjson_line`
Expected: 失败（`spawn_writer` 未定义）。

- [ ] **Step 3: 写最小实现**

```rust
pub fn metrics_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
    std::path::Path::new(&home).join(".zeromux").join("run-metrics")
}

/// 单个全局 worker。fan-out 在 finalize 处 try_send;worker 用 spawn_blocking 落盘,
/// fsync 永不落在对话延迟路径。队列满时 try_send 端 best-effort 丢弃(见 Task 5)。
pub fn spawn_writer() -> tokio::sync::mpsc::Sender<RunMetric> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<RunMetric>(256);
    tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            let _ = tokio::task::spawn_blocking(move || {
                use std::io::Write;
                let dir = metrics_dir();
                if std::fs::create_dir_all(&dir).is_err() { return; }
                let path = dir.join(format!("{}.ndjson", sanitize(&m.session_id)));
                if let Ok(line) = serde_json::to_string(&m) {
                    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                        let _ = writeln!(f, "{}", line);
                    }
                }
            }).await;
        }
    });
    tx
}

/// session_id 是 server 生成的 hex,但仍防御性剥离路径分隔符。
fn sanitize(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test run_metrics::tests::writer_appends_ndjson_line`
Expected: passed。

- [ ] **Step 5: 提交**

```bash
git add src/run_metrics.rs
git commit -m "feat(metrics): async single-worker NDJSON writer (~/.zeromux/run-metrics)"
```

---

## Task 4: SessionInput::TimeoutKill 变体 + Session 字段 + AcpEvent token 解析

**Files:**
- Modify: `src/session_manager.rs`（`SessionInput` `:114`、`Session` `:204`、`RunningProcess` `:184`）
- Modify: `src/acp/process.rs`（`AcpEvent::Result` `:66`、result 解析 `:331`、`kiro_process.rs:356`、`codex_process.rs:712`）
- Test: `src/acp/process.rs` inline test

**Interfaces:**
- Produces:
  - `SessionInput::TimeoutKill { run_id: Option<String> }`
  - `Session.run_metrics: VecDeque<crate::run_metrics::RunMetric>`
  - `AcpEvent::Result { ..., tokens_in: Option<u64>, tokens_out: Option<u64> }`

- [ ] **Step 1: 写失败测试**（process.rs，token 解析）

```rust
#[test]
fn result_parses_usage_tokens_when_present() {
    let raw = serde_json::json!({
        "type": "result", "result": "done", "session_id": "s1",
        "total_cost_usd": 0.02,
        "usage": { "input_tokens": 123, "output_tokens": 45 }
    });
    let evts = translate_event(&raw); // 现有翻译函数名,按实际调整
    match &evts[0] {
        AcpEvent::Result { tokens_in, tokens_out, cost_usd, .. } => {
            assert_eq!(*tokens_in, Some(123));
            assert_eq!(*tokens_out, Some(45));
            assert_eq!(*cost_usd, Some(0.02));
        }
        _ => panic!("expected Result"),
    }
}
```

> 注：`translate_event` 的真实名称见 `process.rs` 内 result 分支所在函数；若是私有，测试放同模块即可调用。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test acp::process::tests::result_parses_usage_tokens`
Expected: 失败（`tokens_in` 字段不存在）。

- [ ] **Step 3: 写实现**

`AcpEvent::Result`（process.rs:66）加字段：

```rust
    Result {
        text: String,
        turn_id: u64,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tokens_in: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tokens_out: Option<u64>,
    },
```

result 解析（process.rs:332）：

```rust
        "result" => {
            let usage = val.get("usage");
            vec![AcpEvent::Result {
                text: val.get("result").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                turn_id: 0,
                session_id: val.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                cost_usd: val.get("total_cost_usd").and_then(|v| v.as_f64()),
                tokens_in: usage.and_then(|u| u.get("input_tokens")).and_then(|v| v.as_u64()),
                tokens_out: usage.and_then(|u| u.get("output_tokens")).and_then(|v| v.as_u64()),
            }]
        }
```

`kiro_process.rs:356` / `codex_process.rs:712` 的 `Result {...}` 构造处补 `tokens_in: None, tokens_out: None`（与 `cost_usd: None` 并列）。

`SessionInput`（:114）末尾加：

```rust
    /// Watchdog→fan-out: 超时终结当前 run。让超时和完成/错/取消一样从 fan-out
    /// 单一出口走,run_metrics 与 finalize_run 天然一致(评审 P0)。
    TimeoutKill { run_id: Option<String> },
```

`Session`（:204）加字段（在 `turns_completed` 旁）：

```rust
    /// 本会话最近的 per-run 度量历史(cap 50, GC 30d)。进程死后仍保留供重连查看。
    run_metrics: std::collections::VecDeque<crate::run_metrics::RunMetric>,
```

在所有 `Session { ... }` 构造点补 `run_metrics: std::collections::VecDeque::new()`（`grep -n "Session {" src/session_manager.rs` 找全；同 idle-watchdog 那次加字段的做法）。

- [ ] **Step 4: 运行确认通过 + 全量编译**

Run: `cargo test acp::process::tests::result_parses_usage_tokens && cargo build`
Expected: test passed；build 成功（所有 Session 构造点已补字段，TimeoutKill 的 `_ => {}` 暂由现有 PTY-ignore 分支兜底）。

- [ ] **Step 5: 提交**

```bash
git add src/session_manager.rs src/acp/process.rs src/acp/kiro_process.rs src/acp/codex_process.rs
git commit -m "feat(metrics): TimeoutKill input, Session.run_metrics field, parse usage tokens"
```

---

## Task 5: fan-out 接线 —— pending_outcome + 边界处记 metric

**Files:**
- Modify: `src/session_manager.rs`（fan-out loop `:1746-2019`；`SessionManager` 加 `record_run_metric` + writer sender）
- Test: 纯函数已在 Task 1/2 覆盖；本任务加一个「构造 metric」纯 helper 的单测。

**Interfaces:**
- Consumes: `classify_outcome`、`RunMetric`、`duration_ms`、`spawn_writer`
- Produces:
  - `SessionManager` 新字段 `run_metrics_tx: tokio::sync::mpsc::Sender<RunMetric>`（`new()` 里 `run_metrics::spawn_writer()`）
  - `pub fn record_run_metric(&self, sid: &str, m: RunMetric)` — 持锁 push VecDeque(cap 50 即 pop_front)+ 出锁 try_send writer
  - fan-out loop 局部 `pending_outcome: Option<RunOutcome>`、`run_started_ms: Option<i64>`、`run_id_hex: String`(每 turn 新生)

- [ ] **Step 1: 写失败测试**（build_run_metric helper 纯函数）

```rust
// 放 session_manager.rs inline tests
#[test]
fn build_run_metric_maps_fields() {
    let m = build_run_metric(
        "rid", "sess", "/w", "claude", 3,
        1000, 1700, // started, ended → duration 700
        crate::run_metrics::RunOutcome::Completed, None,
        Some(0.05), Some(10), Some(20),
    );
    assert_eq!(m.duration_ms, 700);
    assert_eq!(m.outcome, crate::run_metrics::RunOutcome::Completed);
    assert_eq!(m.cost_usd, Some(0.05));
    assert_eq!(m.turn_seq, 3);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test session_manager::tests::build_run_metric_maps_fields`
Expected: 失败（helper 未定义）。

- [ ] **Step 3: 写实现**

`SessionManager::new`（:525）：加字段 `run_metrics_tx: crate::run_metrics::spawn_writer(),`，结构体定义同步加 `run_metrics_tx: tokio::sync::mpsc::Sender<crate::run_metrics::RunMetric>,`。

加纯 helper（放 `apply_turn` 附近，便于单测）：

```rust
#[allow(clippy::too_many_arguments)]
fn build_run_metric(
    run_id: &str, session_id: &str, work_dir: &str, agent_type: &str, turn_seq: u64,
    started_ms: i64, ended_ms: i64,
    outcome: crate::run_metrics::RunOutcome, failure_kind: Option<String>,
    cost_usd: Option<f64>, tokens_in: Option<u64>, tokens_out: Option<u64>,
) -> crate::run_metrics::RunMetric {
    crate::run_metrics::RunMetric {
        run_id: run_id.to_string(), session_id: session_id.to_string(),
        work_dir: work_dir.to_string(), agent_type: agent_type.to_string(), turn_seq,
        started_ms, ended_ms, duration_ms: crate::run_metrics::duration_ms(started_ms, ended_ms),
        outcome, failure_kind,
        verdict: None, verdict_source: crate::run_metrics::VerdictSource::None,
        cost_usd, tokens_in, tokens_out, input_snapshot_ref: None,
    }
}
```

加 `record_run_metric`（SessionManager impl）：

```rust
pub fn record_run_metric(&self, sid: &str, m: crate::run_metrics::RunMetric) {
    {
        let mut map = self.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(sid) {
            s.run_metrics.push_back(m.clone());
            while s.run_metrics.len() > 50 { s.run_metrics.pop_front(); }
        }
    } // 出锁后再 try_send,持锁期间不做 I/O
    let _ = self.run_metrics_tx.try_send(m); // 队列满 best-effort 丢弃
}
```

fan-out loop 接线（在 spawn 闭包顶部、`turn_seq`/`local_running` 等局部旁初始化）：

```rust
let mut pending_outcome: Option<crate::run_metrics::RunOutcome> = None;
let mut run_started_ms: Option<i64> = None;
```

- 每次 turn 起跑（4 处 `m.mark_turn(..., TurnState::Running, turn_seq)` 前：run_id 分支 :1901、Interrupt-mode :1919、Passthrough :1931、idle :1959、collect flush :2008）记 `run_started_ms = Some(now_millis());`。建议抽一行 helper 闭包避免重复。
- `Cancel` 分支（:1983）：`pending_outcome = Some(RunOutcome::Cancelled);` **再** `process.kill().await;`
- `Interrupt` 分支（:1972，`if local_running`内）：`pending_outcome = Some(RunOutcome::Cancelled);`
- 新增 `TimeoutKill { .. }` 分支：`pending_outcome = Some(RunOutcome::Timeout); process.kill().await;`
- 边界处（:1803 `if is_boundary` 内，紧接现有 `finalize_run` 逻辑后）：

```rust
// per-run 度量:每个边界(完成/错/取消/超时)都从这一个出口记一条。
let term = match &evt {
    AcpEvent::Result { .. } => crate::run_metrics::TerminalEvt::Result,
    AcpEvent::Error { .. } => crate::run_metrics::TerminalEvt::Error,
    _ => crate::run_metrics::TerminalEvt::Exit,
};
let outcome = crate::run_metrics::classify_outcome(term, pending_outcome.take());
let (mc, mt_in, mt_out) = match &evt {
    AcpEvent::Result { cost_usd, tokens_in, tokens_out, .. } => (*cost_usd, *tokens_in, *tokens_out),
    _ => (None, None, None),
};
let fk = match outcome {
    crate::run_metrics::RunOutcome::Errored => Some(
        if matches!(evt, AcpEvent::Exit { .. }) { "cli_exited" } else { "cli_error" }.to_string()),
    _ => None,
};
if let Some(started) = run_started_ms.take() {
    if let Some(m) = mgr.upgrade() {
        let rid = crate::run_metrics::new_run_id(); // 见下
        let metric = build_run_metric(&rid, &sid, &work_dir, agent_label, turn_seq,
            started, now_millis(), outcome, fk, mc, mt_in, mt_out);
        m.record_run_metric(&sid, metric);
    }
}
```

在 `run_metrics.rs` 加 `pub fn new_run_id() -> String`（16-hex；用进程内计数器 + pid 拼，避免 `Math.random`/时间依赖；与现有 run_id 生成方式对齐——查 `scheduled_tasks.rs` 现有 run_id 生成复用之）。

> 注：`is_boundary` 已含 `boundary_count >= turn_seq` 守卫翻 Idle。run metric 对每个边界都记一条（与翻 Idle 与否无关），这是有意：interrupt-resend 产生的迟到边界也代表一次真实 run 的结束。

- [ ] **Step 4: 运行确认通过 + 编译**

Run: `cargo test session_manager::tests::build_run_metric_maps_fields && cargo build`
Expected: passed + build 成功。

- [ ] **Step 5: 提交**

```bash
git add src/session_manager.rs src/run_metrics.rs
git commit -m "feat(metrics): wire fan-out — pending_outcome + record one metric per boundary"
```

---

## Task 6: watchdog 对 interactive 会话发 TimeoutKill

**Files:**
- Modify: `src/scheduled_tasks.rs`（`reconcile_timeouts_per_task` `:541` 附近 / watchdog 循环）
- Modify: `src/session_manager.rs`（加 `pub async fn send_timeout_kill(&self, sid: &str, run_id: Option<String>)`）
- Test: 集成测试（`#[tokio::test]`）——构造一个 Running 的假会话,触发超时,断言收到 TimeoutKill 后 outcome=Timeout。

**Interfaces:**
- Consumes: `SessionInput::TimeoutKill`、`record_run_metric`
- Produces: `SessionManager::send_timeout_kill`、`SessionManager::running_idle_too_long(idle_ms) -> Vec<String>`（按 `last_activity_ms` 找静默过久的交互会话）

- [ ] **Step 1: 写失败测试**

```rust
#[tokio::test]
async fn idle_interactive_session_gets_timeout_kill_and_records_timeout() {
    // 构造 SessionManager + 一个 Running 交互会话(假进程,见现有测试 helper),
    // 设 last_activity_ms 为远古,调 watchdog tick,
    // 断言 runs_for_session 末条 outcome == Timeout。
    // (按 session_manager.rs 现有测试构造会话的 helper 实现;若无则本测试标 #[ignore]
    //  并依赖 Task 7 的 REST 层集成验证。)
}
```

> 若 `session_manager.rs` 缺少「构造带假进程的 Running 会话」测试 helper,则本步降级为：单测 `running_idle_too_long` 的纯筛选逻辑（给定一组 `(sid, last_activity_ms, is_interactive)` + idle 阈值 → 应被 kill 的 sid 列表），TimeoutKill 往返留到 Task 7/手动冒烟。

- [ ] **Step 2: 运行确认失败**

Run: `cargo test scheduled_tasks::tests::idle_interactive`
Expected: 失败。

- [ ] **Step 3: 写实现**

`SessionManager`：

```rust
/// watchdog 用:找出静默超过 idle_ms 的「交互」会话(无 source_task_id 且 Running)。
pub fn running_idle_too_long(&self, now_ms: i64, idle_ms: i64) -> Vec<String> {
    let map = self.sessions.lock().unwrap();
    map.values()
        .filter(|s| s.source_task_id.is_none())
        .filter(|s| s.running.as_ref().map(|rp| rp.turn_state == TurnState::Running).unwrap_or(false))
        .filter(|s| now_ms - s.last_activity_ms >= idle_ms)
        .map(|s| s.id.clone())
        .collect()
}

pub async fn send_timeout_kill(&self, sid: &str, run_id: Option<String>) {
    let tx = {
        let map = self.sessions.lock().unwrap();
        map.get(sid).and_then(|s| s.running.as_ref().map(|rp| rp.input_tx.clone()))
    };
    if let Some(tx) = tx {
        let _ = tx.send(SessionInput::TimeoutKill { run_id }).await;
    }
}
```

watchdog 循环（scheduled_tasks 的 tick）：除现有 scheduled-run reconcile 外，加一段对交互会话的 idle 检查（阈值用保守常量，如 `INTERACTIVE_IDLE_MS = 30 * 60_000`，注释标「自整定留接缝、见 spec §8」）：

```rust
// interactive 会话卡死保护(评审高杠杆点):静默过久 → 发 TimeoutKill,
// 让 run_metrics 记一条 Timeout。阈值暂为常量,自整定留接缝。
let stale = mgr.running_idle_too_long(now_ms, INTERACTIVE_IDLE_MS);
for sid in stale {
    mgr.send_timeout_kill(&sid, None).await;
}
```

- [ ] **Step 4: 运行确认通过 + 编译**

Run: `cargo test scheduled_tasks && cargo build`
Expected: passed + build 成功。

- [ ] **Step 5: 提交**

```bash
git add src/session_manager.rs src/scheduled_tasks.rs
git commit -m "feat(metrics): watchdog sends TimeoutKill to stale interactive sessions"
```

---

## Task 7: REST —— GET runs + POST verdict

**Files:**
- Modify: `src/web.rs`（authed `/api/*` 组加两路由 + 两 handler）
- Modify: `src/session_manager.rs`（`runs_for_session`、`set_human_verdict`）
- Test: `src/web.rs` inline handler 测试（沿用现有 web.rs 测试风格）

**Interfaces:**
- Consumes: `Session.run_metrics`、`compute_stats`
- Produces:
  - `SessionManager::runs_for_session(&self, sid, owner_id, limit, before) -> Option<(Vec<RunMetric>, SessionRunStats)>`（owner 校验，返回 None=无权/不存在）
  - `SessionManager::set_human_verdict(&self, sid, owner_id, run_id, verdict) -> bool`
  - `GET /api/sessions/{id}/runs?limit=&before=` → `{ runs, stats }`
  - `POST /api/sessions/{id}/runs/{run_id}/verdict` body `{ verdict, note? }`

- [ ] **Step 1: 写失败测试**（runs_for_session owner 校验 + 分页）

```rust
#[test]
fn runs_for_session_enforces_owner_and_limit() {
    // 构造 mgr + 会话(owner "u1") + push 3 条 metric,
    // runs_for_session(sid,"u2",..) → None (跨 owner 拒);
    // runs_for_session(sid,"u1",Some(2),None) → 2 条 + stats.count==3。
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cargo test web::tests::runs_for_session`（或放 session_manager tests）
Expected: 失败。

- [ ] **Step 3: 写实现**

`SessionManager`：

```rust
pub fn runs_for_session(&self, sid: &str, owner_id: &str, limit: Option<usize>, before_ms: Option<i64>)
    -> Option<(Vec<crate::run_metrics::RunMetric>, crate::run_metrics::SessionRunStats)> {
    let map = self.sessions.lock().unwrap();
    let s = map.get(sid)?;
    if s.owner_id != owner_id { return None; }
    let stats = crate::run_metrics::compute_stats(&s.run_metrics);
    let mut runs: Vec<_> = s.run_metrics.iter()
        .filter(|r| before_ms.map(|b| r.ended_ms < b).unwrap_or(true))
        .cloned().collect();
    runs.reverse(); // 最新在前
    if let Some(n) = limit { runs.truncate(n); }
    Some((runs, stats))
}

pub fn set_human_verdict(&self, sid: &str, owner_id: &str, run_id: &str, verdict: &str) -> bool {
    let mut map = self.sessions.lock().unwrap();
    let Some(s) = map.get_mut(sid) else { return false; };
    if s.owner_id != owner_id { return false; }
    if let Some(r) = s.run_metrics.iter_mut().find(|r| r.run_id == run_id) {
        r.verdict = Some(verdict.to_string());
        r.verdict_source = crate::run_metrics::VerdictSource::Human;
        // 注:此处只改内存;落盘历史的 verdict 回写留接缝(MVP 不重写 ndjson)。
        return true;
    }
    false
}
```

`web.rs`：在 authed 路由组加：

```rust
.route("/api/sessions/{id}/runs", get(get_session_runs))
.route("/api/sessions/{id}/runs/{run_id}/verdict", post(post_run_verdict))
```

handler 沿用现有 `/api/sessions/{id}/files` 的提取 `CurrentUser` + path/query 模式；`get_session_runs` 调 `runs_for_session`，404/403 时回 None→对应状态；`post_run_verdict` 调 `set_human_verdict`。

- [ ] **Step 4: 运行确认通过 + 编译**

Run: `cargo test web && cargo build`
Expected: passed + build 成功。

- [ ] **Step 5: 提交**

```bash
git add src/web.rs src/session_manager.rs
git commit -m "feat(metrics): GET /runs (owner-scoped, paged) + POST verdict"
```

---

## Task 8: 前端 API client + RunMetricsPanel + SessionInfoBar toggle

**Files:**
- Modify: `frontend/src/lib/api.ts`（`getSessionRuns`、`postRunVerdict`）
- Create: `frontend/src/components/RunMetricsPanel.tsx`
- Modify: `frontend/src/components/SessionInfoBar.tsx`（新 toggle 按钮）
- Modify: `frontend/src/components/AcpChatView.tsx`（边界事件 → 防抖 re-GET + 传 started_ms 本地计时）
- Test: `frontend/src/components/__tests__/RunMetricsPanel.test.tsx`（vitest）

**Interfaces:**
- Consumes: `GET /api/sessions/{id}/runs`、`turn_started_ms`（已在 SessionInfo）
- Produces: `RunMetricsPanel({ sessionId, turnStartedMs, running })`

- [ ] **Step 1: 写失败测试**

```tsx
import { render, screen } from '@testing-library/react'
import { RunMetricsPanel } from '../RunMetricsPanel'

test('renders aggregate pills and honest completed label', async () => {
  // mock getSessionRuns 返回 2 条 + stats
  // 断言出现 "P95"、"完成（已退出）"(非"成功")、超时计数
  render(<RunMetricsPanel sessionId="s1" turnStartedMs={null} running={false} />)
  expect(await screen.findByText(/P95/)).toBeInTheDocument()
  expect(screen.queryByText(/成功/)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd frontend && npx vitest run src/components/__tests__/RunMetricsPanel.test.tsx`
Expected: 失败（组件不存在）。

- [ ] **Step 3: 写实现**

- `api.ts`：`getSessionRuns(id, {limit?, before?})` → fetch `/api/sessions/${id}/runs`；`postRunVerdict(id, runId, verdict, note?)`。沿用现有 `credentials:'same-origin'` 模式。
- `RunMetricsPanel.tsx`：`<details>` 折叠（移动端默认折叠）。挂载即 `getSessionRuns`；`running && turnStartedMs` 时用 `setInterval` 本地计时显示 elapsed（不依赖 WS）。历史时间轴每行：outcome 状态圆点 + 文案（`completed`→「完成（已退出）」/`errored`→「出错」/`timeout`→「超时」/`cancelled`→「已取消」）+ 时间 + 右对齐耗时 + 👍/👎 按钮（点击 `postRunVerdict` 后乐观更新）。汇总胶囊：次数/均值/P95/最长 + 各 outcome 计数。成本行「成本（仅 Claude）」，非 Claude run cost 显示「—」。全 `var(--*)` token，零 px 字面量；cancelled 用 `--accent-purple`。
- `SessionInfoBar.tsx`：加 toggle 按钮（lucide `Timer` 或 `BarChart3` 图标），与现有 Files/Git/Events 并列；点击切换 `'metrics'` overlay 或内联展开（按现有 overlay 结构择一，本面板建议内联展开而非全屏 overlay，因为它要和对话同屏看）。
- `AcpChatView.tsx`：监听已有 turn 边界事件（收到 `result`/`error`/`exit`）→ 防抖 300ms re-GET runs（传给 panel 的回调或共享状态）。

- [ ] **Step 4: 运行确认通过 + lint**

Run: `cd frontend && npx vitest run src/components/__tests__/RunMetricsPanel.test.tsx && npm run lint`
Expected: passed + lint 干净（新增代码无 error）。

- [ ] **Step 5: 提交**

```bash
git add frontend/src/lib/api.ts frontend/src/components/RunMetricsPanel.tsx frontend/src/components/SessionInfoBar.tsx frontend/src/components/AcpChatView.tsx frontend/src/components/__tests__/RunMetricsPanel.test.tsx
git commit -m "feat(metrics): RunMetricsPanel — live timer + history + honest labels + verdict"
```

---

## Task 9: 全量验证 + 前端构建 + 文档

**Files:**
- Modify: `README.md` / `README_ZH.md`（一行功能说明，可选）
- Test: 全量

- [ ] **Step 1: 后端全量测试**

Run: `cargo test`
Expected: 全绿（含 run_metrics 的 classify/stats/gc/writer + build_run_metric + runs_for_session + token 解析 + watchdog 筛选）。

- [ ] **Step 2: 前端全量测试 + 构建**

Run: `cd frontend && npm test && npm run build`
Expected: vitest 全绿（已知 KaTeX flaky 除外）；`tsc -b && vite build` 成功 → `frontend/dist/` 生成（rust-embed 需要）。

- [ ] **Step 3: release 编译冒烟**

Run: `cargo build`（debug 即可，确认 embed 后整体编译）
Expected: 成功。

- [ ] **Step 4: 提交 + 收尾**

```bash
git add -A
git commit -m "docs(metrics): note per-run metrics panel in README"
```

---

## Self-Review（已对 spec 核查）

- **spec §3 outcome 语义** → Task 1（classify 意图优先）+ Task 5（Cancel/Interrupt/TimeoutKill 打标）✓
- **spec §3.2 完成≠成功诚实标注** → Task 8（「完成（已退出）」+ 测试断言无「成功」）✓
- **spec §3.3 TimeoutKill 统一出口 + 交互会话卡死检测** → Task 4（变体）+ Task 6（watchdog 发送）✓
- **spec §3.4 人工 verdict** → Task 7（set_human_verdict）+ Task 8（👍/👎）✓；agent_marker 复用 extract_verdict 仅 scheduled run 已有,交互 MVP 默认 none（留接缝，不强加）
- **spec §4 schema 铺全 + 叶子模块** → Task 2（全字段）+ Task 1（叶子，不依赖 scheduled_tasks）✓
- **spec §5 落盘/内存/Drop/GC/砍 first_byte** → Task 3（async worker）+ Task 5（VecDeque cap50 持锁 push 出锁 try_send）+ Task 2（GC）；first_byte 已砍，埋点位置注释留接缝 ✓
- **spec §6 REST 唯一真相源** → Task 7（GET/POST）+ Task 8（前端 REST 取数，WS 仅刷新信号）✓
- **spec §9 测试** → classify 矩阵(T1)/假时钟 stats+gc(T2)/writer(T3)/owner+分页(T7)/前端(T8)✓；watchdog→TimeoutKill 往返(T6，受测试 helper 可用性影响，已标降级路径）
- **依赖方向无环**：run_metrics 叶子；session_manager→run_metrics；scheduled_tasks 不被 run_metrics 依赖 ✓
- **Placeholder 扫描**：无 TBD/TODO；每个 code step 有完整代码 ✓
- **类型一致性**：`RunOutcome`/`RunMetric`/`SessionRunStats`/`classify_outcome`/`compute_stats`/`gc_retain`/`build_run_metric`/`record_run_metric`/`runs_for_session` 跨任务签名一致 ✓
