use serde::Serialize;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::mpsc;

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
    },
    /// 助手输出的一个内容块。`block_type` 决定渲染方式：
    /// - "text"：正文 markdown；`streaming:true` 的连续块前端合并为一段。
    /// - "thinking"：推理痕迹，渲染为可折叠区；流式块合并，turn 结束折叠。
    /// - "tool_use"：工具调用，显示 `name · summary` + 图标，原始 `input` 折叠。
    ContentBlock {
        block_type: StaticOrOwnedStr,
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
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
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

        // Read NDJSON lines from stdout in a background task.
        // Use a large buffer because assistant responses can contain big tool_use inputs.
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

    pub async fn kill(&mut self) {
        let _ = self.child.kill().await;
    }
}

impl Drop for AcpProcess {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
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
            vec![AcpEvent::Result {
                text: val.get("result").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                session_id: val.get("session_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                cost_usd: val.get("total_cost_usd").and_then(|v| v.as_f64()),
            }]
        }

        other => {
            tracing::debug!("stream-json: unhandled event type: {other}");
            vec![]
        }
    }
}
