# Plan B（终端 S4）代码现状分析 + S2/S3 上线 review

日期：2026-09-29 · 基线：main@1783009（已上线）· 只读分析，未改代码

来源：受 `zmx-ai-9ef9c5` 请求。两个只读 reviewer（opus）并行完成，关键结论由我对照源码复核（下文标 ✅ 已复核）。
行号均为 1783009 实读；标「假设」的是按代码/规范推断、未在浏览器或真机实测。

---

## A. S2+S3 上线 review（0fca0cc..1783009）

reviewer 跑过：前端 shell/turn/triage/steps 11 文件 123 用例、Rust `cargo test posture` 11 条，全绿；下列问题测试都覆盖不到。`acceptance.md`「未做/推迟」里的项未重复报。

### Critical

**A1. 部署后未刷新的页面，首次打开懒加载面板即整屏白屏** ✅ 已复核（线上 `GET /assets/GitViewer-deadbeef.js` → 404）
- `frontend/src/components/shell/lazyPanels.ts:4-13`（本期新增）把 GitViewer / FileBrowser / RunMetricsPanel / AgentDashboard / VaultReader / MemoryPanel / AdminPanel / ScheduledTasksPanel / PushSettings / PromptsSheet 全改 `lazy()`。
- `src/web.rs` 的 `/assets/*` 找不到即 404；rust-embed 只含当次构建的 hash 文件。
- `frontend/src` 中无 `ErrorBoundary` / `getDerivedStateFromError` / `vite:preloadError` ✅。
- 复现：手机 PWA 常开 → `./deploy.sh` 或后台自动更新换二进制 → 用户点「面板」、⌘K「定时任务」/「推送设置」，或 ≥1280px 首次切到某会话（ContextPanel 默认开、挂载 GitViewer）→ 请求旧 `GitViewer-<旧hash>.js` 得 404 → `lazy` 抛错，无错误边界，React 卸载整个 root → 白屏；iOS PWA 只能杀 App 重开。
- 叠加因素：`index.html` 本身也是 `Cache-Control: public, max-age=3600`（`src/web.rs` `try_serve_embedded`），旧入口页会在部署后长达 1 小时内持续引用旧 hash。
- 建议：`lazyWithReload` 包住 import，失败 `location.reload()` 一次（sessionStorage 防循环）；AppShell 外层与各 `<Suspense>` 外层加 ErrorBoundary（「已更新，点此刷新」）；监听 `vite:preloadError`；入口文件改 `no-cache`、`assets/` 改 `immutable`。

**A2. 「让 agent 撤销改动」可能发给另一个仓库的 agent，误删其未提交改动** ✅ 已复核
- `GitViewer.tsx:368-383`：传了 `sendTo` 就显示按钮；`ContextPanel.tsx:57` 对 tmux 会话也传 `sendTo`（本期前 tmux 会话的 GitViewer 没有这两个按钮）。
- `lib/sendTargets.ts:4-9`：候选为全部 agent，同目录只是排前，**不限目录**；同目录无 agent 时 ★ 落到最近活跃的其他目录 agent。
- `lib/gitviewer.ts:5-6`：`DISCARD_PROMPT`「撤销(git restore)当前工作区的全部未提交改动」**不含路径**。
- 确认框标题不写目标会话名与目录。
- 复现：tmux 会话在仓库 A（A 无 agent），仓库 B 有最近活跃的 Claude → A 的 Git 面板点「让 agent 撤销改动」→ 点 ★（即 B）→ 确认「发送」→ B 的 agent 在 B 里 `git restore`，删掉 B 的未提交改动，不可恢复。「让 agent 提交」同理会提交 B 的改动。
- 建议：两个 prompt 写入绝对路径（`在 ${workDir} 下…`）；撤销/提交只允许同 `work_dir` 目标，跨目录至少不给 ★，并在确认框写明目标会话名与目录。

### Important

