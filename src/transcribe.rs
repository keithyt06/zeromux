//! WebSocket handler that proxies browser audio to AWS Transcribe Streaming.
//!
//! See `docs/specs/2026-05-18-voice-input-design.md`.

use crate::aws_sigv4;
use crate::event_stream;
use crate::AppState;
use axum::extract::{
    ws::{Message, WebSocket, WebSocketUpgrade},
    Query, State,
};
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::protocol::Message as TtMessage;

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
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(mut browser_ws: WebSocket) {
    // First frame must be `{"type":"start","language":...}`
    let language = match browser_ws.recv().await {
        Some(Ok(Message::Text(t))) => match serde_json::from_str::<ClientFrame>(&t) {
            Ok(ClientFrame::Start { language }) => language,
            Ok(_) => {
                let _ = send_server_frame(
                    &mut browser_ws,
                    &ServerFrame::Error {
                        message: "first frame must be start".into(),
                    },
                )
                .await;
                return;
            }
            Err(e) => {
                let _ = send_server_frame(
                    &mut browser_ws,
                    &ServerFrame::Error {
                        message: format!("invalid start frame: {e}"),
                    },
                )
                .await;
                return;
            }
        },
        Some(Ok(_)) => {
            // First frame was binary or other type — protocol violation
            let _ = send_server_frame(
                &mut browser_ws,
                &ServerFrame::Error {
                    message: "first frame must be a start text frame".into(),
                },
            )
            .await;
            return;
        }
        _ => return,
    };

    // Load credentials + region from default chain
    let (creds, region) = match aws_sigv4::load_default_credentials().await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("AWS creds load failed: {e}");
            let _ = send_server_frame(
                &mut browser_ws,
                &ServerFrame::Error { message: e },
            )
            .await;
            return;
        }
    };

    let now_iso8601 = format_now_iso8601();
    let url = match aws_sigv4::presign_transcribe_url(
        &creds,
        &region,
        &language,
        16000,
        300,
        &now_iso8601,
    ) {
        Ok(u) => u,
        Err(e) => {
            tracing::error!("presign failed: {e}");
            let _ = send_server_frame(
                &mut browser_ws,
                &ServerFrame::Error { message: e },
            )
            .await;
            return;
        }
    };

    let (aws_ws_stream, _) = match tokio_tungstenite::connect_async(&url).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("AWS connect failed: {e}");
            let _ = send_server_frame(
                &mut browser_ws,
                &ServerFrame::Error {
                    message: format!("AWS connection failed: {e}"),
                },
            )
            .await;
            return;
        }
    };
    let (mut aws_sink, mut aws_stream) = aws_ws_stream.split();

    loop {
        tokio::select! {
            browser = browser_ws.recv() => {
                match browser {
                    Some(Ok(Message::Binary(pcm))) => {
                        let frame = event_stream::encode_audio_event(&pcm);
                        if let Err(e) = aws_sink.send(TtMessage::Binary(frame.into())).await {
                            tracing::error!("AWS send failed: {e}");
                            let _ = send_server_frame(&mut browser_ws, &ServerFrame::Error { message: format!("AWS send failed: {e}") }).await;
                            break;
                        }
                    }
                    Some(Ok(Message::Text(t))) => {
                        if matches!(serde_json::from_str::<ClientFrame>(&t), Ok(ClientFrame::Stop)) {
                            // Send empty AudioEvent to flush, then close AWS side, then exit.
                            // Without break, any subsequent binary the browser sends
                            // would call send() on a closed sink and surface a spurious error.
                            let _ = aws_sink.send(TtMessage::Binary(event_stream::encode_audio_event(&[]).into())).await;
                            let _ = aws_sink.close().await;
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        let _ = aws_sink.close().await;
                        break;
                    }
                    Some(Err(e)) => {
                        tracing::error!("browser ws error: {e}");
                        break;
                    }
                    _ => {}
                }
            }
            aws = aws_stream.next() => {
                match aws {
                    Some(Ok(TtMessage::Binary(b))) => {
                        match event_stream::decode_event_message(&b) {
                            Ok(event_stream::DecodedFrame::TranscriptEvent { payload }) => {
                                match serde_json::from_slice::<TranscriptEvent>(&payload) {
                                    Ok(evt) => {
                                        for r in evt.transcript.results {
                                            if let Some(alt) = r.alternatives.first() {
                                                let frame = if r.is_partial {
                                                    ServerFrame::Partial { text: alt.transcript.clone() }
                                                } else {
                                                    ServerFrame::Final { text: alt.transcript.clone() }
                                                };
                                                if send_server_frame(&mut browser_ws, &frame).await.is_err() {
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        // AWS schema may have evolved — log so we notice; don't crash the stream.
                                        tracing::warn!("TranscriptEvent JSON parse failed: {e}");
                                    }
                                }
                            }
                            Ok(event_stream::DecodedFrame::Exception { exception_type, payload }) => {
                                // Full payload may contain access key IDs or other privileged details
                                // (e.g. InvalidSignatureException dumps the whole canonical-request hash
                                // including X-Amz-Credential). Log internally; surface only the type to
                                // the browser so we don't leak operator credentials to the client.
                                let detail = std::str::from_utf8(&payload).unwrap_or("(non-utf8 payload)");
                                tracing::error!("AWS exception {}: {}", exception_type, detail);
                                let _ = send_server_frame(
                                    &mut browser_ws,
                                    &ServerFrame::Error { message: format!("AWS {}", exception_type) },
                                ).await;
                                break;
                            }
                            Ok(event_stream::DecodedFrame::Other { .. }) => { /* ignore unknown */ }
                            Err(e) => {
                                tracing::error!("AWS frame decode failed: {e}");
                            }
                        }
                    }
                    Some(Ok(TtMessage::Close(_))) | None => break,
                    Some(Err(e)) => {
                        tracing::error!("AWS ws error: {e}");
                        let _ = send_server_frame(&mut browser_ws, &ServerFrame::Error { message: format!("AWS connection lost: {e}") }).await;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = browser_ws.close().await;
}

fn format_now_iso8601() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock before epoch");
    let total_secs = now.as_secs();
    let (y, mo, d, h, mi, s) = epoch_to_ymdhms(total_secs);
    format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}Z")
}

/// Convert UNIX epoch seconds to (y, mo, d, h, mi, s) UTC.
/// Civil-from-days algorithm from Howard Hinnant: https://howardhinnant.github.io/date_algorithms.html
fn epoch_to_ymdhms(t: u64) -> (u32, u32, u32, u32, u32, u32) {
    let s = (t % 86_400) as u32;
    let h = s / 3600;
    let mi = (s % 3600) / 60;
    let se = s % 60;
    let days = (t / 86_400) as i64;
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = (y + if mo <= 2 { 1 } else { 0 }) as u32;
    (y, mo, d, h, mi, se)
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

    #[test]
    fn epoch_to_ymdhms_known_values() {
        // 2015-08-30T12:36:00Z = 1440938160
        assert_eq!(epoch_to_ymdhms(1_440_938_160), (2015, 8, 30, 12, 36, 0));
        // Round-trip a modern date — sanity check the algorithm
        let (y, mo, d, _, _, _) = epoch_to_ymdhms(1_747_872_000);
        assert!(y >= 2025 && y <= 2027, "year {y}");
        assert!((1..=12).contains(&mo));
        assert!((1..=31).contains(&d));
    }
}
