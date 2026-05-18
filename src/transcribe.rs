//! WebSocket handler that proxies browser audio to AWS Transcribe Streaming.
//!
//! See `docs/specs/2026-05-18-voice-input-design.md`.

use crate::AppState;
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    Query, State,
};
use axum::response::Response;
use futures::SinkExt;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Inbound JSON frame from browser
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ClientFrame {
    #[serde(rename = "start")]
    Start { language: String },
    #[serde(rename = "stop")]
    Stop,
}

/// Outbound JSON frame to browser
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ServerFrame {
    #[serde(rename = "partial")]
    Partial { text: String },
    #[serde(rename = "final")]
    Final { text: String },
    #[serde(rename = "error")]
    Error { message: String },
}

/// Subset of the AWS Transcribe Streaming `TranscriptEvent` JSON payload.
#[derive(Debug, Deserialize)]
pub struct TranscriptEvent {
    #[serde(rename = "Transcript")]
    pub transcript: TranscriptBody,
}

#[derive(Debug, Deserialize)]
pub struct TranscriptBody {
    #[serde(rename = "Results")]
    pub results: Vec<TranscriptResult>,
}

#[derive(Debug, Deserialize)]
pub struct TranscriptResult {
    #[serde(rename = "IsPartial")]
    pub is_partial: bool,
    #[serde(rename = "Alternatives")]
    pub alternatives: Vec<TranscriptAlternative>,
}

#[derive(Debug, Deserialize)]
pub struct TranscriptAlternative {
    #[serde(rename = "Transcript")]
    pub transcript: String,
}

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
}

pub async fn transcribe_ws(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let authed = query
        .token
        .as_deref()
        .and_then(|t| crate::auth::verify_ws_token(&state, t))
        .is_some();
    if !authed {
        return axum::http::Response::builder()
            .status(401)
            .body(axum::body::Body::from("unauthorized"))
            .unwrap();
    }
    ws.on_upgrade(handle_socket_stub)
}

/// Stub handler: echoes a fake `partial` after `start`, a fake `final` after `stop`.
/// Replaced in a follow-up commit (Task 8) with real AWS Transcribe Streaming proxy.
async fn handle_socket_stub(mut socket: WebSocket) {
    let mut audio_bytes_received: usize = 0;

    while let Some(msg) = socket.recv().await {
        let Ok(msg) = msg else { break };
        match msg {
            Message::Text(text) => {
                let frame: Result<ClientFrame, _> = serde_json::from_str(&text);
                match frame {
                    Ok(ClientFrame::Start { language }) => {
                        tracing::info!("transcribe stub: start language={language}");
                        let _ = send_server_frame(
                            &mut socket,
                            &ServerFrame::Partial {
                                text: format!("[stub partial for {language}]"),
                            },
                        )
                        .await;
                    }
                    Ok(ClientFrame::Stop) => {
                        let _ = send_server_frame(
                            &mut socket,
                            &ServerFrame::Final {
                                text: format!(
                                    "[stub final, audio_bytes={audio_bytes_received}]"
                                ),
                            },
                        )
                        .await;
                        let _ = socket.close().await;
                        return;
                    }
                    Err(e) => {
                        let _ = send_server_frame(
                            &mut socket,
                            &ServerFrame::Error {
                                message: format!("invalid JSON frame: {e}"),
                            },
                        )
                        .await;
                    }
                }
            }
            Message::Binary(b) => {
                audio_bytes_received += b.len();
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

async fn send_server_frame(
    socket: &mut WebSocket,
    frame: &ServerFrame,
) -> Result<(), axum::Error> {
    let json =
        serde_json::to_string(frame).expect("ServerFrame is always serializable");
    socket.send(Message::Text(json.into())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_aws_partial_transcript_payload() {
        let json = r#"{
            "Transcript": {
                "Results": [{
                    "IsPartial": true,
                    "Alternatives": [{"Transcript": "你好世"}]
                }]
            }
        }"#;
        let evt: TranscriptEvent = serde_json::from_str(json).unwrap();
        assert_eq!(evt.transcript.results.len(), 1);
        assert!(evt.transcript.results[0].is_partial);
        assert_eq!(evt.transcript.results[0].alternatives[0].transcript, "你好世");
    }

    #[test]
    fn parses_aws_final_transcript_payload() {
        let json = r#"{
            "Transcript": {
                "Results": [{
                    "IsPartial": false,
                    "Alternatives": [{"Transcript": "你好世界。"}]
                }]
            }
        }"#;
        let evt: TranscriptEvent = serde_json::from_str(json).unwrap();
        assert!(!evt.transcript.results[0].is_partial);
    }

    #[test]
    fn empty_results_is_valid() {
        let json = br#"{"Transcript": {"Results": []}}"#;
        let evt: TranscriptEvent = serde_json::from_slice(json).unwrap();
        assert!(evt.transcript.results.is_empty());
    }

    #[test]
    fn client_frame_start_parses() {
        let json = br#"{"type":"start","language":"zh-CN"}"#;
        let f: ClientFrame = serde_json::from_slice(json).unwrap();
        match f {
            ClientFrame::Start { language } => assert_eq!(language, "zh-CN"),
            _ => panic!("wrong variant"),
        }
    }
}
