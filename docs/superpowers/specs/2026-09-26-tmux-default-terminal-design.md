# 终端默认 tmux + 手机滚动/历史 + 流程重做 设计

日期：2026-09-26 · 状态：待用户审阅 · 评审：CTO + PM 两轮交叉 review

## 1. 背景与目标

用户诉求（原话要点）：
1. 手机 Web 登录，终端一次输出很多内容后无法像文档一样上下滑动看之前的内容。
2. 终端默认 tmux；zeromux 里 X 掉即关闭；在 VSCode（code-server/SSH）里能 `tmux attach` 无缝接续同一会话。
3. Think big，可大刀阔斧，最终优化 UI 流程与体验。P1–P3 全做，拆成多个 Task。

已确认的用户决策：
- **X = 全部 kill**，包括 Attach 进来的外部 tmux 会话。
- **滚动 A+B 都做**：终端内手势驱动 tmux copy-mode + 「历史」原生文本视图。
- **tmux server 持久化**：独立 system unit，默认 socket。

### 成功标准（可验证）
- S1 `./deploy.sh` / auto-update 前后 `tmux ls` 中 `zmx-*` 会话仍在，浏览器重连后回到同一 shell。
- S2 VSCode 终端粘贴复制来的 `tmux attach -t =zmx-xxxx` 能进入同一会话，两端可同时输入。
- S3 手机：tmux 会话内上滑能翻历史，跟手延迟 ≤100ms；「⤒顶」一次到达历史首行；历史视图打开后跳首行 ≤2s（5000 行），可长按复制任意段。
- S4 从「+」到出现 shell 提示符 ≤2 次点击。
- S5 X 后 5s 内可撤销；5s 后 `tmux ls` 中该会话消失（外部会话同样）；刷新页面不会导致会话泄漏。
- S6 外部会话在 VSCode 被 kill 后，zeromux 显示「已在其他终端结束」而非静默变成裸 shell。

### 非目标
- Agent 会话（Claude/Codex/Crew）**不**迁入 tmux：它们依赖结构化协议（stream-json / JSON-RPC / MCP），迁入会丢失聊天 UI、turn 状态、push、调度与升级门控，且已有 resume token。
- ssh 版接续命令（依赖主机名配置）不做。
- tmux window ↔ zeromux 子标签、OSC133 输出折叠不在本 spec（可作后续）。

## 2. 现状（核实，带证据）

| 点 | 现状 | 位置 |
|---|---|---|
| New Shell | target=None 时起裸 `$SHELL`，无 tmux | `src/session_manager.rs:924-927` |
| Attach | `tmux attach -t <name>`（**前缀匹配**），admin-gate | `session_manager.rs:925`、`src/web.rs:840` |
| 关闭 | `remove_session` 仅 Drop PTY，不 kill tmux | `session_manager.rs:1812` |
| resume 失败 | 静默降级为裸 `$SHELL`；`resume_failed` JSON 推进 PTY base64 scrollback，前端 `b64decode` 抛错被 catch 吞 | `session_manager.rs:1705-1775`、`frontend/src/components/TerminalView.tsx:318` |
| fanout 结束 | `mark_fanout_ended` 只置 Idle，下次连接走静默降级 | `session_manager.rs:2271` |
| 环境变量 | 未清 `TMUX`，zeromux 若在 tmux 内启动则 attach 报 nested | `src/pty_bridge.rs:28-34` |
| 尺寸 | WS resize 不回写 `s.cols/rows`，重启按默认尺寸 spawn | `src/ws_handler.rs:166` |
| xterm | 未设 `scrollback`（默认 1000）；touch→`scrollLines`，alt-screen 下无效 | `TerminalView.tsx:147,230` |
| 触屏 | `touch-action:none` 禁原生选择；X hover 才显示 | `frontend/src/index.css:86-89`、`Sidebar.tsx:561` |
| tmux ls | 同步 `std::process::Command`，阻塞 async worker，无超时 | `web.rs:745` |
| cgroup | zeromux 起的 tmux server 属 zeromux.service cgroup（KillMode=control-group），stop 时连带被杀；默认 socket 与 VSCode 共享，server 归谁先起 | `deploy.sh`、systemd unit |

