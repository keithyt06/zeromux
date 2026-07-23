use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::mpsc;

use super::process::AcpEvent;

// ── JSON-RPC 2.0 message classification ──
//
// Kiro communicates over stdin/stdout using JSON-RPC 2.0.
// A single message can be a request, response, or notification depending
// on which fields are present. We classify on parse rather than using
// accessor methods.

/// Classified JSON-RPC 2.0 message.
enum RpcFrame {
    /// Server → client request (has id + method). Needs a response.
    Request {
        id: serde_json::Value,
        method: String,
        #[allow(dead_code)]
        params: Option<serde_json::Value>,
    },
    /// Response to a previous client → server request (has id, no method).
    Response {
        result: Option<serde_json::Value>,
        error: Option<(i64, String)>,
    },
    /// Server → client notification (no id, has method).
    Notification {
        method: String,
        params: Option<serde_json::Value>,
    },
    /// Unclassifiable — ignore.
    Unknown,
}

fn classify(val: &serde_json::Value) -> RpcFrame {
    let id = val.get("id");
    let method = val.get("method").and_then(|m| m.as_str());

    match (id, method) {
        (Some(id), Some(method)) => RpcFrame::Request {
            id: id.clone(),
            method: method.to_string(),
            params: val.get("params").cloned(),
        },
        (Some(_), None) => {
            if let Some(err) = val.get("error") {
                let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
                let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string();
                RpcFrame::Response { result: None, error: Some((code, msg)) }
            } else {
                RpcFrame::Response { result: val.get("result").cloned(), error: None }
            }
        }
        (None, Some(method)) => RpcFrame::Notification {
            method: method.to_string(),
            params: val.get("params").cloned(),
        },
        _ => RpcFrame::Unknown,
    }
}

// ── Prompt command channel ──

enum Cmd {
    Prompt(String),
    Cancel,
    Stop,
}

// ── KiroProcess ──

pub struct KiroProcess {
    child: Child,
    cmd_tx: mpsc::Sender<Cmd>,
    pub event_rx: mpsc::Receiver<AcpEvent>,
}

impl KiroProcess {
    /// Spawn `kiro acp --trust-all-tools` and perform the ACP initialization handshake.
    ///
    /// The Agent Client Protocol uses JSON-RPC 2.0 over stdio. Initialization is:
    ///   1. Client sends `initialize` with capabilities
    ///   2. Server responds with capabilities
    ///   3. Client sends `session/new` (fresh) or `session/load` (resume) with cwd
    ///   4. Server responds with sessionId
    ///
    /// `resume: Some(sid)` issues `session/load` to restore prior context. If the
    /// old process is still alive Kiro rejects with `-32603 "Session is active in
    /// another process"`, which surfaces as `Err` from `drain_until_response` →
    /// the caller falls back to a fresh session (never retried here).
    pub async fn spawn(
        kiro_path: &str,
        work_dir: &str,
        resume: Option<&str>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let mut child = tokio::process::Command::new(kiro_path)
            .args(["acp", "--trust-all-tools"])
            .current_dir(work_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;

        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let reader = BufReader::with_capacity(256 * 1024, stdout);
        let mut lines = reader.lines();

        // ── Handshake step 1: initialize ──
        write_rpc(&mut stdin, 0, "initialize", serde_json::json!({
            "protocolVersion": 1,
            "clientCapabilities": {
                "fs": { "readTextFile": true, "writeTextFile": true },
                "terminal": true
            },
            "clientInfo": { "name": "zeromux", "version": "0.1.0" }
        }))
        .await?;

        drain_handshake_response(&mut lines).await?;

        // ── Handshake step 2: session/new (fresh) or session/load (resume) ──
        let cwd = if work_dir == "." {
            std::env::current_dir()?.to_string_lossy().to_string()
        } else {
            work_dir.to_string()
        };

        let (method, params, sid_known): (&str, serde_json::Value, Option<String>) = match resume {
            Some(sid) => (
                "session/load",
                serde_json::json!({ "sessionId": sid, "cwd": cwd, "mcpServers": [] }),
                Some(sid.to_string()),
            ),
            None => (
                "session/new",
                serde_json::json!({ "cwd": cwd, "mcpServers": [] }),
                None,
            ),
        };

        write_rpc(&mut stdin, 1, method, params).await?;

        let resp = drain_handshake_response(&mut lines).await?;
        let session_id = match sid_known {
            Some(s) => s, // session/load: reuse the id we loaded
            None => resp
                .and_then(|r| r.get("sessionId").and_then(|v| v.as_str().map(String::from)))
                .unwrap_or_else(|| "unknown".to_string()),
        };

        // ── Wire up channels and spawn event loop ──
        let (event_tx, event_rx) = mpsc::channel::<AcpEvent>(256);
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>(16);

        let _ = event_tx
            .send(AcpEvent::System {
                subtype: std::borrow::Cow::Borrowed("init"),
                session_id: Some(session_id.clone()),
                count: None,
            })
            .await;

        tokio::spawn(run_event_loop(lines, stdin, event_tx, cmd_rx, session_id));

        Ok(Self { child, cmd_tx, event_rx })
    }

    pub async fn send_prompt(&mut self, text: &str) -> Result<(), std::io::Error> {
        self.cmd_tx
            .send(Cmd::Prompt(text.to_string()))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "kiro process exited"))
    }

    pub async fn interrupt(&mut self) -> Result<(), std::io::Error> {
        self.cmd_tx.send(Cmd::Cancel).await.map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "kiro event loop exited")
        })
    }

    pub async fn kill(&mut self) {
        let _ = self.cmd_tx.send(Cmd::Stop).await;
        let _ = self.child.kill().await;
    }
}

