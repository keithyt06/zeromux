//! Kiro Crew Gateway client + event normalization.
//!
//! Unlike the other three ACP backends, a Crew session **spawns no process**:
//! the fan-out task exclusively owns one WebSocket to the Kiro Crew Gateway
//! (`127.0.0.1:<crew_port>`) and normalizes the gateway's *global* broadcast
//! frames — filtered by `data.slot` — into the existing `AcpEvent` shape.
//!
//! The normalization half is a **pure function**
//! `(&Value, my_slot, &mut NormState) -> Vec<AcpEvent>` — no I/O, no clock, no
//! channel — so the unit tests can feed it real captured gateway frames without
//! a gateway running.

use std::borrow::Cow;

use futures::StreamExt;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::process::AcpEvent;

/// 归一化的可变状态。三条不变量全部落在这里。
#[derive(Debug, Default)]
pub struct NormState {
    /// I3：本轮 `chat_chunk` 的累积文本。`chat_done` 时 `mem::take` 产出
    /// `Result.text`，**take 即清零**，所以下一轮天然从空开始。
    turn_text: String,
    /// I2：本轮已渲染过的 `tool_call_id` 集合。`chat_done` 时清空。
    seen_tool_calls: std::collections::HashSet<String>,
}

impl NormState {
    pub fn new() -> Self { Self::default() }
}

/// 把一个 Gateway WS 帧归一化成零或多个 `AcpEvent`。
///
/// **纯函数**：无 I/O、无时钟、无 channel —— 这是本模块最重要的设计约束，
/// 它让 T1-T8 能直接喂实测抓到的真实 JSON 帧，不需要 Gateway 在跑。
pub fn normalize_frame(
    frame: &serde_json::Value,
    my_slot: &str,
    st: &mut NormState,
) -> Vec<AcpEvent> {
    let Some(kind) = frame.get("type").and_then(|v| v.as_str()) else { return vec![] };

    // ── I1：slot 过滤 ──
    // 全局帧（heartbeat / slots / dashboard / refresh / mcp_report_update …）没有
    // `data.slot`，在这里就被一并丢掉，不 panic。`data` 是标量（`"data":7`）或
    // `slot` 不是字符串时 `get`/`as_str` 都返回 None，同样走这条门 —— 全函数无
    // unwrap、无索引，畸形帧不可能 panic。
    //
    // 这条必须在 `match kind` **之前**：漏了它不只是「别人的输出进我的会话」，
    // 更隐蔽的是别的 slot 的 `chat_done` 会把我的 turn_text 抽走 → 我的
    // Result.text 变空。
    let Some(data) = frame.get("data") else { return vec![] };
    if data.get("slot").and_then(|v| v.as_str()) != Some(my_slot) { return vec![] }

    match kind {
        // ── chat_chunk → 流式 text 块 + I3 累积 ──
        // `seq` 只用于诊断：按**到达序** append。若拿 seq 做去重/排序，一个非递增
        // 的序列（重连后重编号）会静默丢块 —— 无声的正文缺失，比乱序难查得多。
        "chat_chunk" => {
            let Some(content) = data.get("content").and_then(|v| v.as_str()) else { return vec![] };
            if content.is_empty() { return vec![] }
            st.turn_text.push_str(content);
            vec![AcpEvent::ContentBlock {
                block_type: Cow::Borrowed("text"),
                // 进程层不知道 turn_seq，填 0；fan-out 的 emit 在广播前用
                // with_turn_id 盖真实值（G3.2，session_manager.rs:3030-3037）。
                turn_id: 0,
                text: Some(content.to_string()),
                name: None,
                input: None,
                streaming: Some(true),
                summary: None,
            }]
        }

        // ── tool_call → tool_use 块 + I2 去重 ──
        "tool_call" => {
            let tool = data.get("tool").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
            let is_update = data.get("is_update").and_then(|v| v.as_bool()).unwrap_or(false);
            match data.get("tool_call_id").and_then(|v| v.as_str()) {
                Some(id) => {
                    // insert 返回 false ⇒ 这个 id 已渲染过（含 is_update:true 那两帧）。
                    // 实测一次调用来 3 帧，漏了去重 = UI 里渲染 3 次。
                    if !st.seen_tool_calls.insert(id.to_string()) { return vec![] }
                }
                None => {
                    // 无 id 无法去重 → is_update:true 的只能当更新丢弃，否则每帧渲染一次。
                    if is_update { return vec![] }
                }
            }
            // input_preview 是 Gateway 已序列化好的字符串；先试着解析回 JSON，
            // 解析不了就原样当字符串（前端 input 折叠区两者都能显示）。
            let input = data.get("input_preview").and_then(|v| v.as_str()).map(|s| {
                serde_json::from_str::<serde_json::Value>(s)
                    .unwrap_or_else(|_| serde_json::Value::String(s.to_string()))
            });
            // `purpose` → `summary`：Crew 比现有三后端多给一句「为什么调这个工具」，
            // 前端已渲染成 `name · summary`（AcpChatView.tsx:932-934）。缺 purpose
            // 时回落 format::format_tool_use（未知工具名返回 None）。
            let purpose = data.get("purpose").and_then(|v| v.as_str())
                .filter(|s| !s.is_empty()).map(|s| s.to_string());
            let summary = purpose.or_else(|| super::format::format_tool_use(&tool, input.as_ref()));
            vec![AcpEvent::ContentBlock {
                block_type: Cow::Borrowed("tool_use"),
                turn_id: 0,
                text: None,
                name: Some(tool),
                input,
                streaming: None,
                summary,
            }]
        }

        // ── tool_result → tool_result 块 ──
        // 前端 BlockView 已有 `case 'tool_result'`（AcpChatView.tsx:949）。
        // **不进 turn_text**：Result.text 只该是助手正文，工具输出混进去会污染
        // 活动看板摘要（events.rs:226 的 summarize）与 auto_titler 的输入。
        "tool_result" => {
            let tool = data.get("tool").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
            let text = ["output", "result", "content", "text"].iter()
                .find_map(|k| data.get(*k).and_then(|v| v.as_str())).map(|s| s.to_string())
                .or_else(|| data.get("result").filter(|v| !v.is_null()).map(|v| v.to_string()));
            vec![AcpEvent::ContentBlock {
                block_type: Cow::Borrowed("tool_result"),
                turn_id: 0,
                text,
                name: Some(tool),
                input: None,
                streaming: None,
                summary: None,
            }]
        }

        // ── chat_status → System{subtype:"status"}（非前进信号，见下面的谓词）──
        "chat_status" => vec![AcpEvent::System {
            subtype: Cow::Borrowed("status"),
            session_id: None,
            count: None,
        }],

        // ── chat_done → Result（I3：文本来自累积）──
        // `chat_done` 实测**只带 slot，不带最终文本**。`mem::take` 同时完成两件事：
        // 产出本轮文本 + 把缓冲清零，所以第二轮不会累加第一轮。
        "chat_done" => {
            let text = std::mem::take(&mut st.turn_text);
            st.seen_tool_calls.clear();   // 同一 id 在新一轮应重新渲染
            vec![AcpEvent::Result {
                text,
                turn_id: 0,
                // session_id 填 slot_key：与 Codex 用 Result.session_id 携带 threadId
                // 同构（session_manager.rs:2191-2197）。供 resume token 回填。
                session_id: my_slot.to_string(),
                cost_usd: None,
                tokens_in: None,
                tokens_out: None,
            }]
        }

        // ── chat_error → Error（终态边界）──
        // 同时清本轮状态：失败的轮次不能把半截文本漏进下一轮的 Result
        // （kiro_process.rs:434-441 同型修复，review 2026-08-01）。
        "chat_error" => {
            let _ = std::mem::take(&mut st.turn_text);
            st.seen_tool_calls.clear();
            let msg = ["error", "message", "detail"].iter()
                .find_map(|k| data.get(*k).and_then(|v| v.as_str()))
                .unwrap_or("Crew turn failed").to_string();
            vec![AcpEvent::Error { message: format!("Crew error: {msg}") }]
        }

        // ── approval → Approval（字段名照实测：tool_purpose / tool_input）──
        "approval" => {
            // 无 id 无法回执 → 丢弃。渲染一个点了没反应的卡片比不渲染更糟。
            let Some(id) = data.get("id").and_then(|v| v.as_str()) else { return vec![] };
            let tool = data.get("tool").and_then(|v| v.as_str()).unwrap_or("tool").to_string();
            let nonempty = |k: &str| data.get(k).and_then(|v| v.as_str())
                .filter(|s| !s.is_empty()).map(|s| s.to_string());
            vec![AcpEvent::Approval {
                id: id.to_string(),
                tool,
                tool_input: nonempty("tool_input"),
                tool_purpose: nonempty("tool_purpose"),
                slot: my_slot.to_string(),
            }]
        }

        // ── context_usage → ContextUsage（zeromux 自己没有的能力）──
        "context_usage" => {
            let used = data.get("used").and_then(|v| v.as_u64());
            let total = data.get("total").or_else(|| data.get("limit")).and_then(|v| v.as_u64());
            match (used, total) {
                // total==0 会让前端渲染 NaN%/Infinity% —— 在进程层就滤掉。
                (Some(used), Some(total)) if total > 0 => vec![AcpEvent::ContextUsage { used, total }],
                _ => vec![],
            }
        }

        // ── chat_message：仅 Crew Mode 的 crew_* 回答（R1 实测：普通模式不发此帧）──
        // 白名单 kind，不按 role 放行（KC/state.py:2296-2348 普通模式在无 HTTP reader
        // 时也可能发 assistant chat_message → 会与 chat_chunk 双渲染）。
        // 非边界：不进 turn_text，不产 Result —— 否则会混进下一轮 chat_done 的正文。
        "chat_message" => crew_message_events(data),

        // ── 其余全部丢弃 ──
        // slots / dashboard / heartbeat / refresh / mcp_report_update / slot_title /
        // chat_segment / chat_message_update / activity_event /
        // chat_message（非 crew_* kind 由 crew_message_events 丢弃）：全局帧，或已被上面的
        // 专用帧覆盖（chat_segment / chat_message_update 是 chat_chunk 的重复表述，
        // 一起处理会让同一段正文渲染两次）。
        _ => { tracing::debug!("crew: dropped frame type {kind}"); vec![] }
    }
}

