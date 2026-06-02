use crate::acp::process::AcpEvent;
use rmcp::ErrorData as McpError;
use rmcp::model::{
    CreateElicitationRequestParams, CreateElicitationResult, CustomNotification,
    ElicitationAction, ProgressNotificationParam,
};
use rmcp::service::{NotificationContext, RequestContext, RoleClient, RunningService};
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::{ClientHandler, ServiceExt};
use tokio::process::Command;
use tokio::sync::mpsc;

/// Channel command from the outer fan-out loop into the rmcp event loop.
enum Cmd {
    Prompt(String),
    Cancel,
    Stop,
}

/// Output formatting conventions injected as a developer-role message at the
/// start of every Codex turn. Codex's own system prompt (from the codex CLI
/// binary) is opinionated about output style; this overrides those defaults
/// to match zeromux's frontend renderers (KaTeX dollar-sign math, mermaid
/// fenced code blocks, markdown tables).
const DEVELOPER_FORMAT_INSTRUCTIONS: &str = "Output formatting conventions for this session (override any conflicting defaults):\n- Inline math: use single-dollar `$...$`. Block math: use double-dollar `$$...$$` on its own line(s). Do NOT emit `\\( ... \\)` or `\\[ ... \\]` LaTeX bracket syntax.\n- Diagrams, flowcharts, sequence diagrams, ER diagrams: emit fenced code blocks tagged `mermaid` (```mermaid ... ```). Do NOT use ASCII-art for relationships that mermaid can express.\n- Tabular data: use markdown pipe tables. Do NOT use ASCII boxes or whitespace-aligned text tables.\n- Code: always fence with a language hint (```rust, ```python, ```bash, etc).";

/// Internal notification carrier from `ClientHandler` callbacks
/// into the event loop.
#[derive(Debug)]
enum Notify {
    /// A streaming text delta with the thread_id Codex carried in the event,
    /// so the event loop can stash thread_id mid-flight and preserve it
    /// across a cancel (where the call_tool future is dropped before the
    /// final result containing threadId can arrive).
    ProgressText {
        text: String,
        thread_id: Option<String>,
    },
    /// A streaming reasoning/thinking delta. Surfaced as a separate variant
    /// so the event loop can emit it as `block_type:"thinking"` for the
    /// frontend to render as a collapsible/dimmed section.
    Reasoning {
        text: String,
        thread_id: Option<String>,
    },
    /// A `codex/event` with `msg.type == "error"`. Codex emits these for
    /// model-side failures (missing API key, quota, model not available, etc.)
    /// — they arrive as notifications rather than as the tools/call response,
    /// so without a dedicated path they would be silently dropped and the
    /// user would see "no reply" forever.
    Error(String),
}

#[derive(Clone)]
struct Handler {
    notify_tx: mpsc::Sender<Notify>,
}

/// Push a Notify into the event loop without ever blocking the caller.
/// Used by ClientHandler callbacks because awaiting on a full channel
/// would stall rmcp's transport reader (same task that delivers the
/// in-flight tools/call response — would deadlock).
fn send_notify_nonblocking(tx: &mpsc::Sender<Notify>, n: Notify) {
    if let Err(e) = tx.try_send(n) {
        match e {
            mpsc::error::TrySendError::Full(_) => {
                tracing::warn!(
                    "codex: notify channel full; dropping a chunk. \
                     Increase channel capacity if this fires repeatedly."
                );
            }
            mpsc::error::TrySendError::Closed(_) => {
                // Event loop has exited; nothing actionable.
            }
        }
    }
}