impl Drop for KiroProcess {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

// ── Helpers ──

async fn write_rpc(
    stdin: &mut ChildStdin,
    id: i64,
    method: &str,
    params: serde_json::Value,
) -> Result<(), std::io::Error> {
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    let mut buf = serde_json::to_string(&req).unwrap();
    buf.push('\n');
    stdin.write_all(buf.as_bytes()).await?;
    stdin.flush().await
}

async fn write_response(
    stdin: &mut ChildStdin,
    id: &serde_json::Value,
    result: serde_json::Value,
) -> Result<(), std::io::Error> {
    let resp = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    });
    let mut buf = serde_json::to_string(&resp).unwrap();
    buf.push('\n');
    stdin.write_all(buf.as_bytes()).await?;
    stdin.flush().await
}

/// Upper bound on how long a single handshake step (`initialize`, `session/new`,
/// `session/load`) may block waiting for the Kiro CLI's JSON-RPC response. Without
/// it, a CLI that spawns but never answers (wedged subprocess, stuck on a prompt,
/// stalled network) leaves `drain_until_response` awaiting `next_line()` FOREVER —
/// and since stderr is `Stdio::null()` there is no diagnostic. The whole
/// create-session await then hangs with no session ever appearing and no recovery.
/// A timeout turns that into an ordinary spawn Err, which `spawn_kiro`'s
/// `map_err("Failed to spawn Kiro: ...")` surfaces to the user like any other
/// launch failure. 30s is generous for a local handshake yet bounds the hang.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Bound any handshake-step future; a timeout is a fatal handshake error. Generic
/// over the future, and the bound is a parameter, so the timeout policy is
/// unit-testable with a tiny real duration and no live subprocess / test-util clock.
async fn with_handshake_timeout<T, F>(
    dur: std::time::Duration,
    fut: F,
) -> Result<T, Box<dyn std::error::Error + Send + Sync>>
where
    F: std::future::Future<Output = Result<T, Box<dyn std::error::Error + Send + Sync>>>,
{
    match tokio::time::timeout(dur, fut).await {
        Ok(r) => r,
        Err(_) => Err("kiro handshake timed out (no response)".into()),
    }
}