**A3. 应用未打开期间完成/失败的定时任务，永远不进「需要你」**
`useShellState.ts:227-233`、`readState.ts:105-114`：首次见到的 sid 一律以「现在」为已读基线；`triage.ts:20-23` 只有 `last_outcome_ms > seen` 才算未读/出错；`session_manager.rs:1427-1442` `trigger_run` 每次新建会话。→ 夜里定时任务跑完/出错，早上打开时新会话基线=打开时刻 > 完成时刻 → 显示空闲、不计数。
建议：仅在 `zmx_read` 为空（首次安装）时全量以「现在」为基线；之后新 sid 基线为 0（或后端导出 `created_ms`）。

**A4. ⌘K 输入目录名回车，常跳进不相关的会话**
`CommandPalette.tsx:170-173` 会话匹配拿完整 `work_dir` 做子序列；`:188,224-228` 回车默认第一项且会话排最前；`fuzzy.ts:3-16` 纯子序列。reviewer 用 node 实测：所有路径共享 `/home/ubuntu/s3-workspace/keith-space/github-search/...` 长前缀，`eks`/`ai`/`ops`/`work`/`hub`/`obs`/`keith`/`space` 对每个会话都命中且同分 → 输入 `eks` 回车打开列表第一个会话，而不是 eks 目录结果或新建。
建议：路径只匹配末 1–2 段或要求连续子串；仅命中路径的会话不抢默认高亮。

**A5. 完成 turn 的摘要卡常只剩一个标题**
`steps.ts:94-99` 结论只取最后一个 text 的首段（首个空行前）；`TurnView.tsx:117-118` 卡片替换时间线；`TurnSummaryCard.tsx:93-101`「展开全文」只解除首段截断。Claude 常见 `## 总结\n\n- …` 格式，且该轮调用过一次 Read 即显示卡片 → 卡片只剩「## 总结」，长度不够连「展开全文」都不出现；正文需点「过程 ▾」再滚。首段规则是 spec 规定，但标题开头的情况 spec 未考虑。
建议：首段为 `#` 标题或 < ~40 字时继续拼接后续段落至 ~600 字符；或「展开全文」显示最后一个 text step 全文。

### Minor

- **A6**（假设：线上 Gateway 断线频率）Crew turn 中途重连 Gateway 显示「出错」且不纠正：`crew_process.rs:529-537` 发 `AcpEvent::Error("…正在重连")` 被当 turn 边界 → `session_manager.rs:3938-3950` / `posture_settles` 结算为 Errored，真 `Result` 到来时 FIFO 已空（`settled=None`）不更新 posture。结算逻辑早已存在，本期分诊把它暴露给用户。建议：turn 中途重连提示改非边界 `ContentBlock{error}`（同 Codex F-CODEX-1）。
- **A7** SendToMenu 发出的消息会带走目标会话 composer 的待发附件：`useAcpSocket.ts:493,503` `sendPrompt` 读并清 `getPending`/`clearPending`。B 上传了附件未发，从 A 的笔记 ⚡ 发给 B → 附件拼进消息、B 输入框附件被清。建议：`SessionControls.sendPrompt` 加 `{ withAttachments: false }`，SendToMenu 调用时关闭。
- **A8** 3s 轮询无请求序号，旧快照可覆盖刚新建的会话：`useSessionsPoll.ts:57-61`、`useShellState.ts:304-309`、`AppShell.tsx:188-194`。慢轮询在途时 ⌘K 新建成功，旧响应后到覆盖 → 手机短暂显示「该会话已不存在」，面板卸载、WS 断开，下一轮再挂载回放。竞态早已存在，本期新增了可见症状。建议：加 `reqRef`，或本地 create/close/rename 后丢弃之前发出的轮询结果。
- **A9** Crew 打断后重发、或审批在别处（Gateway dashboard）被回答后，`pending_approvals` 残留：`triage.ts:31-32` 审批优先级高于 stuck，`posture_settles` 不结算旧边界 → 行上一直「待审批」、展开是「审批详情加载中」，并压住「可能卡住」判断。建议：turn 开始（`turn_starts.start`）时清 `approval_ids`。
- **A10** 出错的一轮，分诊第二行仍是上一轮成功摘要：`settle_posture` 不清 `last_snippet`，`TriageRow.tsx:161` 照显。建议：Errored/Timeout 时清空或改写为错误摘要。
- **A11** `?session=` 深链参数常驻 URL：`useSessionsPoll.ts:140-143`。推送打开一次后每次刷新都跳回该会话；会话删除后每次刷新停在「该会话已不存在」而非分诊首页。建议：读取后 `history.replaceState(null, '', location.pathname)`。