impl ClientHandler for Handler {
    fn on_progress(
        &self,
        params: ProgressNotificationParam,
        _context: NotificationContext<RoleClient>,
    ) -> impl std::future::Future<Output = ()> + Send + '_ {
        let tx = self.notify_tx.clone();
        async move {
            if let Some(text) = extract_progress_text(&params) {
                send_notify_nonblocking(&tx, Notify::ProgressText { text, thread_id: None });
            } else {
                tracing::debug!("codex: progress without text: {:?}", params);
            }
        }
    }

    fn on_custom_notification(
        &self,
        notification: CustomNotification,
        _context: NotificationContext<RoleClient>,
    ) -> impl std::future::Future<Output = ()> + Send + '_ {
        let tx = self.notify_tx.clone();
        async move {
            // try_send (via send_notify_nonblocking) instead of awaited send:
            // if the event loop is briefly slow (full event_tx buffer, blocked
            // WebSocket subscriber, etc.) we MUST NOT stall the rmcp transport
            // reader inside a notification callback — that would deadlock the
            // same connection the in-flight tools/call response is trying to
            // come back on.
            if let Some((text, thread_id)) = extract_codex_event_delta(&notification) {
                send_notify_nonblocking(&tx, Notify::ProgressText { text, thread_id });
            } else if let Some((text, thread_id)) = extract_codex_event_reasoning(&notification) {
                send_notify_nonblocking(&tx, Notify::Reasoning { text, thread_id });
            } else if let Some(err) = extract_codex_event_error(&notification) {
                send_notify_nonblocking(&tx, Notify::Error(err));
            }
        }
    }

    fn create_elicitation(
        &self,
        request: CreateElicitationRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> impl std::future::Future<Output = Result<CreateElicitationResult, McpError>> + Send + '_ {
        async move {
            tracing::warn!(
                "codex: unexpected elicitation/create (auto-accepting): {:?}",
                request
            );
            Ok(CreateElicitationResult {
                action: ElicitationAction::Accept,
                content: None,
                meta: None,
            })
        }
    }
}

fn extract_progress_text(params: &ProgressNotificationParam) -> Option<String> {
    if let Some(msg) = &params.message {
        if !msg.is_empty() {
            return Some(msg.clone());
        }
    }
    None
}

/// Extract a streaming text chunk from a Codex `codex/event` custom notification,
/// along with the thread_id Codex stamps into each event.
/// Codex sends incremental output as `params.msg.type == "agent_message_content_delta"`
/// with the text in `params.msg.delta` and the thread id in `params.msg.thread_id`.
fn extract_codex_event_delta(
    notification: &CustomNotification,
) -> Option<(String, Option<String>)> {
    if notification.method != "codex/event" {
        return None;
    }
    let params = notification.params.as_ref()?;
    let msg = params.get("msg")?;
    let msg_type = msg.get("type").and_then(|v| v.as_str())?;
    if msg_type != "agent_message_content_delta" {
        return None;
    }
    let delta = msg.get("delta").and_then(|v| v.as_str())?;
    if delta.is_empty() {
        return None;
    }
    let thread_id = msg
        .get("thread_id")
        .and_then(|v| v.as_str())
        .map(String::from);
    Some((delta.to_string(), thread_id))
}

/// Build the `config` object passed to `tools/call("codex")` for a fresh
/// session. Currently only carries `model_reasoning_effort` when the operator
/// configured it (CLI flag `--codex-reasoning low|medium|high`). Returns an
/// empty JSON object when no overrides are set, which Codex accepts as a
/// no-op rather than as a config-validation error.
fn codex_config_overrides(reasoning_effort: Option<&str>) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    if let Some(level) = reasoning_effort {
        if !level.is_empty() && level != "off" {
            obj.insert(
                "model_reasoning_effort".to_string(),
                serde_json::Value::String(level.to_string()),
            );
            obj.insert(
                "model_reasoning_summary".to_string(),
                serde_json::Value::String("auto".to_string()),
            );
        }
    }
    serde_json::Value::Object(obj)
}

/// Extract a reasoning/thinking text delta from a Codex `codex/event`
/// custom notification. Codex emits the model's reasoning trace via
/// several event shapes depending on model and version:
///   - `msg.type == "agent_reasoning"` (one-shot, e.g. Bedrock Anthropic
///     batches the full reasoning summary into a single event)
///   - `msg.type == "agent_reasoning_delta"` (streaming chunk)
///   - `msg.type == "agent_reasoning_content_delta"` (older alias)
/// The text lives in either `msg.delta` or `msg.text`. Returns the text + the
/// thread_id Codex stamped on the event so the event loop can preserve
/// thread_id across mid-flight cancels.
fn extract_codex_event_reasoning(
    notification: &CustomNotification,
) -> Option<(String, Option<String>)> {
    if notification.method != "codex/event" {
        return None;
    }
    let msg = notification.params.as_ref()?.get("msg")?;
    let msg_type = msg.get("type").and_then(|v| v.as_str())?;
    if !matches!(
        msg_type,
        "agent_reasoning" | "agent_reasoning_delta" | "agent_reasoning_content_delta"
    ) {
        return None;
    }
    let text = msg
        .get("delta")
        .and_then(|v| v.as_str())
        .or_else(|| msg.get("text").and_then(|v| v.as_str()))?;
    if text.is_empty() {
        return None;
    }
    let thread_id = msg
        .get("thread_id")
        .and_then(|v| v.as_str())
        .map(String::from);
    Some((text.to_string(), thread_id))
}

