# ZeroMux

基于 Rust 的单二进制 Web 终端复用器与 AI Agent 编排平台。

ZeroMux 让你在浏览器中管理多个终端会话和**三种 AI 编程代理 —— Claude Code、Kiro CLI 与 OpenAI Codex** —— 内置文件浏览、Git 可视化、会话笔记、语音输入、活动看板和多客户端支持。会话可在服务端重启后存活并自动重连。

> English docs: [README.md](README.md)

## 功能特性

- **Web 终端** — 基于 xterm.js 的完整终端，PTY 后端，WebGL 渲染，2MB 滚动缓冲区，断线重连后自动恢复
- **三种 AI Agent 后端** — 并行运行 **Claude Code**（stream-json ACP）、**Kiro CLI**（JSON-RPC 2.0）和 **OpenAI Codex**（通过 rmcp/MCP 客户端驱动 `codex mcp-server`），三者统一归一化为同一套事件流
- **Agent 工具可见性** — 流式文本、推理/思考块，以及工具调用（shell 命令、文件编辑）在对话中内联渲染 —— 你能看到 Agent 实际做了什么，而不只是它的文字回复
- **会话持久化与恢复** — 会话元数据持久化到 SQLite；服务端重启（或空闲休眠）后，会话在重连时惰性重生，并在后端支持的前提下恢复 Agent 上下文（Claude `--resume`、Kiro `session/load`、Codex `codex-reply`、tmux 重新 attach）
- **会话主动管理** — 每会话的轮次状态（空闲/运行中）+ 实时状态圆点、后台会话完成轮次的红点提醒、**中断（Interrupt）** 按钮取消进行中的轮次、忙时可继续发送（自动中断+重发）、卡死轮次计时器，以及侧边栏内联重命名
- **活动看板** — 跨会话的 Agent `task_done` 事件流（按用户隔离），含摘要、工作目录和成本
- **语音输入** — 输入框旁的麦克风按钮，按住说话调用 AWS Transcribe Streaming 实时转写中文，松开停止；结果填进输入框，需手动点 Send 才发送
- **健壮的 WebSocket** — 服务端心跳 ping + 前端指数退避自动重连，避免空闲超时代理（nginx、Cloudflare）悄无声息地冻结会话
- **多客户端 WebSocket** — 广播架构允许多个浏览器标签页/设备同时查看并操作同一会话
- **会话笔记** — 按工作目录聚合的笔记时间线，markdown 文件为数据源，SQLite 为查询索引，集中存储在 `~/.zeromux/notes/`
- **Git 查看器** — 分支/合并图形化展示，支持 commit diff、文件统计、分支标签（HEAD、分支、标签）
- **文件浏览器** — 浏览、编辑、新建、重命名、上传、删除会话工作目录中的文件
- **Markdown 渲染** — Agent 输出支持 KaTeX 数学公式、mermaid 图表、语法高亮和管道表格，并以内容哈希缓存避免重复渲染
- **Git Worktree 隔离** — 为每个 AI Agent 会话自动创建独立的 git worktree
- **移动端适配** — 可折叠的浮层侧边栏，选择后自动收起，小屏幕下的汉堡菜单
- **身份认证** — GitHub OAuth（支持管理员审批流程）或简单密码模式
- **按用户授权** — 会话和 Agent 事件按所有者隔离；仅所有者（或管理员）可连接、操作、读取某个会话及其事件
- **单文件部署** — 前端通过 `rust-embed` 嵌入，无外部文件依赖
- **Docker 支持** — 内含多阶段构建 Dockerfile

## 快速开始

### 环境要求

- Rust 1.70+
- Node.js 20+
- git, tmux（终端会话需要）
- 按需准备 Agent CLI：PATH 上的 `claude`、`kiro-cli`、`codex`（或显式传入路径）

### 构建与运行

前端**必须**在 Rust 二进制之前构建 —— `rust-embed` 在编译期读取 `frontend/dist/`。

```bash
# 构建前端
cd frontend && npm ci && npm run build && cd ..

# 构建二进制
cargo build --release

# 运行（自动生成密码，输出到控制台）
./target/release/zeromux --port 8080

# 或指定密码
./target/release/zeromux --port 8080 --password "my-secret"
```

也可以使用辅助脚本（二进制缺失时自动重建，管理 PID 文件 + `zeromux.log`）：

```bash
./start.sh --port 8080 --password "my-secret"
```

### Docker

```bash
docker build -t zeromux .
docker run -p 8080:8080 zeromux --password "my-secret"
```

挂载卷以持久化笔记/会话/事件存储：

```bash
docker run -p 8080:8080 -v zeromux-data:/root/.zeromux zeromux --password "my-secret"
```

## 配置参数