/// G1 (S5 spec §6.2). `data` is the frame's `data` object, already slot-filtered.
/// Lenient on purpose (K2, upstream is experimental): kind from `data.kind` or
/// `data.meta.kind`; body from `data.content` or `data.text`. Anything outside the
/// whitelist — other kinds, non-assistant roles, junk types — maps to nothing.
pub fn crew_message_events(data: &serde_json::Value) -> Vec<AcpEvent> {
    if data.get("role").and_then(|v| v.as_str()) != Some("assistant") { return vec![] }
    let kind = data.get("kind").and_then(|v| v.as_str())
        .or_else(|| data.get("meta").and_then(|m| m.get("kind")).and_then(|v| v.as_str()));
    let body = data.get("content").and_then(|v| v.as_str())
        .or_else(|| data.get("text").and_then(|v| v.as_str()))
        .filter(|s| !s.trim().is_empty());
    match (kind, body) {
        // D2: an ack is not an answer — a grey system line, never an assistant bubble.
        (Some("crew_ack"), _) => vec![AcpEvent::System {
            subtype: Cow::Borrowed("crew_ack"), session_id: None, count: None,
        }],
        // D3: non-boundary text blocks; the frontend styles them by `summary`.
        (Some(k @ ("crew_ask" | "crew_result" | "crew_meta")), Some(text)) => vec![AcpEvent::ContentBlock {
            block_type: Cow::Borrowed("text"),
            turn_id: 0,
            text: Some(text.to_string()),
            name: None,
            input: None,
            streaming: None,
            summary: Some(k.to_string()),
        }],
        _ => vec![],
    }
}

/// `emit` 的 bump 谓词对 Crew 的补充（2026-08-05 教训：不前进的信号勿刷看门狗）。
///
/// `System{subtype:"status"}` 是 Gateway 的 "Thinking…" 心跳，**不是** agent 前进
/// 信号。如果它刷新 `last_activity_ms`，一个卡死在工具调用上的轮次会靠 status 心跳
/// 把空闲看门狗永远架空 —— 与 F-CODEX-1-CLOCK 同型。
///
/// 对其余三后端**恒真**（它们的 `System` 只有 `"init"` 和 `"queued"`，见
/// kiro_process.rs:169 / codex_process.rs:412 / session_manager.rs:2897）。
pub fn crew_event_is_forward_progress(evt: &AcpEvent) -> bool {
    !matches!(evt, AcpEvent::System { subtype, .. } if subtype.as_ref() == "status")
}

const TOKEN_TTL: &str = "20h";      // 实测：?ttl= 收 duration 字符串；ttl=300 会静默回落 20h
const REST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const CHAT_POST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3600);
const RECONNECT_INITIAL: std::time::Duration = std::time::Duration::from_secs(3);
const RECONNECT_MAX: std::time::Duration = std::time::Duration::from_secs(60);
const STABLE_AFTER: std::time::Duration = std::time::Duration::from_secs(30);

/// Gateway 连接参数。**不含 secret / token** —— secret 每次从磁盘现读，token 每次
/// 重连现 mint，两者都只在 `run_event_loop` 的栈上活。
#[derive(Clone)]
pub struct CrewConfig {
    pub http_base: String,
    pub ws_base: String,
    pub crew_home: std::path::PathBuf,
    pub port: u16,
}

impl CrewConfig {
    pub fn new(crew_home: std::path::PathBuf, port: u16) -> Self {
        Self {
            http_base: format!("http://127.0.0.1:{port}"),
            ws_base: format!("ws://127.0.0.1:{port}/api/ws"),
            crew_home,
            port,
        }
    }
}

enum Cmd {
    Prompt(String),
    Cancel,
    Approval { approval_id: String, action: String },
    Stop,
}

/// How `spawn` obtains its slot (R4). Ownership is decided by the caller from the
/// PERSISTED origin (U2) — never inferred from "is this a resume": our own slots are
/// resumed with a key after every restart too.
pub enum SlotInit {
    /// Create a fresh slot. `mode` / `agent` are Gateway raw values; empty = omit.
    New { mode: String, agent: String },
    /// Re-attach to an existing slot. `owns=false` for slots zeromux did not create.
    Resume { key: String, owns: bool },
}

/// Drop removes the Gateway slot only if we own it (U2).
pub fn should_delete_on_drop(owns_slot: bool) -> bool { owns_slot }

/// What a resume may touch. A foreign slot keeps its own project/cwd (S7 D-G6).
#[derive(Debug, PartialEq)]
pub struct ResumePlan { pub set_project: bool }

pub fn resume_plan(owns: bool) -> ResumePlan { ResumePlan { set_project: owns } }

/// What `spawn`'s `SlotInit::New` branch does (pure, so Review Focus 4 is testable):
/// a slot zeromux creates — including the resume-failed fresh fallback — is ours.
#[derive(Debug, PartialEq)]
pub struct NewSlotPlan { pub owns: bool, pub created: bool, pub set_project: bool }

pub fn new_slot_plan() -> NewSlotPlan { NewSlotPlan { owns: true, created: true, set_project: true } }

/// 形状与 `CodexProcess`（codex_process.rs:375-378）逐字对齐：私有 `cmd_tx` +
/// `pub event_rx`，所以 `spawn_crew_fanout` 可以照抄 `spawn_codex_fanout`。
pub struct CrewProcess {
    cmd_tx: mpsc::Sender<Cmd>,
    pub event_rx: mpsc::Receiver<AcpEvent>,
    cfg: CrewConfig,
    slot_key: String,
    /// R4: false for slots zeromux did not create — Drop then stops the loop but
    /// never DELETEs the slot. Only S7 G6 ever constructs `owns_slot=false`.
    owns_slot: bool,
}