实测（tmux 3.4，隔离 socket）：`tmux -D` 前台运行可用；`-N` 在无 server 时报错不自启；`has-session -t =zmx-ab` 不前缀匹配 `zmx-abc`；`capture-pane -p -J -S - -E - -t =name:` 可用。

## 3. 架构

### 3.1 tmux server 持久化
- 新增 system unit `zeromux-tmux.service`（仓库内 `deploy/zeromux-tmux.service`，由 `deploy.sh` 幂等安装 + enable）：
  ```
  [Service]
  Type=simple
  User=ubuntu
  Environment=HOME=/home/ubuntu
  ExecStart=/usr/bin/tmux -D -f /home/ubuntu/.zeromux/tmux.conf
  Restart=always
  KillMode=control-group
  ```
  `exit-empty off` 写在 tmux.conf，保证无会话时 server 不退出。
- **默认 socket**（`/tmp/tmux-1000/default`）：VSCode 直接 `tmux a` 可用。
- `zeromux.service` 加 `Wants=zeromux-tmux.service` + `After=`，不反向依赖。
- zeromux 发出的**所有** tmux 命令带 `-N`：server 不在时报错而不是在 zeromux cgroup 里自起。
- 新 CLI 参数 `--tmux-socket <name>`（默认空=默认 socket；非空则所有命令加 `-L <name>`）。冒烟/测试必须使用它隔离。
- 健康检查：`GET /api/tmux/health`（admin）返回 `{server: up|down, in_unit: bool}`，`in_unit` 通过 `display -p '#{pid}'` 读 `/proc/<pid>/cgroup` 是否含 `zeromux-tmux.service`。前端在 server down 或 `in_unit=false` 时于终端顶部显示告警条（含一行修复说明：`sudo systemctl restart zeromux-tmux`）。
- tmux.conf 由 zeromux 启动时生成（若不存在或内容版本号落后则覆写）到 `~/.zeromux/tmux.conf`：
  ```
  source-file -q ~/.tmux.conf
  set -g exit-empty off
  set -g history-limit 50000
  set -g mouse on
  set -sg escape-time 10
  set -g default-terminal tmux-256color
  set -as terminal-features ',xterm-256color:RGB'
  set -g set-clipboard on
  set -g focus-events on
  set -g window-size latest
  set -g status-left '' ; set -g status-right '' ; set -g status-style 'bg=default'
  ```
  （状态栏保留精简一行，只显示 window 列表；tmux 3.4 不支持按客户端隐藏。）

### 3.2 `src/tmux.rs`（新模块 TmuxCtl）
单一职责：拼装 tmux 命令（socket、`-N`、`=name` 精确 target），全部 `tokio::process` + 3s 超时，参数走 argv 不经 shell。接口：
- `attach_argv(name, dir) -> Vec<String>`：`new-session -A -s <name> -c <dir>`（PTY 直接执行，既创建又 attach）
- `has(name) -> Result<bool>`
- `kill(name)`
- `capture(name, max_lines, max_bytes) -> String`：`capture-pane -p -J -S -<n> -E - -t =<name>:`
- `list() -> Vec<HostTmux>`（name/windows/attached/created/path）
- `info(name) -> {attached, pane_in_mode, history_size, current_command}`：一次 `display -p`
- `copy_mode(name, op)`：op ∈ `ScrollUp(n)|ScrollDown(n)|Top|Bottom|Cancel`，映射为 `copy-mode -e` + `send -X -N n scroll-up` / `history-top` / `history-bottom`；`Cancel` 用 `if -F '#{pane_in_mode}' 'send -X cancel'`（绝不向 shell 打 `q`）。
- `health()`

`list_tmux_sessions`（`web.rs:731`）改用 TmuxCtl，去掉同步 Command。