### 已检查无问题
- `useAcpSocket` 连接生命周期：与旧 AcpChatView 对比仅两行改为 `onOpenRef` 回调；无重复 socket、dispose 后不重连、退避与稳定计时器都在。
- `replay_done` 的 busy/时钟/queue_mode 采用后端值；审批事件刷新静默基线。
- WS 负载：审批读 `approval_id ?? id`；`is_error` 只作用于前端合成的 result 并进 `groupSignature`。
- 3s 轮询重渲染：TriageRow memo 签名覆盖全部显示字段；`onSelect`/`controls` 身份稳定；`groupsRef` 稳定；TurnView memo 身份保持。
- `useNextKeys`：J 在 input/textarea/xterm/dialog/menu 中排除；xterm 内 Ctrl+K、Ctrl+] 由 xterm 拦截发给 shell；PresetPicker 只处理自身输入框；IME 组字期 Enter 忽略。
- 后端 posture：打断重发（追上 `turn_seq` 且消费 turn-start 才结算）、Cancel/TimeoutKill 意图分类（cancelled/timeout 不显示为出错）、进程退出（`mark_fanout_ended` 清 step 与审批）正确；三 fan-out 一致；字段在 sessions 锁内维护；截断按 char 多字节安全。
- 权限：无新接口；新字段仅经 `list_sessions` 暴露、按 owner 过滤（admin 看全部为既有设计）。
- 创建流程 `creatingRef` 防双击、失败不关面板并提示；重命名弹窗按 id 作 key 不被轮询冲掉；ContextPanel visited 挂载；推送点击跳会话、有改动开 Git；TriageRow 行内中断/批准未连接时提示且不改本地状态。

---

## B. Plan B 现状分析

### 结论先行

- **B14 生产不可达**（防御性加固，照加）。浏览器语义下同一 socket 的 close 只触发一次，新 socket 只由旧 socket 的 onclose 排队创建 → 旧 onclose 必先于新赋值。计划草案的 B14 用例靠手动二次 `s1.onclose?.()`，是 fake 替身的人工产物。
- **比 B14 更实际的四个风险**：
  1. **§4.6 前提与代码不符** ✅：TerminalView 是裸 `setInterval`，隐藏终端照轮询（§B5）。
  2. **SendToMenu「＋ 新开」会压扁多行终端 prompt**（§B7a，高）。删掉 `onAskAgent` 直接换 SendToMenu 是回归。
  3. `crewSessionType.test.tsx:89-101` 按源码 grep 钉死 TerminalView 中 `key === 'claude'` 那一行，抽 hook 移走 handleBarKey 会红。
  4. **hook 调用顺序硬约束**：`useXterm` 必须先于 `useTerminalSocket`，否则永远连不上（§B1）。

测试：`npx vitest run TerminalView.mobileLayout / MobileKeyBar / HistoryView` 3 文件 18 条全绿。

### B1. TerminalView.tsx 的 WS 生命周期

