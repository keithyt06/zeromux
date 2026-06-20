use serde::Serialize;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::mpsc;

static INT_SEQ: AtomicU64 = AtomicU64::new(0);
fn now_seq() -> u64 {
    INT_SEQ.fetch_add(1, Ordering::Relaxed)
}

/// Browser-facing events emitted by the Claude CLI stream-json protocol.
///
/// These are translated from the NDJSON lines that `claude -p --output-format stream-json`
/// writes to stdout. The translation flattens the nested assistant message structure
/// into individual typed events for easy rendering in the browser.
/// Borrowed-or-owned string for AcpEvent tag fields. The vast majority of
/// emit sites use static literals ("text", "thinking", "tool_use", "init",
/// etc.); using `Cow<'static, str>` lets those paths skip a heap allocation
/// per event. Only Claude's stream-json `assistant` translation, which reads
/// arbitrary block types out of upstream JSON, needs the owned variant.
pub type StaticOrOwnedStr = std::borrow::Cow<'static, str>;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpEvent {
    /// 会话/进程生命周期信号（init、session_id 等）。前端渲染为一行
    /// 灰色 system 文本，不进入助手消息气泡。
    System {
        subtype: StaticOrOwnedStr,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        /// 仅 subtype=="queued" 填充：当前排队条数，供前端显示"已排队 N 条"。
        #[serde(skip_serializing_if = "Option::is_none")]
        count: Option<u32>,
    },
    /// 助手输出的一个内容块。`block_type` 决定渲染方式：
    /// - "text"：正文 markdown；`streaming:true` 的连续块前端合并为一段。
    /// - "thinking"：推理痕迹，渲染为可折叠区；流式块合并，turn 结束折叠。
    /// - "tool_use"：工具调用，显示 `name · summary` + 图标，原始 `input` 折叠。
    ContentBlock {
        block_type: StaticOrOwnedStr,
        /// 归属 turn。进程层不知道 turn_seq，构造时填 0；fan-out 的 emit 在广播前
        /// 用 with_turn_id 盖上真实值（G3.2）。前端据此分组，见 UserPrompt 注释。
        turn_id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        input: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        streaming: Option<bool>,
        /// 仅 tool_use 类型填充：`format::format_tool_use` 生成的一行细节
        /// 摘要（如 `src/main.rs`、`git status`）。前端显示为 `name · summary`。
        /// text/thinking block 及无可提取细节的工具为 None。
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    /// turn 结束信号。`text` **始终携带完整最终文本**；但前端仅在本轮未通过
    /// 任何 `ContentBlock{block_type:"text"}` 流式呈现过正文时，才将其渲染为
    /// 最终文本块（见 AcpChatView result 门控）。这避免流式后重复渲染，同时
    /// 让 Codex 非流式（Bedrock thinking 一次性返回）的正文仍能显示。
    /// `text` 始终完整也保证 session_manager::log_result_event 的活动摘要可用。
    Result {
        text: String,
        /// 归属 turn。同 ContentBlock：进程层填 0，fan-out 盖真实值（G3.2）。
        turn_id: u64,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tokens_in: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tokens_out: Option<u64>,
    },
    /// 用户 prompt 回显。每条用户 prompt 入队即 emit 一个（collect 合并成一个
    /// turn 时仍 N 个事件，见 spec P1）。turn_id 标识它归属的 turn，前端据此分组，
    /// 避免「边流边发」时新 prompt 插进上一个回答中间（spec T1）。
    UserPrompt {
        text: String,
        turn_id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
    },
    /// 错误信息，渲染为红框气泡，并标记当前助手消息为完成。
    Error {
        message: String,
    },
    /// 进程退出，渲染为 system 文本并结束 busy 状态。
    Exit {
        code: i32,
    },
}

/// Events the CLI can produce are all top-level JSON objects with a `type` field.
/// We deserialize into serde_json::Value and dispatch on `type` manually,
/// because the schema varies per event type and we only care about a few fields.
pub struct AcpProcess {
    child: Child,
    stdin: ChildStdin,
    pub event_rx: mpsc::Receiver<AcpEvent>,
}

