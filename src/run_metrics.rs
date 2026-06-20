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
}