| 项 | 位置 | 现状 |
|---|---|---|
| 连接 effect | 420–541 ✅ | deps `[sessionId, wsEpoch]`；守卫 `if (!termRef.current) return`（421）、`if (wsRef.current) return`（422）；`disposed/retryTimer/stableTimer/attempt` 为 effect 闭包局部变量（424–427） |
| onopen 顺序 | 434–478 | ① `wsStatus`=open（435）→ ② 清旧 stableTimer 并设 3s 定时，到点 `attempt=0`（440–441）→ ③ `term.reset()`（444，I-5）→ ④ 非 tmux 开 replay 窗口、`userScrolledUpRef=false`（447–448）→ ⑤ 已开过且 tmux 时 `setReconnected(true)`（451–452）→ ⑥ 首发 resize：`last:{0,0}` 保证新 socket 首发不被判冗余，发出则更新 lastDims，否则置 0（458–473，I-12）→ ⑦ mouse-off 首发（477） |
| 退避 + 稳定窗口 | 513–529 ✅ | onclose 先 `wsRef.current = null`（514，**无条件**），非 ended 且未在重连时才改状态（518），`clearTimeout(stableTimer)`（521），`delay=min(1000·2^attempt,10000)`、`attempt++`（525–527）→ 实际 1/2/4/8/10/10s；`onerror` 只 `ws.close()`（530） |
| tmux_ended | 485、518、524 | 设 `endedRef`+`ended`；onclose 置 `'ended'` 且不重连。服务端先完成握手、发 notice 再 Close（`src/ws_handler.rs:80-84`），所以前端**会先跑一遍 onopen（reset+resize）**再收到 ended。复活 `handleRevive`（547–556）：清 endedRef、ended=false、`wsEpoch+1`。`tmux_down` 只设 health（486），不算 ended → 按 10s 上限持续重连 |
| sendInput 返回值 | 212–220 | 先 `exitScroll()`；OPEN 才发送并返回 true，否则 false。只有 `sendComposer`（243–244，未发出不清空）用了返回值；`handleBarKey`（224–235）、`term.onData`（307–312）忽略它。**绕过 sendInput 的发送路径**：`onBinary`（322–330）、mouse 开关（758–759）、sendScroll（141–146）、scroll_watch（151–157） |
| resize 门控 I-12 | `lib/terminalSize.ts:9-21`、558–582、584–597 | `shouldSendResize`：active、容器非 0×0、cols≥20/rows≥5、与上次不同。`handleResize` 先跳 0×0（566）再 `fit.fit()` 再过门控。active→true 时 lastDims 置 0，50ms 后 handleResize，桌面端还 focus |
| keyboardOpen refit | 607–611；VisualViewport 632–655 | 仅触屏+active：`overlap>120` 设 keyboardOpen（643），切换后 50ms handleResize |
| wsStatus→open 后 refit | 616–620 | 连接条卸载后 50ms 再 fit；另有 split refit（623–627）、`AppShell.tsx:111-115` 的 `dispatchEvent('resize')` |

**抽 `useTerminalSocket` 时带走**：连接 effect（420–541）整体，含闭包变量；`wsRef`；`wsStatus`（JSX 707/713 与 refit effect 616 读取 → 由 hook 返回）；`endedRef`（onmessage 写 485、onclose 读 518/524、`handleRevive` 写 553 → 暴露 `resetEnded()` 或返回 ref）；`lastDims`（onopen 470/472、`handleResize` 579、active effect 588 三处写 → 共享、由 hook 返回）；onopen 里的 reset、首发 resize、mouse-off 原样保留。

**留在组件、以 ref/回调传入**：`activeRef`/`tmuxRef`/`tmuxOriginRef`（onopen 读，但 exitScroll、触摸 handler、`onMouseDownHint` 也读）；`replayingRef`/`userScrolledUpRef`/`scrollDebounceRef`/`openedOnceRef`/`reconnected`（视图侧"回放贴底"逻辑；output 段 498–507 的 120ms debounce 必须原样：hook 负责 write 后回调 `onOutputSettled`，或组件自己 write）；scroll 族 `scrolling`/`scrollingRef`/`appScrollRef`/`lastScrollOpRef`/`newLines`（scroll_state 489–495 经 `onScrollState` 回调）；`lost`/`ended`/`health` 经 `onNotice` 回调；`handleResize` 与全部 refit effect（依赖 active/isTouch/keyboardOpen/split）；status 轮询。

**抽 `useXterm` 时带走**：init effect（250–406）、主题 effect（409–413）；`termRef`/`fitRef`/`searchRef`/`initRef`；`containerRef` 由组件创建后传入（JSX 要用）。
耦合点：init effect 内用到 `sendInput`（311）、`exitScroll`（323）、`setHistoryOpen/setSearchOpen`（294–295）及 `sendScrollRef`/`cancelInertiaRef`/`wheelSinceInputRef`/`replayingRef`/`userScrolledUpRef`/`tmuxRef`（触摸滚轮 332–391）。建议传 `handlersRef = {onData, onBinary, onCtrlF, onScroll}` 每次渲染同步，其余 ref 透传。
注意：现状 `term.onData` 抓的是首次渲染的 `sendInput`（陈旧闭包，其中 `exitScroll` 的 `isTouch` 也是旧值）——既有行为，只搬不改会原样保留。

