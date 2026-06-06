use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
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
    #[serde(rename = "prompt")]
    Prompt { text: String },
    #[serde(rename = "cancel")]
    Cancel,
    #[serde(rename = "interrupt")]
    Interrupt,
}

pub async fn ws_acp(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    Query(query): Query<WsQuery>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let user = match query.token.as_ref().and_then(|t| auth::verify_ws_token(&state, t)) {
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
    // user's agent session by guessing its id.
    if !user.is_admin() && !state.sessions.is_owner(&session_id, &user.id) {
        return Response::builder()
            .status(403)
            .body(axum::body::Body::from("Forbidden"))
            .unwrap();
    }

    ws.on_upgrade(move |socket| handle_acp_ws(socket, session_id, state))
}

async fn handle_acp_ws(socket: WebSocket, session_id: String, state: Arc<AppState>) {
    // Respawn the session if it's not running (e.g. after a server restart).
    if let Err(e) = state.sessions.ensure_running(&session_id).await {
        tracing::error!("ensure_running failed for {}: {}", session_id, e);
        return;
    }
    // Subscribe to broadcast (multi-client safe — no take/return)
    let mut event_rx = match state.sessions.subscribe(&session_id) {
        Some(rx) => rx,
        None => {
            tracing::error!("ACP session {} not found", session_id);
            return;
        }
    };
    let input_tx = match state.sessions.input_tx(&session_id) {
        Some(tx) => tx,
        None => return,
    };

    let (mut ws_sink, mut ws_stream) = socket.split();

    // Send connected message
    let init_msg = serde_json::json!({"type": "system", "message": "connected"});
    let _ = ws_sink
        .send(Message::Text(init_msg.to_string().into()))
        .await;

    // Replay event history for reconnecting clients
    let history = state.sessions.get_scrollback(&session_id);
    let has_history = !history.is_empty();
    for json in history {
        if ws_sink
            .send(Message::Text(json.into()))
            .await
            .is_err()
        {
            return;
        }
    }
    // Signal that replay is done so the frontend can reset busy state
    if has_history {
        let done_msg = serde_json::json!({"type": "replay_done"});
        let _ = ws_sink.send(Message::Text(done_msg.to_string().into())).await;
    }

    let logger = state.logger.clone();

    // Periodic ping keeps the connection alive through idle-timeout proxies
    // (e.g. nginx proxy_read_timeout, Cloudflare ~100s) that would otherwise
    // drop a quiet WebSocket and leave the client unable to send.
    let mut keepalive = tokio::time::interval(std::time::Duration::from_secs(30));
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Subscribe loop: receive broadcast events + forward client input
    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if ws_sink.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
            result = event_rx.recv() => {
                match result {
                    Ok(json) => {
                        // Log ACP event
                        if let Some(ref log) = logger {
                            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json) {
                                log.log_acp_event(&session_id, &val);
                            }
                        }

                        // Push to scrollback buffer
                        state.sessions.push_scrollback(&session_id, json.clone());

                        if ws_sink.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("ACP WS client lagged by {} messages for session {}", n, session_id);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }

            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(client_msg) = serde_json::from_str::<ClientMsg>(&text) {
                            match client_msg {
                                ClientMsg::Prompt { text } => {
                                    if let Some(ref log) = logger {
                                        log.log_acp_input(&session_id, &text);
                                    }
                                    let _ = input_tx.send(SessionInput::Prompt { text, run_id: None }).await;
                                }
                                ClientMsg::Cancel => {
                                    let _ = input_tx.send(SessionInput::Cancel).await;
                                }
                                ClientMsg::Interrupt => {
                                    let _ = input_tx.send(SessionInput::Interrupt).await;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }

    tracing::info!("ACP WebSocket disconnected for session {}", session_id);
}
