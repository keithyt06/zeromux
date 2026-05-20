#![allow(dead_code)]

use crate::acp::process::AcpEvent;
use rmcp::ErrorData as McpError;
use rmcp::model::{
    CreateElicitationRequestParams, CreateElicitationResult, CustomNotification,
    ElicitationAction, ProgressNotificationParam,
};
use rmcp::service::{NotificationContext, RequestContext, RoleClient, RunningService};
use rmcp::transport::child_process::TokioChildProcess;
use rmcp::{ClientHandler, ServiceExt};
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::mpsc;

/// Channel command from the outer fan-out loop into the rmcp event loop.
enum Cmd {
    Prompt(String),
    Cancel,
    Stop,
}

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
}

#[derive(Clone)]
struct Handler {
    notify_tx: mpsc::Sender<Notify>,
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
                let _ = tx
                    .send(Notify::ProgressText { text, thread_id: None })
                    .await;
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
            if let Some((text, thread_id)) = extract_codex_event_delta(&notification) {
                let _ = tx.send(Notify::ProgressText { text, thread_id }).await;
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

pub struct CodexProcess {
    cmd_tx: mpsc::Sender<Cmd>,
    pub event_rx: mpsc::Receiver<AcpEvent>,
    _service_drop_guard: Arc<()>,
}

impl CodexProcess {
    pub async fn spawn(
        codex_path: &str,
        work_dir: &str,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let mut cmd = Command::new(codex_path);
        cmd.arg("mcp-server");
        cmd.current_dir(work_dir);

        let transport = TokioChildProcess::new(cmd)
            .map_err(|e| format!("spawn codex: {e}"))?;

        let (notify_tx, notify_rx) = mpsc::channel::<Notify>(64);
        let handler = Handler { notify_tx };

        let service: RunningService<RoleClient, Handler> = handler
            .serve(transport)
            .await
            .map_err(|e| format!("rmcp serve: {e}"))?;

        let (event_tx, event_rx) = mpsc::channel::<AcpEvent>(256);
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>(16);

        let _ = event_tx
            .send(AcpEvent::System {
                subtype: "init".to_string(),
                session_id: None,
            })
            .await;

        let work_dir_owned = work_dir.to_string();
        let drop_guard = Arc::new(());
        let drop_guard_for_loop = drop_guard.clone();
        let event_tx_for_panic = event_tx.clone();
        tokio::spawn(async move {
            let result = futures::FutureExt::catch_unwind(
                std::panic::AssertUnwindSafe(run_event_loop(
                    service,
                    cmd_rx,
                    notify_rx,
                    event_tx,
                    work_dir_owned,
                    drop_guard_for_loop,
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

        Ok(Self {
            cmd_tx,
            event_rx,
            _service_drop_guard: drop_guard,
        })
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
        let tx = self.cmd_tx.clone();
        tokio::spawn(async move {
            let _ = tx.send(Cmd::Stop).await;
        });
    }
}

async fn run_event_loop(
    service: RunningService<RoleClient, Handler>,
    mut cmd_rx: mpsc::Receiver<Cmd>,
    mut notify_rx: mpsc::Receiver<Notify>,
    event_tx: mpsc::Sender<AcpEvent>,
    work_dir: String,
    _drop_guard: Arc<()>,
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
                                            tracing::info!(
                                                "codex: cancelling in-flight call_tool"
                                            );
                                            drop(call_fut);
                                            let _ = event_tx
                                                .send(AcpEvent::Error {
                                                    message: "已取消".to_string(),
                                                })
                                                .await;
                                            break Err("cancelled by user".to_string());
                                        }
                                        Some(Cmd::Stop) | None => {
                                            drop(call_fut);
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
                                                    block_type: "text".to_string(),
                                                    text: Some(text),
                                                    name: None,
                                                    input: None,
                                                    streaming: Some(true),
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
                                let _ = event_tx
                                    .send(AcpEvent::Result {
                                        text: content.unwrap_or_default(),
                                        session_id: tid.unwrap_or_default(),
                                        cost_usd: None,
                                    })
                                    .await;
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
                                // Cancel path: the AcpEvent::Error{"已取消"} was
                                // already sent above. thread_id is intentionally
                                // preserved so the next prompt can codex-reply.
                            }
                        }
                    }
                    Some(Cmd::Cancel) | Some(Cmd::Stop) | None => {
                        break;
                    }
                }
            }

            // Outer notify_rx arm only fires between turns (the inner select
            // drains during turns). A chunk arriving here is stale — likely the
            // tail end of a previous turn's stream landing after we processed
            // its result. Drop it rather than emitting a phantom ContentBlock
            // that would double-render content the user already saw via Result.
            Some(notify) = notify_rx.recv() => {
                tracing::debug!("codex: progress between turns (dropped): {:?}", notify);
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