**两条硬约束**：
- **调用顺序**：`useXterm` 先于 `useTerminalSocket`。连接 effect 依赖同一次提交中 init effect 已设好 `termRef`，而 deps 不含 termRef，顺序反了不会重跑 → 永远连不上。
- **跨 hook 引用**：init cleanup 403 行 `wsRef.current?.close()` 会造成循环依赖。可删（539 行已做同样的事，且 pane 按 `key={s.id}` 挂载，`AppShell.tsx:161`，sessionId 不变），或由组件创建 wsRef 同时传给两个 hook。

### B2. B14：onclose 无条件清 wsRef —— 生产不可达

514 行 `wsRef.current = null` 确为无条件 ✅。逐条推演"旧 close 晚于新 socket 赋值"：

1. **正常重连**：ws1 close → onclose(ws1) 同步清 wsRef 并排队 retry → ≈1s 后 `connect()` 设 ws2。close 事件每 socket 仅一次；`onerror→close()` 对 CLOSING/CLOSED 是 no-op。**不可达。**
2. **切换会话**：不重连（I-1），pane 常驻挂载、`hidden` 切换（`AppShell.tsx:161`）。**不可达。**
3. **可见性重连**：TerminalView 中 `visibilitychange` 零命中 ✅。**不存在。**
4. **effect 重跑**（wsEpoch 变、卸载、dev StrictMode）：cleanup `ws1.close()` 是异步的 → 新一轮 effect 在 422 `if (wsRef.current) return` **直接返回，根本不建 ws2**，无从误清。真正潜伏的是反向问题：此时序下**连不上**（ws1 的 onclose 来时 `disposed=true`，不重连也不改状态）。生产中仅"收到 tmux_ended、服务端 Close 未到、用户已点复活"会碰上，几乎不可能。dev StrictMode（`main.tsx:1,14`）下 init cleanup 还会 `term.dispose()`，之后 initRef 挡住重建 ——**假设**，未在浏览器验证。

**复现（仅 fake）**：`s1.fireOpen → s1.fireClose → 推进 1010ms 得 s2 → s2.fireOpen → 手动 s1.onclose?.() → onData('x')` → wsRef 已为 null，`sendInput` 返回 false，`inputs(s2)` 长度 0。红来自真实浏览器不会发生的事件。

**建议**：
- 照加最小修复 `if (wsRef.current === ws) wsRef.current = null`；更好：onclose 开头 `if (wsRef.current !== ws && wsRef.current !== null) return` 整体早退（旧闭包的 `disposed/stableTimer/attempt` 本属于它，早退安全）。commit message 注明"浏览器语义下不可达，防御性加固"。
- 若同时修第 4 条"连不上"：在 cleanup（539）`close()` 之后 `wsRef.current = null`。**必须和身份守卫同一提交**——一旦 cleanup 清空 wsRef，新 effect 能建出 ws2，迟到的 ws1 onclose 才真会误清 ws2，B14 就变成可达了。

### B3. MobileKeyBar / HistoryView 现状与 V4 / V5 / V16

**MobileKeyBar.tsx（86 行）**：第一页 history（40–43，已是 lucide `History`，代码里**没有 📜**，只在 spec 示意图里）、↑↓↵（9–13）、`^C`（15–17）、claude/codex/crew（19–23）。第二页 `PAGE2`（26–31）：Esc Tab ←→ ^D ^Z PgUp PgDn。翻页状态本地 `useState(0)`（34）；翻页键（82–83）文字 `⋯`/`↩︎`，走 `onPointerDown + preventDefault + touchAction`（I-15）。