### 3.3 会话模型
- 新建终端**一律 tmux**：tmux 会话名固定 `zmx-<uuid 前 8 位>`，与 zeromux 显示名解耦；`ResumeToken::Tmux(name)` 在创建时即写入。
- Session 新增字段 `tmux_origin: Own | External`（持久化；旧行默认按 token 前缀 `zmx-` 推断 Own，否则 External）。
- PTY spawn：`tmux [-L s] -N <attach_argv>`；spawn 前 `env_remove("TMUX")`。External 用 `attach -t =<name>`。
- WS resize 回写 `s.cols/rows` 并持久化，重启后按真实尺寸 spawn。
- 存量裸 shell 会话（无 token）保持原行为，自然淘汰。

### 3.4 重启 re-attach 与结束识别
`ensure_running` 的 Tmux 分支：
1. `has(name)` 为真 → attach。
2. 为假且 Own → 同名 `new-session -A` 重建，推送 `session_notice{kind:"tmux_lost"}`。
3. 为假且 External → **不 spawn**，置 `SessionMeta::Ended`（新增变体），推送 `session_notice{kind:"tmux_ended"}`。

fan-out 退出（`mark_fanout_ended`）时对 tmux 会话查一次 `has(name)`：不存在 → Ended；存在（只是 detach）→ Idle。

**修复通知通道**：终端 WS 协议新增 JSON 消息类型 `{"type":"notice", kind, text}`，不再把 JSON 塞进 base64 output 帧；agent 会话 `resume_failed` 路径保持不变。前端 `TerminalView` 处理 `notice`：`tmux_lost` 为常驻顶部条（用户手动关）「tmux 会话已丢失（服务重启？），已在原目录新建，之前的输出不可恢复」；`tmux_ended` 为终端区覆盖层「<name> 已在其他终端结束」+ [新建同名会话] [关闭]。

### 3.5 X 关闭：服务端延迟 kill + 分级确认
- `DELETE /api/sessions/{id}` 语义改为：tmux 会话标记 `pending_kill_until = now+5s`，从 list 中隐藏，PTY 暂保留；服务端 tokio 定时器到期执行 `tmux kill` + `remove_session`（Drop 模型不变，清理仍在 remove 时发生）。非 tmux 会话行为不变（立即删除）。
- `POST /api/sessions/{id}/restore`：清除标记，会话重新出现在列表。
- 进程重启时存在未到期标记 → 启动 reconcile 直接执行 kill（标记持久化到 session store）。
- `GET /api/sessions/{id}/close-check` 返回 `{external, other_clients, busy_command}`（`info()`：`attached - 本 zeromux 客户端数`，`pane_current_command` 非 shell）。
- 前端：`other_clients>0 || external || busy_command` → 确认框（外部会话红色标注），文案例：「vscode-dev 正在 1 个其他终端中使用，关闭将终止整个 tmux 会话。」否则直接关闭 + toast「已关闭 <name> · 撤销（5s）」。
- 这是对 "cleanup by Drop" 约定的**有意扩展**：`kill-session` 只在显式关闭路径发生，绝不放进 Drop（否则 detach / fan-out 结束也会误杀）。同步更新 CLAUDE.md。

### 3.6 滚动（手势 → copy-mode）
- 前端判定 tmux 会话（session_type=tmux 且有 token）：单指拖动不再 `term.scrollLines`，而是经 WS 发 `{"type":"scroll", op, n}`；服务端调 `copy_mode`。n 按拖动速度换算，带简单惯性（touchend 后按末速度衰减发送，合并为 ≤每 50ms 一条）。
- 非 tmux / 非 alt-screen 仍走 `scrollLines`；xterm `scrollback` 设为 10000。
- 浮标：进入滚动后右下角「⏸ 已暂停跟随 · ⤓」，旁边「⤒顶」。点 ⤓ = `Bottom`+`Cancel`。KeyBar 按键 / Composer 发送前先 `Cancel`。
- 「↓ N 行新输出」：滚动态期间前端通过 WS 订阅 `{"type":"scroll_watch", on}`，服务端每 1s `info()`，以 `history_size` 增量 + `pane_in_mode` 推 `{"type":"scroll_state", in_mode, new_lines}`；`in_mode=false` 时前端自动收起浮标（例如用户在 VSCode 端退出了 copy-mode）。
- 桌面：`mouse on` 后拖选需 Shift（macOS 开 `macOptionClickForcesSelection`）；首次拖选出现一次提示；加载 `@xterm/addon-clipboard` 接收 OSC52，使 tmux copy-mode 复制进入系统剪贴板；设置中提供「鼠标交给 tmux / 浏览器」开关（后者发送 `set -t =name mouse off` 于该会话）。

