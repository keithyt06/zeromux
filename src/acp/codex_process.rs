#![allow(dead_code)]

use crate::acp::process::AcpEvent;
use rmcp::ErrorData as McpError;
use rmcp::model::{
    CreateElicitationRequestParams, CreateElicitationResult, ElicitationAction,
    ProgressNotificationParam,
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
    ProgressText(String),
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
                let _ = tx.send(Notify::ProgressText(text)).await;
            } else {
                tracing::debug!("codex: progress without text: {:?}", params);
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
        tokio::spawn(run_event_loop(
            service,
            cmd_rx,
            notify_rx,
            event_tx,
            work_dir_owned,
            drop_guard.clone(),
        ));

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

                        let mut params = CallToolRequestParams::new(tool_name);
                        if let Some(obj) = args.as_object().cloned() {
                            params = params.with_arguments(obj);
                        }

                        let result = service.peer().call_tool(params).await;

                        match result {
                            Ok(resp) => {
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
                            Err(e) => {
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
                        }
                    }
                    Some(Cmd::Cancel) | Some(Cmd::Stop) | None => {
                        break;
                    }
                }
            }

            // Drain progress notifications while idle. Task 8 wires them into AcpEvent.
            Some(_n) = notify_rx.recv() => {
                // intentionally dropped in Task 7
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
