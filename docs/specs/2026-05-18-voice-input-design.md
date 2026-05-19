# 语音输入（AWS Transcribe Streaming）Design Spec

- **日期**: 2026-05-18
- **作者**: keith + Claude
- **状态**: Draft，待用户复核
- **影响范围**:
  - 后端新建 `src/transcribe.rs`、`src/aws_sigv4.rs`、`src/event_stream.rs`
  - 后端修改 `src/main.rs`（路由）、`Cargo.toml`（新依赖）
  - 前端修改 `frontend/src/components/AcpChatView.tsx`
  - 前端新建 `frontend/src/components/MicButton.tsx`、`frontend/src/lib/transcribe.ts`、`frontend/src/lib/pcmWorklet.ts`
- **不影响**: 现有终端/Claude/Kiro 会话协议、笔记、Git/文件视图、systemd 服务

## 1. 目标 / 非目标

### 目标
1. 在 AcpChatView（Claude/Kiro 聊天）输入框旁加一个麦克风按钮，**按住说话**实时转写为中文文字，松开停止。
2. 转写结果只**填进 textarea，绝不自动发送**——用户审阅 / 编辑后用现有 Send 按钮发出。
3. 实时显示中间结果（partial）和确认结果（final）：partial 显示在 textarea 上方的状态条预览中，textarea 不抖动；final 才追加到 textarea。
4. 后端代理 AWS Transcribe Streaming，浏览器不直连 AWS、不暴露凭证。
5. 沿用 ZeroMux 既有体积纪律：**不引入 `aws-sdk-*`**，手写 SigV4 + EventStream，二进制增长 ≤ 1MB。
6. AWS 凭证沿用默认 chain：`AWS_ACCESS_KEY_ID/SECRET` env → AWS profile → IMDS（EC2 IAM Role），ZeroMux 不新增 CLI flag。
7. 音频与转写文本**不落盘**、不进任何日志。

### 非目标
- ❌ 不做语言切换 UI（MVP 固定 zh-CN，但协议留 `language` 字段）。
- ❌ 不做 batch（S3 中转）模式。
- ❌ 不做 Safari/旧浏览器 `ScriptProcessorNode` fallback——不支持 AudioWorklet 的浏览器整体禁用按钮 + tooltip。
- ❌ 不做 push-to-talk 之外的 toggle / VAD 模式。
- ❌ 不集成进终端（PTY 字符流场景不同，未来另谈）。
- ❌ 不做自定义词汇表（custom vocabulary / vocabulary filter）。
- ❌ 不做转写 history / 回放——一次按下 = 一段独立文字，不持久化。
- ❌ 不做断流自动续接（AWS 不支持，见 §6）。

## 2. 背景

### 现状
ZeroMux AcpChatView 输入框是一个 `<textarea>` + Send 按钮（`src/components/AcpChatView.tsx:230-252`）。所有 prompt 都靠手打。

### AWS Transcribe Streaming 协议要点
AWS Transcribe Streaming 提供两条通路：