所有选项均可通过命令行参数或环境变量设置。

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `--port` | — | `8080` | 监听端口 |
| `--host` | — | `0.0.0.0` | 监听地址 |
| `--password` | `ZEROMUX_PASSWORD` | 自动生成 | 密码认证模式的密码 |
| `--shell` | — | `bash` | 终端会话使用的 Shell |
| `--claude-path` | — | `claude` | Claude CLI 二进制路径 |
| `--kiro-path` | — | `kiro-cli` | Kiro CLI 二进制路径 |
| `--codex-path` | — | `codex` | Codex CLI 二进制路径（以 `codex mcp-server` 运行） |
| `--codex-reasoning` | — | `off` | Codex 推理强度：`off` \| `low` \| `medium` \| `high`（见下方说明） |
| `--work-dir` | — | `.` | 默认工作目录（会话被限制在 `$HOME` 之下的路径） |
| `--cols` | — | `120` | 默认终端列数 |
| `--rows` | — | `36` | 默认终端行数 |
| `--log-dir` | — | — | 会话 I/O 日志目录 |
| `--data-dir` | — | `~/.zeromux` | 数据库和笔记存储目录 |

> **`--codex-reasoning`** 会在每次 Codex `tools/call` 中注入 `model_reasoning_effort`。仅当底层模型/供应商（如 LiteLLM → Bedrock Claude）支持并传递 `thinking` 参数时才生效，否则为空操作。

### GitHub OAuth 配置

适用于多用户 GitHub 认证场景：

| 参数 | 环境变量 | 说明 |
|------|---------|------|
| `--github-client-id` | `GITHUB_CLIENT_ID` | GitHub OAuth App 客户端 ID |
| `--github-client-secret` | `GITHUB_CLIENT_SECRET` | GitHub OAuth App 客户端密钥 |
| `--jwt-secret` | `ZEROMUX_JWT_SECRET` | JWT 签名密钥（未设置时自动生成） |
| `--allowed-users` | `ZEROMUX_ALLOWED_USERS` | 逗号分隔的自动批准 GitHub 用户名 |
| `--external-url` | `ZEROMUX_EXTERNAL_URL` | OAuth 回调的公网 URL |

```bash
./target/release/zeromux \
  --github-client-id "your-id" \
  --github-client-secret "your-secret" \
  --external-url "https://zeromux.example.com" \
  --allowed-users "alice,bob"
```

第一个登录的用户自动成为管理员。OAuth 模式下，会话和事件按用户隔离；管理员可查看全部。

### AWS 凭证（可选，启用语音输入需要）

语音输入功能调用 AWS Transcribe Streaming，沿用 AWS 默认 credential chain：

1. 环境变量：`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION`
2. 共享配置：`~/.aws/credentials [default]` + `~/.aws/config [default]`
3. EC2 IAM Instance Role（推荐部署模式）

需要的 IAM 权限：`transcribe:StartStreamTranscription`。

未配置 AWS 凭证不影响其他功能，仅麦克风按钮在使用时显示 "AWS credentials not configured" 错误。

## 架构

```
┌──────────────────────────────────────────────────┐
│                    浏览器                          │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐ │
│  │  终端    │ │  Agent   │ │ Git / 文件 /      │ │
│  │ (xterm)  │ │  对话    │ │ 笔记 / 活动看板   │ │
│  └────┬─────┘ └────┬─────┘ └──────┬────────────┘ │
│       │WS          │WS            │HTTP           │
└───────┼────────────┼──────────────┼───────────────┘
        │            │              │
┌───────┴────────────┴──────────────┴───────────────┐
│              ZeroMux（单一二进制）                   │
│                                                    │
│  ┌──────────┐  ┌────────────────┐  ┌───────────┐  │
│  │  Axum    │  │  会话管理器     │  │   认证    │  │
│  │  路由    │  │  + 持久化存储   │  │ (JWT/     │  │
│  │          │  │                │  │  OAuth)   │  │
│  └────┬─────┘  └───────┬────────┘  └───────────┘  │
│       │                │                           │
│  ┌────┴─────┐  ┌───────┴────────┐  ┌───────────┐  │
│  │ Fan-out  │  │  broadcast::   │  │  SQLite   │  │
│  │ 广播任务  │  │  Sender<T>    │  │ 会话/事件/ │  │
│  │ (PTY /   │  │  (每会话独立)   │  │ 笔记存储  │  │
│  │  ACP×3)  │  │                │  │           │  │
│  └──────────┘  └────────────────┘  └───────────┘  │
└────────────────────────────────────────────────────┘
```

**核心设计：**