/// 读 Gateway 的 internal secret：优先 `<crew_home>/run/gateway-<port>.secret`，
/// 回落 `<crew_home>/.local_secret`（均 32 字节、0600）。
///
/// 错误信息只含**路径**，绝不含内容，也不报长度。`trim()` 是必需的：实测 secret
/// 文件带尾换行，不 trim 会让 `X-Local-Secret` 头带 `\n`，reqwest 直接拒绝构造。
/// 空白文件视为不可读并**继续回落**，而不是当成合法空 secret。
pub fn read_gateway_secret(crew_home: &std::path::Path, port: u16) -> Result<String, String> {
    let primary = crew_home.join("run").join(format!("gateway-{port}.secret"));
    let fallback = crew_home.join(".local_secret");
    for p in [&primary, &fallback] {
        if let Ok(s) = std::fs::read_to_string(p) {
            let t = s.trim();
            if !t.is_empty() { return Ok(t.to_string()); }
        }
    }
    Err(format!(
        "Kiro Crew secret 不可读：{} 与 {} 均无法读取或为空",
        primary.display(), fallback.display()
    ))
}

/// `GET /api/token/local?ttl=20h`，头 `X-Local-Secret: <secret>`。仅 loopback 可用。
pub async fn mint_ws_token(http: &reqwest::Client, base: &str, secret: &str) -> Result<String, String> {
    let resp = http.get(format!("{base}/api/token/local?ttl={TOKEN_TTL}"))
        .header("X-Local-Secret", secret)
        .timeout(REST_TIMEOUT)
        .send().await
        .map_err(|_| "Kiro Crew Gateway 未运行或 token mint 请求失败".to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Kiro Crew token mint 被拒（HTTP {}）", status.as_u16()));
    }
    let body: serde_json::Value = resp.json().await
        .map_err(|_| "Kiro Crew token mint 响应不是 JSON".to_string())?;
    body.get("token").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "Kiro Crew token mint 响应缺少 token 字段".to_string())
}

/// 统一的 REST POST：带 `X-Internal-Secret`，**只读状态码、body 立刻 drop**。
async fn post_json_ok(
    http: &reqwest::Client, base: &str, secret: &str, path: &str,
    body: serde_json::Value, timeout: std::time::Duration,
) -> Result<(), String> {
    let resp = http.post(format!("{base}{path}"))
        .header("X-Internal-Secret", secret)
        .json(&body).timeout(timeout).send().await
        .map_err(|_| format!("Gateway 请求失败：{path}"))?;
    let status = resp.status();
    drop(resp);
    if status.is_success() { Ok(()) } else { Err(format!("Gateway 拒绝 {path}（HTTP {}）", status.as_u16())) }
}

/// G2: POST body for a new slot. With empty mode/agent this is byte-identical to the
/// pre-S5 `{"name":k}` so default sessions are untouched.
pub fn slot_create_body(key: &str, mode: &str, agent: &str) -> serde_json::Value {
    let mut b = serde_json::json!({ "name": key });
    if !mode.is_empty() { b["mode"] = serde_json::Value::String(mode.to_string()); }
    if !agent.is_empty() { b["agent"] = serde_json::Value::String(agent.to_string()); }
    b
}

async fn create_slot(http: &reqwest::Client, base: &str, secret: &str, body: serde_json::Value) -> Result<(), String> {
    post_json_ok(http, base, secret, "/api/chat/slots", body, REST_TIMEOUT).await
}

async fn set_slot_project(http: &reqwest::Client, base: &str, secret: &str, key: &str, project: &str) -> Result<(), String> {
    post_json_ok(http, base, secret, &format!("/api/chat/slots/{key}/project"),
                 serde_json::json!({ "project": project }), REST_TIMEOUT).await
}

/// 取消当前轮次。**用 `/stop` 而非 `/interrupt`** —— 后者清的是排队，队列空时返回
/// 400 `"queue empty, use /stop instead"`（实测）。
async fn stop_turn(http: &reqwest::Client, base: &str, secret: &str, key: &str) -> Result<(), String> {
    post_json_ok(http, base, secret, &format!("/api/chat/slots/{key}/stop"),
                 serde_json::json!({}), REST_TIMEOUT).await
}

async fn resolve_approval(http: &reqwest::Client, base: &str, secret: &str, id: &str, action: &str) -> Result<(), String> {
    post_json_ok(http, base, secret, &format!("/api/approvals/{id}/{action}"),
                 serde_json::json!({}), REST_TIMEOUT).await
}

async fn delete_slot(http: &reqwest::Client, base: &str, secret: &str, key: &str) {
    let _ = http.delete(format!("{base}/api/chat/slots/{key}"))
        .header("X-Internal-Secret", secret).timeout(REST_TIMEOUT).send().await;
}

async fn slot_alive(http: &reqwest::Client, base: &str, secret: &str, key: &str) -> bool {
    match http.get(format!("{base}/api/chat/slots/{key}"))
        .header("X-Internal-Secret", secret).timeout(REST_TIMEOUT).send().await
    {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

/// **响应体整体丢弃，只读 HTTP 状态码**（load-bearing）：空闲时响应是阻塞整轮的
/// SSE，忙时是 `{"queued":true}`，而实测并发第二条 prompt 时**第二轮的输出会出现在
/// 第一条请求的 SSE 流里** —— 把它当事件源必然轮次串台。
///
/// `reqwest` 的 `send()` 在响应**头**到齐即 resolve，body 是惰性流 —— 所以
/// `drop(resp)` 就是「整体丢弃」的准确实现，不会先把整轮 SSE 拉进内存。
async fn post_prompt(http: &reqwest::Client, base: &str, secret: &str, slot_key: &str, text: &str) -> Result<(), String> {
    let resp = http.post(format!("{base}/api/chat"))
        .header("X-Internal-Secret", secret)
        .json(&serde_json::json!({ "slot": slot_key, "message": text }))
        .timeout(CHAT_POST_TIMEOUT)
        .send().await
        .map_err(|e| if e.is_timeout() {
            // 事件已从 WS 到齐；超时只是挂断那条本就要丢弃的 SSE 流，不是投递失败。
            "prompt 已投递（SSE 流超时挂断，事件走 WS）".to_string()
        } else {
            "投递 prompt 失败：Gateway 不可达".to_string()
        })?;
    let status = resp.status();
    drop(resp);
    if status.is_success() { Ok(()) } else { Err(format!("投递 prompt 被拒（HTTP {}）", status.as_u16())) }
}

/// slot 名。`zmx-` 前缀让 Gateway dashboard 一眼看出是 zeromux 建的；短 uuid 避免
/// 与用户手建的 slot 撞名。
fn new_slot_key() -> String {
    let u = uuid::Uuid::new_v4().to_string();
    format!("zmx-{}", &u[..8])
}

/// 指数退避 + 「稳定才清零」。**不 onopen 即清零**（2026-08-05 教训）：一个连上就
/// 被踢的连接（token 刚过期、Gateway 正在重启）会在 onopen 立刻把退避归零，于是
/// 每 3s 锤一次，永不升级。与前端 `AcpChatView.tsx:236-244` 的修法同构。
struct Backoff { delay: std::time::Duration }

impl Backoff {
    fn new() -> Self { Self { delay: RECONNECT_INITIAL } }
    fn next(&mut self) -> std::time::Duration {
        let d = self.delay;
        self.delay = std::cmp::min(self.delay * 2, RECONNECT_MAX);
        d
    }
    /// 只在这条连接**活过** `STABLE_AFTER` 之后才清零。做成传入「连接存活时长」
    /// 而非读时钟，所以可单测。
    fn mark_stable_if_elapsed(&mut self, connection_lived: std::time::Duration) {
        if connection_lived >= STABLE_AFTER { self.delay = RECONNECT_INITIAL; }
    }
}

enum LoopStep { Continue, Stop }

/// 退避睡眠，但仍响应 `Cmd::Stop` / 通道关闭 —— 否则删会话时要等满 60s 才收尾。
///
/// 退避期间到达的 Prompt/Cancel 会被丢掉（没有连接，也没有可靠的 slot 状态），
/// 但记一行 warn 而非静默。**不排队是刻意的** —— 排队会让「Gateway 挂了 5 分钟」
/// 变成「Gateway 恢复后突然涌进 20 条陈旧 prompt」。
async fn sleep_or_stop(dur: std::time::Duration, cmd_rx: &mut mpsc::Receiver<Cmd>) -> LoopStep {
    let deadline = tokio::time::sleep(dur);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return LoopStep::Continue,
            cmd = cmd_rx.recv() => match cmd {
                Some(Cmd::Stop) | None => return LoopStep::Stop,
                Some(_) => { tracing::warn!("crew: dropped an input received while reconnecting"); continue; }
            }
        }
    }
}

