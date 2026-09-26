use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    http::HeaderMap,
    response::Response,
};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::session_manager::SessionInput;
use crate::{auth, AppState};

#[derive(serde::Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(tag = "type")]
enum ClientMsg {
    #[serde(rename = "input")]
    Input { data: String },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    /// Touch-drag scrolling for tmux terminals: drives server-side copy-mode.
    #[serde(rename = "scroll")]
    Scroll { op: String, #[serde(default)] n: u32 },
    /// Desktop mouse/browser toggle for tmux terminals: session-level `mouse` option.
    #[serde(rename = "mouse")]
    Mouse { on: bool },
    /// While reading tmux copy-mode, ask the server to diff `history_size` every
    /// 1s and push `scroll_state.new_lines` — the frozen pane can't show new
    /// output any other way.
    #[serde(rename = "scroll_watch")]
    ScrollWatch { on: bool },
}

pub async fn ws_terminal(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    // `?token=` first (CSRF-safe), then the HttpOnly `zeromux_jwt` cookie the browser
    // attaches to the upgrade — needed in OAuth mode where JS can't read that cookie
    // into the query param (F-WS-OAUTH-COOKIE). Cookie path is Origin-gated (CSWSH).
    let user = match auth::verify_ws_auth(&state, query.token.as_deref(), &headers) {
        Some(u) => u,
        None => {
            return Response::builder()
                .status(401)
                .body(axum::body::Body::from("Unauthorized"))
                .unwrap();
        }
    };

    // Authorization: only the session owner (or an admin) may attach. Without
    // this any authenticated user could read/drive — and now respawn — another
    // user's session by guessing its id.
    if !user.is_admin() && !state.sessions.is_owner(&session_id, &user.id) {
        return Response::builder()
            .status(403)
            .body(axum::body::Body::from("Forbidden"))
            .unwrap();
    }

    ws.on_upgrade(move |socket| handle_ws(socket, session_id, state))
}

async fn handle_ws(socket: WebSocket, session_id: String, state: Arc<AppState>) {
    use crate::session_manager::Preflight;
    let notice = |kind: &str| serde_json::json!({"type": "notice", "kind": kind}).to_string();
    // Decide BEFORE ensure_running spawns anything: an Ended/unreachable tmux
    // terminal must never be (re)created behind the user's back.
    let pre = state.sessions.tmux_preflight(&session_id).await;
    let mut socket = socket;
    if matches!(pre, Preflight::Ended | Preflight::ServerDown) {
        let kind = if matches!(pre, Preflight::Ended) { "tmux_ended" } else { "tmux_down" };
        let _ = socket.send(Message::Text(notice(kind).into())).await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    }
    // Respawn the session if it's not running (e.g. after a server restart).
    if let Err(e) = state.sessions.ensure_running(&session_id).await {
        tracing::error!("ensure_running failed for {}: {}", session_id, e);
        return;
    }
    // Atomically snapshot scrollback AND subscribe under ONE lock. Since 19ab52b
    // made the PTY fan-out the sole scrollback writer via `record_and_broadcast`
    // (persist-before-broadcast under the sessions mutex), the old two-step
    // `subscribe()` then `get_scrollback()` reopened the reconnect double-delivery
    // race for terminals: a frame emitted between the two lock acquisitions landed
    // in BOTH the replay snapshot and the live receiver → duplicated xterm bytes on
    // reconnect-mid-stream. `subscribe_with_history` takes both under one lock, so
    // every frame falls on exactly one side of the boundary — mirror the ACP handler
    // (review 2026-06-11 / 2026-07-21).
    let (scrollback, mut event_rx) = match state.sessions.subscribe_with_history(&session_id) {
        Some(pair) => pair,
        None => {
            tracing::error!("Session {} not found", session_id);
            return;
        }
    };
    // tmux terminals have no byte replay; ask tmux to repaint this client's
    // screen now that we're subscribed.
    if state.sessions.tmux_binding(&session_id).is_some() {
        if let Some(pid) = state.sessions.pty_pid(&session_id) {
            let tmux = state.tmux.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                let _ = tmux.refresh_client_for_pid(pid).await;
            });
        }
    }
    let input_tx = match state.sessions.input_tx(&session_id) {
        Some(tx) => tx,
        None => return,
    };

    let (mut ws_sink, mut ws_stream) = socket.split();
    let logger = state.logger.clone();
    if matches!(pre, Preflight::Lost) {
        let _ = ws_sink.send(Message::Text(notice("tmux_lost").into())).await;
    }

    // Replay scrollback history first (snapshot taken above, atomically with the
    // subscribe, so no frame is both replayed and delivered live).
    for b64 in scrollback {
        let msg = serde_json::json!({"type": "output", "data": b64});
        if ws_sink
            .send(Message::Text(msg.to_string().into()))
            .await
            .is_err()
        {
            return;
        }
    }

    // Periodic ping keeps the connection alive through idle-timeout proxies
    // (e.g. nginx proxy_read_timeout, Cloudflare ~100s) that would otherwise
    // drop a quiet WebSocket and leave the client unable to send.
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(30));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Polls `history_size` every 1s while the client is reading copy-mode, so
    // the "↓ N new lines" indicator can tell the user output is piling up
    // behind the frozen pane. Only armed while `watch_baseline` is Some.
    let mut watch = tokio::time::interval(std::time::Duration::from_secs(1));
    watch.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut watch_baseline: Option<u64> = None;

    // Subscribe loop: receive broadcast events + forward client input
    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if ws_sink.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
            _ = watch.tick(), if watch_baseline.is_some() => {
                if let (Some(base), Some((name, _))) = (watch_baseline, state.sessions.tmux_binding(&session_id)) {
                    if let Ok(i) = state.tmux.info(&name).await {
                        // Reading a fullscreen app via wheel events (AppWheel): there is no
                        // copy-mode to report and history doesn't grow — stay silent so the
                        // client's pill isn't cleared by `in_mode: false`.
                        if crate::tmux::scroll_route(i.in_mode, i.alternate_on, i.mouse_any, i.mouse_sgr) == crate::tmux::ScrollRoute::AppWheel {
                            continue;
                        }
                        // Alt-screen output never lands in history → new_lines is meaningless.
                        let new_lines = if i.alternate_on { 0 } else { crate::scroll_watch::new_lines(base, i.history_size) };
                        let m = serde_json::json!({"type": "scroll_state", "in_mode": i.in_mode,
                            "history_size": i.history_size, "new_lines": new_lines});
                        if !i.in_mode { watch_baseline = None; }   // left copy-mode (maybe from VSCode)
                        if ws_sink.send(Message::Text(m.to_string().into())).await.is_err() { break; }
                    }
                }
            }
            result = event_rx.recv() => {
                match result {
                    Ok(b64) => {
                        // Log output
                        if let Some(ref log) = logger {
                            log.log_pty_output(&session_id, &b64);
                        }

                        // NOTE: scrollback is written ONCE by the PTY fan-out task
                        // (session_manager::record_and_broadcast), NOT here — mirror
                        // the ACP handler. Writing per connection duplicated scrollback
                        // under multi-client and lost output entirely with zero clients.
                        let msg = serde_json::json!({"type": "output", "data": b64});
                        if ws_sink
                            .send(Message::Text(msg.to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("PTY WS client lagged by {} messages for session {}", n, session_id);
                        // Continue — client will miss some output but can still operate
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }

            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(client_msg) = serde_json::from_str::<ClientMsg>(&text) {
                            match client_msg {
                                ClientMsg::Input { data } => {
                                    if let Some(ref log) = logger {
                                        log.log_pty_input(&session_id, &data);
                                    }
                                    if let Ok(bytes) = base64::Engine::decode(
                                        &base64::engine::general_purpose::STANDARD,
                                        &data,
                                    ) {
                                        let _ = input_tx.send(SessionInput::PtyData(bytes)).await;
                                    }
                                }
                                ClientMsg::Resize { cols, rows } => {
                                    state.sessions.set_size(&session_id, cols, rows);
                                    let _ = input_tx.send(SessionInput::PtyResize(cols, rows)).await;
                                }
                                ClientMsg::Scroll { op, n } => {
                                    // Awaited inline: up to 3 tmux calls (info, op, info), each 3s-bounded → ≤9s.
                                    if let (Some((name, _)), Some(op)) =
                                        (state.sessions.tmux_binding(&session_id), crate::tmux::ScrollOp::parse(&op, n))
                                    {
                                        if let Ok((info, route)) = state.tmux.scroll(&name, op).await {
                                            let m = serde_json::json!({"type": "scroll_state", "in_mode": info.in_mode, "history_size": info.history_size,
                                                "app_scroll": route == crate::tmux::ScrollRoute::AppWheel});
                                            if ws_sink.send(Message::Text(m.to_string().into())).await.is_err() { break; }
                                        }
                                    }
                                }
                                ClientMsg::Mouse { on } => {
                                    if let Some((name, _)) = state.sessions.tmux_binding(&session_id) {
                                        let _ = state.tmux.set_mouse(&name, on).await;
                                    }
                                }
                                ClientMsg::ScrollWatch { on } => {
                                    watch_baseline = None;
                                    if on {
                                        if let Some((name, _)) = state.sessions.tmux_binding(&session_id) {
                                            watch_baseline = state.tmux.info(&name).await.ok().map(|i| i.history_size);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        let _ = input_tx.send(SessionInput::PtyData(data.to_vec())).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    tracing::info!("WebSocket disconnected for session {}", session_id);
}