impl AcpProcess {
    /// Spawn `claude -p` in stream-json mode.
    ///
    /// The CLI arguments are documented at:
    /// https://docs.anthropic.com/en/docs/claude-code/cli-usage
    pub async fn spawn(
        claude_path: &str,
        work_dir: &str,
        resume: Option<&str>,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let mut args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(), "stream-json".into(),
            "--input-format".into(), "stream-json".into(),
            "--verbose".into(),
            "--dangerously-skip-permissions".into(),
        ];
        if let Some(sid) = resume {
            args.push("--resume".into());
            args.push(sid.to_string());
        }
        let mut child = tokio::process::Command::new(claude_path)
            .args(&args)
            .current_dir(work_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let (tx, rx) = mpsc::channel::<AcpEvent>(256);
        start_reader(stdout, tx);

        Ok(Self { child, stdin, event_rx: rx })
    }

    /// Spawn `claude -p` in stream-json mode for the **auto-titler**: a
    /// sandboxed, tool-less read of conversation text (C1/E10). Differs from
    /// `spawn` in two security-critical ways:
    ///   - **No `--dangerously-skip-permissions`** (so any tool use Claude
    ///     attempts would hit a permission prompt and stall, never auto-run).
    ///   - **`--allowedTools ""`** — empty allow-list grants zero tools, so
    ///     even a prompt-injected conversation can't make the model act.
    /// Runs in `sandbox_dir` (a temp empty dir), NOT the session's repo.
    /// Keeps the stream-json input/output flags so the shared NDJSON reader
    /// (`start_reader`) parses its output identically.
    pub async fn spawn_titler(
        claude_path: &str,
        sandbox_dir: &str,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let args: Vec<String> = vec![
            "-p".into(),
            "--output-format".into(), "stream-json".into(),
            "--input-format".into(), "stream-json".into(),
            "--verbose".into(),
            "--allowedTools".into(), "".into(),
        ];
        let mut child = tokio::process::Command::new(claude_path)
            .args(&args)
            .current_dir(sandbox_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;

        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let (tx, rx) = mpsc::channel::<AcpEvent>(256);
        start_reader(stdout, tx);

        Ok(Self { child, stdin, event_rx: rx })
    }

    /// Write a user turn to the CLI via stdin (NDJSON).
    pub async fn send_prompt(&mut self, text: &str) -> Result<(), std::io::Error> {
        let msg = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": text}]
            }
        });
        let mut line = serde_json::to_string(&msg).unwrap();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await
    }

    /// Turn-level interrupt: tell Claude to abort the current turn but keep the
    /// process alive (verified: stdin control_request {subtype:"interrupt"}).
    pub async fn interrupt(&mut self) -> Result<(), std::io::Error> {
        let msg = serde_json::json!({
            "type": "control_request",
            "request_id": format!("zmx-int-{}", now_seq()),
            "request": { "subtype": "interrupt" }
        });
        let mut line = serde_json::to_string(&msg).unwrap();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await
    }

    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}

impl Drop for AcpProcess {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

/// Spawn the background task that reads NDJSON lines from the CLI's stdout,
/// translates each into `AcpEvent`s, and forwards them down `tx`. Shared by
/// both `spawn` and `spawn_titler` so the stream-json parsing lives in one
/// place. Uses a large buffer because assistant responses can carry big
/// tool_use inputs.
fn start_reader(stdout: ChildStdout, tx: mpsc::Sender<AcpEvent>) {
    let reader = BufReader::with_capacity(256 * 1024, stdout);
    tokio::spawn(async move {
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.is_empty() {
                continue;
            }
            let val: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    tracing::debug!("stream-json: bad line: {e} — {}", &line[..line.len().min(200)]);
                    continue;
                }
            };
            for evt in translate_event(&val) {
                if tx.send(evt).await.is_err() {
                    return;
                }
            }
        }
        let _ = tx.send(AcpEvent::Exit { code: 0 }).await;
    });
}

// ── Stream-json event translation ──
//
// Claude CLI's stream-json format emits one JSON object per line.
// Each object has a "type" field. We translate interesting ones into AcpEvent
// and silently drop internal/hook events.

/// Set of system subtypes we drop because they're internal CLI lifecycle noise.
const IGNORED_SUBTYPES: &[&str] = &["hook_started", "hook_response"];