/// Await one handshake response with a bound; a timeout is a fatal handshake error.
async fn drain_handshake_response(
    lines: &mut tokio::io::Lines<BufReader<ChildStdout>>,
) -> Result<Option<serde_json::Value>, Box<dyn std::error::Error + Send + Sync>> {
    with_handshake_timeout(HANDSHAKE_TIMEOUT, drain_until_response(lines)).await
}

/// Read lines until we get a JSON-RPC response, skipping notifications.
async fn drain_until_response(
    lines: &mut tokio::io::Lines<BufReader<ChildStdout>>,
) -> Result<Option<serde_json::Value>, Box<dyn std::error::Error + Send + Sync>> {
    loop {
        let raw = lines
            .next_line()
            .await?
            .ok_or("kiro closed during handshake")?;
        if raw.trim().is_empty() {
            continue;
        }
        let val: serde_json::Value = serde_json::from_str(&raw)?;
        match classify(&val) {
            RpcFrame::Response { result, error: Some((code, msg)) } => {
                drop(result);
                return Err(format!("RPC error {code}: {msg}").into());
            }
            RpcFrame::Response { result, .. } => return Ok(result),
            _ => continue, // skip notifications during handshake
        }
    }
}

// ── Event loop ──

async fn run_event_loop(
    mut lines: tokio::io::Lines<BufReader<ChildStdout>>,
    mut stdin: ChildStdin,
    tx: mpsc::Sender<AcpEvent>,
    mut cmd_rx: mpsc::Receiver<Cmd>,
    session_id: String,
) {
    let mut rpc_id: i64 = 2;
    let mut pending_text = String::new();

    loop {
        tokio::select! {
            line_result = lines.next_line() => {
                match line_result {
                    Ok(Some(line)) if !line.trim().is_empty() => {
                        let val: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::debug!("kiro: bad line: {e} — {}", line.chars().take(200).collect::<String>());
                                continue;
                            }
                        };
                        let events = dispatch_frame(
                            classify(&val),
                            &mut pending_text,
                            &session_id,
                            &mut stdin,
                        ).await;
                        for evt in events {
                            if tx.send(evt).await.is_err() { return; }
                        }
                    }
                    Ok(Some(_)) => continue,
                    _ => {
                        let _ = tx.send(AcpEvent::Exit { code: 0 }).await;
                        return;
                    }
                }
            }

            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(Cmd::Prompt(text)) => {
                        pending_text.clear();
                        let req = serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": rpc_id,
                            "method": "session/prompt",
                            "params": {
                                "sessionId": session_id,
                                "prompt": [{ "type": "text", "text": text }]
                            }
                        });
                        rpc_id += 1;
                        let mut buf = serde_json::to_string(&req).unwrap();
                        buf.push('\n');
                        if stdin.write_all(buf.as_bytes()).await.is_err() { return; }
                        let _ = stdin.flush().await;
                    }
                    Some(Cmd::Cancel) => {
                        // ACP session/cancel is a notification (no id). Verified:
                        // aborts the in-flight session/prompt turn, process lives.
                        let req = serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": "session/cancel",
                            "params": { "sessionId": session_id }
                        });
                        let mut buf = serde_json::to_string(&req).unwrap();
                        buf.push('\n');
                        if stdin.write_all(buf.as_bytes()).await.is_err() { return; }
                        let _ = stdin.flush().await;
                    }
                    Some(Cmd::Stop) | None => return,
                }
            }
        }
    }
}