/// 串行 prompt 投递。**响应体整体丢弃**。
///
/// 存在的理由：`POST /api/chat` 空闲时**阻塞整轮**，在 `select!` 臂里 await 它会让
/// WS 读取整轮停摆 —— 帧全堆在 tungstenite 缓冲里，流式文本一个字都不出来，直到
/// 轮次结束才一次性涌出。**与 codex_process.rs:74-77 那条「回调必须 try_send，
/// await 会锁死 rmcp 的 transport reader」是同一类错误。**
async fn prompt_worker(
    cfg: CrewConfig, http: reqwest::Client,
    slot_key: String, mut rx: mpsc::Receiver<String>,
) {
    while let Some(text) = rx.recv().await {
        // **每次投递前现读 secret**（不缓存）：Gateway 每次重启都轮换
        // `run/gateway-<port>.secret`（实测 6853ccebfa39 → c1a1086f71c9），
        // 一份长期持有的 secret 在 Gateway 重启后就永久 403。这与 `Drop` 里
        // 「同步栈上现读」是同一个模式。读的是本地 0600 文件，开销可忽略。
        let secret = match read_gateway_secret(&cfg.crew_home, cfg.port) {
            Ok(sec) => sec,
            Err(e) => { tracing::warn!("crew send_prompt: {e}"); continue; }
        };
        if let Err(e) = post_prompt(&http, &cfg.http_base, &secret, &slot_key, &text).await {
            tracing::warn!("crew send_prompt: {e}");
        }
    }
}

async fn run_event_loop(
    cfg: CrewConfig, http: reqwest::Client, slot_key: String,
    event_tx: mpsc::Sender<AcpEvent>, mut cmd_rx: mpsc::Receiver<Cmd>,
) {
    let (prompt_tx, prompt_rx) = mpsc::channel::<String>(64);
    tokio::spawn(prompt_worker(cfg.clone(), http.clone(), slot_key.clone(), prompt_rx));

    let mut backoff = Backoff::new();
    let mut st = NormState::new();

    // `let exit_code = 'outer: loop {…}` 保证 Exit 恰好从一个出口发一次。
    let exit_code = 'outer: loop {
        // **每轮（重）连都现读 secret，不缓存**：Gateway 每次重启都轮换
        // `run/gateway-<port>.secret`（实测重启前后 6853ccebfa39 → c1a1086f71c9）。
        // 长期持有一份 secret 会让「Gateway 重启后会话永久 403、backoff 无限重试」
        // —— 端到端验收第 8 条抓到的真 bug。`Drop` 里本来就是同步栈上现读，
        // 「现读」是本模块已确立的模式，只是重连路径当初漏了。
        let secret = match read_gateway_secret(&cfg.crew_home, cfg.port) {
            Ok(sec) => sec,
            Err(e) => {
                if event_tx.send(AcpEvent::Error { message: e }).await.is_err() { return; }
                match sleep_or_stop(backoff.next(), &mut cmd_rx).await {
                    LoopStep::Continue => continue 'outer,
                    LoopStep::Stop => break 'outer 0,
                }
            }
        };
        // 每次（重）连都重新 mint token（廉价，且覆盖 token 被 revoke 的情形）。
        let token = match mint_ws_token(&http, &cfg.http_base, &secret).await {
            Ok(t) => t,
            Err(e) => {
                if event_tx.send(AcpEvent::Error { message: e }).await.is_err() { return; }
                match sleep_or_stop(backoff.next(), &mut cmd_rx).await {
                    LoopStep::Continue => continue 'outer,
                    LoopStep::Stop => break 'outer 0,
                }
            }
        };

        // WS 只认 `?token=`（实测 X-Internal-Secret → 403）。
        let url = format!("{}?token={}", cfg.ws_base, token);
        let connect = tokio_tungstenite::connect_async(url.as_str()).await;
        drop(url); drop(token);   // url 带 token —— 到此为止，绝不进 tracing 或事件
        let mut ws = match connect {
            Ok((ws, _resp)) => ws,
            Err(_) => {
                // **绝不格式化 tungstenite 的 Error**：它会回显请求 URL，而 URL 带 token。
                let msg = format!("Kiro Crew Gateway WS 连接失败（127.0.0.1:{}）", cfg.port);
                if event_tx.send(AcpEvent::Error { message: msg }).await.is_err() { return; }
                match sleep_or_stop(backoff.next(), &mut cmd_rx).await {
                    LoopStep::Continue => continue 'outer,
                    LoopStep::Stop => break 'outer 0,
                }
            }
        };

        // 重连后确认 slot 存活；已消失 → Error + Exit，会话需重建。
        if !slot_alive(&http, &cfg.http_base, &secret, &slot_key).await {
            let _ = event_tx.send(AcpEvent::Error {
                message: format!("Crew slot {slot_key} 已在 Gateway 侧消失，会话需重建"),
            }).await;
            break 'outer -1;
        }

        let connected_at = std::time::Instant::now();

        loop {
            tokio::select! {
                msg = ws.next() => {
                    match msg {
                        Some(Ok(WsMessage::Text(txt))) => {
                            let val: serde_json::Value = match serde_json::from_str(&txt) {
                                Ok(v) => v,
                                Err(e) => { tracing::debug!("crew: bad frame: {e}"); continue; }
                            };
                            for evt in normalize_frame(&val, &slot_key, &mut st) {
                                if event_tx.send(evt).await.is_err() { return; }
                            }
                        }
                        // Ping 由 tungstenite 在 read() 内部自动回 Pong。
                        Some(Ok(_)) => continue,
                        Some(Err(_)) | None => {
                            backoff.mark_stable_if_elapsed(connected_at.elapsed());
                            let _ = event_tx.send(AcpEvent::Error {
                                message: "Kiro Crew Gateway 连接中断，正在重连".to_string(),
                            }).await;
                            match sleep_or_stop(backoff.next(), &mut cmd_rx).await {
                                LoopStep::Continue => continue 'outer,
                                LoopStep::Stop => break 'outer 0,
                            }
                        }
                    }
                }
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(Cmd::Prompt(text)) => {
                            // 绝不 await 那个可能阻塞整轮的 POST。
                            if prompt_tx.send(text).await.is_err() {
                                tracing::warn!("crew: prompt worker gone; prompt dropped");
                            }
                        }
                        Some(Cmd::Cancel) => {
                            // detached：它绝不能排在一个正在阻塞的 Prompt POST 之后 ——
                            // 那个 POST 恰好要到轮次结束才返回，而 /stop 的全部意义
                            // 就是提前结束那一轮。
                            let (base, sec, cl, key) = (cfg.http_base.clone(), secret.clone(),
                                                        http.clone(), slot_key.clone());
                            tokio::spawn(async move {
                                if let Err(e) = stop_turn(&cl, &base, &sec, &key).await {
                                    tracing::warn!("crew stop: {e}");
                                }
                            });
                        }
                        Some(Cmd::Approval { approval_id, action }) => {
                            // 同理 detached。404 = 该审批已过期/已被别处回答，属正常。
                            let (base, sec, cl) = (cfg.http_base.clone(), secret.clone(), http.clone());
                            tokio::spawn(async move {
                                if let Err(e) = resolve_approval(&cl, &base, &sec, &approval_id, &action).await {
                                    tracing::warn!("crew approval: {e}");
                                }
                            });
                        }
                        Some(Cmd::Stop) | None => { let _ = ws.close(None).await; break 'outer 0; }
                    }
                }
            }
        }
    };

    // 终态边界（与 kiro_process.rs:373-389 的 Stop 臂同理）：没有它，fan-out 的
    // `if is_boundary` 块不触发，一个被 watchdog-Timeout 或 Cancel 的轮次不记
    // run metric —— 它在 turn_starts FIFO 里的 (start, intent) 会被搁死，与
    // Claude/Codex 的行为分叉。每条退出路径都恰好经过这里一次。
    let _ = event_tx.send(AcpEvent::Exit { code: exit_code }).await;
}