- **广播 Fan-out 架构** — 每个会话生成一个独立的 fan-out 任务，*独占*拥有 PTY/Agent 进程所有权，通过 `tokio::sync::broadcast` 广播事件。多个 WebSocket 客户端独立订阅 —— 无独占锁，断连不会导致会话挂起。清理由 `Drop` 完成：移除会话即结束其 fan-out 任务，进而 drop 进程。
- **三种 Agent 协议，一套事件模型** — Claude（NDJSON stream-json）、Kiro（JSON-RPC 2.0）、Codex（rmcp 上的 MCP 通知）全部归一化为前端渲染的同一个 `AcpEvent` 枚举。
- **持久化与惰性重生** — 会话元数据存于 SQLite；（重）连接时，未运行的会话以并发安全方式重生，并在可能时从存储的 token 恢复。
- **服务端滚动缓冲**（每会话 2MB），重连时自动回放 —— 刷新浏览器、切换设备不丢失输出。
- **WebSocket 韧性** — 服务端定期 ping + 前端自动重连，让空闲会话在超时代理后仍存活。
- **统一输入通道** — 所有 WebSocket 客户端通过共享的 `mpsc` 通道发送输入（`SessionInput` 枚举：`PtyData`、`PtyResize`、`Prompt`、`Cancel`、`Interrupt`）。
- **CSS 可见性切换** —— 切换到文件/Git/看板视图时终端和对话状态完整保留。
- **Git Worktree 隔离** —— 每个 AI Agent 会话获得独立 worktree，避免并发冲突。
- **笔记即文件** — 笔记存储为带 YAML frontmatter 的 markdown 文件（`~/.zeromux/notes/{目录哈希}/`），SQLite 仅作为查询索引。

## 会话类型

| 类型 | 后端 | 协议 | 用途 |
|------|------|------|------|
| `tmux` | portable-pty | 原始 PTY over WebSocket | Shell、tmux、vim 等 |
| `claude` | Claude CLI | Stream-JSON ACP | Claude Code 代理 |
| `kiro` | Kiro CLI | JSON-RPC 2.0 | Kiro AI 代理 |
| `codex` | Codex CLI | MCP（`codex mcp-server`，经 rmcp） | OpenAI Codex 代理 |

## API 接口

### 会话管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions` | 列出会话（含轮次状态与活动） |
| POST | `/api/sessions` | 创建会话（`work_dir` 限制在 `$HOME` 之下） |
| PATCH | `/api/sessions/{id}` | 更新名称/描述/状态（仅所有者） |
| DELETE | `/api/sessions/{id}` | 删除会话（仅所有者） |
| GET | `/api/sessions/{id}/status` | 获取 Git 分支及修改状态 |

### Agent 事件（活动看板）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/events` | 列出 Agent 事件（仅本人；管理员可见全部） |
| POST | `/api/events?token=...` | 写入事件（token 认证，供 hook 使用；所有者由服务端盖章） |
| DELETE | `/api/events/{id}` | 删除事件（仅本人；管理员可删任意） |

### 笔记

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions/{id}/notes` | 获取该会话工作目录下的笔记 |
| POST | `/api/sessions/{id}/notes` | 创建笔记（body: `{"text": "..."}`) |
| DELETE | `/api/sessions/{id}/notes/{note_id}` | 删除笔记 |

笔记按工作目录聚合 —— 共享同一工作目录的会话共享同一组笔记。

### 文件操作

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions/{id}/files?pattern=*.md` | 列出文件 |
| GET | `/api/sessions/{id}/file?path=...` | 读取文件（最大 1MB） |
| POST | `/api/sessions/{id}/file` | 写入文件 |
| DELETE | `/api/sessions/{id}/file?path=...` | 删除文件 |
| POST | `/api/sessions/{id}/upload` | 上传文件（base64，最大 10MB） |

### Git

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions/{id}/git/log?limit=100` | Git 日志（含分支图） |
| GET | `/api/sessions/{id}/git/show?commit=...` | Commit diff 及文件统计 |

### WebSocket

| 路径 | 协议 | 说明 |
|------|------|------|
| `/ws/term/{id}` | Binary (base64) | 终端 I/O（多客户端） |
| `/ws/acp/{id}` | JSON | Agent 数据流 —— Claude/Kiro/Codex（多客户端） |
| `/ws/transcribe` | Binary | 麦克风音频 → AWS Transcribe Streaming |

WebSocket 通过 `?token=` 查询参数认证。仅会话所有者（或管理员）可连接。ACP 客户端消息：`{"type":"prompt","text":...}`、`{"type":"interrupt"}`、`{"type":"cancel"}`。多个客户端可同时连接同一会话，各自独立接收完整的广播流。

## 技术栈

**后端：** Rust, Axum 0.8, Tokio, portable-pty, rmcp（MCP 客户端）, rusqlite, jsonwebtoken, rust-embed

**前端：** React 19, TypeScript, Tailwind CSS 4, xterm.js, react-markdown + KaTeX + mermaid, Vite, lucide-react

## 开源协议

MIT