/// Map a `session/prompt` response `stopReason` (+ the turn's accumulated text) to
/// the browser event(s) that end the turn. Pure, so the af1e5c0 classification is
/// unit-testable without a live JSON-RPC channel.
///
/// - `refusal` / `max_tokens` / `max_turn_requests` → Error (so a refused / capped
///   turn is NOT reported as a clean success — the 323e8bc parity fix). The message
///   carries ONLY the reason: the turn body already streamed live via
///   `agent_message_chunk` ContentBlocks, so inlining `text` again duplicated the
///   whole reply under a red banner.
/// - `cancelled` and `end_turn` (and any absent/unknown value) → a normal Result
///   carrying the text. `cancelled` is the user's own interrupt, not a failure, so
///   routing it to Error would spuriously finalize a scheduled run as failed.
fn stop_reason_events(stop: &str, text: String, session_id: &str) -> Vec<AcpEvent> {
    match stop {
        "refusal" | "max_tokens" | "max_turn_requests" => vec![AcpEvent::Error {
            message: format!("Kiro turn ended: {stop}"),
        }],
        _ => vec![AcpEvent::Result {
            text,
            turn_id: 0,
            session_id: session_id.to_string(),
            cost_usd: None,
            tokens_in: None,
            tokens_out: None,
        }],
    }
}

/// Process a single classified JSON-RPC frame and return zero or more browser events.
async fn dispatch_frame(
    frame: RpcFrame,
    pending_text: &mut String,
    session_id: &str,
    stdin: &mut ChildStdin,
) -> Vec<AcpEvent> {
    match frame {
        // Turn-complete response from session/prompt
        RpcFrame::Response { error: Some((code, msg)), .. } => {
            vec![AcpEvent::Error { message: format!("RPC error {code}: {msg}") }]
        }
        RpcFrame::Response { result, .. } => {
            // The ACP `session/prompt` response carries a `stopReason` even on a
            // NON-error turn end. `refusal` / `max_tokens` / `max_turn_requests`
            // arrive here (JSON-RPC result, no `error` object), so emitting an
            // unconditional Result rendered a refused or token/turn-capped turn as a
            // clean success — blank bubble interactively, and finalize_run(succeeded)
            // + RunOutcome::Completed for scheduled runs. This is the same class the
            // Claude backend fixed in 323e8bc (is_error result → Error); Kiro was
            // never given parity. Route the non-normal stops to Error. `cancelled`
            // stays a Result: it's the user's own interrupt/cancel, not a failure,
            // and routing it to Error would spuriously finalize a scheduled run as
            // failed. Absent/`end_turn` → normal Result.
            let stop = result
                .as_ref()
                .and_then(|r| r.get("stopReason"))
                .and_then(|v| v.as_str())
                .unwrap_or("end_turn");
            // take() clears pending_text for the NEXT turn regardless of arm.
            let text = std::mem::take(pending_text);
            stop_reason_events(stop, text, session_id)
        }

        // Permission request — auto-approve so the agent can run unattended
        RpcFrame::Request { id, method, .. } if method == "session/request_permission" => {
            let _ = write_response(stdin, &id, serde_json::json!({
                "outcome": { "outcome": "selected", "optionId": "allow-once" }
            }))
            .await;
            vec![]
        }

        // Other server requests — acknowledge with empty result
        RpcFrame::Request { id, .. } => {
            let _ = write_response(stdin, &id, serde_json::json!({})).await;
            vec![]
        }

        // session/update notifications carry streaming content
        RpcFrame::Notification { method, params } if method == "session/update" => {
            parse_session_update(params.as_ref(), pending_text)
        }

        _ => vec![],
    }
}

