//! Per-run metrics —— 交互式会话每轮对话的耗时/结果度量。叶子模块，不依赖 scheduled_tasks。
use serde::{Deserialize, Serialize};

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
}