**V4**：
- `lib/terminalInput.ts:68-78`：`ControlKey`/`CONTROL` 加 `ctrl-r=\x12`、`ctrl-l=\x0c`。
- **Home/End 不要写死**：xterm 按 DECCKM 发不同序列——普通模式 `ESC[H`/`ESC[F`，application cursor 模式 `ESC OH`/`ESC OF`（`@xterm/xterm/lib/xterm.mjs` 的 `case 36/35`）。应像 `arrowSequence` 那样按 `term.modes.applicationCursorKeysMode` 分派（扩展 `handleBarKey`，TerminalView 230–231）。**计划草案写死 `\x1b[H`，与此不一致。**
- `PAGE2` 追加 4 键后共 12 个 `flex-1` 按钮，390px 宽下每个约 28px，不满足 44px 触控目标 → 分两行或横向滚动（宽度按计算，**假设**）。
- 收起/展开：MobileKeyBar 加 `collapsed/onToggleCollapsed` props，TerminalView 持有 state 并读写 localStorage `zmx_keytray`；收起后 refit 并入 607–611 effect 的 deps，不另开 effect。

**V16（去 emoji）**：
- 真 emoji：TerminalView **763 行 `🖱`（两处）、772 行 `⧉`** ✅。
- 注释里还有 `⤓`（193）和 `AcpChatView.tsx:314 📎`。lint 的 emoji 规则扫原始源码，**注释也算**（`scripts/lint-tokens.mjs:13,42`）；基线 `emojiIcon: 5` 正好 = 🖱×2 + ⧉ + ⤓ + 📎。去掉 🖱、⧉ 后须把基线降到 2（ratchet 会要求）。
- 👍👎 在 src 零命中。
- 按"只用 lucide"口径可一并换的非 emoji 字形：MobileKeyBar 83 `⋯/↩︎`；HistoryView 113–115 `▲▼✕`；TerminalView 686 `✕`、721 placeholder「点 ✈」。

**HistoryView.tsx（140 行）**：第 6 行从 `./ui` 导入 `confirm`（项目自有 primitive，不计 nativeDialog）；props `onSendToAgent`（15）；底栏 124–137（首行 / 底部 / 复制全部 / 颜色 / 发给 agent）；发送 **129–136**：131 读 `getSelection()`，132 彩色模式去 ANSI，133 无选区取 `slice(-200)`，**134 行 `await confirm(...)`** ✅（spec 写 :132，有偏差）。

**V5**：
- 删 134 行 confirm 与第 6 行 import。
- 129–136 改主按钮「发给 ★〈名〉」：目标 `sendTargets(...)[0]`，一击 `sendPrompt(wrap(payload))`；长按或旁边 ▾ 打开 SendToMenu；无候选时按钮改为开菜单。
- 选区在 pointerdown 时读取并缓存（防开菜单后焦点变化清掉选区）；长按按钮需 `-webkit-touch-callout:none; user-select:none`，否则 iOS 弹系统选词（**假设**，未真机验证）。
- `HistoryView.test.tsx` 中 "asks for confirmation…" 与 "strips ANSI…" 两条须按新交互改写。

### B4. 终端 onAskAgent 与 HistoryView confirm 接到 SendToMenu

**现状**：`AppShell.tsx:165` ✅ `onAskAgent={(prompt) => shell.create('claude', s.work_dir, undefined, prompt)…}` 写死 claude。TerminalView 701–705 仅在 `onAskAgent` 存在时给 HistoryView 传 `onSendToAgent`：关抽屉，再 `historyPrompt({name, workDir: status?.work_dir, text})`（`lib/historyToAgent.ts:6-34`，32KB 截断）。

**SendToMenu 接口**（`SendToMenu.tsx:28-40`）：`open, anchor, onClose, text, workDir, excludeId?, sessions, controls, queueModes, onSelectSession, onNew, title?, confirmDanger?`。内部 `send`（41–51）成功 toast「已发给 X」+「查看」，失败「未连接,未发送」+「复制」。候选（52）`sendTargets` 过滤 tmux、同目录优先、按活跃度（`lib/sendTargets.ts:4-10`）。底部固定密钥提示（69）。现有调用点：`AppShell.tsx:316`（笔记 ⚡，配 `sendTo()` 帮助函数 128–130）、`GitViewer.tsx:382`（`GitSendTo` 类型在 `GitViewer.tsx:10`）、`CommandPalette.tsx:327`。