fn translate_event(val: &serde_json::Value) -> Vec<AcpEvent> {
    let event_type = val.get("type").and_then(|v| v.as_str()).unwrap_or("");

    match event_type {
        "system" => {
            let subtype = val.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
            if IGNORED_SUBTYPES.contains(&subtype) {
                return vec![];
            }
            vec![AcpEvent::System {
                subtype: StaticOrOwnedStr::Owned(subtype.to_string()),
                session_id: val.get("session_id").and_then(|v| v.as_str()).map(String::from),
                count: None,
            }]
        }

        "assistant" => {
            // Flatten message.content[] into individual ContentBlock events.
            let blocks = val
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_array());

            let Some(blocks) = blocks else { return vec![] };

            blocks
                .iter()
                .map(|b| {
                    // block_type comes from upstream JSON, so it must be Owned.
                    // Pin the common literals to Borrowed for zero allocation
                    // when Claude uses the standard set; fall back to Owned
                    // for unrecognized types so we still pass them through.
                    let raw = b.get("type").and_then(|v| v.as_str()).unwrap_or("text");
                    let block_type: StaticOrOwnedStr = match raw {
                        "text" => StaticOrOwnedStr::Borrowed("text"),
                        "thinking" => StaticOrOwnedStr::Borrowed("thinking"),
                        "tool_use" => StaticOrOwnedStr::Borrowed("tool_use"),
                        other => StaticOrOwnedStr::Owned(other.to_string()),
                    };
                    // Claude stream-json sends extended-thinking blocks with
                    // `{"type":"thinking","thinking":"..."}` (the prose lives in
                    // a `thinking` field, not `text`). Read the right field so
                    // the frontend gets non-empty text on thinking blocks.
                    let text = if block_type == "thinking" {
                        b.get("thinking")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                            .or_else(|| {
                                b.get("text").and_then(|v| v.as_str()).map(String::from)
                            })
                    } else {
                        b.get("text").and_then(|v| v.as_str()).map(String::from)
                    };
                    let summary = if block_type == "tool_use" {
                        crate::acp::format::format_tool_use(
                            b.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                            b.get("input"),
                        )
                    } else {
                        None
                    };
                    AcpEvent::ContentBlock {
                        block_type,
                        turn_id: 0,
                        text,
                        name: b.get("name").and_then(|v| v.as_str()).map(String::from),
                        input: b.get("input").cloned(),
                        streaming: None,
                        summary,
                    }
                })
                .collect()
        }

        "result" => {
            let usage = val.get("usage");
            vec![AcpEvent::Result {
                text: val.get("result").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                turn_id: 0,
                session_id: val.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                cost_usd: val.get("total_cost_usd").and_then(|v| v.as_f64()),
                tokens_in: usage.and_then(|u| u.get("input_tokens")).and_then(|v| v.as_u64()),
                tokens_out: usage.and_then(|u| u.get("output_tokens")).and_then(|v| v.as_u64()),
            }]
        }

        other => {
            tracing::debug!("stream-json: unhandled event type: {other}");
            vec![]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn user_prompt_serializes_with_turn_and_client_id() {
        let evt = AcpEvent::UserPrompt { text: "hello".into(), turn_id: 7, client_id: Some("c1".into()) };
        let j = serde_json::to_string(&evt).unwrap();
        assert!(j.contains("\"type\":\"user_prompt\""));
        assert!(j.contains("\"turn_id\":7"));
        assert!(j.contains("\"client_id\":\"c1\""));
    }
    #[test]
    fn user_prompt_omits_client_id_when_none() {
        let evt = AcpEvent::UserPrompt { text: "x".into(), turn_id: 1, client_id: None };
        let j = serde_json::to_string(&evt).unwrap();
        assert!(!j.contains("client_id"));
    }
    #[test]
    fn result_parses_usage_tokens() {
        let raw = serde_json::json!({
            "type": "result", "result": "done", "session_id": "s1",
            "total_cost_usd": 0.02,
            "usage": { "input_tokens": 123, "output_tokens": 45 }
        });
        let evts = translate_event(&raw);
        match &evts[0] {
            AcpEvent::Result { tokens_in, tokens_out, cost_usd, .. } => {
                assert_eq!(*tokens_in, Some(123));
                assert_eq!(*tokens_out, Some(45));
                assert_eq!(*cost_usd, Some(0.02));
            }
            _ => panic!("expected Result"),
        }
    }
}