impl CrewProcess {
    pub async fn spawn(cfg: CrewConfig, work_dir: &str, init: SlotInit)
        -> Result<Self, Box<dyn std::error::Error + Send + Sync>>
    {
        let secret = read_gateway_secret(&cfg.crew_home, cfg.port)?;   // fail fast
        let http = reqwest::Client::builder()
            // Gateway 在 loopback，任何重定向都是异常；照 push.rs 的 SSRF 硬化惯例
            // 直接禁掉，免得带 secret 的头被跟到别的 host 去。
            .redirect(reqwest::redirect::Policy::none())
            .build().map_err(|e| format!("build crew http client: {e}"))?;

        let (slot_key, owns_slot, created, set_project) = match init {
            SlotInit::Resume { key, owns } => {
                if !slot_alive(&http, &cfg.http_base, &secret, &key).await {
                    return Err(format!("Crew slot 已不存在（{key}），需重建会话").into());
                }
                (key, owns, false, resume_plan(owns).set_project)
            }
            SlotInit::New { mode, agent } => {
                let k = new_slot_key();
                create_slot(&http, &cfg.http_base, &secret, slot_create_body(&k, &mode, &agent)).await?;
                let p = new_slot_plan();
                (k, p.owns, p.created, p.set_project)
            }
        };

        // project 就是 agent 的真实 cwd（实测 agent `pwd` 与设定值逐字相同）。
        // work_dir=="." 解析成绝对路径 —— Gateway 逐字传给 ACP session/new 的 cwd，
        // 相对路径无意义（照 kiro_process.rs:134-138）。
        if set_project {
            let project = if work_dir == "." {
                std::env::current_dir()?.to_string_lossy().to_string()
            } else {
                work_dir.to_string()
            };
            if let Err(e) = set_slot_project(&http, &cfg.http_base, &secret, &slot_key, &project).await {
                if created {
                    // 建了 slot 但设 project 失败 → 清掉，别留孤儿
                    delete_slot(&http, &cfg.http_base, &secret, &slot_key).await;
                }
                return Err(e.into());
            }
        }

        let (event_tx, event_rx) = mpsc::channel::<AcpEvent>(256);   // 与 kiro:164 / codex:407 同容量
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>(16);

        // 与 Kiro（kiro_process.rs:167-173）/ Codex（codex_process.rs:409-416）一致：
        // 开局一条 System{init}。session_id 填 slot_key，让 fan-out 的 resume 回填拿到它。
        let _ = event_tx.send(AcpEvent::System {
            subtype: Cow::Borrowed("init"),
            session_id: Some(slot_key.clone()),
            count: None,
        }).await;

        tokio::spawn(run_event_loop(cfg.clone(), http, slot_key.clone(), event_tx, cmd_rx));
        Ok(Self { cmd_tx, event_rx, cfg, slot_key, owns_slot })
    }

    pub fn slot_key(&self) -> &str { &self.slot_key }

    pub async fn send_prompt(&mut self, text: &str) -> Result<(), std::io::Error> {
        self.cmd_tx.send(Cmd::Prompt(text.to_string())).await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "crew loop gone"))
    }

    /// 取消当前轮次（映射到 `/stop`）。
    pub async fn interrupt(&mut self) -> Result<(), std::io::Error> {
        self.cmd_tx.send(Cmd::Cancel).await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "crew loop gone"))
    }

    pub async fn resolve_approval(&mut self, approval_id: &str, action: &str) -> Result<(), std::io::Error> {
        self.cmd_tx.send(Cmd::Approval {
            approval_id: approval_id.to_string(), action: action.to_string(),
        }).await.map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "crew loop gone"))
    }

    pub async fn kill(&mut self) { let _ = self.cmd_tx.send(Cmd::Stop).await; }
}

impl Drop for CrewProcess {
    fn drop(&mut self) {
        // 照 CodexProcess::drop（codex_process.rs:471-481）：try_send 而非 spawn，
        // 运行时关停时 spawn 的任务可能永不执行，把 cmd_tx clone 钉死在未完成的
        // future 里，循环就永远卡在 recv()。
        let _ = self.cmd_tx.try_send(Cmd::Stop);

        // R4: never delete a slot we did not create (U2).
        if !should_delete_on_drop(self.owns_slot) { return; }

        // 清远端 slot。必须 spawn（Drop 不能 await），但 secret 在 **Drop 的同步栈上**
        // 现读、再 move 进那个 future —— 不缓存在 self 里，也**不在 async 任务里做
        // 阻塞 fs 读**（生产是 JuiceFS/S3，会阻塞一个 tokio worker）。
        //
        // 已知有界泄漏：运行时正在关停、spawn 的任务没跑起来时，slot 会留在 Gateway
        // 上，下次 GET /api/chat/slots 可见。这比把 secret 常驻结构体安全，也比在
        // Drop 里 block_on 安全（会死锁 current-thread runtime）。
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        let Ok(secret) = read_gateway_secret(&self.cfg.crew_home, self.cfg.port) else { return };
        let Ok(http) = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none()).build() else { return };
        let base = self.cfg.http_base.clone();
        let slot_key = self.slot_key.clone();
        handle.spawn(async move { delete_slot(&http, &base, &secret, &slot_key).await; });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 实测抓到的 tool_call 三帧序列（真实 payload）。
    fn tool_call_frames(slot: &str) -> Vec<serde_json::Value> {
        vec![
            json!({"type":"tool_call","data":{"slot":slot,"tool":"echo TOOLTEST && date -u",
                "kind":"execute","is_shell":true,"tool_call_id":"toolu_bdrk_01QWSR",
                "purpose":"Run the exact command the user requested.",
                "input_preview":"{\"command\":\"echo TOOLTEST && date -u\"}"}}),
            json!({"type":"tool_call","data":{"slot":slot,"tool":"echo TOOLTEST && date -u",
                "tool_call_id":"toolu_bdrk_01QWSR","is_update":true}}),
            json!({"type":"tool_call","data":{"slot":slot,"tool":"echo TOOLTEST && date -u",
                "tool_call_id":"toolu_bdrk_01QWSR","is_update":true,"status":"completed"}}),
        ]
    }
    fn chunk(slot: &str, content: &str, seq: u64) -> serde_json::Value {
        json!({"type":"chat_chunk","data":{"slot":slot,"content":content,"seq":seq}})
    }
    fn done(slot: &str) -> serde_json::Value {
        json!({"type":"chat_done","data":{"slot":slot}})
    }
    fn run(frames: &[serde_json::Value], my_slot: &str, st: &mut NormState) -> Vec<AcpEvent> {
        frames.iter().flat_map(|f| normalize_frame(f, my_slot, st)).collect()
    }