**接线方案**：
1. `SendToMenu.tsx` 导出 `type SendToProps = Omit<Props,'open'|'anchor'|'onClose'|'text'>`（即 `GitSendTo` 上移改名）；把 41–51 抽成导出函数 `sendToSession(target, text, {controls, onSelectSession})`，供 HistoryView 一击发送复用，toast 逻辑不写两份。
2. `AppShell.tsx:163-165` 删 `onAskAgent`，改传 `sendTo={sendTo(s.work_dir)}`。
3. TerminalView：prop `onAskAgent`（43、46）换 `sendTo?: SendToProps`；给 HistoryView 传 `sendTo` 与 `wrap = t => historyPrompt({name: tmuxName, workDir: sendTo.workDir ?? '', text: t})`。**work_dir 改用 SessionInfo 的，不再用 `status?.work_dir`**，否则 §4.6 收紧轮询后这里拿不到值。
4. HistoryView：一击调 `sendToSession`；长按渲染 `<SendToMenu {...sendTo} text={wrap(payload)} …/>`；窄屏 Popover 自动变 Sheet（`ui/Popover.tsx:29`）。
5. **「＋ 新开」必须单独处理，见 §B7a。**

### B5. 隐藏终端的 status/health 轮询（§4.6）

- **TerminalView 117–128** ✅：裸 `setInterval(fetchStatus, 10000)`，挂载即拉一次，deps `[sessionId, tmuxName]`，**不看 active、不看页面可见性**。每 tick 拉 `getSessionStatus`，tmux 会话还拉 `getTmuxHealth()`——`/api/tmux/health` 是全局端点却每个终端各拉一次。
- 所有 pane 常驻、`hidden` 切换（`AppShell.tsx:161`）→ **隐藏终端持续轮询**：N 个 tmux 会话每 10s 发 2N 个请求。触屏上桌面状态栏根本不渲染（727），但轮询照跑。后台标签页浏览器会节流但仍触发。
- **spec §4.6「S1 的 usePolling 已限定 active + 可见」与代码不符**：`usePolling`（`lib/usePolling.ts:5-36`，只按页面可见性暂停，不管 active）只被 AgentDashboard:70、WaitingPage:23、`useSessionsPoll.ts:94`（调度器健康 60s）使用。
- 其他轮询：`useSessionsPoll.ts:57-71` 会话列表 3s（裸 setInterval，页面隐藏也不停）；`:86` 确认队列 30s；`AppShell.tsx:53` 3s 时钟；`GitViewer.tsx:122` 挂载拉一次 status。
- **建议**：`usePolling(fetchStatus, 10_000, { enabled: active })`（隐藏→active 时立即拉一次）；tmux health 上提到 AppShell 只拉一份。

### B6. 现有测试覆盖

| 文件 | 覆盖 |
|---|---|
| `TerminalView.mobileLayout.test.tsx`（4 条） | **自带内联 xterm mock**（非 xtermMock）：触屏不渲染状态栏；键栏与 composer 同一底部容器；键盘弹起跨 120px 阈值 refit 一次且不多 refit；close→open 后 refit |
| `MobileKeyBar.test.tsx`（5 条） | 第一页键；第一页无 esc/←→；pointerDown 传逻辑键名；history 键开关；翻页往返 |
| `HistoryView.test.tsx`（9 条） | 加载、截断提示、复制、全屏提示、错误、搜索、颜色切换、**confirm 发送与 ANSI 去除（这两条要改写）** |
| `crewSessionType.test.tsx:89-101` | **源码 grep TerminalView.tsx 中含 `key === 'claude'` 的行**——handleBarKey 移出该文件即红 |
| `AppShell.test.tsx:75-82`、`App.characterization.test.tsx:43-52` | 切换会话时 xterm 实例数与 WS 数不变（I-1） |
| lib 测试 | terminalSize / terminalInput / terminalScroll / desktopHints / historyToAgent / scrollReplay / TerminalNotices |

**完全未覆盖**：I-5 reset；I-4 退避与 3s 稳定窗口；tmux_ended 不重连；sendInput 未 OPEN 返回 false；I-12 onopen 首发与隐藏视图不发；切到 active 重发尺寸；B14；mouse-off 首发；scroll_state 胶囊；replay 贴底；onBinary；status 轮询；AppShell 的 onAskAgent 接线。

**`test/xtermMock.ts`（22 行）提供**：Terminal 的 cols/rows/options，`modes` 仅 `bracketedPasteMode`，方法全是 no-op 返回 disposable；Fit/Webgl/Search/Clipboard 桩。