1. **SDK 路径**：`aws-sdk-transcribestreaming`（HTTP/2 双向流），自带 SigV4、EventStream 编解码、重试。
2. **原生 WebSocket 协议**：URL 用 SigV4 presign（query 字符串带签名），body 走 [Amazon EventStream binary framing](https://docs.aws.amazon.com/transcribe/latest/dg/event-stream.html)。每个 audio chunk 一帧、每条 transcript event 一帧。

ZeroMux 已经依赖 `reqwest+rustls`、`tokio`、`sha2`、`hex`，加 `tokio-tungstenite`、`hmac` 即可走原生 WebSocket，**不引入 `aws-sdk-*` 整套生态**。原生协议在网上有多套参考实现（[aws-samples/amazon-transcribe-websocket-static](https://github.com/aws-samples/amazon-transcribe-websocket-static) 等），协议本身稳定（v1 多年未变）。

### 为什么不用 AWS SDK
- `aws-config` + `aws-sdk-transcribestreaming` 加上 hyper / h2 / aws-smithy 一整套，release 二进制估算涨 8–15 MB。ZeroMux 当前二进制 ~11 MB（含 mermaid lazy chunk 后），引 SDK 会再翻一倍量级，破坏单文件部署的体积纪律。
- 需要的功能很窄：开一条流、推 PCM、收 transcript。SDK 抽象层带来的复杂度不抵省下的代码量。

## 3. 架构总览

```
┌─────────────────────────────── 浏览器 ─────────────────────────────┐
│                                                                    │
│  AcpChatView                                                       │
│   ├─ textarea                                                      │
│   ├─ partial 状态条 (录音中显示，灰色 italic)                      │
│   ├─ MicButton  ── pointerdown / pointerup ──► useTranscribe()     │
│   └─ Send 按钮（仍由用户主动点击发送，永不自动发）                 │
│                                                                    │
│  useTranscribe()                                                   │
│   ├─ getUserMedia({ audio: { sampleRate:16000, channelCount:1 }})  │
│   ├─ AudioContext + AudioWorkletNode (Blob URL inline 加载)        │
│   │    └─ pcmWorklet：48k → 16k 重采样 + Float32→Int16 PCM         │
│   └─ WebSocket /ws/transcribe                                      │
│        ├─ 上行：第一帧 JSON {"type":"start","language":"zh-CN"}    │
│        │       后续二进制 PCM 帧 (~100ms / 3200B 一帧)             │
│        │       结束帧 JSON {"type":"stop"}                         │
│        └─ 下行：JSON {"type":"partial"|"final"|"error", text|msg}  │
└────────────────────────────────────┬───────────────────────────────┘
                                     │ WebSocket (内网/同域)
                                     ▼
┌──────────────────────────── ZeroMux 后端 ──────────────────────────┐
│                                                                    │
│  Axum router                                                       │
│   └─ GET /ws/transcribe (auth required, JWT cookie)                │
│        └─ src/transcribe.rs::transcribe_ws                         │
│             ├─ 收浏览器 PCM 帧 (mpsc → tokio task)                 │
│             ├─ 调 src/aws_sigv4.rs::presign_transcribe_url()       │
│             ├─ tokio_tungstenite::connect_async(presigned_url)     │
│             ├─ 上行：src/event_stream.rs::encode_audio_event(pcm)  │
│             ├─ 下行：src/event_stream.rs::decode_event_message()   │
│             │      → TranscriptEvent JSON → 转回前端              │
│             └─ 错误统一映射为 {"type":"error", message}            │
└────────────────────────────────────┬───────────────────────────────┘
                                     │ WSS (region 端点 SigV4 presigned)
                                     ▼
                        AWS Transcribe Streaming
                  (transcribestreaming.<region>.amazonaws.com)
```

### 关键设计决策

1. **后端代理而非前端直连**：浏览器没有现成的 SigV4 流签名 SDK，前端直连要么引重 SDK、要么自己写签名。后端代理一次性把这件事做好，前端只用一条同域 WS。
2. **WS endpoint 不绑定 session_id**：语音流是私人输入、与会话广播无关。`/ws/transcribe` 是单 WS = 单语音流，互相独立。未来若要给笔记/其他输入复用，路径直接复用。
3. **无 fan-out，无滚动缓冲**：和现有 `/ws/term/{id}` / `/ws/acp/{id}` 不一样，语音 WS 是 1:1 的私有通道，不广播、不重放、断了就重新按一下按钮。
4. **AWS 客户端在每条 WS 现连现关**：不持有长连接池。push-to-talk 一次按住通常 < 30 秒，连接成本可忽略；好处是凭证刷新、错误隔离都自然解决。
5. **AudioWorklet inline 加载**：worklet 源码作为 TS 字符串内联进 bundle，运行时 `URL.createObjectURL(new Blob([code], {type:'application/javascript'}))` 喂 `audioContext.audioWorklet.addModule(blobUrl)`。无需 Vite 单独配置 worklet 入口、无需额外资源文件，符合"前端零新增依赖"。

## 4. 后端设计

### 4.1 `src/transcribe.rs`

公开一个 axum handler，**WS auth 模式与现有 `/ws/term/{id}` 完全一致**——不挂 middleware，handler 内部从 query 取 token、调 `auth::verify_ws_token` 校验：

```rust
#[derive(serde::Deserialize)]
pub struct WsQuery { token: Option<String> }

pub async fn transcribe_ws(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let authed = query.token.as_deref()
        .and_then(|t| auth::verify_ws_token(&state, t))
        .is_some();
    if !authed {
        return Response::builder().status(401).body(Body::empty()).unwrap();
    }
    ws.on_upgrade(|socket| handle_socket(socket, state))
}
```

`handle_socket` 内部状态机：

```
Idle
  └─ 收到 {"type":"start", language} → 进入 Connecting

Connecting
  ├─ 调 aws_sigv4::presign_transcribe_url(language, region, creds)
  ├─ tokio_tungstenite::connect_async(url)
  ├─ 成功 → 进入 Streaming
  └─ 失败 → 发 {"type":"error", message}, 关 WS

Streaming
  ├─ 浏览器 binary 帧（PCM）→ event_stream::encode_audio_event → AWS WS send
  ├─ AWS WS recv → event_stream::decode → 解出 TranscriptEvent
  │     ├─ Results[0].IsPartial=true  → {"type":"partial", text}
  │     └─ Results[0].IsPartial=false → {"type":"final",   text}
  ├─ 浏览器 {"type":"stop"} → 发 EndOfStream 帧、关 AWS WS、保留浏览器 WS 等下游收尾
  └─ 浏览器 ws close / 任意一侧错误 → 关另一侧

任意状态遇错 → 发 {"type":"error", message}（best effort），关 WS
```

实现要点：
- 用两个 `tokio::spawn` 并发驱动「浏览器 → AWS」和「AWS → 浏览器」方向，通过 `tokio::select!` 主任务收尾。
- 错误包装：`anyhow::Error` 内部统一类型，到 WS 边界转 `{"type":"error", message: e.to_string()}`。**不暴露内部栈帧/凭证细节**——`message` 仅含简短描述（"AWS connection failed"、"microphone protocol error" 等），详细错误进 `tracing::error!`。
- 不接 `logger.rs`：转写不参与会话日志，二进制 PCM 帧任何时候都不写文件、不进 SQLite。

### 4.2 `src/aws_sigv4.rs`

最小化 SigV4 presigner，只服务 Transcribe Streaming WebSocket：

```rust
pub struct AwsCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,  // STS / IAM Role 临时凭证有
}

/// 解析默认 credential chain：
///   1. env: AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN
///   2. shared config: ~/.aws/credentials [default] (含 ~/.aws/config 的 region)
///   3. IMDSv2: http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>
pub async fn load_default_credentials() -> Result<(AwsCredentials, String /*region*/)>;

/// 生成 wss://transcribestreaming.<region>.amazonaws.com:8443/stream-transcription-websocket
/// ?language-code=zh-CN&media-encoding=pcm&sample-rate=16000
/// &X-Amz-Algorithm=AWS4-HMAC-SHA256&...&X-Amz-Signature=...
pub fn presign_transcribe_url(
    creds: &AwsCredentials,
    region: &str,
    language: &str,        // "zh-CN"
    sample_rate: u32,      // 16000
    expires_seconds: u32,  // 300（一段流够长，AWS 限 ≤ 5 min presign）
) -> Result<String>;
```

实现走 [AWS SigV4 query-string presign 标准](https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html)：
- `service = "transcribe"`
- `host = transcribestreaming.<region>.amazonaws.com:8443`
- `path = "/stream-transcription-websocket"`
- canonical request 包含上述 query 参数（按字典序），payload hash 用 `UNSIGNED-PAYLOAD`（流式专用）
- string-to-sign + 4 步 HMAC-SHA256 derive signing key
- 输出完整 wss URL

依赖：`hmac = "0.12"`、`sha2`（已有）、`hex`（已有）。

凭证解析：
- env 部分：`std::env::var`，零依赖。
- shared config：MVP 只解析 `[default]` profile（行解析，~30 行手写），不支持 `assume_role`、`source_profile` 等高级功能。
- IMDSv2：用现有 `reqwest` 调 `PUT /latest/api/token` + `GET /latest/meta-data/iam/security-credentials/<role>`，~50 行，含 1 秒超时（不在 EC2 上时快速跳过）。

`AwsCredentials` 在每条 WS 启动时重新加载（`load_default_credentials().await`），保证 IMDS 临时凭证刷新被自然吸纳。**不缓存凭证**。

### 4.3 `src/event_stream.rs`

[Amazon EventStream binary framing](https://docs.aws.amazon.com/transcribe/latest/dg/event-stream.html) 的最小子集：

```
Frame layout (大端序):
  ┌──────────────────────────────────────────────────┐
  │ Prelude (12 字节)                                │
  │   total_length    : u32  整帧字节数              │
  │   headers_length  : u32  headers 区字节数        │
  │   prelude_crc     : u32  上面 8 字节的 CRC32     │
  ├──────────────────────────────────────────────────┤
  │ Headers (headers_length 字节)                    │
  │   反复出现：                                     │
  │     header_name_len : u8                         │
  │     header_name     : utf8                       │
  │     header_value_type: u8   (7 = string)         │
  │     header_value_len: u16  + header_value: utf8  │
  ├──────────────────────────────────────────────────┤
  │ Payload (total_length - headers_length - 16)     │
  ├──────────────────────────────────────────────────┤
  │ message_crc       : u32  整帧（除自身）的 CRC32  │
  └──────────────────────────────────────────────────┘
```

Public API：

```rust
/// 编码一帧 AudioEvent：headers = [":message-type":"event", ":event-type":"AudioEvent",
/// ":content-type":"application/octet-stream"]; payload = pcm bytes
pub fn encode_audio_event(pcm: &[u8]) -> Vec<u8>;

/// 解码一帧 message。返回 Event（含 TranscriptEvent payload JSON）或 Exception
pub enum DecodedFrame {
    TranscriptEvent(TranscriptEvent),  // 含 IsPartial + Alternatives[0].Transcript
    BadRequestException { message: String },
    InternalFailureException { message: String },
    LimitExceededException { message: String },
    ConflictException { message: String },
    ServiceUnavailableException { message: String },
    Other { message_type: String, payload: Vec<u8> },  // 未来扩展兜底
}
pub fn decode_event_message(buf: &[u8]) -> Result<DecodedFrame>;

#[derive(serde::Deserialize)]
pub struct TranscriptEvent { /* AWS schema 子集，仅取需要字段 */ }
```

CRC32 用 `crc32fast`（~80KB 编译产物，单一 crate，独立、无递归依赖）。或者手写 IEEE CRC32（~30 行 + 表）省一个依赖——MVP 选 `crc32fast` 简单可靠。

### 4.4 路由注册（`src/web.rs::build_router` 改动）

加到现有 `ws` 子 router 里（与 `/ws/term/{id}`、`/ws/acp/{id}` 同组，**无 middleware**，handler 内部 token 校验）：

```rust
let ws = Router::new()
    .route("/ws/term/{session_id}", get(crate::ws_handler::ws_terminal))
    .route("/ws/acp/{session_id}", get(crate::acp::ws_handler::ws_acp))
    .route("/ws/transcribe",       get(crate::transcribe::transcribe_ws));  // ← 新增
```

**不**新增 CLI flag——region 和凭证全走默认 chain（`AWS_REGION` env / `~/.aws/config` / IMDS region）。如果 region 解析不出来，`load_default_credentials` 返回错误，前端收到 `{"type":"error","message":"AWS region not configured"}`。

`src/main.rs` 仅在 `mod` 列表里加 `mod transcribe; mod aws_sigv4; mod event_stream;`。

### 4.5 `Cargo.toml` 新增依赖

```toml
# axum 0.8 已传递依赖 tokio-tungstenite 0.29 / tungstenite 0.29——pin 同 minor 版本
# 避免 dual compile（实测 Cargo.lock 已含 tokio-tungstenite 0.29.0）
tokio-tungstenite = { version = "0.29", features = ["rustls-tls-native-roots"] }
hmac = "0.12"
crc32fast = "1"
```

预估二进制增长（release，opt-level=z + lto + strip）：
- `tokio-tungstenite`：复用 `tokio` + `rustls`，净增 ~150 KB
- `hmac`：~30 KB
- `crc32fast`：~10 KB
- 自写代码（transcribe + sigv4 + event_stream）：~300 行 ≈ ~80 KB

**总计目标：≤ 300 KB，远低于「≤ 1MB」纪律线**。如果实测超 1MB，回到设计阶段。

## 5. 前端设计

### 5.1 文件布局

```
frontend/src/
  ├─ components/
  │   ├─ AcpChatView.tsx        # 改：插入 MicButton + partial 预览条
  │   └─ MicButton.tsx          # 新：pointer 事件 + 状态指示
  └─ lib/
      ├─ transcribe.ts          # 新：useTranscribe() hook，封装 WS + AudioContext
      └─ pcmWorklet.ts          # 新：导出 worklet 源码字符串
```

### 5.2 `lib/pcmWorklet.ts`

把一段 worklet 源码作为字符串导出。worklet 内部：

- 输入采样率：浏览器决定（通常 48000 Hz）
- 重采样到 16000 Hz：用「按比例丢点」的简单线性插值（语音质量足够，AWS 服务端会再做声学处理）
- Float32 → Int16：`Math.max(-1, Math.min(1, sample)) * 0x7FFF | 0`
- 缓冲到 ~100ms（1600 samples = 3200 字节）后 `port.postMessage(int16ArrayBuffer)`

主线程拿到 ArrayBuffer，原样 `ws.send(buffer)`。

### 5.3 `lib/transcribe.ts`：`useTranscribe()` hook

```ts
interface UseTranscribeReturn {
  isRecording: boolean
  partial: string             // 状态条显示这个
  error: string | null        // 状态条出错时显示
  start: () => Promise<void>  // pointerdown 调用
  stop: () => void            // pointerup / pointerleave 调用
  supported: boolean          // false → MicButton disabled + tooltip
}

interface UseTranscribeOptions {
  language?: string                       // 默认 "zh-CN"
  onFinal: (text: string) => void         // final 文本，调用方自行追加进 textarea
}

export function useTranscribe(opts: UseTranscribeOptions): UseTranscribeReturn
```

内部状态机：

```
idle → start() → requesting-mic → connecting-ws → streaming
                       │                │              │
                       └─ deny ─────────┴─ ws-error ───┴─ stop() / error
                                                       ▼
                                                     idle
```

要点：
- `supported = 'audioWorklet' in (window.AudioContext?.prototype ?? {}) && navigator.mediaDevices?.getUserMedia`
- AudioContext 用 `new AudioContext({ sampleRate: 16000 })`——浏览器若拒绝（少数老 Safari），fallback 到默认采样率，由 worklet 内部重采样。
- WebSocket URL：直接调 `lib/api.ts` 现有的 `wsUrl('/ws/transcribe')`，它已经处理了 `http→ws`/`https→wss` 切换 + `?token=...` 拼接（与 `/ws/term/{id}` 走同一函数）。
- 收到 `{"type":"final"}` 立刻清空当前 partial、回调 onFinal。
- 收到 `{"type":"error"}` 设 error、清 partial、stop()。
- stop()：发 `{"type":"stop"}` JSON、close WS、关 AudioContext + MediaStream tracks。所有清理路径都要 idempotent，避免「按按钮太快」竞态。

### 5.4 `MicButton.tsx`

```tsx
interface MicButtonProps {
  isRecording: boolean
  supported: boolean
  onPressStart: () => void
  onPressEnd: () => void
}
```

- 用 lucide `Mic` / `MicOff` 图标
- `onPointerDown` 触发 `onPressStart`，捕获 pointer：`(e.target as HTMLElement).setPointerCapture(e.pointerId)`
- `onPointerUp` / `onPointerCancel` / `onPointerLeave` 触发 `onPressEnd`
- `supported=false` 时：`disabled` + `title="浏览器不支持 AudioWorklet，无法使用语音输入"`
- `isRecording=true`：按钮变红，加 CSS pulse 动画（纯 CSS keyframes，不引动画库）
- 阻止文本选择 / 拖拽：CSS `user-select: none; touch-action: manipulation`

### 5.5 `AcpChatView.tsx` 改动

只动两块：

**a) 输入区结构**（约 line 229-253 现有 `<div className="flex gap-2 ...">`）改为：

```tsx
<div className="flex flex-col px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
  {(transcribe.partial || transcribe.error) && (
    <div className="px-2 pb-1 text-xs italic text-[var(--text-muted)]">
      {transcribe.error
        ? <span className="text-[var(--accent-red)]">⚠ {transcribe.error}</span>
        : transcribe.partial}
    </div>
  )}
  <div className="flex gap-2">
    <textarea ... />                   {/* 现有 */}
    <MicButton
      isRecording={transcribe.isRecording}
      supported={transcribe.supported}
      onPressStart={transcribe.start}
      onPressEnd={transcribe.stop}
    />
    <button onClick={sendPrompt} ... > {/* 现有 Send */}
  </div>
</div>
```

**b) hook 调用**：

```tsx
const transcribe = useTranscribe({
  language: 'zh-CN',
  onFinal: (text) => {
    setInput(prev => prev + text)   // 中文场景直接拼接，不强行加空格
    // textarea 高度需重新计算：把现有 onInput 里的 autoResize 逻辑抽成一个函数，这里也调一次
  },
})
```

textarea 自动高度的代码现在写在 `onInput` 里（line 239-243）；为了从 `onFinal` 也能触发，抽成 `autoResize(t: HTMLTextAreaElement)`，两边都调。**这是允许的「服务于当前目标的局部清理」**——onFinal 必须能更新 textarea 高度，否则文本插入后高度卡死。

### 5.6 不破坏现有交互

- 录音中 textarea **不禁用**：用户可以同时打字。final 追加点固定在 **textarea 末尾**（不是光标位置），更可预测，符合 push-to-talk 用法："说一段、看一眼、改一改、再说一段"。
- 录音中 Enter 仍发送（沿用现有 onKeyDown）：用户能一边按住 Mic 一边按 Enter 发当前内容。这是明确的设计决策，**不**为录音状态做特殊禁用。
- 历史消息的 MarkdownContent 不受影响。

## 6. 错误处理与边界

### 6.1 错误矩阵

| 失败点 | 表现 | 用户看到 |
|---|---|---|
| 浏览器不支持 AudioWorklet | hook `supported=false` | MicButton 禁用 + tooltip |
| 用户拒绝麦克风权限 | `getUserMedia` reject | 状态条红字"需要麦克风权限" |
| `/ws/transcribe` 401（未登录 / token 过期）| HTTP 401 在 WS upgrade 前返回，浏览器看到 ws.onerror+onclose | 状态条"未登录，请刷新页面" |
| AWS 凭证缺失（默认 chain 全失败）| 后端首次 presign 抛错 → `{"type":"error","message":"AWS credentials not configured"}` | 状态条原样显示后端 message |
| AWS region 缺失 | 同上，message 改"AWS region not configured" | 同上 |
| AWS Transcribe 限流 / 服务异常 | 后端解 LimitExceededException / ServiceUnavailableException → error 帧 | 状态条原样显示 |
| 网络抖动 → 浏览器→后端 WS 断 | hook 监听 ws.onclose，stop()、保留 textarea 已有 final | 状态条显示"连接已断开，请重新按住" |
| 网络抖动 → 后端→AWS WS 断 | 后端发 error 帧、关浏览器 WS | 同上 |
| AWS 4 小时单流上限 | 不处理（push-to-talk 不会触达，按断流处理足够）| — |

**错误清空规则**（统一）：所有 error 显示后**保持**直到用户下一次 `start()`（pointerdown）时清空。不做基于时间的自动消失——避免用户没注意到错误就被自动隐藏。

### 6.2 断流不自动续接

**AWS Transcribe Streaming 不支持续接旧 session**：每次 WS 建连都是一段全新的 stream，旧流积累的语境（语言模型 / 句段边界）无法保留。所以：

- WS 任意一侧断 → hook 进 idle 态，partial 清空，textarea 已写入的 final 文本**保留**。
- 用户重新按住 MicButton = 一段新流。这是产品上能接受的：push-to-talk 一次说一句，一句被中断重说一遍代价低。

不要为了"看起来更智能"做自动重连——会让 partial 反复重置、用户困惑。

### 6.3 隐私

- 浏览器→后端 PCM 帧：内存 → AWS WS，**永不落盘**。
- 后端→浏览器 transcript JSON：内存中转，**永不落盘**。
- `tracing::error!` 错误日志只记类型 / 简短描述，**不记**音频 bytes、不记 transcript 文本。
- `--log-dir` 选项原本就是会话 PTY/ACP I/O 日志，与本 WS 完全独立，不接入。

## 7. 协议定义（前后端 WS 帧格式）

### 浏览器 → 后端

```
Frame 1 (text):  {"type":"start","language":"zh-CN"}
Frame 2..N (binary):  Int16 PCM, 16kHz mono, little-endian, 任意切分
Frame N+1 (text):  {"type":"stop"}    -- 可选，WS close 也视同 stop
```

### 后端 → 浏览器

```
{"type":"partial", "text":"你好世"}        -- 可重复，每次内容会被替换
{"type":"final",   "text":"你好世界。"}   -- 一段确认结果，append 进 textarea
{"type":"error",   "message":"..."}       -- 错误，前端清 partial、回 idle
```

### 不变量

1. `language` 字段在 MVP 必须为 `"zh-CN"`，未来扩展不破协议。
2. `start` 帧必须是第一帧，否则后端关 WS。
3. `partial` 之间没有"清空"指令——前端总是用最新 `partial.text` 覆盖显示。
4. 一段 `final` 不会被后续 `partial` 撤销。

## 8. 测试策略

### 8.1 后端单测

```
tests 模块或独立 #[cfg(test)] 块
├─ event_stream
│   ├─ encode_audio_event：长度、CRC、headers 都对
│   ├─ decode_event_message：合法 TranscriptEvent
│   ├─ decode 未知 message-type → DecodedFrame::Other
│   └─ decode CRC 不匹配 → Err
├─ aws_sigv4
│   ├─ presign_transcribe_url：固定时间戳 + 固定凭证 → 已知签名 string（用 AWS 文档 test vector）
│   └─ 解析 ~/.aws/credentials [default] 简单格式
└─ transcribe（协议状态机）
    ├─ 未发 start 直接发 binary → 关 WS（内部状态校验）
    └─ start → stop 不发任何 audio → 干净结束
```

**不写**集成测试触达真实 AWS（需要凭证、有费用、不稳定）。

### 8.2 前端单测（vitest，已有基础设施）

```
frontend/src/lib/transcribe.test.ts
├─ supported=false 时调 start() 应是 no-op
├─ WS 收到 {"type":"final"} → onFinal 被回调
├─ WS 收到 {"type":"partial"} → partial state 更新
└─ stop() 后 partial / error 清空

frontend/src/components/MicButton.test.tsx
├─ supported=false → disabled + tooltip 文本
├─ onPointerDown 触发 onPressStart
└─ onPointerUp / onPointerLeave 触发 onPressEnd
```

**不测**：AudioWorklet（happy-dom 不实现 AudioContext）、真实 WS、真实 AWS。

### 8.3 手动验收清单（PR 合入硬指标）

```
□ 1.  设好 AWS_REGION + 默认凭证，按住 Mic 说"你好世界"        → final 出现"你好世界"在 textarea
□ 2.  说一长句中文                                              → 状态条 partial 滚动，松手后 final 落入 textarea
□ 3.  textarea 已有"前面打的字"，按住说"接着说的"               → 末尾追加，前面文字不丢
□ 4.  按住 Mic 中途松手（很短）                                  → idle，无报错
□ 5.  浏览器拒绝麦克风权限                                       → 状态条红字提示，3s 后消
□ 6.  退出登录后再按 Mic                                         → 状态条"未登录，请刷新页面"
□ 7.  断网后按 Mic                                               → 状态条 ws 错误
□ 8.  AWS 凭证故意改坏（错的 secret），按 Mic                    → 状态条显示后端 error
□ 9.  Safari 14 之前的浏览器（或在 DevTools 关 audioWorklet）    → MicButton disabled + tooltip
□ 10. 按住 Mic 同时打字                                          → 不冲突，键盘照常输入
□ 11. 按住 Mic 期间按 Enter                                      → 当前 textarea 内容发出，录音继续
□ 12. 录音过程切换到 Notes/Git 视图再切回                        → 沿用现有 CSS 可见性切换，状态保留
□ 13. 检查 ZeroMux 日志（含 --log-dir）                          → 无 PCM 字节、无 transcript 文本
□ 14. 检查 release 二进制大小                                    → 增长 ≤ 1 MB（vs feat/md-rendering 基线 ~11 MB）
```

第 1、2、14 是硬指标，其余为体验保障。

## 9. 包体与编译影响

### 9.1 后端 release 二进制

| 项 | 现状（feat/md-rendering 后） | 新增 |
|---|---|---|
| 二进制 | ~11 MB | + ≤ 1 MB（目标） |
| 编译 deps | 26 | +3（tokio-tungstenite, hmac, crc32fast） |

`tokio-tungstenite` 是其中最大的一项（~150KB after lto+strip），但与 ZeroMux 现有 axum WS 实现共享 `tungstenite-rs` 底层（axum 内部用），有一定符号 dedupe 空间。

如果实测 > 1 MB，复盘选项：
1. 用 `tungstenite-rs` 直接（去掉 tokio 适配层），自己包 tokio 任务。
2. 改用 raw `tokio::net::TcpStream + rustls + 手写 ws upgrade`。

MVP 不预先做这两步——先用 `tokio-tungstenite` 量出来再说。

### 9.2 前端 bundle

零新增 npm 依赖。预估 gzipped + ~5 KB（hook + Component + worklet 源码字符串）。

## 10. 已知风险

| 风险 | 应对 |
|---|---|
| EventStream / SigV4 手写实现 corner case bug | 用 AWS 文档 test vectors 锁住 sigv4；event_stream 帧用真实 AWS 抓包对照（可一次性手测获取） |
| AWS Transcribe 协议未来变更 | 单元测试 + version-pin region endpoint。AWS streaming v1 至少 5 年未变，风险低 |
| 浏览器 16kHz AudioContext 不被支持 → 用默认采样率重采样质量略差 | AWS 服务端 frontend 处理较强，实测一般可用；不可用时降级到 8kHz 不在范围 |
| 用户在公共 Wi-Fi 上语音 → AWS 调用走互联网，有人嗅探？ | 全程 wss + SigV4 加密。后端到 AWS 也是 wss。隐私保证已足够。 |
| Push-to-talk 在移动端长按手感（部分系统会弹 context menu） | CSS `user-select:none + touch-action:manipulation + -webkit-touch-callout:none` 已规避大半 |
| AWS Transcribe 中文识别准确度边角（专有名词、混入英文） | 不在 MVP 范围，未来引入 vocabulary filter / custom vocabulary |
| `tokio-tungstenite` 与 axum 0.8 内部使用的 `tungstenite-rs` 版本不一致 → 编译进两个版本，二进制翻倍增长 | 实现第一步：`cargo tree -i tungstenite` 确认版本对齐；`Cargo.toml` 显式 pin 一致 minor 版本 |

## 11. 验收标准

§8.3 第 1、2、14 项硬指标。其余为体验保障。

## 12. 实现拆分建议（交给 writing-plans）

按"每步独立可验证 = 1 commit"拆：

1. **后端基础**：`event_stream.rs` + 单测（无网络）
2. **后端基础**：`aws_sigv4.rs` + 单测（用 AWS 文档 test vector）
3. **后端基础**：默认 credential chain 解析（env / shared config / IMDS）
4. **后端集成**：`transcribe.rs` handler + 路由注册（先 stub 不真连 AWS，验证 WS upgrade + auth）
5. **后端集成**：接通真实 AWS Transcribe，过手动验收 1+2
6. **前端基础**：`pcmWorklet.ts` + `transcribe.ts` hook（不连 UI，单测覆盖状态机）
7. **前端基础**：`MicButton.tsx` + 单测
8. **前端集成**：AcpChatView 接入，过手动验收 1-13
9. **隐私 + 体积验收**：日志检查、二进制 size 测量
10. **文档**：README_ZH.md 加一节"语音输入"，README.md 同步

每步独立可验证，建议 1 步 = 1 commit / 1 小段 PR。