    // ── T1 · I1 slot 过滤 ──
    #[test]
    fn t1_only_my_slots_frames_are_emitted() {
        // WS 是全局广播、无 per-slot 订阅，所以客户端过滤是唯一手段。
        // 漏了它 = 会话 A 的输出出现在会话 B 里（跨会话串台）。
        let mut st = NormState::new();
        let frames = vec![
            chunk("s1", "MINE-a", 1),
            chunk("s2", "THEIRS-a", 1),
            json!({"type":"tool_call","data":{"slot":"s2","tool":"rm -rf /","tool_call_id":"other"}}),
            chunk("s1", "MINE-b", 2),
            done("s2"),
        ];
        let evts = run(&frames, "s1", &mut st);
        assert_eq!(evts.len(), 2, "只有本 slot 的两个 chunk 该产出：{evts:?}");
        for e in &evts {
            match e {
                AcpEvent::ContentBlock { text: Some(t), .. } =>
                    assert!(t.starts_with("MINE"), "别的 slot 的文本泄漏了：{t}"),
                other => panic!("expected text ContentBlock, got {other:?}"),
            }
        }
        // 别的 slot 的 chat_done 绝不能把我的累积缓冲抽走（否则我的 Result 变空）。
        let mine = run(&[done("s1")], "s1", &mut st);
        match &mine[0] {
            AcpEvent::Result { text, .. } => assert_eq!(text, "MINE-aMINE-b"),
            other => panic!("expected Result, got {other:?}"),
        }
    }

    // ── T2 · 全局帧丢弃且不 panic ──
    #[test]
    fn t2_global_frames_without_slot_are_dropped_without_panicking() {
        let mut st = NormState::new();
        let globals = vec![
            json!({"type":"heartbeat"}),
            json!({"type":"heartbeat","data":{}}),
            json!({"type":"slots","data":[{"name":"s1"},{"name":"s2"}]}),
            json!({"type":"dashboard","data":{"uptime":123}}),
            json!({"type":"refresh"}),
            json!({"type":"mcp_report_update","data":{"servers":[]}}),
            json!({"type":"slot_title","data":{"title":"x"}}),
            json!({"type":"chat_segment","data":{"slot":"s1","text":"dup"}}),
            json!({"type":"chat_message_update","data":{"slot":"s1"}}),
            json!({"type":"activity_event","data":{"kind":"tick"}}),
            // 畸形帧：无 type / data 是标量 / data.slot 不是字符串。
            json!({"data":{"slot":"s1"}}),
            json!({"type":"chat_chunk","data":7}),
            json!({"type":"chat_chunk","data":{"slot":42,"content":"x"}}),
            json!(null),
        ];
        let evts = run(&globals, "s1", &mut st);
        assert!(evts.is_empty(), "全局帧/畸形帧必须全部丢弃，却产出了 {evts:?}");
        // 更强的断言：它们也不能污染累积缓冲。chat_segment / chat_message_update
        // 带着本 slot 的 slot 字段（是 chat_chunk 的重复表述），若被当正文处理，
        // Result.text 会把同一段文本渲染两次。
        let r = run(&[chunk("s1", "only", 1), done("s1")], "s1", &mut st);
        match r.last().unwrap() {
            AcpEvent::Result { text, .. } => assert_eq!(text, "only"),
            other => panic!("expected Result, got {other:?}"),
        }
    }

    // ── T3 · I2 tool_call 去重 ──
    #[test]
    fn t3_repeated_tool_call_id_renders_once() {
        let mut st = NormState::new();
        let evts = run(&tool_call_frames("s1"), "s1", &mut st);
        assert_eq!(evts.len(), 1, "同一 tool_call_id 只该产 1 个块：{evts:?}");
        match &evts[0] {
            AcpEvent::ContentBlock { block_type, name, summary, input, .. } => {
                assert_eq!(block_type.as_ref(), "tool_use");
                assert_eq!(name.as_deref(), Some("echo TOOLTEST && date -u"));
                // purpose → summary（Crew 比现有后端多给的一句）。
                assert_eq!(summary.as_deref(), Some("Run the exact command the user requested."));
                // input_preview 是字符串化的 JSON，解析回结构以便前端折叠区显示。
                assert_eq!(
                    input.as_ref().and_then(|v| v.get("command")).and_then(|v| v.as_str()),
                    Some("echo TOOLTEST && date -u")
                );
            }
            other => panic!("expected tool_use ContentBlock, got {other:?}"),
        }
        // 新一轮里同一个 id 应重新渲染（chat_done 清了去重集）。
        let _ = run(&[done("s1")], "s1", &mut st);
        let again = run(&tool_call_frames("s1"), "s1", &mut st);
        assert_eq!(again.len(), 1, "新一轮同 id 应重新渲染一次：{again:?}");
    }