/// Extract an error message from a Codex `codex/event` custom notification.
/// Codex reports model-side failures (missing API key, quota, etc.) as
/// `params.msg.type == "error"` with the human-readable text in
/// `params.msg.message`. Without surfacing these, the user just sees
/// "no reply" because the actual `tools/call` may not return an error
/// itself — the error is emitted as a side-channel notification.
fn extract_codex_event_error(notification: &CustomNotification) -> Option<String> {
    if notification.method != "codex/event" {
        return None;
    }
    let msg = notification.params.as_ref()?.get("msg")?;
    let msg_type = msg.get("type").and_then(|v| v.as_str())?;
    if msg_type != "error" {
        return None;
    }
    let text = msg.get("message").and_then(|v| v.as_str())?;
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

pub struct CodexProcess {
    cmd_tx: mpsc::Sender<Cmd>,
    pub event_rx: mpsc::Receiver<AcpEvent>,
}

impl CodexProcess {
    pub async fn spawn(
        codex_path: &str,
        work_dir: &str,
        reasoning_effort: Option<String>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let mut cmd = Command::new(codex_path);
        cmd.arg("mcp-server");
        cmd.current_dir(work_dir);

        let transport = TokioChildProcess::new(cmd)
            .map_err(|e| format!("spawn codex: {e}"))?;

        // 1024 buffer: Codex emits one notification per delta token; long
        // answers (1000+ chunks) plus reasoning summaries can burst quickly.
        // The handler uses try_send so a full channel won't block rmcp's
        // transport reader, but a generous buffer means we almost never
        // drop chunks under normal load.
        let (notify_tx, notify_rx) = mpsc::channel::<Notify>(1024);
        let handler = Handler { notify_tx };

        let service: RunningService<RoleClient, Handler> = handler
            .serve(transport)
            .await
            .map_err(|e| format!("rmcp serve: {e}"))?;

        let (event_tx, event_rx) = mpsc::channel::<AcpEvent>(256);
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>(16);

        let _ = event_tx
            .send(AcpEvent::System {
                subtype: std::borrow::Cow::Borrowed("init"),
                session_id: None,
            })
            .await;

        let work_dir_owned = work_dir.to_string();
        let event_tx_for_panic = event_tx.clone();
        tokio::spawn(async move {
            let result = futures::FutureExt::catch_unwind(
                std::panic::AssertUnwindSafe(run_event_loop(
                    service,
                    cmd_rx,
                    notify_rx,
                    event_tx,
                    work_dir_owned,
                    reasoning_effort,
                )),
            )
            .await;
            if result.is_err() {
                let _ = event_tx_for_panic
                    .send(AcpEvent::Error {
                        message: "Codex event loop panicked".to_string(),
                    })
                    .await;
                let _ = event_tx_for_panic
                    .send(AcpEvent::Exit { code: -1 })
                    .await;
            }
        });

        Ok(Self { cmd_tx, event_rx })
    }

    pub async fn send_prompt(&mut self, text: &str) -> Result<(), std::io::Error> {
        self.cmd_tx
            .send(Cmd::Prompt(text.to_string()))
            .await
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "codex event loop exited")
            })
    }

    pub async fn kill(&mut self) {
        let _ = self.cmd_tx.send(Cmd::Cancel).await;
    }
}

impl Drop for CodexProcess {
    fn drop(&mut self) {
        // Best-effort signal so the loop wakes up promptly. We DON'T spawn
        // a tokio task here: during runtime shutdown the spawned task may
        // never run, leaving a cloned cmd_tx pinned inside the unfinished
        // future and the loop blocked on cmd_rx.recv() forever. try_send
        // is non-blocking; the subsequent drop of self.cmd_tx closes the
        // channel, which the loop's `None => break` arm handles.
        let _ = self.cmd_tx.try_send(Cmd::Stop);
    }
}