### 3.7 历史视图
- `GET /api/sessions/{id}/history?ansi=0|1`：owner/admin 校验（与 WS 一致）；target 只取服务端保存的 token，不接受请求参数；`capture(name, 50000 行, 5MB)`，超限截头并返回 `truncated:true`。
- 前端 `HistoryView`：全屏抽屉（横屏为右半屏分屏，左侧终端继续实时）。原生 `<pre>` 分块渲染（每 500 行一块，`content-visibility:auto`），打开即定位到底部并收起软键盘；按钮：⤒首行 / ⤓底部 / 复制全部 / 发给 agent / 纯文本⇄颜色。
- 搜索：输入框 + ▲▼ + `3/17` 计数，高亮匹配块内文本。
- ANSI 模式：`ansi=1` 时后端带 `-e`，前端 Web Worker 把 SGR 转 span（只支持 SGR 颜色/粗体，其余控制序列丢弃）。
- 抽屉打开期间隐藏 Composer/KeyBar。入口：手机 KeyBar 最左 📜 常驻；桌面终端状态栏按钮。
- 重连后顶部 3s 淡提示「已重连 · 历史保留在 tmux 中 [查看历史]」。

### 3.8 回放
- tmux 会话不再写 / 回放 2MB scrollback（fan-out 直接 broadcast，不 `record`）；WS 订阅后服务端执行 `refresh-client -t <client_tty>`（client_tty 由 `list-clients -F '#{client_pid} #{client_tty}'` 按 PTY 子进程 pid 匹配）强制整屏重绘。
- 前端对 tmux 会话去掉 replay 窗口逻辑（`shouldStickToBottom` 路径仅保留给非 tmux）。

### 3.9 UI 流程重做
- 新建：「+」→ 类型卡片「终端」→ 目录（快捷卡片/⚡/搜索已定目录则跳过）→ 直接创建 tmux 会话。删除 `pick-terminal-mode` 与 `pick-tmux` 两步。
- 会话列表新增分组「本机 tmux（未接入）」（仅 admin）：空心灰点、`N win · 🖥N`，点击即 attach（External）。数据由 `/api/sessions` 附带 `host_tmux` 字段提供（服务端 `list()` 5s TTL 缓存，过滤已被 zeromux 接管的会话），复用现有 3s poll（`App.tsx:118`）。模糊搜索索引纳入 host tmux 名。
- 孤儿收养：`zmx-*` 但无对应 zeromux 会话的，出现在同一分组，标「zeromux 遗留」，点击收养为 Own。
- 状态栏 chip `⧉ zmx-3f2a` → 复制 `tmux attach -t =zmx-3f2a`，toast「已复制」。行尾 `⋯` 菜单：复制接续命令 / 重命名 / 查看历史 / 关闭。
- 触屏：会话行 `⋯` 常显（不用 hover，不做左滑）。
- 「VSCode 也在看」：`attached>1`（减去 zeromux 自身客户端）时会话行与 chip 显示 `🖥+1`。
- KeyBar 第二页（左右滑切换）：Esc / Tab / ← → / ^D / ^Z / PgUp / PgDn。
- 桌面 Ctrl+F：xterm search addon（仅搜 xterm 缓冲；tmux 会话提示「在历史中搜索」并打开 HistoryView 搜索框）。
- 「发给 agent」：历史视图选区或最近 200 行 → 截断 ≤32KB → 复用 ⚡ 链路（`Sidebar.tsx` askAgentPrompt）新建 Claude 会话；发送前提示「内容可能包含密钥，确认发送？」。
- 进程结束 push：tmux 会话 fan-out 结束且 `has=false`（Ended）时经 `PushService::send_to_user` 发新 kind `term_ended`（routine 级，与 turn_done 同样受前台抑制）。

