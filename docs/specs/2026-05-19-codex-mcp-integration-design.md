# Codex CLI（MCP）接入 Design Spec

- **日期**: 2026-05-19
- **作者**: keith + Claude
- **状态**: Draft，待用户复核
- **影响范围**:
  - 后端新建 `src/acp/codex_process.rs`
  - 后端修改 `src/acp/mod.rs`、`src/session_manager.rs`、`src/web.rs`、`src/main.rs`
  - 修改 `Cargo.toml`（新增 `rmcp` 依赖）
  - 前端修改 `frontend/src/lib/api.ts`、`frontend/src/components/Sidebar.tsx`、`frontend/src/components/AcpChatView.tsx`
- **不影响**: PTY/tmux 会话、Claude Code 会话、Kiro 会话、笔记、Git/文件视图、WebSocket 路由、scrollback / 多客户端广播、认证 / OAuth / systemd 服务

## 1. 目标 / 非目标

### 目标

1. 在 zeromux 中支持把 **OpenAI Codex CLI** 作为第三种 AI agent 会话类型，与 Claude Code / Kiro **平级共存**。
2. 通过 `codex mcp-server` 子命令以 MCP（Model Context Protocol）协议对接 Codex，**不使用** `codex exec --json`、**不使用** `codex app-server`（实验性）。
3. 用 [`rmcp`](https://crates.io/crates/rmcp) 官方 Rust MCP SDK 做客户端——OpenAI Codex 自身在 `codex-rs/rmcp-client/` 也用 `rmcp`，与上游对齐。
4. 复用现有抽象：`AcpEvent` 事件枚举、`/ws/acp/{id}` WebSocket 路径、scrollback ring buffer、broadcast 多客户端、前端 `AcpChatView`——**前端不感知 Codex 是 MCP**。
5. 多轮对话：通过 Codex MCP 的 `threadId` 维持上下文；首轮调 `tools/call("codex")`，续轮调 `tools/call("codex-reply")`。
6. 取消语义：用 MCP `notifications/cancelled` 中止当前轮，**保留 thread_id**，用户可继续追问。
7. 默认 sandbox 等级 `danger-full-access`、`approval-policy: "never"`，对齐 Claude `--dangerously-skip-permissions` / Kiro `--trust-all-tools` 的"无人值守"哲学。

### 非目标

- ❌ 不做 sandbox 等级前端 UI 选择（与 Claude / Kiro 一致，后端硬写）。
- ❌ 不做 Codex 登录 UI（不内嵌 `codex login`），由运维在 zeromux 主机上预先登录或注入 `CODEX_API_KEY` env。
- ❌ 不做 `codex exec --json` 兜底通路（YAGNI；rmcp + mcp-server 协议稳定，无需双后端）。
- ❌ 不做 `--model` / `--profile` 前端可选（如需，后期通过 CLI flag 提供，不进 UI）。
- ❌ 不抽象 `AgentProcess` trait 复用 Claude/Kiro fan-out（值得做，但作为独立重构 PR，不绑在本功能里）。
- ❌ 不把 Kiro 的 cancel 也升级到 `notifications/cancelled`（同上，独立 PR）。
- ❌ 不持久化 `thread_id`：进程内存 only，重启后新会话开新 thread。
- ❌ 不引入 dev-deps 测试基建（仓库现状无 CI 测试）；只加少量纯函数 inline `#[test]`。

## 2. 背景

### 2.1 现状

zeromux 当前通过 `src/acp/` 目录支持两种 AI agent 会话：

| Agent | 协议 | 启动命令 | 实现文件 |
|---|---|---|---|
| Claude Code | Anthropic stream-json (NDJSON 单向) | `claude -p --output-format stream-json --input-format stream-json --verbose --dangerously-skip-permissions` | `src/acp/process.rs` |
| Kiro | ACP（JSON-RPC 2.0 over stdio，双向） | `kiro acp --trust-all-tools` | `src/acp/kiro_process.rs` |

二者都把异构协议事件翻译成统一的 `AcpEvent` 枚举（`src/acp/process.rs:14`），通过 `session_manager.rs` 的 broadcast channel 扇出到 `/ws/acp/{id}` WebSocket，前端 `AcpChatView.tsx` 渲染。两条会话共用同一 WS 路径，按 `SessionType` 在 `session_manager` 里分发。

### 2.2 Codex MCP 协议要点

`codex mcp-server`（OpenAI Codex CLI 的子命令，stable）通过 stdin/stdout 跑标准 **MCP 协议**（底层 JSON-RPC 2.0），暴露 **2 个 MCP 工具**：

| 工具 | 用途 | 关键入参 | 输出 |
|---|---|---|---|
| `codex` | 开新对话 | `prompt`（必填）, `cwd`, `sandbox` ∈ {`read-only`, `workspace-write`, `danger-full-access`}, `approval-policy` ∈ {`untrusted`, `on-failure`, `on-request`, `never`}, `model`, `profile`, `config`, `base-instructions`, `developer-instructions`, `compact-prompt` | `{threadId, content}` |
| `codex-reply` | 续对话 | `prompt`（必填）, `threadId` | `{threadId, content}` |

**与 Kiro ACP 的关键区别：**

- Codex MCP **没有 `session/new` 握手**，只跑 MCP 标准的 `initialize`；threadId 由首次 `tools/call("codex")` 的响应返回。
- 流式增量通过 **MCP `notifications/progress`** 推送（关联 `_meta.progressToken`），不是 Kiro 那种 `session/update` 通知。
- 反向请求是 **`elicitation/create`**（MCP 标准），不是 Kiro 的 `session/request_permission`。
- 取消用 **`notifications/cancelled`**（关联 in-flight request id），保留 thread；不需要杀进程。

来源验证：
- [`codex-rs/mcp-server/src/codex_tool_config.rs`](https://github.com/openai/codex/blob/main/codex-rs/mcp-server/src/codex_tool_config.rs) — 工具名与 input schema
- [`codex-rs/mcp-server/src/lib.rs`](https://github.com/openai/codex/blob/main/codex-rs/mcp-server/src/lib.rs) — `ExecApprovalElicitRequestParams` / `PatchApprovalElicitRequestParams`（elicitation 反向请求载荷）
- [`codex-rs/rmcp-client/Cargo.toml`](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/Cargo.toml) — Codex 自身用 `rmcp` 做 MCP client，与本设计对齐

### 2.3 为什么用 `rmcp` 而不是手写 JSON-RPC

Kiro 的 `kiro_process.rs` 手写 JSON-RPC 帧分类（`classify` 函数）+ id 关联 + 握手。这套办法在 ACP 上 393 行能搞定，因为 ACP 实际只用了 4 个方法。

但 Codex MCP 要正确处理：

- `initialize` 握手 + capability 协商
- `tools/list` 验证工具名（保险）
- `tools/call` 携带 `_meta.progressToken`
- `notifications/progress` 关联 progressToken，流式增量
- `notifications/cancelled` 取消
- `elicitation/create` 反向请求兜底（虽然 `approval-policy:"never"` 应屏蔽）

手写这些 ~250 行起步，且容易踩 progress token 关联、id 关联等边界 case。用 `rmcp` v1.7（官方 Rust SDK，Apache-2.0）只需 ~150 行薄壳，且**与 OpenAI 上游 `codex-rs/rmcp-client/` 的实现完全同源**——按"稳定 + 生态最佳"标准是正确选择。

### 2.4 现状不变量（设计必须满足）

- WebSocket 路由不变：`/ws/acp/{id}` 一条路径覆盖所有 agent 会话（`src/web.rs:81`）。
- `AcpEvent` 5 变体不变：`System` / `ContentBlock` / `Result` / `Error` / `Exit`（`src/acp/process.rs:14-43`）。
- session_manager 的 broadcast / scrollback / 多客户端 fan-out 不动（`src/session_manager.rs:536+`）。
- 前端 `AcpChatView` 渲染逻辑不动；只在 union 类型加 `'codex'`。

## 3. 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (TS/React)                      │
│                                                                  │
│  Sidebar.tsx ──[POST /api/sessions {type:"codex"}]──             │
│  AcpChatView.tsx ──[WS /ws/acp/<id>?token=...]──                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│                         Backend (Rust)                           │
│                                                                  │
│  web.rs::create_session ──┐                                      │
│                           ├─► SessionManager::create_codex_session│
│  acp/ws_handler.rs ────────┐                                     │
│  ws_acp ──► broadcast::Receiver<String> (existing)              │
│             ▲                                                    │
│             │ String (JSON-serialized AcpEvent)                  │
│             │                                                    │
│  ┌──────────┴────────────┐                                       │
│  │ spawn_codex_fanout()  │  <NEW, mirrors spawn_kiro_fanout>     │
│  │   reads CodexProcess  │                                       │
│  │   .event_rx           │                                       │
│  └──────────┬────────────┘                                       │
│             │ AcpEvent                                           │
│             │                                                    │
│  ┌──────────▼────────────────────────────────────────────────┐   │
│  │ acp/codex_process.rs (NEW)                                │   │
│  │                                                           │   │
│  │  CodexProcess {                                           │   │
│  │    spawn() / send_prompt() / kill() / event_rx            │   │
│  │  }                                                        │   │
│  │       │                                                   │   │
│  │       │ uses                                              │   │
│  │       ▼                                                   │   │
│  │  rmcp::serve_client(MyClientHandler, TokioChildProcess)   │   │
│  │       │                                                   │   │
│  │       │ stdio                                             │   │
│  └───────┼───────────────────────────────────────────────────┘   │
└──────────┼──────────────────────────────────────────────────────┘
           ▼
       codex mcp-server  (child process, env: CODEX_API_KEY)
```

### 关键架构原则

- **`CodexProcess` 与 `KiroProcess` 同形签名**：对外暴露 `spawn` / `send_prompt` / `kill` / `pub event_rx: mpsc::Receiver<AcpEvent>`。让 fan-out 函数几乎复用现有 `spawn_kiro_fanout` 模板。
- **`rmcp` 隐藏在 `codex_process.rs` 内部**：依赖只此一个文件知道，Kiro/Claude 路径完全不受影响。
- **AcpEvent 不扩展**：所有 Codex 协议事件翻译到现有 5 个变体。前端不感知协议差异。
- **状态机内部化**：`thread_id` 在 `CodexProcess` 内部维护，外部协议同 Kiro。

## 4. 组件

### 4.1 模块清单

| 模块 | 类型 | 职责 |
|---|---|---|
| `src/acp/codex_process.rs` | **新增** | 包 `rmcp` client，对外暴露 `CodexProcess` |
| `src/acp/mod.rs` | 改 | 加 `pub mod codex_process;` |
| `src/session_manager.rs` | 改 | `SessionType::Codex` 变体；`create_codex_session`；`spawn_codex_fanout` |
| `src/web.rs` | 改 | `create_session` match 加 `Codex` 分支 |
| `src/main.rs` | 改 | `--codex-path`（默认 `codex`）CLI 旗标；`AppState.codex_path` 字段 |
| `Cargo.toml` | 改 | 加 `rmcp = { version = "1.7", features = ["client", "transport-child-process"] }` |
| `frontend/src/lib/api.ts` | 改 | `SessionType` union 加 `'codex'` |
| `frontend/src/components/Sidebar.tsx` | 改 | 新建会话面板加 Codex 按钮（图标 `Cpu`，色 `--accent-blue`）；列表行图标 mapping 加一项 |
| `frontend/src/components/AcpChatView.tsx` | 改 | `agentType` union 加 `'codex'`；label `'Codex'` |

### 4.2 `CodexProcess` 内部结构

```rust
// src/acp/codex_process.rs

use crate::acp::process::AcpEvent;
use rmcp::{ServiceExt, ClientHandler, /* ... */};
use rmcp::transport::child_process::TokioChildProcess;
use tokio::sync::mpsc;

enum Cmd {
    Prompt(String),
    Cancel,
    Stop,
}

pub struct CodexProcess {
    cmd_tx: mpsc::Sender<Cmd>,
    pub event_rx: mpsc::Receiver<AcpEvent>,
}

impl CodexProcess {
    pub async fn spawn(
        codex_path: &str,
        work_dir: &str,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>>;

    pub async fn send_prompt(&mut self, text: &str) -> Result<(), std::io::Error>;

    pub async fn kill(&mut self);
}

impl Drop for CodexProcess { /* cmd_tx.send(Stop) best-effort */ }
```

**对外签名与 `KiroProcess` 完全一致**——这是 `spawn_codex_fanout` 能套用 `spawn_kiro_fanout` 模板的关键。

### 4.3 内部三个角色

```
┌────────────────────────────────────────────────────────┐
│  CodexProcess::spawn()                                 │
│  ├─ 1. TokioChildProcess::new(codex mcp-server,        │
│  │     cwd=work_dir, env={CODEX_API_KEY 透传})         │
│  ├─ 2. serve_client(handler, transport)                │
│  │     └ rmcp 自动跑 initialize 握手                   │
│  ├─ 3. emit AcpEvent::System{subtype:"init"}          │
│  └─ 4. tokio::spawn(event_loop) (含 catch_unwind 包护)│
└────────────────────────────────────────────────────────┘
                         │
        ┌────────────────┼─────────────────┐
        │                │                 │
        ▼                ▼                 ▼
┌──────────────┐ ┌───────────────┐ ┌──────────────────┐
│ ClientHandler│ │ event_loop    │ │ rmcp Peer        │
│ (rmcp回调)   │ │ tokio::select │ │ (clone 进入循环) │
│              │ │               │ │ call_tool /      │
│ on_progress  │ │ ┌──cmd_rx ──┐ │ │ cancel_request   │
│ ─►notify_tx  │ │ │ Prompt    │ │ │                  │
│              │ │ │  → peer   │ │ │                  │
│ on_elicit    │ │ │  .call_   │ │ │                  │
│ (auto reply  │ │ │  tool()   │ │ │                  │
│  allow-once) │ │ │ Cancel    │ │ │                  │
│              │ │ │  → peer   │ │ │                  │
│              │ │ │  .cancel  │ │ │                  │
│              │ │ │  _request │ │ │                  │
│              │ │ │ Stop → 退 │ │ │                  │
│              │ │ └───────────┘ │ │                  │
│              │ │ ┌──notify_rx┐│ │                  │
│              │ │ │ →AcpEvent ││ │                  │
│              │ │ │  →event_tx│ │ │                  │
│              │ │ └───────────┘ │ │                  │
└──────────────┘ └───────────────┘ └──────────────────┘
```

三个角色：

1. **`ClientHandler` impl**：rmcp 回调入口。处理：
   - `notifications/progress` → 提取 chunk 文本 → 走 internal `notify_tx` 送给 event_loop
   - `elicitation/create`（exec_approval / patch_approval）→ 立即应答 `{action:"accept", content:{outcome:"allow-once"}}` + `tracing::warn!` 留痕（正常 `approval-policy:"never"` 不该来）
2. **`event_loop` 任务**：`tokio::select!` 同时监听：
   - `cmd_rx`：`Prompt(text)` → 根据 `thread_id` 调 `call_tool("codex")` 或 `call_tool("codex-reply")`；`Cancel` → `peer.cancel_request(in_flight_id)`；`Stop` → break
   - `notify_rx`：progress chunk 翻译成 `AcpEvent::ContentBlock { streaming: true }` 推到 `event_tx`
3. **`rmcp::Peer` 句柄**：clone 进入 event_loop，prompt 来时调 `.call_tool()`，cancel 来时调 `.cancel_request()`。

### 4.4 `thread_id` 状态机

`event_loop` 内部维护 `thread_id: Option<String>` + `in_flight_request_id: Option<RequestId>`：

```
spawn 后 thread_id=None, in_flight=None
    │
    ├─ Cmd::Prompt("hello")
    │     ├─ thread_id 为 None → call_tool("codex", {prompt, cwd,
    │     │                       sandbox:"danger-full-access",
    │     │                       approval-policy:"never"})
    │     ├─ in_flight = Some(request_id)
    │     ├─ 期间 notify_rx 收到 progress chunks → emit ContentBlock{streaming:true}
    │     └─ tools/call 返 {threadId:"t-abc", content:"..."}
    │           ├─ thread_id = Some("t-abc")
    │           ├─ in_flight = None
    │           └─ emit AcpEvent::Result{text=content, session_id="t-abc", cost_usd:None}
    │
    ├─ Cmd::Prompt("和上句续")
    │     ├─ thread_id 为 Some → call_tool("codex-reply", {prompt, threadId:"t-abc"})
    │     └─ 同上流程，threadId 不变
    │
    ├─ Cmd::Cancel（in_flight 存在）
    │     ├─ 触发 rmcp 的 per-request 取消机制
    │     │   （具体 API 实现期确认：CancellationToken / abort handle / cancel_request；
    │     │    底层都会让 rmcp 向 server 发 notifications/cancelled）
    │     └─ in-flight call_tool 返 cancelled error → emit AcpEvent::Error{message:"已取消"}
    │     ├─ thread_id 保留
    │     └─ 用户可继续发 prompt 续上同 thread
    │
    └─ Cmd::Stop / drop CodexProcess
          ├─ break event_loop
          ├─ drop rmcp client → 子进程 stdin EOF → codex mcp-server 自退
          └─ emit AcpEvent::Exit{code:0}
```

### 4.5 thread_id 状态恢复（thread not found）

如果 Codex 服务端回收了 thread（比如长时间空闲、或服务端重启），`call_tool("codex-reply")` 会返业务 error。处理：

- emit 一次 `AcpEvent::Error{message:"会话已过期，自动开新对话"}`
- 清空本地 `thread_id` → `None`
- 用户下次 prompt 自动走 `call_tool("codex")` 重开 thread

### 4.6 复用 vs 新写

| 复用现有 | 新写 |
|---|---|
| `AcpEvent` 枚举 | `CodexProcess` struct |
| `session_manager.rs` 的 broadcast / scrollback / 多客户端逻辑 | `ClientHandler` impl（~40 行） |
| `acp/ws_handler.rs` 的 WS 处理（一字不改） | `event_loop`（~80 行） |
| 前端 `AcpChatView` 渲染逻辑 | `spawn` + handshake glue（~30 行） |

预估 `codex_process.rs` 总长 **~180 行**（含注释和 use），比 `kiro_process.rs` 的 393 行少一半。

## 5. 数据流

### 5.1 会话创建

```
Browser              web.rs              SessionManager        CodexProcess          codex mcp-server
   │                   │                       │                    │                       │
   │ POST /api/sessions│                       │                    │                       │
   │ {type:"codex",    │                       │                    │                       │
   │  work_dir:"/x"}   │                       │                    │                       │
   ├──────────────────►│                       │                    │                       │
   │                   │ create_codex_session()│                    │                       │
   │                   ├──────────────────────►│                    │                       │
   │                   │                       │ CodexProcess::spawn(codex_path, "/x")     │
   │                   │                       ├───────────────────►│                       │
   │                   │                       │                    │ spawn child:          │
   │                   │                       │                    │  codex mcp-server     │
   │                   │                       │                    │  cwd=/x               │
   │                   │                       │                    │  env=CODEX_API_KEY... │
   │                   │                       │                    ├──────────────────────►│
   │                   │                       │                    │                       │
   │                   │                       │                    │ rmcp serve_client     │
   │                   │                       │                    │ initialize 握手       │
   │                   │                       │                    │◄─────────────────────►│
   │                   │                       │                    │                       │
   │                   │                       │                    │ emit                  │
   │                   │                       │                    │ AcpEvent::System      │
   │                   │                       │                    │ {subtype:"init"}      │
   │                   │                       │ CodexProcess ready │                       │
   │                   │                       │◄───────────────────┤                       │
   │                   │                       │                    │                       │
   │                   │                       │ session_manager:   │                       │
   │                   │                       │ - 注册 Session     │                       │
   │                   │                       │ - 创建 broadcast   │                       │
   │                   │                       │ - spawn_codex_     │                       │
   │                   │                       │   fanout 任务      │                       │
   │                   │ session_id="s-123"    │                    │                       │
   │                   │◄──────────────────────┤                    │                       │
   │ {id:"s-123"}      │                       │                    │                       │
   │◄──────────────────┤                       │                    │                       │
```

### 5.2 发送 prompt（首轮，thread_id=None）

```
Browser           ws_handler          input_tx        CodexProcess         rmcp Peer        codex mcp-server
   │                 │                   │                 │                   │                  │
   │ WS Text {       │                   │                 │                   │                  │
   │  type:"prompt", │                   │                 │                   │                  │
   │  text:"列一下" │                   │                 │                   │                  │
   ├────────────────►│                   │                 │                   │                  │
   │                 │ SessionInput::    │                 │                   │                  │
   │                 │ Prompt("列一下") │                 │                   │                  │
   │                 ├──────────────────►│                 │                   │                  │
   │                 │                   │ fan-out task    │                   │                  │
   │                 │                   │ select! 命中    │                   │                  │
   │                 │                   ├────────────────►│                   │                  │
   │                 │                   │                 │ send_prompt(...)  │                  │
   │                 │                   │                 │ → cmd_tx(Prompt)  │                  │
   │                 │                   │                 │                   │                  │
   │                 │                   │                 │ event_loop 收 cmd│                  │
   │                 │                   │                 │ thread_id == None │                  │
   │                 │                   │                 │ → 走 "codex"      │                  │
   │                 │                   │                 ├──────────────────►│                  │
   │                 │                   │                 │                   │ tools/call       │
   │                 │                   │                 │                   │ name="codex"     │
   │                 │                   │                 │                   │ args={prompt,cwd,│
   │                 │                   │                 │                   │  sandbox:"danger-│
   │                 │                   │                 │                   │   full-access",  │
   │                 │                   │                 │                   │  approval-policy:│
   │                 │                   │                 │                   │  "never"}        │
   │                 │                   │                 │                   │ + _meta.         │
   │                 │                   │                 │                   │   progressToken  │
   │                 │                   │                 │                   ├─────────────────►│
```

### 5.3 流式增量

```
codex mcp-server        rmcp Peer            ClientHandler        event_loop          fan-out         broadcast       all WS clients
       │ notifications/     │                     │                    │                  │                │                │
       │ progress           │                     │                    │                  │                │                │
       │ {progressToken,    │                     │                    │                  │                │                │
       │  progress:{        │                     │                    │                  │                │                │
       │   text:"我先看..."}│                     │                    │                  │                │                │
       │ }                  │                     │                    │                  │                │                │
       ├───────────────────►│                     │                    │                  │                │                │
       │                    │ on_progress 回调    │                    │                  │                │                │
       │                    ├────────────────────►│                    │                  │                │                │
       │                    │                     │ notify_tx.send(    │                  │                │                │
       │                    │                     │  ProgressChunk(    │                  │                │                │
       │                    │                     │  "..."))           │                  │                │                │
       │                    │                     ├───────────────────►│                  │                │                │
       │                    │                     │                    │ select! 命中     │                │                │
       │                    │                     │                    │ AcpEvent::       │                │                │
       │                    │                     │                    │ ContentBlock {   │                │                │
       │                    │                     │                    │   block_type:    │                │                │
       │                    │                     │                    │   "text",        │                │                │
       │                    │                     │                    │   text:"...",    │                │                │
       │                    │                     │                    │   streaming:true │                │                │
       │                    │                     │                    │ }                │                │                │
       │                    │                     │                    ├─────────────────►│                │                │
       │                    │                     │                    │                  │ JSON-serialize │                │
       │                    │                     │                    │                  ├───────────────►│                │
       │                    │                     │                    │                  │                │ broadcast      │
       │                    │                     │                    │                  │                ├───────────────►│
   ... (重复 N 个 chunks)
```

### 5.4 一轮结束

```
codex mcp-server        rmcp Peer            event_loop                fan-out         all WS clients
       │ tools/call response│                     │                       │                 │
       │ {result: {         │                     │                       │                 │
       │   threadId:"t-9",  │                     │                       │                 │
       │   content:"..."    │                     │                       │                 │
       │ }}                 │                     │                       │                 │
       ├───────────────────►│                     │                       │                 │
       │                    │ call_tool().await   │                       │                 │
       │                    │   解锁 → 返结果     │                       │                 │
       │                    ├────────────────────►│                       │                 │
       │                    │                     │ thread_id =           │                 │
       │                    │                     │   Some("t-9")         │                 │
       │                    │                     │ in_flight = None      │                 │
       │                    │                     │ emit                  │                 │
       │                    │                     │ AcpEvent::Result {    │                 │
       │                    │                     │   text=content,       │                 │
       │                    │                     │   session_id="t-9",   │                 │
       │                    │                     │   cost_usd:None       │                 │
       │                    │                     │ }                     │                 │
       │                    │                     ├──────────────────────►├────────────────►│
```

### 5.5 续轮（thread_id 已存在）

数据流和 5.2 + 5.3 + 5.4 完全相同，唯一差别在 event_loop 那一格：

```
event_loop:
  thread_id == Some("t-9")
  → 走 "codex-reply" 工具
  → tools/call name="codex-reply" args={prompt, threadId:"t-9"}
```

后续 progress / response 流程不变。

### 5.6 Cancel

```
Browser           ws_handler          input_tx        event_loop          rmcp Peer        codex mcp-server
   │ WS Text {       │                   │                │                   │                  │
   │  type:"cancel"} │                   │                │                   │                  │
   ├────────────────►│                   │                │                   │                  │
   │                 │ SessionInput::    │                │                   │                  │
   │                 │ Cancel            │                │                   │                  │
   │                 ├──────────────────►├───────────────►│                   │                  │
   │                 │                   │                │ rmcp 取消当前轮   │                  │
   │                 │                   │                │ (CancellationToken│                  │
   │                 │                   │                │  /cancel_request, │                  │
   │                 │                   │                │  实现期定)        │                  │
   │                 │                   │                ├──────────────────►│                  │
   │                 │                   │                │                   │ notifications/   │
   │                 │                   │                │                   │ cancelled        │
   │                 │                   │                │                   ├─────────────────►│
   │                 │                   │                │                   │                  │
   │                 │                   │                │                   │  ◄ 中止当前轮    │
   │                 │                   │                │                   │  thread_id 保活 │
   │                 │                   │                │                   │                  │
   │                 │                   │                │ in-flight call_   │                  │
   │                 │                   │                │ tool 返 Cancelled│                  │
   │                 │                   │                │ error             │                  │
   │                 │                   │                │ → in_flight=None  │                  │
   │                 │                   │                │ → emit Error      │                  │
   │                 │                   │                │  {message:"已取消"}│                  │
```

**与 Kiro 的差异**：Kiro 当前 cancel 直接 `process.kill()` 杀进程（`session_manager.rs:608`），下一句 prompt 等于全新会话。Codex 用 `cancel_request` 只取消当前轮，保留 thread_id——用户取消后追问"那刚才那个文件改完没"，Codex 还能记得上文。这是本次改动比 Kiro 更精细的地方。Kiro 的等价升级作为后续独立 PR。

### 5.7 会话删除 / 进程退出

```
Browser → DELETE /api/sessions/{id}
  → SessionManager::remove_session
    → drop input_tx (input_rx 收到 None)
    → fan-out task break loop
    → drop CodexProcess
      → Drop impl: cmd_tx.send(Stop) (best-effort)
      → drop rmcp client → 子进程 stdin EOF → codex mcp-server 自退
    → emit AcpEvent::Exit{code:0}
    → broadcast 给所有客户端 → 前端切换到 "Done" 状态
```

### 5.8 Scrollback / 重连

完全复用现有逻辑（`session_manager.rs:507` `push_scrollback` + `ws_handler.rs:74` history 重放）。每条 `AcpEvent` JSON 序列化后进 ring buffer，新客户端连入时一次性 replay，不区分 Codex / Kiro / Claude。

`thread_id` **不进 scrollback**——内部状态，不需要持久化或重放。重连后新发的 prompt 仍然走 `codex-reply`（因为 `CodexProcess` 还活着，thread_id 在 event_loop 内存里），无影响。

## 6. 错误处理

### 6.1 启动期错误

| # | 故障 | 触发点 | 兜底策略 | 用户看到 |
|---|---|---|---|---|
| E1 | `codex` 二进制不存在 / `--codex-path` 错 | `TokioChildProcess::new` 返 `io::Error` | `CodexProcess::spawn` 返 `Err`；`create_codex_session` 返 500 | 前端 toast: `Failed to spawn Codex: <reason>` |
| E2 | `codex` 存在但缺登录 / `CODEX_API_KEY` 无效 | rmcp `initialize` 握手成功，但首次 `tools/call` 返 auth error | 第一次 prompt 收到 tool error → emit `AcpEvent::Error` | 红字气泡：`Codex authentication failed. Set CODEX_API_KEY or run codex login on host.` 会话仍存在，需删后重建 |
| E3 | rmcp 握手超时 | `serve_client().await` 卡住 | `tokio::time::timeout(10s, serve_client(...))`，超时返错 | 同 E1 |
| E4 | `codex mcp-server` 启动后立即退出 | rmcp transport 收到 EOF | event_loop 检测到 transport 关闭 → emit `AcpEvent::Exit{code}` | 会话状态变 Done |

### 6.2 运行期错误

| # | 故障 | 触发点 | 兜底 | 用户看到 |
|---|---|---|---|---|
| R1 | `tools/call("codex")` 返业务 error（quota / context too long / sandbox 拒绝） | event_loop 拿到 `Result::Err` | emit `AcpEvent::Error{message: rmcp error 字符串}`；保留 thread_id（如果已建） | 红字气泡，会话继续可发下一条 |
| R2 | `tools/call("codex-reply")` 报 `threadId not found` | thread 在服务端被回收 | emit Error；清空本地 `thread_id`；下次 prompt 自动走 `call_tool("codex")` 开新 thread | 红字提示"会话已过期，已自动开新对话"，继续可用 |
| R3 | progress 通知到的 chunk 解不开 | `ClientHandler::on_progress` JSON 字段不符预期 | `tracing::debug!` 吞掉，不 emit；不打断流 | 该轮可能少一段流式增量；最终响应不影响 |
| R4 | 服务端来反向 `elicitation/create`（理论不该来，因为 `approval-policy:"never"`） | `ClientHandler` 回调 | 立即应答 `{action:"accept", content:{outcome:"allow-once"}}` 然后 `tracing::warn!` 留痕 | 用户无感；日志里有警告 |
| R5 | 子进程被 OOM kill | rmcp transport 收到 EOF | event_loop 退出 → emit `Exit{code}` | 同 E4 |
| R6 | rmcp 内部 panic（库 bug 或 schema 不兼容） | `tokio::spawn(event_loop)` 任务 panic | 见下面 6.4 防护 | 红字气泡 + 会话变 Done |

### 6.3 Cancel 期错误

| # | 故障 | 兜底 |
|---|---|---|
| C1 | `cancel_request` 时没有 in-flight 调用（用户连点两次） | rmcp 返 not-found，event_loop 吞掉，不 emit |
| C2 | `cancel_request` 自身失败 | 降级 `kill()`（杀子进程）作为最后手段，emit `Exit` |

### 6.4 panic 防护

rmcp 的 ClientHandler 回调如果触发 panic，event_loop tokio task 会静默退出，broadcast channel 仍开但永远无新事件，前端"卡住"（既无 Error 也无 Exit）。

对策：event_loop 整体用 `futures::FutureExt::catch_unwind` 包一层（`futures = "0.3"` 在 `Cargo.toml:22` 已存在，无新增依赖）：

```rust
use futures::FutureExt;

tokio::spawn(async move {
    let result = std::panic::AssertUnwindSafe(run_event_loop(...))
        .catch_unwind()
        .await;
    if result.is_err() {
        let _ = event_tx.send(AcpEvent::Error {
            message: "Codex event loop panicked".into(),
        }).await;
    }
    let _ = event_tx.send(AcpEvent::Exit { code: -1 }).await;
});
```

成本一个 `catch_unwind` 调用，避免会话假死。

### 6.5 日志策略

- 启动失败：`tracing::error!` + 错误返给 HTTP 客户端
- 运行期 protocol 异常：`tracing::warn!`（不打断）
- 解码失败 / 未识别字段：`tracing::debug!`（噪音）
- 沿用现有 logger（`AppState.logger`）：把 outgoing `AcpEvent` JSON 也记进 `acp.log`，与 Kiro/Claude 一致

### 6.6 不处理的情况（明示边界）

- **`CODEX_API_KEY` 轮换 / 过期**：不做活探测。用户重建会话即可。
- **MCP server 版本与 rmcp 客户端不兼容**：依赖 codex CLI 升级时的兼容性承诺。出问题时报错堆栈进 trace，让用户自己升或降版本。
- **超长 progress 流导致 broadcast lag**：沿用现有 `RecvError::Lagged` 处理（`ws_handler.rs:113` `tracing::warn!` 后继续），不做特殊优化。
- **同一 thread_id 上多个并发 prompt**：上层 input_tx 是 mpsc，天然串行；不在 event_loop 里再加锁。

## 7. 测试

zeromux 仓库**没有现成的测试基建**（`Cargo.toml` 无 dev-deps，`src/` 下无 `mod tests`，CLAUDE.md 明示无 build/test 流水线）。测试策略要符合现状——**不引入测试框架**，但保证 Codex 集成可手动验证。

### 7.1 单元测试（轻量 inline）

只针对**纯函数**加 inline `#[cfg(test)]` 块，沿用 Rust 标准 `#[test]`，不引入 dev-deps：

| 测试点 | 位置 | 内容 |
|---|---|---|
| `thread_id` 状态机 | `codex_process.rs` | 给定 `Option<String>`，验证生成的 `tools/call` name 和 args |
| progress chunk → AcpEvent 翻译 | `codex_process.rs` | 喂几种合法 / 异常 progress payload，断言 `AcpEvent` 输出 |
| tool response → AcpEvent::Result 翻译 | `codex_process.rs` | 同上 |

约 60-80 行测试，全部走 `cargo test`，无外部依赖。

### 7.2 集成测试（手动 checklist）

环境前置：
- codex CLI 已安装，已 `codex login` 或设 `CODEX_API_KEY`
- `cargo build --release` 通过
- `cd frontend && npm ci && npm run build` 通过

冒烟流程：

```
[ ] 启动 zeromux，前端打开
[ ] Sidebar 新建 → 看到 Terminal / Claude / Kiro / Codex 四个按钮
[ ] 点 Codex，会话创建成功，Sidebar 列表出现 Codex 行带新图标
[ ] 进会话发 prompt "ls"，看到流式增量、最终结果
[ ] 续发 prompt "把第一个文件 cat 出来"，验证多轮（threadId 复用）
[ ] 中途发长 prompt 后立即点 Cancel，会话不死，再发 prompt 仍能续上
[ ] 关浏览器再开同一会话，scrollback 完整重放
[ ] 同时开两个浏览器 tab 看同一 Codex 会话，prompt/响应实时同步
[ ] 删除 Codex 会话，子进程退出（ps aux | grep codex 验）
[ ] 配错 --codex-path /no/such/bin，重启，新建 Codex 会话报红字 toast
[ ] 错 CODEX_API_KEY 启动，发首条 prompt 收到 auth error 红字气泡
```

### 7.3 不写的测试（明示）

- **不**写端到端自动化测试（仓库无 CI / playwright / 测试 fixture）
- **不**mock rmcp（mock MCP 协议成本极高，价值低；端到端跑真 codex 才靠谱）
- **不**做 fuzz / property-based（YAGNI）

### 7.4 回归检查

每次改动后跑：
- `cargo build --release`
- `cd frontend && npm run build`
- 手动按 7.2 checklist 至少跑前 6 项（核心交互）

## 8. 工作量与改动锚点

### 8.1 后端改动锚点

| 文件 | 锚点（行号或 anchor） | 改动 | 估算行数 |
|---|---|---|---|
| `Cargo.toml` | `[dependencies]` 末尾 | 加 `rmcp = { version = "1.7", features = ["client", "transport-child-process"] }` | +1 |
| `src/main.rs` | `Args` 结构体 `--kiro-path` 后 | 加 `--codex-path` arg + `AppState.codex_path` + 透传 | +6 |
| `src/acp/mod.rs` | 末尾 | 加 `pub mod codex_process;` | +1 |
| `src/acp/codex_process.rs` | 新文件 | `CodexProcess` 实现 + `ClientHandler` impl + event_loop | ~180 |
| `src/session_manager.rs` | `SessionType` 枚举 | 加 `Codex` 变体 + Display impl | +3 |
| `src/session_manager.rs` | `create_kiro_session` 后 | `create_codex_session` | ~50 |
| `src/session_manager.rs` | `spawn_kiro_fanout` 后 | `spawn_codex_fanout`（套模板） | ~40 |
| `src/web.rs` | `create_session` match | 加 `SessionType::Codex => create_codex_session(...)` 分支 | +5 |

后端总增量 **~286 行**。

### 8.2 前端改动锚点

| 文件 | 锚点 | 改动 | 估算行数 |
|---|---|---|---|
| `frontend/src/lib/api.ts` | 第 1 行 `SessionType` union | 加 `'codex'` | 0（修改一行） |
| `frontend/src/components/Sidebar.tsx` | line 281-300 区间 | 在 Kiro 按钮后加 Codex 按钮（图标 `Cpu`，色 `--accent-blue`） | +10 |
| `frontend/src/components/Sidebar.tsx` | line 136 / 236 | 列表行 icon mapping 加 `s.type === 'codex'` 分支 | +2 |
| `frontend/src/components/AcpChatView.tsx` | line 54 / 242 / 260 / 288 | `agentType` union 加 `'codex'`；label `'Codex'` | +5 |

前端总增量 **~17 行**。

### 8.3 总计

后端 ~286 行 + 前端 ~17 行 + 测试 ~60-80 行 ≈ **~370 行新代码**，零删除，零重构。

### 8.4 二进制 / 编译时间影响

- `rmcp` v1.7 + 启用 features（client / transport-child-process）粗估传递依赖 ~10-15 个 crate。
- 编译时间增量：粗估 +10-20s（首次），增量编译 +几秒。
- release 二进制 size 增量：粗估 +1-3 MB（rmcp 本身较轻；schemars / tower 在 features 控制下不应被拉入）。

## 9. 风险与未决

| # | 风险 | 缓解 |
|---|---|---|
| 1 | rmcp v1.7 API 在 1.x 内有 breaking change | pin minor version `= "1.7"`；升级时跑回归 checklist |
| 2 | Codex MCP 工具 schema（`codex` / `codex-reply`）未来增删字段 | 入参用 builder 风格构造，只填我们用到的字段；忽略未识别响应字段 |
| 3 | rmcp 的 `notifications/progress` 载荷 schema 与 Codex 实际 emit 不一致 | 实现期需用 `tracing::debug!` 把第一批 progress payload 打印出来比对，再调翻译逻辑 |
| 4 | `elicitation/create` 实际 schema 与 MCP spec 微妙不一致（exec_approval / patch_approval） | 实现兜底用 `ClientHandler` 默认 reject，不阻塞主流程；上 trace 留痕 |
| 5 | codex CLI 在 `~/.codex` 写凭证缓存，多用户 zeromux 部署可能串号 | 文档明示：建议单用户部署或用 `CODEX_API_KEY` env 注入而非依赖 `codex login` |
| 6 | rmcp 1.7 的 per-request cancellation API 形态未在本 spec 锁定（`CancellationToken` / `cancel_request` / abort handle 三种可能） | 实现期第 5 步翻 rmcp 文档与 `codex-rs/rmcp-client/` 用法定型；不影响整体架构 |

## 10. 落地顺序

实施时按以下顺序，每步可独立 build & 验证：

1. **加 rmcp 依赖**：`Cargo.toml` 改一行，`cargo build` 通过。
2. **写 `codex_process.rs` 骨架**：`spawn` + `Drop` + 空 `ClientHandler`，能起进程能握手；写 inline `#[test]` 验状态机。
3. **接 prompt / response**：实现 `send_prompt` + tool response 翻译，先不管 progress 流；命令行手动跑一次能拿到完整响应。
4. **接 progress 流**：实现 `ClientHandler::on_progress` + notify_tx 路径，验证流式增量。
5. **接 cancel + elicitation 兜底**：实现 cancel_request + elicit auto-reject。
6. **接入 session_manager**：`SessionType::Codex` + `create_codex_session` + `spawn_codex_fanout`。
7. **接入 web 路由**：`create_session` 加 match 分支。
8. **加 CLI 旗标**：`--codex-path`。
9. **前端 Sidebar 加按钮 + AcpChatView label**。
10. **跑 7.2 集成 checklist**。

每步完成后 `cargo build --release` + `npm run build` 必须绿；任意一步失败回退到上一步定位。

---

**审阅指引**：本 spec 描述完整设计意图；具体实现锚点（函数签名、file:line）以本文档为准。下一步进入 implementation plan（writing-plans 技能），不再调整设计。