**写 characterization 还缺**：取最近实例句柄；reset/write/focus 调用计数；**write 不调回调**（replay debounce 路径永不执行）；onData/onSelectionChange 的 handler 未收集；`modes.applicationCursorKeysMode` 缺失（读出 undefined，恰落 CSI 分支）；`proposeDimensions` 返回固定值、`fit()` 不改 cols/rows；`hasSelection` 写死 false。

**`test/fakeWs.ts` 的坑**：默认构造即 readyState=OPEN，不经 onopen 也能发送 → 测 I-13 须 `startConnecting:true`（22–39）。happy-dom 元素全 0×0，需 spy `clientWidth/Height`；mobileLayout 那种整原型 spy 区分不了隐藏与可见视图。

### B7. 风险：spec 与代码偏差、首屏体积

**7a【高】「＋ 新开」路径会压扁终端 prompt**：SendToMenu 的「＋ 新开…」走 `AppShell.tsx:118-120` `openNewPrefilled` ✅，把整段 prompt 塞进 ⌘K 的**单行 `<input>`**（`CommandPalette.tsx:262` ✅，`maxLength=512` 只限手动输入）。按 HTML 规范 text input 的 value 会剥掉换行，随后 `parseNew` 以 `toks.join(' ')` 把空白压成一个（`lib/paletteParse.ts:9-15`）→ historyPrompt 的多行输出和 ``` 围栏被压成一行。现在写死的 `shell.create('claude', …, prompt)` 反而传全文，**删掉 onAskAgent 会回归**。建议：终端入口的 `onNew` 直接 `shell.create(type, workDir, undefined, prompt)` 保留全文，或 palette 以带外方式携带 payload。（按规范推断，**假设**，未浏览器实测。）

**7b spec ↔ 代码偏差**：
- §4.6 的 usePolling 前提不成立（§B5）。
- spec 引用 `App.tsx:454 onAskAgent`，现在在 `AppShell.tsx:165`（App.tsx 只剩 76 行）。
- spec `HistoryView.tsx:132` 实为 134。
- spec 的 📜 在代码中已是 lucide 图标。
- §4.2 的自定义键编辑器与 `⌘⇧Enter` 已被 V2/V4 删除，以 §0.3 为准。
- §5.2 写"首屏 ≤ 400KB"，实际门禁 330KB（`package.json` build：`check-size.mjs dist 337920` ✅）。
- 计划草案 Home/End 写死 `\x1b[H`，与 DECCKM 不符（§B3）。

**7c 抽 hook 的结构性风险**：hook 调用顺序与 403 跨 hook 引用（§B1）；crewSessionType 源码 grep 钉死 handleBarKey 所在行；`onBinary`、mouse、scroll 发送路径本就不经 sendInput，只搬不改要原样保留。

**7d 首屏体积**：
- 门禁 `scripts/check-size.mjs`：统计 index.html 引用的 entry script + stylesheet + modulepreload，按 `.br` 求和。
- 对现有 `dist`（2026-09-28 15:08 构建，推断对应 HEAD，**假设**）跑 `node scripts/check-size.mjs dist 337920`：`index-7c28bUSe.js` 304.5KB + css 8.9KB = **313.3KB / 330KB，余量约 16.7KB**。
- **终端相关全在入口 chunk**：AppShell 静态导入 TerminalView、SendToMenu（13–14）；xterm/HistoryView/MobileKeyBar 字符串只见于 `index-*.js`；xterm.css 由 `index.css:2` 引入；只有 `ansi.worker` 独立 chunk；懒加载仅 `lazyPanels.ts:4-13` 的 10 个面板。
- node_modules 单文件粗估 br：xterm core ≈75KB、addon-webgl ≈31KB、search ≈11.5KB、clipboard ≈2KB、fit <1KB，合计 ≈120KB（打包后会不同，**假设**）。
- S4 新增 lucide 图标每个几百字节，影响小。预算紧时最大手段是 `WebglAddon` 动态 import（≈−31KB），但会改变初始化时序，不属"只搬不改"，需单独评估；HistoryView 懒加载可再省几 KB。