async fn run_event_loop(
    service: RunningService<RoleClient, Handler>,
    mut cmd_rx: mpsc::Receiver<Cmd>,
    mut notify_rx: mpsc::Receiver<Notify>,
    event_tx: mpsc::Sender<AcpEvent>,
    work_dir: String,
    reasoning_effort: Option<String>,
) {
    use rmcp::model::CallToolRequestParams;
    use serde_json::json;

    let mut thread_id: Option<String> = None;

    loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(Cmd::Prompt(text)) => {
                        // Drain any stale progress chunks left from a previous turn.
                        while notify_rx.try_recv().is_ok() {}

                        let (tool_name, args) = match &thread_id {
                            None => (
                                "codex",
                                json!({
                                    "prompt": text,
                                    "cwd": work_dir,
                                    "sandbox": "danger-full-access",
                                    "approval-policy": "never",
                                    "developer-instructions": DEVELOPER_FORMAT_INSTRUCTIONS,
                                    "config": codex_config_overrides(reasoning_effort.as_deref()),
                                }),
                            ),
                            Some(tid) => (
                                "codex-reply",
                                json!({
                                    "prompt": text,
                                    "threadId": tid,
                                }),
                            ),
                        };
                        tracing::debug!(
                            "codex: send_prompt tool={} thread_id={:?}",
                            tool_name,
                            thread_id
                        );

                        let mut params = CallToolRequestParams::new(tool_name);
                        if let Some(obj) = args.as_object().cloned() {
                            params = params.with_arguments(obj);
                        }

                        // Race the call_tool future against an interleaved
                        // Cmd::Cancel and against notify_rx so streaming chunks
                        // emit in real time instead of after the result.
                        //
                        // Dropping the call_tool future on cancel discards the
                        // RequestHandle without sending notifications/cancelled
                        // to Codex (rmcp 1.7 only sends that on explicit
                        // RequestHandle::cancel or on timeout). For our purposes
                        // this is acceptable: thread_id is preserved (Codex
                        // finishes the turn server-side; we just stop reading),
                        // and the next prompt continues via codex-reply.
                        let mut call_fut = Box::pin(service.peer().call_tool(params));

                        // Outer Result wraps cancel-vs-completion;
                        // inner Result is rmcp's call_tool return.
                        let outcome: Result<
                            Result<rmcp::model::CallToolResult, rmcp::ServiceError>,
                            String,
                        > = loop {
                            tokio::select! {
                                biased;
                                cmd = cmd_rx.recv() => {
                                    match cmd {
                                        Some(Cmd::Cancel) => {
                                            tracing::debug!(
                                                "codex: cancelling in-flight call_tool"
                                            );
                                            drop(call_fut);
                                            let _ = event_tx
                                                .send(AcpEvent::Error {
                                                    message: "Codex turn cancelled".to_string(),
                                                })
                                                .await;
                                            // Without a thread_id, the next prompt would
                                            // silently start a fresh thread — surface so
                                            // the operator can see the lost-context case.
                                            if thread_id.is_none() {
                                                tracing::warn!(
                                                    "codex: cancelled before thread_id arrived; \
                                                     next prompt will open a new thread"
                                                );
                                            }
                                            break Err("cancelled by user".to_string());
                                        }
                                        Some(Cmd::Stop) | None => {
                                            // H2 fix: emit Exit so listeners see a clean
                                            // termination event instead of inferring it
                                            // from broadcast channel close.
                                            drop(call_fut);
                                            let _ = event_tx
                                                .send(AcpEvent::Exit { code: 0 })
                                                .await;
                                            return;
                                        }
                                        Some(Cmd::Prompt(_)) => {
                                            // The UI should disable Send while
                                            // a turn is in flight; if a prompt
                                            // arrives anyway, drop it and warn.
                                            tracing::warn!(
                                                "codex: prompt received during \
                                                 in-flight turn; dropping"
                                            );
                                        }
                                    }
                                }
                                Some(notify) = notify_rx.recv() => {
                                    match notify {
                                        Notify::ProgressText { text, thread_id: tid } => {
                                            // Stash thread_id eagerly from streaming
                                            // events so that a mid-flight cancel still
                                            // leaves us with the thread Codex created
                                            // for this turn — the next prompt can then
                                            // continue via codex-reply.
                                            if let Some(t) = tid {
                                                if thread_id.as_deref() != Some(t.as_str()) {
                                                    thread_id = Some(t);
                                                }
                                            }
                                            let _ = event_tx
                                                .send(AcpEvent::ContentBlock {
                                                    block_type: std::borrow::Cow::Borrowed("text"),
                                                    text: Some(text),
                                                    name: None,
                                                    input: None,
                                                    streaming: Some(true),
                                                    summary: None,
                                                })
                                                .await;
                                        }
                                        Notify::Reasoning { text, thread_id: tid } => {
                                            if let Some(t) = tid {
                                                if thread_id.as_deref() != Some(t.as_str()) {
                                                    thread_id = Some(t);
                                                }
                                            }
                                            let _ = event_tx
                                                .send(AcpEvent::ContentBlock {
                                                    block_type: std::borrow::Cow::Borrowed("thinking"),
                                                    text: Some(text),
                                                    name: None,
                                                    input: None,
                                                    streaming: Some(true),
                                                    summary: None,
                                                })
                                                .await;
                                        }
                                        Notify::Error(message) => {
                                            let _ = event_tx
                                                .send(AcpEvent::Error {
                                                    message: format!("Codex: {message}"),
                                                })
                                                .await;
                                        }
                                    }
                                }
                                r = &mut call_fut => break Ok(r),
                            }
                        };

                        match outcome {
                            Ok(Ok(resp)) => {
                                let (tid, content) = parse_codex_tool_result(&resp);
                                if let Some(t) = tid.clone() {
                                    thread_id = Some(t);
                                }
                                // M2 fix: parse_codex_tool_result returns
                                // (None, None) on unexpected response shape.
                                // Emitting an empty Result hides the failure;
                                // surface it as Error instead so the chat
                                // bubble shows red-bordered diagnostic text.
                                if tid.is_none() && content.is_none() {
                                    tracing::warn!(
                                        "codex: tool response had neither \
                                         threadId nor content"
                                    );
                                    let _ = event_tx
                                        .send(AcpEvent::Error {
                                            message: "Codex returned an empty result \
                                                      (unexpected response shape)"
                                                .to_string(),
                                        })
                                        .await;
                                } else {
                                    let _ = event_tx
                                        .send(AcpEvent::Result {
                                            text: content.unwrap_or_default(),
                                            session_id: tid.unwrap_or_default(),
                                            cost_usd: None,
                                        })
                                        .await;
                                }
                            }
                            Ok(Err(e)) => {
                                let msg = format!("{e}");
                                if msg.contains("thread") && msg.contains("not found") {
                                    thread_id = None;
                                }
                                let _ = event_tx
                                    .send(AcpEvent::Error {
                                        message: format!("Codex error: {msg}"),
                                    })
                                    .await;
                            }
                            Err(_cancel_msg) => {
                                // Cancel path: the AcpEvent::Error was
                                // already sent above. thread_id is intentionally
                                // preserved so the next prompt can codex-reply.
                            }
                        }
                    }
                    // H4 fix: split idle Cancel from Stop. An idle Cancel
                    // (no in-flight turn) shouldn't tear down the session —
                    // user almost certainly meant "abort whatever's pending,
                    // I want to type something else." Only Stop / channel
                    // close should end the loop.
                    Some(Cmd::Cancel) => {
                        tracing::debug!("codex: idle cancel — no in-flight turn, ignoring");
                    }
                    Some(Cmd::Stop) | None => {
                        break;
                    }
                }
            }

            // Outer notify_rx arm only fires between turns (the inner select
            // drains during turns). A ProgressText arriving here is stale —
            // likely the tail end of a previous turn's stream landing after
            // we processed its result. Drop it rather than emitting a phantom
            // ContentBlock that would double-render content the user already
            // saw via Result. An Error here is genuinely standalone (e.g.
            // session_configured rejection before any prompt) and must surface.
            Some(notify) = notify_rx.recv() => {
                match notify {
                    Notify::ProgressText { .. } | Notify::Reasoning { .. } => {
                        tracing::debug!("codex: stream chunk between turns (dropped): {:?}", notify);
                    }
                    Notify::Error(message) => {
                        let _ = event_tx
                            .send(AcpEvent::Error {
                                message: format!("Codex: {message}"),
                            })
                            .await;
                    }
                }
            }
        }
    }

    let _ = event_tx.send(AcpEvent::Exit { code: 0 }).await;
}