/// Extract browser events from a `session/update` notification.
fn parse_session_update(
    params: Option<&serde_json::Value>,
    pending_text: &mut String,
) -> Vec<AcpEvent> {
    let Some(params) = params else { return vec![] };
    let update = params.get("update");
    let Some(update) = update else { return vec![] };
    let kind = update.get("sessionUpdate").and_then(|v| v.as_str()).unwrap_or("");

    match kind {
        "agent_message_chunk" => {
            let text = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str());
            if let Some(text) = text {
                pending_text.push_str(text);
                vec![AcpEvent::ContentBlock {
                    block_type: std::borrow::Cow::Borrowed("text"),
                    turn_id: 0,
                    text: Some(text.to_string()),
                    name: None,
                    input: None,
                    streaming: Some(true),
                    summary: None,
                }]
            } else {
                vec![]
            }
        }
        "agent_thought_chunk" => {
            // ACP standard: thinking/reasoning trace, separate from the main
            // message stream. Surface as block_type="thinking" so the frontend
            // can render it collapsed/dimmed and the chunks don't pollute the
            // main reply text or get accumulated into pending_text.
            let text = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str());
            if let Some(text) = text {
                vec![AcpEvent::ContentBlock {
                    block_type: std::borrow::Cow::Borrowed("thinking"),
                    turn_id: 0,
                    text: Some(text.to_string()),
                    name: None,
                    input: None,
                    streaming: Some(true),
                    summary: None,
                }]
            } else {
                vec![]
            }
        }
        "tool_call" => {
            let title = update
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("tool")
                .to_string();
            vec![AcpEvent::ContentBlock {
                block_type: std::borrow::Cow::Borrowed("tool_use"),
                turn_id: 0,
                text: None,
                name: Some(title),
                input: None,
                streaming: None,
                summary: None,
            }]
        }
        "tool_call_update" => vec![],
        _ => {
            tracing::debug!("kiro: unhandled session update kind: {kind}");
            vec![]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn handshake_timeout_turns_a_silent_hang_into_an_error() {
        // A Kiro CLI that spawns but never answers the handshake would otherwise
        // leave drain_until_response awaiting next_line() forever. with_handshake_timeout
        // must convert that into an Err after the bound so spawn_kiro can surface it
        // as a normal launch failure. A never-completing future + a tiny real bound.
        let never = std::future::pending::<
            Result<Option<serde_json::Value>, Box<dyn std::error::Error + Send + Sync>>,
        >();
        let res = with_handshake_timeout(std::time::Duration::from_millis(10), never).await;
        assert!(res.is_err(), "a hung handshake step must time out to an Err");
        assert!(
            res.unwrap_err().to_string().contains("timed out"),
            "the error must identify the handshake timeout"
        );
    }

    #[test]
    fn stop_reason_refusal_and_caps_error_without_duplicating_streamed_body() {
        // af1e5c0: refusal / token / turn caps must NOT read as a clean success.
        for stop in ["refusal", "max_tokens", "max_turn_requests"] {
            let ev = stop_reason_events(stop, "STREAMED BODY".to_string(), "s1");
            assert_eq!(ev.len(), 1);
            match &ev[0] {
                AcpEvent::Error { message } => {
                    assert!(message.contains(stop), "reason named: {message}");
                    // The body already streamed live; it must NOT be inlined again.
                    assert!(
                        !message.contains("STREAMED BODY"),
                        "error bubble must not duplicate the streamed turn body: {message}"
                    );
                }
                other => panic!("expected Error for {stop}, got {other:?}"),
            }
        }
    }

    #[test]
    fn stop_reason_end_turn_and_cancelled_are_results_with_text() {
        // end_turn / cancelled / absent → normal Result carrying the reply text.
        for stop in ["end_turn", "cancelled", "somethingelse"] {
            let ev = stop_reason_events(stop, "hello".to_string(), "s1");
            assert_eq!(ev.len(), 1);
            match &ev[0] {
                AcpEvent::Result { text, session_id, .. } => {
                    assert_eq!(text, "hello");
                    assert_eq!(session_id, "s1");
                }
                other => panic!("expected Result for {stop}, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn handshake_timeout_passes_through_a_prompt_response() {
        // The happy path must be untouched: a future that resolves before the
        // (generous) bound returns its value verbatim.
        let ok = async {
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(Some(serde_json::json!({
                "sessionId": "s-1"
            })))
        };
        let res = with_handshake_timeout(std::time::Duration::from_secs(30), ok).await.unwrap();
        assert_eq!(
            res.and_then(|v| v.get("sessionId").and_then(|s| s.as_str().map(String::from))),
            Some("s-1".to_string())
        );
    }
}
