//! Per-run metrics —— 交互式会话每轮对话的耗时/结果度量。叶子模块，不依赖 scheduled_tasks。
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Completed,
    Errored,
    Timeout,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictSource {
    None,
    AgentMarker,
    Human,
}

/// Lightweight mirror of terminal event types, so this leaf module does not
/// depend on `acp::AcpEvent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalEvt {
    Result,
    Error,
    Exit,
}

/// Outcome classification: intent (`pending`) takes precedence over the
/// terminal event type. This is the core of review P0 —— Cancel / Interrupt /
/// TimeoutKill set `pending` on the input branch, and at the boundary it
/// overrides the event-based inference.
pub fn classify_outcome(evt: TerminalEvt, pending: Option<RunOutcome>) -> RunOutcome {
    if let Some(p) = pending {
        return p;
    }
    match evt {
        TerminalEvt::Result => RunOutcome::Completed,
        TerminalEvt::Error | TerminalEvt::Exit => RunOutcome::Errored,
    }
}

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

/// 把 Claude CLI 的累计 `total_cost_usd` 差分成本轮增量。
/// 返回 `(本轮增量, 更新后的 prev)`。tokens 不走此函数(实证证实单轮)。
///
/// - `cur == None`：本轮不计成本,prev 不推进。
/// - resume 首轮(`is_first && is_resumed`,prev=None）：记 None,prev 设为 cur，
///   避免把 CLI 恢复的历史累计额误算成本轮花费。
/// - 冷启动首轮(`is_first && !is_resumed`)：调用方把 prev 初始化为 `Some(0.0)`，
///   故增量 = cur - 0 = cur 本身。
/// - 负差 clamp 到 0(对齐 `duration_ms` 的单调回拨保护）。
pub fn diff_cost(
    prev: Option<f64>,
    cur: Option<f64>,
    is_first: bool,
    is_resumed: bool,
) -> (Option<f64>, Option<f64>) {
    let Some(cur) = cur else {
        return (None, prev); // None：不计、不推进
    };
    if is_first && is_resumed {
        return (None, Some(cur)); // resume 首轮:不误算历史额
    }
    let base = prev.unwrap_or(0.0);
    let delta = (cur - base).max(0.0);
    (Some(delta), Some(cur))
}

/// fan-out 接入处的"按边界"成本决策。`will_record` = 本边界是否带 turn-start
/// 时间戳(即是否会落一条 RunMetric)。返回 `(本轮 cost, 新 prev, 新 first_seen)`。
///
/// **不变量**:`prev`/`first_seen` 只在边界真正落 metric 时推进。turn-start 时间戳
/// 现由 FIFO(`TurnStarts`)按边界结算,故 interrupt-resend 的两个边界(旧被打断
/// turn + 新答复 turn)各配到自己的 start、各落一条 metric —— `will_record` 都为
/// true。`!will_record` 只在一个 turn 发出**多余**边界(FIFO 已空)时出现:此时既
/// 不落 metric,也**不能**推进 `prev`,否则该轮增量凭空消失、`lifetime_cost_usd`
/// 系统性偏低(spec §4.1 警示的"偏低更隐蔽")。让该增量自然并入下一条被记录的
/// turn —— 累计 telescoping 保持精确。
pub fn diff_cost_at_boundary(
    prev: Option<f64>,
    cur: Option<f64>,
    first_seen: bool,
    is_resumed: bool,
    will_record: bool,
) -> (Option<f64>, Option<f64>, bool) {
    if !will_record {
        return (None, prev, first_seen); // 丢弃的边界:不推进基线
    }
    let (delta, new_prev) = diff_cost(prev, cur, !first_seen, is_resumed);
    let new_first = first_seen || cur.is_some();
    (delta, new_prev, new_first)
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

/// 16-hex run id for a per-run metric. Process-local monotonic counter mixed
/// with the pid, so it is unique within and across the process's lifetime
/// without depending on wall-clock or a CSPRNG draw on the hot path. Distinct
/// from scheduled-task run ids (those are full UUIDs); these label interactive
/// per-turn metrics only.
pub fn new_run_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id() as u64;
    // pid in the high 32 bits, counter in the low 32 bits → 16 hex chars.
    format!("{:08x}{:08x}", pid & 0xffff_ffff, n & 0xffff_ffff)
}

pub fn metrics_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/ubuntu".to_string());
    std::path::Path::new(&home).join(".zeromux").join("run-metrics")
}

/// 单个全局 worker。fan-out 在 finalize 处 try_send;worker 用 spawn_blocking 落盘,
/// fsync 永不落在对话延迟路径。队列满时 try_send 端 best-effort 丢弃(见 Task 5)。
// The on-disk `<sid>.ndjson` is an append-only audit log (~one short line per
// turn, no bodies); the app never reads it back. The in-memory VecDeque (cap 50,
// see `runs_for_session`) is the source of truth for queries. On-disk GC via
// `gc_retain` is a deferred seam (tracked) — not wired here, so the files grow
// unbounded by design until that lands.
pub fn spawn_writer() -> tokio::sync::mpsc::Sender<RunMetric> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<RunMetric>(256);
    // Spawn the drain task only when a Tokio runtime is present. In production
    // `SessionManager::new` runs inside the server runtime, so the writer always
    // starts. Sync unit tests construct a manager with no reactor — there we skip
    // the spawn (the channel still works; `try_send` is best-effort and drops).
    if tokio::runtime::Handle::try_current().is_ok() {
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
    }
    tx
}