## 4. 安全
- 所有 tmux target 来自服务端存储的 token 或 `list()` 结果，经 `=` 精确匹配，argv 传参，不拼 shell。
- attach External / host_tmux 列表 / 收养 / health：admin-gate（与现有 `list_tmux_sessions` 对称）。
- history / close-check / restore / scroll：owner-or-admin（与 WS 一致）。
- history 响应不经凭证过滤（终端内容本就对 owner 可见），但「发给 agent」有显式确认。

## 5. 错误处理
- tmux 命令超时 / server down：API 返回 503 + 前端告警条；创建终端失败时明确报错「tmux 服务未运行」，**不**回退裸 shell（避免重回不可持久化状态）。
- `kill` 失败（会话已不存在）视为成功。
- 延迟 kill 定时器与 restore 竞争：以 session 锁内的 `pending_kill_until` 为准，到期时重新检查标记仍存在才执行。

## 6. 测试与验证
- Rust 集成测试：`TmuxCtl` 用 `-L zmx-test-<pid>-<n>` 隔离 socket，测试结束 `kill-server`；无 tmux 则 skip。覆盖：attach_argv 创建/复用、`=` 精确匹配、has/kill、capture 截断、copy_mode Cancel 在非 copy-mode 下无副作用、Ended/tmux_lost 分流、延迟 kill + restore + 启动 reconcile。
- 前端 vitest：手势→scroll 消息换算与节流、浮标状态机、HistoryView 分块/搜索、SGR→span、关闭确认分级、Sidebar 新流程步骤数。
- 冒烟：`--data-dir /tmp/zmx-smoke --tmux-socket zmx-smoke --port 18xxx`，**绝不触碰默认 socket 与线上 8090**。
- 验收（线上，部署后）：S1–S6 逐条手测（真机 iOS Safari/PWA + VSCode 终端）。

## 7. Task 拆分（可独立交付顺序）

| # | Task | 依赖 | 阶段 |
|---|---|---|---|
| T1 | `zeromux-tmux.service` + tmux.conf 生成 + deploy.sh 幂等安装 + `--tmux-socket` + health API/告警条 | — | P1 |
| T2 | `src/tmux.rs` TmuxCtl + 集成测试；`list_tmux_sessions` 迁移 | T1 | P1 |
| T3 | 默认 tmux 会话模型（`zmx-<id8>`、tmux_origin、`-N`、清 TMUX、尺寸持久化） | T2 | P1 |
| T4 | re-attach / Ended / tmux_lost 分流 + WS `notice` 通道修复 + 前端覆盖层/常驻条 | T3 | P1 |
| T5 | X 延迟 kill + restore + close-check + 启动 reconcile + 前端 toast/分级确认；更新 CLAUDE.md | T3 | P1 |
| T6 | 回放改 refresh-client；xterm scrollback 10000 | T3 | P1 |
| T7 | 手势→copy-mode（WS scroll 消息、惯性、浮标、⤒⤓、发送前 Cancel） | T2,T6 | P1 |
| T8 | 历史视图最小版（纯文本、分块、⤒⤓、复制、重连提示） | T2 | P1 |
| T9 | 新建流程简化 + host_tmux 分组 + 模糊搜索纳入 + 孤儿收养 | T3 | P2 |
| T10 | 状态栏 chip / `⋯` 菜单（复制接续命令）+ 触屏 ⋯ 常显 + 「VSCode 也在看」 | T9 | P2 |
| T11 | 桌面：OSC52 clipboard addon、Shift 提示、鼠标开关、Ctrl+F | T6 | P2 |
| T12 | 历史视图增强：搜索、ANSI 颜色（Worker）、横屏分屏 | T8 | P3 |
| T13 | 「↓ N 行新输出」（scroll_watch/scroll_state） | T7 | P3 |
| T14 | KeyBar 第二页 | — | P3 |
| T15 | 「发给 agent」 + 进程结束 push（term_ended） | T8,T4 | P3 |

每个 Task 完成即 commit；T1–T8 完成后先部署一次验收 S1–S3/S5/S6，再继续 T9+。