    // ── T4 · I3 Result 累积 ──
    #[test]
    fn t4_result_text_is_accumulated_from_chunks() {
        // chat_done 实测只带 slot、**不带最终文本**。漏了累积 → Result.text 为空
        // → 活动看板摘要空白、auto_titler 无输入、log_result_event 不可用
        // （与 2026-07-17「Claude is_error result 空白」同型）。
        let mut st = NormState::new();
        let evts = run(&[chunk("s1", "a", 1), chunk("s1", "b", 2), done("s1")], "s1", &mut st);
        assert_eq!(evts.len(), 3, "{evts:?}");   // 2 个流式块 + 1 个 Result
        match &evts[2] {
            AcpEvent::Result { text, session_id, turn_id, .. } => {
                assert_eq!(text, "ab", "Result.text 必须由 chunk 累积而成");
                assert_eq!(session_id, "s1");   // 供 resume token 回填
                assert_eq!(*turn_id, 0);        // 进程层填 0；fan-out 用 with_turn_id 盖
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    // ── T5 · I3 跨轮缓冲清零 ──
    #[test]
    fn t5_turn_buffer_is_cleared_between_turns() {
        let mut st = NormState::new();
        let _ = run(&[chunk("s1", "a", 1), chunk("s1", "b", 2), done("s1")], "s1", &mut st);
        let second = run(&[chunk("s1", "c", 1), done("s1")], "s1", &mut st);
        match second.last().unwrap() {
            AcpEvent::Result { text, .. } => assert_eq!(text, "c", "第二轮必须是 \"c\"，不是 \"abc\""),
            other => panic!("expected Result, got {other:?}"),
        }
        // chat_error 同样要清（失败轮次的半截文本不能漏进下一轮，
        // 与 kiro_process.rs:434-441 同型修复）。
        let _ = run(&[chunk("s1", "half", 1),
                      json!({"type":"chat_error","data":{"slot":"s1","error":"boom"}})],
                    "s1", &mut st);
        let third = run(&[chunk("s1", "fresh", 1), done("s1")], "s1", &mut st);
        match third.last().unwrap() {
            AcpEvent::Result { text, .. } =>
                assert_eq!(text, "fresh", "失败轮次的 \"half\" 不得漏进下一轮"),
            other => panic!("expected Result, got {other:?}"),
        }
    }

    // ── T6 · chunk seq 乱序不丢块 ──
    #[test]
    fn t6_out_of_order_seq_appends_in_arrival_order_and_drops_nothing() {
        // `seq` 只是诊断字段，不是重组依据：按**到达序** append。若拿 seq 做
        // 去重/排序，一个非递增（重连后重编号）的序列会静默丢块 —— 那是无声的
        // 正文缺失，比乱序难查得多。
        let mut st = NormState::new();
        let frames = vec![
            chunk("s1", "one", 3),
            chunk("s1", "two", 1),
            chunk("s1", "three", 1),   // 重复 seq
            chunk("s1", "four", 0),    // 回退
            done("s1"),
        ];
        let evts = run(&frames, "s1", &mut st);
        assert_eq!(evts.len(), 5, "4 个 chunk 块 + 1 个 Result，一块都不许丢：{evts:?}");
        match evts.last().unwrap() {
            AcpEvent::Result { text, .. } =>
                assert_eq!(text, "onetwothreefour", "必须按到达序拼接"),
            other => panic!("expected Result, got {other:?}"),
        }
    }

    // ── T7 · chat_error → Error ──
    #[test]
    fn t7_chat_error_maps_to_terminal_error() {
        let mut st = NormState::new();
        let evts = run(&[json!({"type":"chat_error","data":{"slot":"s1","error":"model unavailable"}})],
                       "s1", &mut st);
        assert_eq!(evts.len(), 1);
        match &evts[0] {
            AcpEvent::Error { message } => assert!(message.contains("model unavailable"), "{message}"),
            other => panic!("expected Error, got {other:?}"),
        }
        // 字段名回落：error / message / detail 任一。
        for key in ["message", "detail"] {
            let f = json!({"type":"chat_error","data":{"slot":"s1", key:"kaboom"}});
            match &normalize_frame(&f, "s1", &mut st)[0] {
                AcpEvent::Error { message } => assert!(message.contains("kaboom"), "{message}"),
                other => panic!("expected Error, got {other:?}"),
            }
        }
        // 一个字段都没有也必须产出 Error（否则轮次永不结束、前端永远 busy）。
        let bare = json!({"type":"chat_error","data":{"slot":"s1"}});
        assert!(matches!(normalize_frame(&bare, "s1", &mut st)[0], AcpEvent::Error { .. }));
        // 别的 slot 的 chat_error 不许终结我的轮次（I1 与终态的交叉）。
        let theirs = json!({"type":"chat_error","data":{"slot":"s2","error":"not mine"}});
        assert!(normalize_frame(&theirs, "s1", &mut st).is_empty());
    }

    // ── T8 · chat_status 不刷看门狗 ──
    #[test]
    fn t8_chat_status_does_not_bump_the_silence_clock() {
        // 2026-08-05 教训：不前进的信号勿刷看门狗。Gateway 的 "Thinking…" 是心跳，
        // 一个卡死在工具调用上的轮次靠它就能把空闲看门狗永远架空
        // （F-CODEX-1-CLOCK 同型）。
        let mut st = NormState::new();
        let evts = run(&[json!({"type":"chat_status","data":{"slot":"s1","status":"Thinking…"}})],
                       "s1", &mut st);
        assert_eq!(evts.len(), 1);
        match &evts[0] {
            AcpEvent::System { subtype, .. } => assert_eq!(subtype.as_ref(), "status"),
            other => panic!("expected System, got {other:?}"),
        }
        assert!(!crew_event_is_forward_progress(&evts[0]),
            "chat_status 必须不算前进信号，否则它会刷新 last_activity_ms");
        // 真正的前进信号必须仍然算。
        let text_block = AcpEvent::ContentBlock {
            block_type: Cow::Borrowed("text"), turn_id: 0,
            text: Some("real output".into()), name: None, input: None,
            streaming: Some(true), summary: None,
        };
        assert!(crew_event_is_forward_progress(&text_block));
        assert!(crew_event_is_forward_progress(&AcpEvent::Result {
            text: "done".into(), turn_id: 0, session_id: "s1".into(),
            cost_usd: None, tokens_in: None, tokens_out: None,
        }));
        // init 那条 System 是真事件（携带 slot_key 供 resume 回填），不受影响。
        assert!(crew_event_is_forward_progress(&AcpEvent::System {
            subtype: Cow::Borrowed("init"),
            session_id: Some("s1".into()), count: None,
        }));
    }

    // ── T-extra-1 · 退避不 onopen 即清零 ──
    #[test]
    fn backoff_only_resets_after_a_connection_proves_stable() {
        let mut b = Backoff::new();
        assert_eq!(b.next(), std::time::Duration::from_secs(3));
        assert_eq!(b.next(), std::time::Duration::from_secs(6));
        // 短命连接（1s）不许清零 —— 退避必须继续升级。
        b.mark_stable_if_elapsed(std::time::Duration::from_secs(1));
        assert_eq!(b.next(), std::time::Duration::from_secs(12));
        b.mark_stable_if_elapsed(STABLE_AFTER);       // 活过 STABLE_AFTER 才清零
        assert_eq!(b.next(), std::time::Duration::from_secs(3));
        let mut c = Backoff::new();
        for _ in 0..12 { c.next(); }
        assert_eq!(c.next(), RECONNECT_MAX);          // 上限封顶
    }

    // ── T-extra-2 · context_usage / approval 映射 ──
    #[test]
    fn context_usage_and_approval_map_to_the_new_variants() {
        let mut st = NormState::new();
        let cu = json!({"type":"context_usage","data":{"slot":"s1","used":12000,"total":200000}});
        match &normalize_frame(&cu, "s1", &mut st)[0] {
            AcpEvent::ContextUsage { used, total } => assert_eq!((*used, *total), (12000, 200000)),
            other => panic!("expected ContextUsage, got {other:?}"),
        }
        // total 缺失或为 0 → 丢弃（前端会拿它做分母）。
        for bad in [json!({"type":"context_usage","data":{"slot":"s1","used":1}}),
                    json!({"type":"context_usage","data":{"slot":"s1","used":1,"total":0}})] {
            assert!(normalize_frame(&bad, "s1", &mut st).is_empty());
        }
        // 字段名照 Gateway 实测：tool_purpose / tool_input（不是 purpose / input）。
        let ap = json!({"type":"approval","data":{"slot":"s1","id":"ap-1","source":"dashboard",
            "tool":"rm -rf /tmp/build","tool_input":"{\"cmd\":\"rm -rf /tmp/build\"}",
            "tool_purpose":"Clean the build dir.","ts":1.0}});
        match &normalize_frame(&ap, "s1", &mut st)[0] {
            AcpEvent::Approval { id, tool, tool_purpose, tool_input, slot } => {
                assert_eq!(id, "ap-1");
                assert_eq!(tool, "rm -rf /tmp/build");
                assert_eq!(tool_purpose.as_deref(), Some("Clean the build dir."));
                assert!(tool_input.is_some());
                assert_eq!(slot, "s1");
            }
            other => panic!("expected Approval, got {other:?}"),
        }
        // 无 id 无法回执 → 丢弃（渲染一个点不动的卡片比不渲染更糟）。
        let no_id = json!({"type":"approval","data":{"slot":"s1","tool":"x"}});
        assert!(normalize_frame(&no_id, "s1", &mut st).is_empty());
        // 别的 slot 的 approval 不属于我（I1 对 approval 同样适用）。
        let theirs = json!({"type":"approval","data":{"slot":"s2","id":"ap-2","tool":"x"}});
        assert!(normalize_frame(&theirs, "s1", &mut st).is_empty());
    }

    // ── T-extra-3 · secret 读取的回落与错误卫生 ──
    #[test]
    fn secret_falls_back_and_errors_never_echo_content() {
        let dir = std::env::temp_dir().join(format!("crewtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("run")).unwrap();
        std::fs::write(dir.join(".local_secret"), "FALLBACKSECRET\n").unwrap();
        assert_eq!(read_gateway_secret(&dir, 5476).unwrap(), "FALLBACKSECRET");
        std::fs::write(dir.join("run").join("gateway-5476.secret"), "PRIMARYSECRET\n").unwrap();
        assert_eq!(read_gateway_secret(&dir, 5476).unwrap(), "PRIMARYSECRET");  // 首选优先，trim 尾换行
        std::fs::write(dir.join("run").join("gateway-5476.secret"), "   \n").unwrap();
        assert_eq!(read_gateway_secret(&dir, 5476).unwrap(), "FALLBACKSECRET"); // 空文件继续回落
        std::fs::remove_file(dir.join("run").join("gateway-5476.secret")).unwrap();
        std::fs::remove_file(dir.join(".local_secret")).unwrap();
        let err = read_gateway_secret(&dir, 5476).unwrap_err();
        assert!(err.contains("gateway-5476.secret") && err.contains(".local_secret"));
        assert!(!err.contains("SECRET"), "错误信息绝不能回显 secret 内容：{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── G1 · chat_message 白名单（夹具来自 S5 SP，slot 已改写为 zmxprobe）──
    const F_ACK: &str = include_str!("testdata/crew_frames_crew_ack.json");
    const F_ASK: &str = include_str!("testdata/crew_frames_crew_ask.json");
    const F_META: &str = include_str!("testdata/crew_frames_crew_meta.json");
    // constructed — no live crew_result captured (gap-research §7 S5 SP)
    const F_RESULT: &str = include_str!("testdata/crew_frames_crew_result.json");
    const F_NORMAL: &str = include_str!("testdata/crew_frames_normal_turn.json");
    fn frames(src: &str) -> Vec<serde_json::Value> { serde_json::from_str(src).expect("fixture is a JSON array") }

    #[test]
    fn g1_normal_mode_assistant_chat_message_without_kind_is_dropped() {
        // Defensive regression (spec §6.3 must-have): KC may emit an assistant chat_message in
        // normal mode when no HTTP reader is attached; letting it through double-renders
        // alongside chat_chunk.
        let mut st = NormState::new();
        let f = json!({"type":"chat_message","data":{"slot":"s1","role":"assistant","content":"dup of the chunks"}});
        assert!(normalize_frame(&f, "s1", &mut st).is_empty());
    }

    #[test]
    fn g1_crew_ack_maps_to_a_system_notice() {
        let mut st = NormState::new();
        let evts: Vec<_> = frames(F_ACK).iter().flat_map(|f| normalize_frame(f, "zmxprobe", &mut st)).collect();
        assert!(!evts.is_empty());
        for e in &evts {
            assert!(matches!(e, AcpEvent::System { subtype, session_id: None, count: None } if subtype.as_ref() == "crew_ack"), "{e:?}");
        }
    }

    #[test]
    fn g1_ask_result_meta_become_non_boundary_text_blocks_tagged_by_kind() {
        // crew_result fixture is constructed — no live crew_result captured (gap-research §7 S5 SP)
        for (src, kind) in [(F_ASK, "crew_ask"), (F_RESULT, "crew_result"), (F_META, "crew_meta")] {
            let mut st = NormState::new();
            let fs = frames(src);
            let evts: Vec<_> = fs.iter().flat_map(|f| normalize_frame(f, "zmxprobe", &mut st)).collect();
            assert_eq!(evts.len(), fs.len(), "one block per {kind} frame");
            for (e, f) in evts.iter().zip(&fs) {
                let want = f["data"]["content"].as_str().or(f["data"]["text"].as_str()).unwrap();
                match e {
                    AcpEvent::ContentBlock { block_type, text, summary, streaming, turn_id, .. } => {
                        assert_eq!(block_type.as_ref(), "text");
                        assert_eq!(text.as_deref(), Some(want));
                        assert_eq!(summary.as_deref(), Some(kind));
                        assert_eq!(*streaming, None);
                        assert_eq!(*turn_id, 0);
                    }
                    other => panic!("{kind}: expected ContentBlock (never a boundary), got {other:?}"),
                }
            }
        }
    }

    #[test]
    fn g1_crew_frames_never_enter_turn_text() {
        // Non-boundary: a crew_* body must not leak into the next chat_done's Result.
        // crew_result fixture is constructed — no live crew_result captured (gap-research §7 S5 SP)
        let mut st = NormState::new();
        let _ = normalize_frame(&chunk("zmxprobe", "a", 1), "zmxprobe", &mut st);
        for f in frames(F_RESULT).iter().chain(frames(F_ASK).iter()) { let _ = normalize_frame(f, "zmxprobe", &mut st); }
        match normalize_frame(&done("zmxprobe"), "zmxprobe", &mut st).last().unwrap() {
            AcpEvent::Result { text, .. } => assert_eq!(text, "a"),
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn g1_another_slots_crew_result_is_filtered() {
        // constructed — no live crew_result captured (gap-research §7 S5 SP)
        let mut st = NormState::new();
        for f in frames(F_RESULT) { assert!(normalize_frame(&f, "someone-else", &mut st).is_empty()); }
    }

    #[test]
    fn g1_lenient_fields_empty_bodies_and_foreign_kinds() {
        // text fallback + kind under meta (K2: upstream is experimental).
        let d = json!({"role":"assistant","text":"from text","meta":{"kind":"crew_result"}});
        assert!(matches!(&crew_message_events(&d)[..],
            [AcpEvent::ContentBlock { text: Some(t), summary: Some(k), .. }] if t == "from text" && k == "crew_result"));
        // Blank body → dropped (ack carries no body of interest and is kept).
        assert!(crew_message_events(&json!({"role":"assistant","kind":"crew_ask","content":"  "})).is_empty());
        assert_eq!(crew_message_events(&json!({"role":"assistant","kind":"crew_ack"})).len(), 1);
        // Unknown kind, user role, missing role → dropped.
        assert!(crew_message_events(&json!({"role":"assistant","kind":"crew_plan","content":"x"})).is_empty());
        assert!(crew_message_events(&json!({"role":"user","kind":"crew_result","content":"x"})).is_empty());
        assert!(crew_message_events(&json!({"kind":"crew_result","content":"x"})).is_empty());
        // Non-string junk never panics.
        assert!(crew_message_events(&json!({"role":"assistant","kind":7,"content":["x"]})).is_empty());
    }

    #[test]
    fn g1_normal_turn_fixture_still_ends_in_one_result_and_no_crew_blocks() {
        let mut st = NormState::new();
        let evts: Vec<_> = frames(F_NORMAL).iter().flat_map(|f| normalize_frame(f, "zmxprobe", &mut st)).collect();
        assert!(matches!(evts.last(), Some(AcpEvent::Result { .. })), "{evts:?}");
        assert!(!evts.iter().any(|e| matches!(e, AcpEvent::ContentBlock { summary: Some(k), .. } if k.starts_with("crew_"))));
    }

    // ── R4 · owns_slot（U2：只看持久化的 origin，禁止从 resume.is_none() 推断）──
    #[test]
    fn r4_drop_deletes_only_owned_slots() {
        assert!(should_delete_on_drop(true));
        assert!(!should_delete_on_drop(false));
    }

    #[test]
    fn r4_resume_of_a_foreign_slot_never_touches_its_project() {
        // S7 D-G6: attaching an external slot must not overwrite its cwd.
        assert!(resume_plan(true).set_project, "our own slot: re-point project on resume (unchanged behaviour)");
        assert!(!resume_plan(false).set_project, "external slot: leave its project alone");
    }

    #[test]
    fn r4_new_slot_is_owned_created_and_project_set() {
        // Review Focus 4 / M4: a freshly created slot (incl. the resume-failed fallback) is ours.
        let p = new_slot_plan();
        assert!(p.owns, "a slot zeromux creates is always owned");
        assert!(p.created);
        assert!(p.set_project);
    }

    // ── G2 · create_slot 请求体（默认逐字不变）──
    #[test]
    fn g2_default_slot_body_is_byte_identical_to_before() {
        assert_eq!(serde_json::to_string(&slot_create_body("zmx-ab12cd34", "", "")).unwrap(),
                   r#"{"name":"zmx-ab12cd34"}"#);
    }

    #[test]
    fn g2_mode_and_agent_are_added_only_when_set() {
        let b = slot_create_body("k", "crew", "");
        assert_eq!(b, json!({"name":"k","mode":"crew"}));
        let b = slot_create_body("k", "", "kirocrew-conductor");
        assert_eq!(b, json!({"name":"k","agent":"kirocrew-conductor"}));
        let b = slot_create_body("k", "crew", "kirocrew-conductor");
        assert_eq!(b, json!({"name":"k","mode":"crew","agent":"kirocrew-conductor"}));
    }
}