/// Parse a CallToolResult from `tools/call("codex" | "codex-reply")` into
/// `(threadId, content)`. Returns (None, None) on unexpected shape.
fn parse_codex_tool_result(
    result: &rmcp::model::CallToolResult,
) -> (Option<String>, Option<String>) {
    // Strategy 1: structured_content (preferred when present)
    if let Some(structured) = &result.structured_content {
        let tid = structured
            .get("threadId")
            .and_then(|v| v.as_str())
            .map(String::from);
        let content = structured
            .get("content")
            .and_then(|v| v.as_str())
            .map(String::from);
        if tid.is_some() || content.is_some() {
            return (tid, content);
        }
    }
    // Strategy 2: first text content block contains a JSON-encoded {threadId, content}
    for block in &result.content {
        if let Some(text) = block.as_text() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text.text) {
                let tid = v.get("threadId").and_then(|x| x.as_str()).map(String::from);
                let content = v
                    .get("content")
                    .and_then(|x| x.as_str())
                    .map(String::from);
                if tid.is_some() || content.is_some() {
                    return (tid, content);
                }
            }
        }
    }
    (None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::{Annotated, CallToolResult, CustomNotification, RawContent};
    use serde_json::json;

    fn text_block(s: &str) -> Annotated<RawContent> {
        Annotated::new(RawContent::text(s), None)
    }

    // ---- parse_codex_tool_result ----

    #[test]
    fn parse_result_prefers_structured_content() {
        let mut result = CallToolResult::default();
        result.structured_content = Some(json!({
            "threadId": "t-abc",
            "content": "Hello world",
        }));
        let (tid, content) = parse_codex_tool_result(&result);
        assert_eq!(tid.as_deref(), Some("t-abc"));
        assert_eq!(content.as_deref(), Some("Hello world"));
    }

    #[test]
    fn parse_result_falls_back_to_text_block_json() {
        let mut result = CallToolResult::default();
        result.content = vec![text_block(
            r#"{"threadId":"t-xyz","content":"reply text"}"#,
        )];
        let (tid, content) = parse_codex_tool_result(&result);
        assert_eq!(tid.as_deref(), Some("t-xyz"));
        assert_eq!(content.as_deref(), Some("reply text"));
    }

    #[test]
    fn parse_result_returns_none_for_unparseable_text() {
        let mut result = CallToolResult::default();
        result.content = vec![text_block("plain text not json")];
        let (tid, content) = parse_codex_tool_result(&result);
        assert!(tid.is_none());
        assert!(content.is_none());
    }

    #[test]
    fn parse_result_returns_none_for_empty_result() {
        let result = CallToolResult::default();
        let (tid, content) = parse_codex_tool_result(&result);
        assert!(tid.is_none());
        assert!(content.is_none());
    }

    // ---- extract_codex_event_delta ----

    fn codex_event(msg: serde_json::Value) -> CustomNotification {
        CustomNotification::new("codex/event", Some(json!({ "msg": msg })))
    }

    #[test]
    fn extract_delta_with_thread_id() {
        let n = codex_event(json!({
            "type": "agent_message_content_delta",
            "delta": "hello",
            "thread_id": "t-1",
        }));
        let got = extract_codex_event_delta(&n);
        assert_eq!(got, Some(("hello".to_string(), Some("t-1".to_string()))));
    }

    #[test]
    fn extract_delta_without_thread_id() {
        let n = codex_event(json!({
            "type": "agent_message_content_delta",
            "delta": "world",
        }));
        let got = extract_codex_event_delta(&n);
        assert_eq!(got, Some(("world".to_string(), None)));
    }

    #[test]
    fn extract_delta_ignores_non_codex_event_method() {
        let n = CustomNotification::new(
            "something/else",
            Some(json!({
                "msg": {
                    "type": "agent_message_content_delta",
                    "delta": "x",
                    "thread_id": "t-1",
                }
            })),
        );
        assert!(extract_codex_event_delta(&n).is_none());
    }

    #[test]
    fn extract_delta_ignores_empty_delta() {
        let n = codex_event(json!({
            "type": "agent_message_content_delta",
            "delta": "",
            "thread_id": "t-1",
        }));
        assert!(extract_codex_event_delta(&n).is_none());
    }

    #[test]
    fn extract_delta_ignores_other_msg_type() {
        let n = codex_event(json!({
            "type": "agent_thinking",
            "delta": "hmm",
            "thread_id": "t-1",
        }));
        assert!(extract_codex_event_delta(&n).is_none());
    }

    // ---- extract_codex_event_error ----

    #[test]
    fn extract_error_returns_message() {
        let n = codex_event(json!({
            "type": "error",
            "codex_error_info": "other",
            "message": "Missing environment variable: `LITELLM_API_KEY`.",
        }));
        let got = extract_codex_event_error(&n);
        assert_eq!(
            got.as_deref(),
            Some("Missing environment variable: `LITELLM_API_KEY`.")
        );
    }

    #[test]
    fn extract_error_ignores_non_error_msg_type() {
        let n = codex_event(json!({
            "type": "agent_message_content_delta",
            "delta": "hi",
        }));
        assert!(extract_codex_event_error(&n).is_none());
    }

    #[test]
    fn extract_error_ignores_non_codex_event_method() {
        let n = CustomNotification::new(
            "something/else",
            Some(json!({"msg": {"type": "error", "message": "x"}})),
        );
        assert!(extract_codex_event_error(&n).is_none());
    }

    #[test]
    fn extract_error_ignores_empty_message() {
        let n = codex_event(json!({
            "type": "error",
            "message": "",
        }));
        assert!(extract_codex_event_error(&n).is_none());
    }

    // ---- extract_codex_event_reasoning ----

    #[test]
    fn extract_reasoning_returns_delta_with_thread_id() {
        let n = codex_event(json!({
            "type": "agent_reasoning_delta",
            "delta": "let me think...",
            "thread_id": "t-9",
        }));
        let got = extract_codex_event_reasoning(&n);
        assert_eq!(
            got,
            Some(("let me think...".to_string(), Some("t-9".to_string())))
        );
    }

    #[test]
    fn extract_reasoning_handles_alt_msg_type_and_text_field() {
        // Some Codex versions use `agent_reasoning_content_delta` with `text`
        // instead of `delta`. Our helper accepts both.
        let n = codex_event(json!({
            "type": "agent_reasoning_content_delta",
            "text": "still thinking",
        }));
        let got = extract_codex_event_reasoning(&n);
        assert_eq!(got, Some(("still thinking".to_string(), None)));
    }

    #[test]
    fn extract_reasoning_handles_one_shot_agent_reasoning() {
        // For Bedrock Anthropic, Codex batches reasoning into a single
        // `agent_reasoning` event with the text in `msg.text`. No streaming.
        let n = codex_event(json!({
            "type": "agent_reasoning",
            "text": "The user wants a proof of irrationality.",
            "thread_id": "t-42",
        }));
        let got = extract_codex_event_reasoning(&n);
        assert_eq!(
            got,
            Some((
                "The user wants a proof of irrationality.".to_string(),
                Some("t-42".to_string())
            ))
        );
    }

    #[test]
    fn extract_reasoning_ignores_message_delta() {
        // Make sure reasoning extractor doesn't accidentally match the
        // regular message stream — that would surface the same chunk twice.
        let n = codex_event(json!({
            "type": "agent_message_content_delta",
            "delta": "hello",
        }));
        assert!(extract_codex_event_reasoning(&n).is_none());
    }

    #[test]
    fn extract_reasoning_ignores_empty_text() {
        let n = codex_event(json!({
            "type": "agent_reasoning_delta",
            "delta": "",
        }));
        assert!(extract_codex_event_reasoning(&n).is_none());
    }

    // ---- codex_config_overrides ----

    #[test]
    fn codex_config_overrides_off_yields_empty_object() {
        assert_eq!(codex_config_overrides(None), json!({}));
        assert_eq!(codex_config_overrides(Some("off")), json!({}));
        assert_eq!(codex_config_overrides(Some("")), json!({}));
    }

    #[test]
    fn codex_config_overrides_sets_reasoning_fields() {
        let v = codex_config_overrides(Some("medium"));
        assert_eq!(v["model_reasoning_effort"], "medium");
        assert_eq!(v["model_reasoning_summary"], "auto");
    }
}