/// session_id 是 server 生成的 hex,但仍防御性剥离路径分隔符。
fn sanitize(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_prefers_pending_intent_over_terminal_event() {
        // P0: Cancel→kill→Exit 必须出 Cancelled，不是 Errored
        assert_eq!(classify_outcome(TerminalEvt::Exit, Some(RunOutcome::Cancelled)), RunOutcome::Cancelled);
        // P0: TimeoutKill→Exit 必须出 Timeout
        assert_eq!(classify_outcome(TerminalEvt::Exit, Some(RunOutcome::Timeout)), RunOutcome::Timeout);
        // Interrupt→Result 仍记 Cancelled（被打断的 turn 不算 completed）
        assert_eq!(classify_outcome(TerminalEvt::Result, Some(RunOutcome::Cancelled)), RunOutcome::Cancelled);
    }

    #[test]
    fn classify_falls_back_to_terminal_event_when_no_intent() {
        assert_eq!(classify_outcome(TerminalEvt::Result, None), RunOutcome::Completed);
        assert_eq!(classify_outcome(TerminalEvt::Error, None), RunOutcome::Errored);
        assert_eq!(classify_outcome(TerminalEvt::Exit, None), RunOutcome::Errored);
    }

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

    #[tokio::test]
    async fn writer_appends_ndjson_line() {
        // 用临时 HOME 隔离 —— 必须持锁并恢复，否则会泄漏给其它线程上的测试
        let _guard = crate::session_manager::HOME_ENV_LOCK.lock().unwrap();
        let prev = std::env::var("HOME").ok();
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
        let mut written = false;
        for _ in 0..50 {
            let p = metrics_dir().join("sessA.ndjson");
            if p.exists() && std::fs::read_to_string(&p).unwrap().contains("\"r1\"") {
                written = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // 恢复 HOME，无论成功失败都执行
        match prev {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
        assert!(written, "ndjson line not written");
    }

    #[test]
    fn diff_cost_normal_cumulative_sequence() {
        // 累计 0.01 → 0.03 → 0.06,增量应为 0.01 / 0.02 / 0.03
        let (d1, p1) = diff_cost(Some(0.0), Some(0.01), true, false);
        assert!((d1.unwrap() - 0.01).abs() < 1e-9);
        let (d2, p2) = diff_cost(p1, Some(0.03), false, false);
        assert!((d2.unwrap() - 0.02).abs() < 1e-9);
        let (d3, _p3) = diff_cost(p2, Some(0.06), false, false);
        assert!((d3.unwrap() - 0.03).abs() < 1e-9);
    }

    #[test]
    fn diff_cost_cold_start_first_turn_keeps_full_value() {
        // 冷启动:prev 由调用方初始化为 Some(0.0),首轮增量 = total 本身
        let (d, p) = diff_cost(Some(0.0), Some(0.28), true, false);
        assert_eq!(d, Some(0.28));
        assert_eq!(p, Some(0.28));
    }

    #[test]
    fn diff_cost_resume_first_turn_records_zero() {
        // resume 首轮:prev=None,记 None,prev 设为该轮 total
        let (d, p) = diff_cost(None, Some(0.50), true, true);
        assert_eq!(d, None);
        assert_eq!(p, Some(0.50));
        // 下一轮正常差分
        let (d2, _) = diff_cost(p, Some(0.55), false, true);
        assert!((d2.unwrap() - 0.05).abs() < 1e-9);
    }

    #[test]
    fn diff_cost_none_does_not_advance_prev() {
        let (d, p) = diff_cost(Some(0.03), None, false, false);
        assert_eq!(d, None);
        assert_eq!(p, Some(0.03)); // 基线不变
        // 下一轮以旧基线差分
        let (d2, _) = diff_cost(p, Some(0.05), false, false);
        assert!((d2.unwrap() - 0.02).abs() < 1e-9);
    }

    #[test]
    fn diff_cost_negative_clamped_to_zero() {
        let (d, p) = diff_cost(Some(0.10), Some(0.04), false, false);
        assert_eq!(d, Some(0.0));
        assert_eq!(p, Some(0.04)); // 仍推进基线
    }

    #[test]
    fn boundary_dropped_does_not_advance_baseline_and_no_cost_lost() {
        // `!will_record` 路径(一个 turn 发出多余边界、TurnStarts FIFO 已空):该边界
        // 不落 metric,且**不能**推进基线。模拟:
        //   边界1(will_record=true,total=0.10)→ 记 0.10,prev→0.10
        //   多余边界(will_record=false,total=0.18)→ 丢弃:cost None,prev 不动(仍 0.10)
        //   下一条被记录的 turn(total=0.25)→ 增量 = 0.25-0.10 = 0.15,
        //     恰含被丢弃边界的 0.08 增量(telescoping 不丢钱)。
        let (d1, p1, f1) = diff_cost_at_boundary(Some(0.0), Some(0.10), false, false, true);
        assert_eq!(d1, Some(0.10));
        assert_eq!(p1, Some(0.10));
        assert!(f1);

        let (d2, p2, f2) = diff_cost_at_boundary(p1, Some(0.18), f1, false, false);
        assert_eq!(d2, None);          // 丢弃边界不计 cost
        assert_eq!(p2, Some(0.10));    // 基线不被未记录边界推进
        assert!(f2);

        let (d3, _p3, _) = diff_cost_at_boundary(p2, Some(0.25), f2, false, true);
        assert!((d3.unwrap() - 0.15).abs() < 1e-9); // 0.10(本轮)+0.08(并入的漏算)
    }

    #[test]
    fn boundary_record_path_matches_plain_diff_cost() {
        // will_record=true 时行为应与 diff_cost 等价(冷启动首轮)。
        let (d, p, f) = diff_cost_at_boundary(Some(0.0), Some(0.28), false, false, true);
        assert_eq!(d, Some(0.28));
        assert_eq!(p, Some(0.28));
        assert!(f);
    }
}
