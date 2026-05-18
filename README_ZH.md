# ZeroMux

基于 Rust 的单二进制 Web 终端复用器与 AI Agent 编排平台。

ZeroMux 让你在浏览器中管理多个终端会话、Claude Code 代理和 Kiro CLI 代理 —— 内置文件浏览、Git 可视化、会话笔记和多客户端支持。

## 功能特性

- **Web 终端** — 基于 xterm.js 的完整终端，PTY 后端，WebGL 渲染，2MB 滚动缓冲区，断线重连后自动恢复
- **AI Agent 会话** — 并行运行 Claude Code（stream-json ACP）和 Kiro CLI（JSON-RPC 2.0）
- **语音输入** — AcpChatView 输入框旁的麦克风按钮，按住说话调用 AWS Transcribe Streaming 实时转写中文，松开停止；结果填进输入框，需手动点 Send 才发送
- **多客户端 WebSocket** — 广播架构允许多个浏览器标签页/设备同时查看同一会话
- **会话笔记** — 按工作目录聚合的笔记时间线，markdown 文件为数据源，SQLite 为查询索引，集中存储在 `~/.zeromux/notes/`
- **Git 查看器** — 分支/合并图形化展示，支持 commit diff、文件统计、分支标签（HEAD、分支、标签）
- **文件浏览器** — 浏览、编辑、新建、重命名、上传、删除会话工作目录中的文件
- **会话元数据** — 每个会话支持描述、状态标记（运行中/已完成/阻塞/空闲），彩色圆点指示
- **Git Worktree 隔离** — 为每个 AI Agent 会话自动创建独立的 git worktree
- **移动端适配** — 可折叠的浮层侧边栏，选择后自动收起，小屏幕下的汉堡菜单
- **身份认证** — GitHub OAuth（支持管理员审批流程）或简单密码模式
- **单文件部署** — 前端通过 `rust-embed` 嵌入，无外部文件依赖
- **Docker 支持** — 内含多阶段构建 Dockerfile

## 快速开始

### 环境要求

- Rust 1.70+
- Node.js 20+
- git, tmux（终端会话需要）

### 构建与运行

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

也可以使用辅助脚本：

```bash
./start.sh --port 8080 --password "my-secret"
```

### Docker

```bash
docker build -t zeromux .
docker run -p 8080:8080 zeromux --password "my-secret"
```

挂载卷以持久化笔记存储：

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
| `--work-dir` | — | `.` | 默认工作目录 |
| `--cols` | — | `120` | 默认终端列数 |
| `--rows` | — | `36` | 默认终端行数 |
| `--log-dir` | — | — | 会话 I/O 日志目录 |
| `--data-dir` | — | `~/.zeromux` | 数据库和笔记存储目录 |

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

第一个登录的用户自动成为管理员。

### AWS 凭证（可选，启用语音输入需要）

语音输入功能调用 AWS Transcribe Streaming，沿用 AWS SDK 默认 credential chain：

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
│  │  终端     │ │  Claude  │ │ Git / 文件 /      │ │
│  │ (xterm)  │ │  对话     │ │ 笔记查看器        │ │
│  └────┬─────┘ └────┬─────┘ └──────┬────────────┘ │
│       │WS          │WS            │HTTP           │
└───────┼────────────┼──────────────┼───────────────┘
        │            │              │
┌───────┴────────────┴──────────────┴───────────────┐
│              ZeroMux（单一二进制）                   │
│                                                    │
│  ┌──────────┐  ┌────────────────┐  ┌───────────┐  │
│  │  Axum    │  │  会话管理器     │  │   认证    │  │
│  │  路由    │  │                │  │ (JWT/     │  │
│  │          │  │                │  │  OAuth)   │  │
│  └────┬─────┘  └───────┬────────┘  └───────────┘  │
│       │                │                           │
│  ┌────┴─────┐  ┌───────┴────────┐  ┌───────────┐  │
│  │ Fan-out  │  │  broadcast::   │  │  SQLite   │  │
│  │ 广播任务  │  │  Sender<T>    │  │ + 笔记    │  │
│  │ (PTY/    │  │  (每会话独立)   │  │  存储     │  │
│  │  ACP)    │  │                │  │           │  │
│  └──────────┘  └────────────────┘  └───────────┘  │
└────────────────────────────────────────────────────┘
```

**核心设计：**

- **广播 Fan-out 架构** — 每个会话生成一个独立的 fan-out 任务，拥有 PTY/ACP 进程所有权，通过 `tokio::sync::broadcast` 广播事件。多个 WebSocket 客户端独立订阅 —— 无独占所有权，断连不会导致会话挂起
- **服务端滚动缓冲**（每会话 2MB），重连时自动回放 —— 刷新浏览器、切换设备不丢失输出
- **统一输入通道** — 所有 WebSocket 客户端通过共享的 `mpsc` 通道发送输入（`SessionInput` 枚举：`PtyData`、`PtyResize`、`Prompt`、`Cancel`）
- **CSS 可见性切换** —— 切换到文件/Git 视图时终端状态完整保留
- **Git Worktree 隔离** —— 每个 AI Agent 会话获得独立 worktree，避免并发冲突
- **笔记即文件** — 笔记存储为带 YAML frontmatter 的 markdown 文件（`~/.zeromux/notes/{目录哈希}/`），SQLite 仅作为查询索引

## 会话类型

| 类型 | 后端 | 协议 | 用途 |
|------|------|------|------|
| `tmux` | portable-pty | 原始 PTY over WebSocket | Shell、tmux、vim 等 |
| `claude` | Claude CLI | Stream-JSON ACP | Claude Code 代理 |
| `kiro` | Kiro CLI | JSON-RPC 2.0 | Kiro AI 代理 |

## API 接口

### 会话管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions` | 列出会话 |
| POST | `/api/sessions` | 创建会话 |
| PATCH | `/api/sessions/{id}` | 更新描述/状态 |
| DELETE | `/api/sessions/{id}` | 删除会话 |
| GET | `/api/sessions/{id}/status` | 获取 Git 分支及修改状态 |

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
| `/ws/acp/{id}` | JSON | ACP Agent 数据流（多客户端） |

多个客户端可同时连接同一会话的 WebSocket，各自独立接收完整的广播流。

## 技术栈

**后端：** Rust, Axum 0.8, Tokio, portable-pty, rusqlite, jsonwebtoken, rust-embed

**前端：** React 19, TypeScript, Tailwind CSS 4, xterm.js 6, react-markdown, Vite 8, lucide-react

## 开源协议

MIT
