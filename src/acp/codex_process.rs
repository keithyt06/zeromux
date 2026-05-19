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
    mut _cmd_rx: mpsc::Receiver<Cmd>,
    mut _notify_rx: mpsc::Receiver<Notify>,
    event_tx: mpsc::Sender<AcpEvent>,
    _work_dir: String,
    _drop_guard: Arc<()>,
) {
    // PLACEHOLDER: handshake-only behaviour. Holding `service` keeps the child
    // process alive. Task 7 replaces this with the real prompt/response loop.
    let _ = service.waiting().await;
    let _ = event_tx.send(AcpEvent::Exit { code: 0 }).await;
}
