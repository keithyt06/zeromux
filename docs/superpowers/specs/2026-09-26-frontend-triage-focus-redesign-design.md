# 前端重设计「Triage + Focus」—— 设计

日期:2026-09-26
状态:v2(2026-09-27 CTO + PM + 高级 UI/UX 三方交叉评审后修订 §3 S1 与若干 S2 条目,见 §0.4;P0 已上线 3601fb4)
基线:`main` @ `acb3ea3`
输入:
- 前端审计 `docs/superpowers/audits/2026-09-26-frontend-ux-audit.md`(以下简称「审计」,§/I-/B- 编号均指它)
- PM review、CTO review(本会话并行子 agent,结论已吸收进本文;关键断言主会话复核,见 §0.3)

---

## 0. 背景与决策

### 0.1 用户与目标(用户确认)

- 单人自用;**手机浏览器与 Mac 浏览器比例相当,两端都要一流**;纯 Web/PWA,不做原生。
- 同时开 3–8 个会话,agent 会话为主。
- 五大痛点**全部存在**:A 找/切会话慢、分不清谁在跑/谁在等我;B 盯 agent 累、无全局态势;C 操作路径长;D 对话信息阅读费劲;E 视觉过时。
- 接受大刀阔斧修改。

### 0.2 交叉评审收敛

| 议题 | PM | CTO | 决定 |
|---|---|---|---|
| 核心隐喻 | 分诊队列(Superhuman 式)+「下一个」键 | 可接受看板,但只读聚合 + 跳转 | **分诊队列**。单人 3–8 会话,四列看板多数时间空。同一份数据以后可加看板视图 |
| 「等你处理」 | 砍审批类(Claude 以 skip-permissions 运行,几乎无审批) | 只有 Crew 审批 + 定时确认两类真信号;「空闲」不可包装成「等你」 | 保留收件箱,**只收真信号**:出错/卡住、完成未读、Crew 待审批、定时待确认 |
| 卡片直接回复 | 不做(易发错会话) | 若做,只能走已挂载 AcpChatView 的 `sessionControls`,禁止卡片自开 WS | **不做回复**;行内只做「中断」「批准」一击操作,经 `sessionControls` |
| 顺序 | 止血 → 地基 → 分诊 | 修缺陷/压缩/api/stale 收敛 → characterization → strangler 新壳 | 合并为 P0 → S1 → S2 → S3 → S4(§1) |
| 库 | — | 引 zustand、Radix(按需);不引路由、motion、cmdk;虚拟列表暂不引 | 采纳 |
| 分屏(方案 C) | 不做 | WebGL 上下文上限 | 非目标 |

### 0.3 主会话复核过的关键断言

- `Composer.tsx:39` Enter 未判 `isComposing`;`App.tsx:72` `isMobile` 单次 `useMemo`;`AcpChatView.tsx:687` WS 未 OPEN 直接 `return`;全仓 `.tsx` 零 `sm:/md:/lg:`;`MarkdownViewer.tsx` 仅被测试引用。
- `Cargo.toml:9` tower-http 只开 `cors`、`set-header`,**无压缩**;`frontend/dist/assets/index-*.js` 1,364,669 B 原样下发。
- `SessionInfo`(`session_manager.rs:386-406`)无成本/结果/片段/当前步骤字段;`lifetime_cost_usd` 存在于 `Session`(`:331`)但未导出。
- 所有 fan-out 事件经唯一咽喉 `emit`(`:3555`)→ `record_and_broadcast`(`:2025`,锁内、无 I/O)。

### 0.4 v2 修订(2026-09-27 三方交叉评审)

用户要求:「大刀阔斧但要美观、便捷、功能不重复」。三份评审(CTO / PM / 高级 UI/UX)的关键断言主会话已复核:
`--text-muted` #484f58 on #11161d = **2.19:1**(170+ 处使用,S1 对比度验收必挂);br q4 → q11 预压实测 JS 388,540 → 312,657、CSS 8,820 → 7,556(**腾出 ~77KB**);
happy-dom 15 有 `<dialog>.showModal` 但**无 Popover API**;`text-[8-11px]` 现 180 处(非 136),调色板直用 16、`z-*` 26、原生弹窗 17;stale 测试现存 4 个 `*.stale.test.tsx` + 3 个含 reqRef 断言的文件。

| # | 修订 | 来源 | 裁决理由 |
|---|---|---|---|
| R1 | **Primitives 不用 Radix**:Sheet/Dialog 用原生 `<dialog>`(top-layer,天然越过 `contain: paint`/overflow/z-index,无需 portal);Popover/Menu 用定位 `div` + 自写点外/Esc(不用 Popover API) | CTO(体积)+ 主会话(happy-dom 无 Popover API,不可测) | Radix 三件 25–35KB br 会吃掉全部余量;原生 ≈3KB;Popover 自写与现有 6 处手写遮罩同构,只是收敛为一个组件 |
| R2 | **S1 第一件事是构建期 br q11 预压 + 体积门禁**(`scripts/check-size.mjs`) | CTO | 在线 q11 每请求 ~2s CPU 不可行;预压腾出 77KB,让后续所有工作不再为 3KB 余量卡脖子 |
| R3 | **token 终值采用 UI/UX 表**(§3.1 v2),`--text-muted`(→ `--fg-subtle`)暗 #848d97 / 亮 #5f6873,在最深的 surface-3 上仍 ≥ 4.5:1(主会话复算;UI/UX 原值 #7d8590/#6e7781 在 surface-3 仅 4.08/4.01);新语义层 `--color-*` 为唯一真源,旧 `--bg-*`/`--text-*`/`--accent-*` 保留为兼容别名 | UI/UX + CTO(`@theme inline`) | 修对比度是全局可见变化,**明确告知用户**(非「零视觉变化」) |
| R4 | **状态视觉收敛为 5 种语义**:danger(error)、stuck(橙,与 error 分开)、attention(approval/confirm/done_unread)、running(= accent + 呼吸)、muted(idle/ended);StatusDot 以**形状 + 颜色**区分(色弱) | PM(4 种)+ UI/UX(6 种)折中 | stuck 与 error 处理动作不同(中断 vs 查看),须分色;approval/confirm/done_unread 都是「该你了」,同色不同形 |
| R5 | **密度按 `(pointer: coarse)` 切换**(桌面紧凑 13px 正文 / 32px 行;触屏舒适 15px / 44px 行),与布局断点解耦 | UI/UX | 同一 token 两套密度,CSS 实现比 JS 分支便宜;iPad + 触控板等混合设备按指针判定更准 |
| R6 | **字号阶梯**:2xs 12 / xs 13 / sm 14 / base 15 / input 16 / lg 17 / xl 20;12px 仅角标/时间戳;16px 只给 input(I-15) | UI/UX | Tailwind 默认 `text-xs`=12px 不改名(避免 111 处静默变化,CTO);新增命名 `text-ui-*` 层,旧类逐文件迁 |
| R7 | **lint 门禁用棘轮(ratchet)**:记录当前计数,只许减不许增,第一天即上线 | CTO | 不必先迁完 180 处才上门禁 |
| R8 | **主题三态无闪烁**:`public/theme-boot.js` 同步脚本(CSP `script-src 'self'` 禁内联)在首帧前设 class + `color-scheme`;xterm/mermaid 读**已解析**主题 | CTO | 现 `useEffect` 设 class,亮色用户每次先闪暗 |
| R9 | **`request<T>` 超时按端点显式,不设默认**;`useAsyncResource` 只有 key 变化才清 data,`reload` 不清 | CTO | createSession(隔离 24s)、上传、JuiceFS git diff 会被 15s 误杀;fe5396b 修过「写后闪空」 |
| R10 | **push 客户端单独迁移**:`lib/push.ts` 的 `enablePush` 现在 subscribe 500 仍写本地已启用(真 bug),PushSettings.toggle 无 catch | CTO | 统一抛错会暴露未处理 rejection,须同时补 catch |
| R11 | **S1 只迁「不会被 S2/S3 重写」的站点**。AcpChatView、GitViewer、FileBrowser、App.tsx 轮询/焦点、SessionInfoBar 的 reqRef/原生弹窗/hover-only/小字号**留给 S2/S3 的重写**;S1 验收相应改为「S1 负责文件清零 + 全局棘轮不增」 | CTO | 避免 S1 迁完 S3 又重写一遍(重复劳动) |
| R12 | **新增 primitives**:Kbd、Badge、SegmentedControl、Tooltip(仅桌面)、Skeleton;EmptyState 并入 PaneStatus。**推迟**:StatusDot 与 PaneStatus 实现推到 S2/S3(状态集由 triage 定;Git/Files 面板 S3 重写),但 S1 **锁定其 token 与形态规范** | UI/UX + CTO | 规范先锁、实现跟需求 |
| R13 | **手机上 Menu/Popover 一律以 bottom Sheet 呈现**;Sheet 最多一层(禁 Sheet 套 Sheet) | UI/UX + PM | 锚定浮层遇 iOS 软键盘会被顶出屏幕(未验证,S1 真机确认) |
| R14 | **图标只用 lucide,禁 emoji**(📜、👍、⧉ 等) | UI/UX | 视觉一致;emoji 跨平台渲染不一(P0 的「⤒→不」同类) |
| R15 | **`lib/format.ts`**:成本(列表/顶栏 2 位,详情 4 位)、耗时、相对时间统一;数字 `tabular-nums` | UI/UX + PM | 审计 §3.3「三处精度不一」 |
| R16 | **sanitize 回归测试锁死 `popover`/`popovertarget`/`dialog` 属性与元素不被放行** | CTO | 若将来放行,笔记可免 JS 弹出穿透 `contain: paint` 的全屏层(I-16) |
| R17 | **截图基线工具进 S1**(playwright-core,P0 T8 已验证可用;gstack browse 需 bun 未装) | CTO | S1 是第一次动全局视觉,须有前后对比 |

**对 S2 的修订(本版一并记录,S2 plan 时落实)**:

| # | 修订 | 来源 |
|---|---|---|
| R20 | **手机底部 Tab 栏取消**。会话页全屏,左上「‹ 分诊 (3)」;分诊页底部常驻「搜索或新建…」输入条(= ⌘K 入口);会话页仅 FAB ⏭(「需要你」> 0 时)。 | PM(三方中两方指出 Tab 重复 ⌘K;占 ~90px 与终端可视高度目标冲突) |
| R21 | **⌘K 空状态**直接列 quick targets + 最近会话(否则手机新建常用目录比现在更慢) | PM |
| R22 | **新建会话唯一实现 = ⌘K 新建模式**;Sidebar 六步状态机、「+新建」Tab 在 v2 上线当天删除(不留两周);其他入口(QuickTargets、⚡、SendToMenu「新开」、搜索结果「在此开 agent」)只做**预填 ⌘K** | PM |
| R23 | **`lib/sessionActions.ts` 动作注册表**:重命名/置顶/关闭/复制 peer/复制 attach 等只注册一次,TriageRow ⋯、FocusHeader ⋯、⌘K 动作三处都从它渲染 | PM |
| R24 | **砍**:置顶(与 attention 排序冲突)、`K`/`⌘[`(保留 `J` 与 `⌘]`)、顶栏横滑手势(与 iOS 边缘返回冲突)、手动 Blocked/Done 状态(与 attention 双系统) | PM |
| R25 | **补**:`document.title` 计数 + PWA `navigator.setAppBadge`;分诊行「忽略」(不进会话清提醒);定时任务「立即运行」后「打开会话」 | PM |
| R26 | **TriageRow 两行**(名称 + 状态/耗时;片段 + 行内动作),成本仅桌面显示 | UI/UX |
| R27 | **队列模式 chip 点一下即切换**(只有两个值,不开菜单) | PM |

**对 S3+S4 spec(2026-09-27-focus-session-experience-design.md)的修订**由该文件 v2 记录(ContextPanel 3 tab、删 Esc Esc/⌘⇧Enter/⌘1-5/自定义键编辑器/可拖宽/每会话记忆等)。

---

## 1. 路线图

| 阶段 | 目标 | 本 spec 深度 | 可独立部署 |
|---|---|---|---|
| **P0 止血** | 修高频缺陷、压缩、手机终端底部 | 详细(§2) | ✅ |
| **S1 地基** | 设计 token、响应式、primitives、数据层收敛 | 详细(§3) | ✅(视觉统一,IA 不变) |
| **S2 分诊与导航** ⭐ | 态势字段 + 分诊队列 + 下一个 + ⌘K + 新壳 | **完整**(§4) | ✅(新旧壳开关) |
| S3 对话体验 | turn 摘要卡、tool 配对、Context 面板 | 纲要(§5),另起 spec | — |
| S4 移动终端 | 键栏收起、选中转发、WebGL 策略 | 纲要(§6),另起 spec | — |

每阶段单独出 implementation plan;每步部署走 `./deploy.sh --build`,**先 commit + push 再 deploy**。

---

## 2. P0 止血

### 2.1 缺陷修复

| # | 位置 | 修法 | 测试 |
|---|---|---|---|
| B7 | `Composer.tsx:38-43` | `if (e.nativeEvent.isComposing \|\| e.keyCode === 229) return` 先于 Enter 判断 | Composer 单测:`isComposing:true` 的 Enter 不触发 send |
| B8 | `AcpChatView.tsx:687` | `sendPrompt` 返回 `boolean`;未 OPEN 返回 `false`,Composer 不清空(同 TerminalView `sendInput` 语义 I-13);`registerControls` 暴露的签名同步改 | 组件测:socket CLOSED 时发送 → 文本保留 + 出现连接条 |
| — | AcpChatView / TerminalView | **连接状态条**:WS 状态 `connecting/open/reconnecting(attempt)/ended` 暴露为 state;非 open 超 1.5s 在 composer 上方显示细条「重连中…」,ended 显示「会话已结束」 | 同上 |
| B3 | `App.tsx:261-274` + Sidebar 调用点 | `handleCreate` 返回 Promise,失败抛出;Sidebar `await` 后才关弹层,失败留在当前步并显示错误行 | `Sidebar.newflow` 增 case:create reject → 弹层不关、显示错误 |
| B1 | `ScheduledTasksPanel.tsx:79-93` | toggle 改为发送完整 task(含 `idle_timeout_min`、原 schedule kind),或后端改 PATCH 语义(plan 阶段二选一,优先前端) | 单测:toggle body 含 `idle_timeout_min` 与原 schedule |
| B4 | `FileBrowser.tsx:109-127` | cwd 变化时同步 `setLoading(true)` + 清 `entries`;加载中列表不可点 | FileBrowser 测:切目录期间旧行不存在 |
| B15 | `MarkdownViewer.tsx` + 其测试 + 过时注释 | 删除 | `npm test` 绿 |

### 2.2 压缩

- `Cargo.toml`:tower-http 加 `compression-gzip`、`compression-br` feature;`build_router` 外层加 `CompressionLayer`。
- **WS 升级路由不得被压缩层影响**(plan 阶段实测 `/ws/*` 仍能 101 升级);SSE/流式端点若有需同样验证。
- 验收:`curl -H 'Accept-Encoding: br' -sI /assets/index-*.js` 带 `content-encoding: br`;主包传输体积 ≤ 400KB。

### 2.3 手机终端底部(对应截图 IMG_1629)

- 滚动胶囊(`TerminalView.tsx:710-717`,现 `bottom-28` 固定)改为相对**输入区顶部**定位,不覆盖 MobileKeyBar。
- 「⤒顶」字符在 iOS 渲染为「不」:改用 lucide `ArrowUpToLine` 图标 + `aria-label`。
- 软键盘收起时,MobileKeyBar + Composer 合并为**一行**(键栏横向滚动,右端发送);路径/tmux 名状态栏(`:745`)收进顶栏 ⋯。
- 验收:iPhone 竖屏(390×844 视口)键盘收起时终端可视高度 ≥ 75%;任何浮层不遮挡键栏按钮(截图回归,见 §7)。

---

## 3. S1 地基(v2)

> 本节为 v2(按 §0.4 R1–R17 重写)。S1 目标:**让后续 S2/S3/S4 只用组件和 token 拼界面,不再手写样式与遮罩**;同时一次性修正全局对比度与字号。S1 会产生**全局可见的视觉变化**(次要文字变亮、小字放大、主题跟随系统),不改信息架构。

### 3.0 构建与体积(第一件事)

- **构建期预压**:`vite build` 后运行 `scripts/precompress.mjs`,对 `dist/**/*.{js,css,html,svg,json,woff2?}` 生成 `.br`(Node `zlib` brotli q11)与 `.gz`(level 9),仅对 ≥ 1KB 且压缩后更小的文件。
- **后端**:`try_serve_embedded`(`web.rs:222`)按请求 `Accept-Encoding` 优先返回嵌入的 `path.br` / `path.gz`,设 `Content-Encoding` 与 `Vary: Accept-Encoding`,MIME 仍按原路径推断。**CompressionLayer 保留**给动态 JSON(P0),但对已带 `Content-Encoding` 的响应 tower-http 自动跳过(已核实)。
- **体积门禁** `scripts/check-size.mjs`:读取 `dist/index.html` 引用的入口 JS + CSS 的 `.br`,合计 **≤ 330KB**(当前 ≈ 320KB,留 10KB 给 S1 自身增长;S2 起每期 plan 须声明其预算并更新阈值)。接入 `npm run build`(构建失败即挡住部署)。
- **不引入**:Radix、Ariakit、Base UI、motion、cmdk、虚拟列表库。S1 **零新增运行时依赖**。

### 3.1 设计 token(v2 终值)

**机制**:`index.css` 中 `:root` / `:root.light` 定义新语义变量(唯一真源);旧变量改为指向新变量的别名(兼容 170+ 处现有用法);`@theme inline { --color-*: var(--*) }` 暴露给 Tailwind 工具类。

**颜色**(对比度按 surface-1 计):

| token | 暗 | 亮 | 旧别名 |
|---|---|---|---|
| `--surface-0` | #0d1117 | #ffffff | — (xterm 背景) |
| `--surface-1` | #11161d | #f6f8fa | `--bg-primary` |
| `--surface-2` | #161c25 | #eef1f4 | `--bg-secondary` |
| `--surface-3` | #1f2630 | #e4e8ec | `--bg-tertiary` |
| `--surface-hover` | #243040 | #dce3ea | `--bg-hover` |
| `--border` | #2a323d | #d0d7de | `--border` |
| `--border-subtle` | #1f252e | #e4e8ec | `--border-light` |
| `--fg-strong` | #e6edf3 | #1f2328 | `--text-bright` |
| `--fg` | #cdd6e0 | #1f2328 | `--text-primary` |
| `--fg-muted` | #9aa5b1(7.3:1) | #59636e | `--text-secondary` |
| `--fg-subtle` | **#848d97**(s1 5.4 / s3 4.53) | **#5f6873**(s1 5.31 / s3 4.72) | `--text-muted`(**值变**) |
| `--accent` | #58a6ff | #0969da | `--accent-blue` |
| `--accent-hover` | #79c0ff | #0550ae | `--accent-blue-hover` |
| `--on-accent` | #0d1117 | #ffffff | — |
| `--danger` | #f85149 | #cf222e | `--accent-red` |
| `--stuck` | #f0883e | #bc4c00 | — |
| `--attention` | #d29922 | #9a6700 | `--accent-yellow` |
| `--success` | #3fb950 | #1a7f37 | `--accent-green-text` |
| `--running` | = `--accent` | = `--accent` | — |
| `--brand` | #f7b500 | #b08800 | `--accent-brand` |
| `--focus-ring` | #58a6ff99 | #0969da80 | — |

- 删除 `--color-info`(与 accent 重复)。`--accent-green`/`--accent-green-hover`(按钮底)保留为 `--success-solid` 别名;`--accent-purple*`(peer 标签)保留为 `--peer`。
- `--ansi-0..15` 保留,xterm 运行时读取(§3.1.3)。

**状态语义**(R4,S2/S3 的 StatusDot/分诊唯一来源):

| 语义 | 颜色 | 形态(8px) | 覆盖的 Attention |
|---|---|---|---|
| danger | `--danger` | 实心 + 内白点 | error |
| stuck | `--stuck` | 实心 + 静态外环 | stuck |
| attention | `--attention` | 菱形 | approval、confirm、done_unread |
| running | `--running` | 实心 + 呼吸(opacity .5↔1,1.6s) | running |
| muted | `--fg-subtle` | 空心环 | idle、ended |

**字号**(R6;新命名层 `text-ui-*`,不覆盖 Tailwind 默认 `text-xs/sm/base`):

| token | px / 行高 | 用途 |
|---|---|---|
| `text-ui-2xs` | 12 / 16 | 角标、时间戳、kbd(**仅此**可用 12) |
| `text-ui-xs` | 13 / 18 | 桌面次要文字、手机辅助文字、代码块 |
| `text-ui-sm` | 14 / 20 | 桌面正文 |
| `text-ui-base` | 15 / 24(中文 1.6) | 手机正文、对话正文 |
| `text-ui-input` | 16 / 24 | **仅**输入框(I-15) |
| `text-ui-lg` | 17 / 24,600 | 面板标题 |
| `text-ui-xl` | 20 / 28,600 | 页面标题(登录、空态) |

- 数字列一律 `tabular-nums`(工具类 `.num`)。

**密度**(R5):

```css
:root { --row-h: 32px; --ctl-h: 28px; --hit: 28px; --pad-x: 12px; }
@media (pointer: coarse) { :root { --row-h: 44px; --ctl-h: 36px; --hit: 44px; --pad-x: 16px; } }
```
工具类 `.row`(min-height: var(--row-h))、`.ctl`、IconButton 命中区用 `--hit`。**正文字号不随 pointer 自动切换**(由组件按场景选 `text-ui-sm`/`text-ui-base`),避免全局静默变化。

**间距**:4px 基数,只用 Tailwind 默认 `0/0.5/1/2/3/4/5/6/8`(即 0/2/4/8/12/16/20/24/32px);lint 不强制(棘轮只管字号/颜色/层级)。

**圆角**:`--radius-sm 4`(chip/kbd)、`--radius-md 8`(按钮、行、输入)、`--radius-lg 12`(卡片、浮层)、`--radius-sheet 16`(Sheet 顶角)。

**阴影 / 层次**:暗色靠明度 + 1px 边框分层,**仅浮层**用 `--shadow-overlay: 0 8px 24px rgb(0 0 0 / .45)`;亮色 `--shadow-overlay: 0 8px 24px rgb(31 35 40 / .12)` + `--shadow-card: 0 1px 2px rgb(31 35 40 / .06)`。

**层级**:`--z-sticky 10`、`--z-drawer 30`、`--z-modal 50`、`--z-popover 55`(高于遗留手写 `z-50` 遮罩)、`--z-toast 60`;工具类 `.z-sticky` 等(Tailwind v4 写法 `z-(--z-modal)` 在 plan 首个 task 验证,不可用则用自定义类)。原生 `<dialog>` 在 top-layer,不参与 z 表。

**动效**:`--ease-out: cubic-bezier(.2,.8,.2,1)`、`--dur-fast 120ms`(hover/press)、`--dur-base 200ms`(面板/Sheet 进入)、退出 150ms ease-in;`prefers-reduced-motion: reduce` 时时长归零、呼吸停止。

**字体**(系统栈,不自托管):
- `--font-sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif`
- `--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace`(xterm 同源,取代 `TerminalView.tsx:301` 写死)
- `body` 默认 `font-family: var(--font-sans)`、`-webkit-font-smoothing: antialiased`。

#### 3.1.1 主题三态

- `lib/theme.ts`:`ThemePref = 'system'|'dark'|'light'`(存 `zeromux_theme`,缺省 `system`);`resolvedTheme: 'dark'|'light'`;`matchMedia('(prefers-color-scheme: light)')` 监听。**class 切换在 setter / media 回调中同步执行**,再 setState(子组件 effect 读到的已是新值,CTO §3 时序陷阱)。
- `public/theme-boot.js`(`index.html` `<head>` 同步引用,早于 CSS 外的一切):读 localStorage + media,设 `documentElement.classList` 与 `style.colorScheme`,防首帧闪烁。
- `index.html` 与 `manifest.json` 的 `theme-color` 改为两条 `<meta name="theme-color" media="(prefers-color-scheme: …)">`(暗 #11161d、亮 #f6f8fa);品牌黄仅保留在图标。
- 设置入口:Sidebar Settings 的主题项改为三态 SegmentedControl。

#### 3.1.2 消除硬编码

审计 §2.1 列出的调色板直用(现 16 处)、GitViewer graph/高亮 hex、`LoginPage` GitHub 按钮、`AcpChatView` fallback,**仅在 S1 负责的文件中**迁到 token(R11);其余由棘轮兜底。mermaid 按 `resolvedTheme` 初始化并在主题切换后重渲染(B13)。

#### 3.1.3 xterm 主题

`lib/terminalTheme.ts`:`readTerminalTheme(): ITheme` 用 `getComputedStyle(documentElement)` 读 `--surface-0`、`--fg`、`--accent`、`--ansi-0..15`、`--term-selection`;TerminalView 初始化与 `resolvedTheme` 变化时调用(取代 `TerminalView.tsx:27-72` THEMES)。`--ansi-*` 值以现 THEMES 为准(两处取值不一致时以 xterm THEMES 为准,因为那是用户实际看到的终端色)。

#### 3.1.4 门禁(棘轮)

`scripts/lint-tokens.mjs`:扫描 `src/**/*.tsx`(排除 `__tests__`),统计五类计数:`text-[8-11px]`、Tailwind 调色板直用、`z-\d+`、原生 `alert/confirm/prompt`、emoji 图标(📜👍👎⧉🖱✎ 等清单)。与 `scripts/lint-tokens.baseline.json` 比较:**任一类增加即失败**;减少时打印提示要求同步下调 baseline。接入 `npm run lint`。

### 3.2 响应式

- 断点:`md` 768、`lg` 1024、`xl` 1280(Tailwind 默认)。布局切换用 CSS 断点。
- `lib/useMediaQuery.ts`:`useMediaQuery(q)`(`useSyncExternalStore` + `matchMedia`);导出 `useIsNarrow()` = `(max-width: 767px)`、`useIsTouch()` = `(any-pointer: coarse)`。
- `App.tsx:72` 单次 `isMobile` 改用 `useIsNarrow()`(B11)。**只替换判定来源,不改 App 其余逻辑**(I-2/I-3 所在文件,S2 才重构)。
- TerminalView 触屏判定(`:131-135`)改用 `useIsTouch()`。

### 3.3 Primitives(`components/ui/`,零依赖)

| 组件 | 实现 | 规范 |
|---|---|---|
| `Dialog` | 原生 `<dialog>` + `showModal()`(StrictMode:先判 `el.open`);Esc 由浏览器处理并映射 `onClose`;关闭后焦点回触发元素 | 居中,`--radius-lg`,`max-width: min(480px, 100vw - 24px)` |
| `Sheet` | 基于 Dialog;`side = 'bottom' \| 'right' \| 'full'` | bottom:两档 `half`(50% 可视视口)/`full`(100% − safe-top − 8px);键盘弹出时高度取 `visualViewport.height` 并锁 full;底部 padding `max(12px, env(safe-area-inset-bottom))`;顶部 16px 圆角 + 把手;**下拉关闭**:仅把手区或内容 `scrollTop=0` 时响应,位移 > 30% 或速度 > 0.5px/ms。right:360px。full:手机 = 全屏页。**禁止 Sheet 内再开 Sheet**(dev 下 console.error) |
| `Popover` | 定位 `div`(fixed,`getBoundingClientRect` + VisualViewport 计算,碰撞翻转),挂在 `document.body` 末尾的 `#overlay-root`(非 `.xterm-container`、非 `.vault-reading-surface` 内);点外(pointerdown capture)与 Esc 关闭 | offset 6px,`max-width: min(320px, 100vw - 24px)`;**窄屏(useIsNarrow)自动改用 `Sheet side="bottom"`**(R13) |
| `Menu` | 基于 Popover;items `{label, icon?, danger?, kbd?, onSelect}` | 行高 `--row-h`;↑↓ / Home / End / 首字母跳转 / Enter;危险项 `--danger` 文字 |
| `toast` | 模块级队列 + `<Toaster/>`(App 挂一次);`toast.push({ message, action?, durationMs, key? })` | 同 key 去重;同屏 ≤ 3;桌面右下、手机底部居中(`bottom: calc(env(safe-area-inset-bottom) + 16px)`);带 action 的 toast 在 pointer 按住时暂停计时;**撤销关闭 toast 时长公式不变(I-18)** |
| `confirm()` | `await confirm({ title, body?, confirmLabel, danger? }): Promise<boolean>`,渲染 Dialog | 替代原生 `window.confirm`;**`ConfirmInline` 不做**(与 confirm 二选一,PM;行内两段确认仍可用现有模式) |
| `prompt()` | `await promptText({ title, initial?, placeholder? }): Promise<string \| null>` | 替代原生 `window.prompt`(FileBrowser 新建/重命名等) |
| `IconButton` | `<button>`,强制 `label`(aria-label + 桌面 Tooltip);视觉 28/36px,命中区 `--hit`(伪元素扩展) | 图标 16/18px(lucide) |
| `Tooltip` | 仅 `(hover: hover)` 设备渲染;500ms 延迟 | 触屏不渲染 |
| `Kbd` | `<kbd>` 样式 | `text-ui-2xs`,`--radius-sm`,`--surface-3` 底 |
| `Badge` | 计数 / 点 | `text-ui-2xs` `.num`,`--attention`/`--danger` 两色 |
| `SegmentedControl` | radio 组语义;←→ 切换 | 高 `--ctl-h`;选中 `--surface-3` + `--fg-strong` |
| `Skeleton` | 行级占位 | `--surface-3` + 1.2s shimmer(reduced-motion 下静态) |

- **StatusDot、PaneStatus**:S1 只锁规范(§3.1 状态表、R12),实现在 S2/S3。
- 全部 primitives 有组件测(键盘、Esc、焦点回归、`#overlay-root` 挂载点、窄屏 Popover→Sheet)。新增「给侧栏根加 `relative` 后 Sheet 仍全屏」(`<dialog>` top-layer 天然满足)。
- sanitize 回归(R16):`components/markdown/__tests__/sanitize.test.ts` 增 case:`<div popover>`、`<button popovertarget>`、`<dialog open>` 均被剥离。

### 3.4 数据层收敛

- **`lib/http.ts`**:`request<T>(path, init?: RequestInit & { timeoutMs?: number; parse?: 'json' | 'text' | 'none' }): Promise<T>` —— 复用 `api()` 的 header/credentials;`!res.ok` → `throw new ApiError(res.status, bodyText || statusText)`;`timeoutMs` 仅在显式传入时启用 AbortController(**无默认超时**,R9)。`api()` 保留(push 等暂未迁移的调用方)。
- **`lib/api.ts` 拆分**为 `lib/api/{core,sessions,git,files,vault,scheduler,push,memory,prompts,auth,search}.ts`,`lib/api.ts` 变为 `export * from './api/…'` 的聚合(所有 `import … from '../lib/api'` 与 `vi.spyOn(api, …)` 不变)。拆分 PR 只搬不改语义;语义变更(`throw new Error` → `ApiError`)在拆分后的独立 task,**逐域**进行并跑该域测试。4 个 `if (!res.ok) return null/默认值` 的函数(`api.ts:170,235,477,500`)**保持原语义**(调用方依赖降级)。
- **`lib/useLatestRequest.ts`**:`{ begin(): number; isCurrent(t: number): boolean; bump(): void }`(三点显式,不做 `run()` 包装,I-8)。
- **`lib/useAsyncResource.ts`**:`(key: string | null, fetcher: () => Promise<T>) → { data, loading, error, reload, setData }`;key 变化 → 同步清 data + loading(render-phase reset,同 B4 修法);`reload()` **不清 data**;`setData` 供乐观写(内部先 bump)。key 为 `null` 时不请求。
- **`lib/usePolling.ts`**:`usePolling(fn, intervalMs, { enabled })`;`visibilityState==='hidden'` 暂停,恢复可见立即跑一次。
- **迁移范围(R11)**,按顺序,每处:**先注释守卫 → 跑对应测试确认变红 → 迁移 → 变绿**;无测试者先补 stale 测试:
  1. `lib/usePromptPresets.ts:30`(`usePromptPresets.test.ts`)
  2. `QuickTargets.tsx:39`(`QuickTargets.test.tsx`)
  3. `MemoryPanel.tsx:23`(补 `MemoryPanel.stale.test.tsx`)
  4. `RunMetricsPanel.tsx:64`(`RunMetricsPanel.stale.test.tsx`)
  5. `AgentDashboard.tsx:46`(`AgentDashboard.stale.test.tsx`)
  6. `DirectoryPicker.tsx:29` + `Sidebar.tsx` 目录浏览 → `useDirBrowser`(`DirectoryPicker.stale.test.tsx` + `Sidebar.newflow.test.tsx`;**保持 P0 的 `creatingRef`/`runCreate` 守卫原样**)
  7. `Sidebar.tsx` 搜索 + `VaultReader.tsx:34` → `usePathSearch`(`Sidebar.search.test.tsx` + `VaultReader.test.tsx`;S2 ⌘K 复用)
  8. 无守卫站点:`AdminPanel.load`、`ScheduledTasksPanel.load`、`ConfirmationQueue.reload`(随 §3.5 改 Sheet 一并迁)
  9. push:`lib/push.ts` 改用 `request`(修 `enablePush` 在 subscribe 失败时仍写本地已启用,R10);`PushSettings.toggle` 补 catch + toast
- **不迁(留 S2/S3)**:`AcpChatView.tsx` memReqRef、`GitViewer.tsx` selectedHashRef/wtReqRef/loadLog、`FileBrowser.tsx` openReqRef、App.tsx 全部轮询与焦点逻辑、`TerminalView.tsx` status 轮询(S3+S4 spec §4.6 负责)。
- 轮询迁到 `usePolling`:`Sidebar` 调度器健康 60s、`AgentDashboard` 10s、`WaitingPage` 5s(并改用 `request`,B12)。

### 3.5 S1 负责的界面迁移

只迁**不会被 S2/S3 重写**的组件,每个文件一次提交 + 前后截图:

| 文件 | 迁移内容 |
|---|---|
| `AdminPanel`、`ScheduledTasksPanel`、`PushSettings` | 改为 `<Sheet side="full">`,挂载点从 Sidebar 上移到 App;字号/颜色 token 化;原生 confirm → `confirm()`;修 B2(编辑时调度类型/时分回填) |
| `PromptManager` | 在 `<Sheet>` 内;token 化 |
| `DirectoryPicker`、`QuickTargets`、`SearchResults` | token 化;行内操作 → `<Menu>`;hover-only 清零 |
| `HistoryView` | token 化;原生 confirm → `confirm()`;📜 等 emoji → lucide |
| `MobileKeyBar` | 📜 → lucide `History`;token 化 |
| `LoginPage`、`WaitingPage` | token 化(GitHub 按钮色走 token);`text-ui-xl` 标题 |
| `VaultReader` | 原生 alert → toast;列表 loading/error 用 Skeleton/简单错误行 |
| `Toast`(旧) | 被 `toast` 队列取代;App 的 `undoToast`/`failToast` 改用 `toast.push`(I-18 公式与测试不变) |
| `Sidebar` | **仅**:三处手写遮罩 → `<Popover>`/`<Sheet>`;主题三态;面板挂载上移;token 化。新建状态机**不重构**(S2 删除) |

### 3.6 S1 验收

- `npm run build` 内的体积门禁通过(入口 JS + CSS br ≤ 330KB);线上 `curl -H 'Accept-Encoding: br'` 取到的是预压版本(体积 ≈ q11)。
- 棘轮:五类计数**全部低于**起始 baseline;§3.5 列出的文件中五类计数为 0。
- 对比度:`scripts/contrast.mjs` 自动校验 token 表 —— 暗/亮两主题下 `--fg`/`--fg-muted`/`--fg-subtle` 在 `--surface-0..3` 上均 ≥ 4.5:1;`--danger`/`--stuck`/`--attention`/`--accent`/`--success` 在 `--surface-1` 上 ≥ 4.5:1(文字用)。
- 主题:system/dark/light 三态切换无首帧闪烁(截图:冷启动亮色系统 → 首帧即亮);xterm 与 mermaid 跟随。
- 截图回归:390×844 与 1440×900 × 暗/亮 × {登录、侧栏、定时任务 Sheet、推送 Sheet、Admin Sheet、tmux 终端、Claude 会话} 前后对比,存 `docs/superpowers/screens/s1/`。
- 既有测试全绿;新增 primitives / hooks / 脚本测试全绿;`npm run lint` 含棘轮通过。

## 4. S2 分诊与导航(本期核心)

### 4.1 信息架构

**桌面(≥ lg)三栏**:

```
┌─ Triage 队列 (272px) ─┬─ Focus 主区 ──────────────────────────┬─ Context (S3) ─┐
│ ⌘K 搜索或命令…         │ 顶栏:← 会话名 · ●状态 · 耗时 · $  ⋯   │ (S2 仍用现有    │
│ ── 需要你 (3) ──       │───────────────────────────────────────│  overlay 图标,  │
│ ● api-refactor  出错   │  TerminalView / AcpChatView           │  S3 收编)       │
│   "cargo test 失败…"   │  (常驻挂载,hidden 切换,I-1)          │                │
│ ◉ docs-sync  完成·未读 │                                       │                │
│ ⚑ crew-a  待审批 1     │                                       │                │
│ ── 运行中 (2) ──       │                                       │                │
│ ◌ zeromux-fe  Edit…3m │                                       │                │
│ ── 空闲 ──             │                                       │                │
│ ○ shell-main           │                                       │                │
│ ── 文档 ──             │                                       │                │
│ ＋ 新建  ⌘N    J 下一个 │                                       │                │
└────────────────────────┴───────────────────────────────────────┴────────────────┘
```

- `md ≤ 宽 < lg`:队列可折叠为 56px 图标栏(沿用现 CollapsedRail 语义)。

**手机(< md)**:

```
┌────────────────────────────────┐
│ ‹  api-refactor  ● 出错 · 4m  ⋯ │  顶栏(横滑:切到上/下一个会话)
├────────────────────────────────┤
│                                │
│   主区(聊天 / 终端)             │
│                                │
├────────────────────────────────┤
│ [Composer / 终端输入行]          │
├────────────────────────────────┤
│ 分诊(3) │ 当前 │ ＋新建 │ 搜索   │  底部 Tab(56px + safe-area)
└────────────────────────────────┘
               (⏭ FAB:下一个需要你的,仅在「需要你」>0 时出现,位于 Tab 上方右侧)
```

- 「分诊」Tab = 全屏队列(同桌面左栏内容);「当前」= 最近活动会话;「＋新建」= 打开 ⌘K 并预置「新建」模式;「搜索」= ⌘K 默认模式。
- 软键盘弹出时底部 Tab 隐藏(沿用 VisualViewport 补偿),Composer 贴键盘。
- 横滑只在**顶栏**识别(不在 xterm 区域,I-15 `touch-action:none`)。

### 4.2 后端:会话态势字段

在 `SessionInfo`(`session_manager.rs:386`)新增,均为 `Session` 上**预计算**字段,`session_info_of` 只拷贝,**锁内零 I/O、零扫描**:

| 字段 | 类型 | 维护点 | 语义 |
|---|---|---|---|
| `last_outcome` | `Option<"completed"\|"errored"\|"cancelled"\|"timeout">` | 与 `record_run_metric` 同处(turn settle 时已知 `RunOutcome`) | 最近一个**已结束** turn 的结果;新 turn 开始时不清(用于「上一轮出错」显示),由 `turn_state` 表达正在跑 |
| `last_outcome_ms` | `Option<i64>` | 同上 | 结束时间 |
| `last_snippet` | `Option<String>` | `emit` → `record_and_broadcast` 锁内 | 最近一个 `ContentBlock{text}`(非 streaming 或合并后)或 `Result.text` 的**末行**,去 markdown 标记后截 **120 字符**(按 `chars()`,防多字节切片 panic,见历史 review);tmux 会话为 None |
| `current_step` | `Option<String>` | 同上 | 最近一个 `tool_use` 的 `name · summary`(截 80 字符);turn 结束(boundary)时清为 None |
| `pending_approvals` | `u32` | 同上 | Crew 专属:收到 `AcpEvent::Approval` +1;该 approval 被处理(plan 阶段定位 `POST /api/approvals/{id}/{action}` 的回执路径或 Gateway 后续事件)−1;turn boundary 与进程退出时归零。其余 backend 恒 0 |
| `lifetime_cost_usd` | `f64` | 已有(`:331`) | 仅导出 |

- **三 backend parity**:`last_snippet`/`current_step` 依赖统一 `AcpEvent`,在 `emit` 咽喉处维护 → Claude/Kiro/Codex/Crew 自动一致。Codex 非流式正文经 `Result.text` 覆盖;Crew `System{status}` 心跳不更新片段。Rust 单测对四种 backend 各喂一段代表事件序列断言字段。
- **不新开全局事件 WS**。沿用 3s `/api/sessions` 轮询(态势感知 3s 足够;全局 WS 需新鉴权/owner 过滤/重连语义,列为非目标)。
- `pending_approvals` 若 plan 阶段发现回执路径无法在后端可靠观测,**降级**为:前端对**已挂载**的 Crew 会话从 transcript 派生(`AcpChatView` 已有 `resolvedApprovals`),经 `sessionControls` 上报 App;spec 接受任一实现,验收只看行为。

### 4.3 分诊模型(`lib/triage.ts`,纯函数,全覆盖单测)

```ts
type Attention = 'error' | 'stuck' | 'approval' | 'confirm' | 'done_unread' | 'running' | 'idle' | 'ended'
triage(s: SessionInfo, ctx: { now: number; readCount: number; confirmsBySession: Record<string, number> }): Attention
```

判定顺序(先中先得):

1. `error`:`turn_state !== 'running'` 且 `last_outcome ∈ {errored, timeout}` 且 `last_outcome_ms` 晚于用户最后一次查看该会话(见下「已读」)
2. `stuck`:`turn_state === 'running'` 且 `now - last_activity_ms > STUCK_SILENCE_MS`(**复用** `lib/stuck.ts:3` 的 180s,与 Rust 同名常量镜像,不另立阈值)
3. `approval`:`pending_approvals > 0`
4. `confirm`:该会话 `source_task_id` 对应定时确认队列有待确认项(复用现有 30s 确认轮询,改为按 session 分组)
5. `done_unread`:`turn_state !== 'running'` 且 `turns_completed > readCount`
6. `running`:`turn_state === 'running'`
7. `idle`:其余运行中的进程
8. `ended`:`running === false`

- 分组:**需要你** = {error, stuck, approval, confirm, done_unread};**运行中** = {running};**空闲** = {idle, ended};**文档** = docTabs。
- 组内排序:需要你按 (Attention 优先级, 事件时间降序);运行中按 `turn_started_ms` 升序(跑得最久在上);空闲按 `last_activity_ms` 降序。用户可**置顶**(localStorage `zmx_pins`,置顶项在各组内最前)。
- **已读**:沿用 `readCounts`(`App.tsx:216-234`);另记 `lastViewedMs[sid]`(切入会话时写),用于 error 的「已看过」判定。
  - 现状(已核对):`readCounts` **不持久化**,每次加载由 `baselineInit`(`:218-222`)把全部既有完成视为已读 → 刷新页面会丢掉「离开期间完成」的未读。
  - 改为:二者持久化到 localStorage(`zmx_read`,按 sid);加载时**只对 localStorage 中不存在的 sid** 做 baseline;列表中已消失的 sid 在写回时 GC。这样「推送 → 打开页面」后离开期间完成的会话仍在「需要你」组。
- **identity 稳定(I-9)**:队列项由 `useMemo` 按 `(id, attention, name, last_snippet, current_step, cost 四舍五入到分)` 生成签名,签名不变复用对象;行组件 `memo`。3s 整表替换不导致全部行重渲染(组件测断言 render 次数)。
- **I-2**:分诊只派生视图,**绝不写 `activeId`**;测试沿用 07-07 场景(轮询导致排序变化时焦点不动)。

### 4.4 队列行(`TriageRow`)

```
[StatusDot] [类型图标] 会话名                    右侧:耗时 / 相对时间
            last_snippet 或 current_step(1 行,fg-muted,12px+)      $0.42
            [行内动作:中断 | 批准 | 打开确认]  (仅在对应 attention 时出现)
```

- 行高 ≥ 56px(手机 ≥ 64px),整行可点;⋯ 菜单(`<Menu>`):重命名、置顶、复制 peer 名、关闭(沿用撤销 toast,I-18)。
- 行内动作:
  - **中断**(running/stuck):先 `setActiveId`?**否**——中断不切焦点;调用 `sessionControls[sid].cancel()`(新增,等价现「中断」按钮的 WS 消息)。返回 `false`(WS 未 OPEN)时 toast「未连接,稍后重试」。
  - **批准**(approval):展开行内审批摘要(tool + purpose),「批准 / 拒绝」经 `sessionControls[sid].resolveApproval(id, action)`(复用 ApprovalCard 同一路径)。
  - **打开确认**(confirm):打开定时任务确认 Sheet 并定位该项。
  - **不提供回复**(§0.2)。
- 所有动作走已挂载会话的 `sessionControls`,**禁止新开 WS**(每条 WS 连接触发全量 replay,`acp/ws_handler.rs:100-139`)。tmux 会话无行内动作。

### 4.5 「下一个」

- 定义:按分诊「需要你」组的当前排序,取**当前会话之后**的第一项(环绕);组为空时 no-op + toast「都处理完了 ✓」。
- 入口:桌面 `J`(下一个)/ `K`(上一个)——仅在焦点不在输入框/xterm 时生效;`⌘]` / `⌘[` 在任何焦点下生效。手机 FAB ⏭。
- 切入即视为已读(更新 readCount + lastViewedMs)。
- **推送闭环**:SW `open_session` 深链(I-17,`App.tsx:197-210`)保持;新增 `&turn=<turn_id>`,AcpChatView 收到后滚动定位到该 turn(复用 I-11 的程序滚动豁免)。无 turn 参数时行为不变。

### 4.6 命令面板 ⌘K

- 实现:Radix Dialog + 自写列表(不引 cmdk);模糊匹配:会话/动作在前端内存匹配(新 `lib/fuzzy.ts`,纯函数单测);目录/笔记复用后端模糊搜索接口 + `lib/searchOrder.ts` 排序。桌面 `⌘K` / `Ctrl+K`;手机「搜索」Tab、「＋新建」Tab。
- 输入框 16px(I-15);↑/↓ 选择,Enter 执行,Tab 补全,Esc 关闭;IME 组合中 Enter 不执行(同 B7 守卫)。
- **结果分区**(按输入动态):
  1. **会话**:按名称 / work_dir / peer 名模糊匹配,右侧显示 attention。Enter 切入。
  2. **动作**:新建会话、下一个、切换主题、打开定时任务/推送设置/管理、当前会话的 Git/文件/事件/记忆、切换当前会话队列模式(显示值取 `queueModes`,I-6)。
  3. **目录 / 笔记**:复用现有模糊搜索接口(`sections`),⚡ 问 agent 保留。
  4. **预设**(输入以 `/` 开头):选中后发往当前 agent 会话(走 `sessionControls.sendPrompt`,返回 false 则 toast)。
- **新建模式**(一步到位):
  - 语法:`<类型>? <目录片段> <prompt>?`,类型关键字 `claude|codex|kiro|crew|tmux|term`,缺省 = **上次使用的类型**(localStorage `zmx_last_type`)。
  - 面板底部**预览行**:`Claude · ~/s3-workspace/…/zeromux · "修复 xx"`,Enter 确认创建(有 prompt 则 Create & send)。目录片段解析为目录搜索首项,`Tab` 在候选间切换;输入以 `/` 或 `~` 开头时按**字面路径**补全(取代逐级点目录,审计 §3.1)。
  - 创建失败:面板不关,预览行变错误态(依赖 P0 B3)。
  - 无 LLM,纯规则解析;歧义时靠预览行让用户确认。
- 现 Sidebar 新建状态机(`Sidebar.tsx:74` 六步)在新壳下由 ⌘K 新建模式取代;旧壳保留原流程直至删除。

### 4.7 新壳 `AppShell` 与迁移(strangler)

1. **zustand store**(`lib/store.ts`):`sessions`、`hostTmux`、`queueModes`、`readCounts`、`lastViewedMs`、`activeId`、`overlay`、`pins`、`confirmsBySession`。App 的 3s 轮询写 store;组件用 selector 订阅。行为与现 App state 一一对应,**先做纯搬迁**(一个 PR,不改 UI),App 级 characterization 测试托底:
   - 轮询不改 activeId(I-2);401 登出、5xx 不登出(I-3);切换会话 xterm 实例不重建、WS 不重连(I-1);撤销关闭 toast 时长(I-18);`?session=` 深链(I-17)。
2. **`AppShell`**:桌面三栏 / 手机单栏 + 底部 Tab;**会话层 DOM 原样搬入**(`App.tsx:446-474` 的 sessions.map + docTabs.map,常驻 + hidden)。分诊队列、⌘K、下一个、FAB 挂在壳上。
3. **开关**:`localStorage.zmx_shell = 'v2' | 'v1'`;设置里可切换;S2 上线默认 `v2`,v1 保留至 v2 稳定两周后删除(另起清理 PR)。
4. S2 期间 overlay(files/git/events/memory)**保持现状**:仍由顶栏图标打开、条件挂载;S3 收编进 Context 面板。

### 4.8 S2 非目标

看板视图;卡片内回复;全局事件 WS;自然语言(LLM)命令;批量操作;多会话分屏;Context 面板(S3);时间线重做(S3);手机终端键栏重做(P0 做最小修复,完整在 S4)。

---

## 5. S3 对话体验(纲要,另起 spec)

- **前置**:AcpChatView WS 流程 characterization 测试(replay 清空、`replay_done` 定 busy/queue_mode/时钟、client_id 对账、退避计时、B14 验证),然后整体搬迁出 `useAcpSocket`,不改逻辑。1s 时钟下沉到 `TurnStatusBar`。
- **Turn 摘要卡**:默认显示结论首段 + 「改 N 个文件 · M 次工具 · 耗时 · $」;tool_use/result 配对为一张卡(状态、时长、截断后「看全文」);**单块展开**取代整会话切 full;`TurnGroupView` memo 比较器与 `stabilizeGroups` 原样保留(I-9);折叠/展开高度变化不计为用户上滚(I-11)。
- **Composer**:队列模式常驻 chip(受控于 `queueModes`,I-6),Interrupt 下发送按钮变色 + 提示;`/` 预设补全;preset 无 `{{input}}` 时覆盖前确认。
- **Context 面板**:Diff/文件/事件/记忆/度量,桌面右栏常驻、手机底部 Sheet;**按会话常驻挂载 + hidden**(修复 overlay 条件挂载丢状态);GitViewer 选文件过滤 diff(B6)、tab stale(B5)。
- notices 按时间穿插;成本精度统一。

## 6. S4 移动终端(纲要,另起 spec)

- 键栏可收起(记忆状态)、自定义键;选中文本「发给…」任意会话(取代固定 claude,`App.tsx:454`);GitViewer 手机布局。
- WebGL:仅 active + 最近 N(暂定 4)个终端加载 WebglAddon,其余 DOM 渲染;切换闪烁需实测(未验证)。
- 软键盘下状态信息收进顶栏。

---

## 7. 测试与验收

### 7.1 贯穿全部阶段的硬约束

1. 审计 §7 不变量 **I-1 ~ I-19 全部保持**;任一改动触及须在 plan 中写明如何保持并附测试。
2. 新 UI **不新开 WS、不在前端猜测后端状态**(queue_mode/busy/running 均取后端权威)。
3. 每处 stale/WS 相关迁移:**先注释守卫验红,再迁移**。
4. 首屏传输 gzip/br 后 ≤ 400KB(主包 + CSS,不含懒载 mermaid/katex)。
5. 后端新字段只做预计算;`list_sessions` 锁内零 I/O。
6. 每次上线 `./deploy.sh --build`;commit + push 先于 deploy。

### 7.2 成功指标

| 指标 | 目标 | 验证方式 |
|---|---|---|
| 到达下一个需要我的会话 | 手机 ≤ 1 击,桌面 1 键 | 手测 + 组件测(J/FAB) |
| 常用目录新建 agent 并发 prompt | ≤ 1 击 + 打字(⌘K) | 手测 |
| 非常用目录新建 | ≤ 3 击(或字面路径输入) | 手测 |
| 首屏判断各会话状态 | 不进会话即可见 状态/类型/片段/耗时 | 截图 |
| 字号 | 正文 ≥ 14px(手机),辅助 ≥ 12px;`text-[8-11px]` = 0 | lint 门禁 |
| 触控目标 | ≥ 44×44px;hover-only = 0 | 审查 + 截图 |
| 原生弹窗 | `alert/confirm/prompt` = 0 | grep |
| 手机终端 | 390×844 键盘收起时可视高度 ≥ 75%;浮层遮挡交互控件 = 0 | 截图回归 |
| 断线发送 | WS 断开时发送不丢文本(保留在输入框)并提示 | 组件测 |
| 包体积 | 首屏传输 ≤ 400KB | curl 验证 |

### 7.3 截图回归

用 gstack browse(headless)在 390×844 与 1440×900 两视口、暗/亮两主题,对登录后首页、分诊 Tab、Claude 会话、tmux 会话、⌘K 新建模式截图,存 `docs/superpowers/screens/<阶段>/`,每阶段 plan 的收尾步骤对比。**冒烟必须用 `--data-dir` 隔离**,不得指向线上数据目录(历史教训)。

---

## 8. 风险

| 风险 | 缓解 |
|---|---|
| zustand 搬迁破坏 I-1/I-2/I-3 | 先补 App 级 characterization 测试;纯搬迁 PR 不改 UI |
| 态势字段三 backend 语义不一致 | 在 `emit` 咽喉统一维护;四 backend 各一组 Rust 测试 |
| `pending_approvals` 回执不可观测 | §4.2 降级方案(前端派生) |
| CompressionLayer 影响 WS 升级 / 流式 | P0 实测 `/ws/*` 101 与流式端点 |
| Radix + React 19 StrictMode 细节 | S1 首个 primitive 落地即跑 StrictMode 组件测(未验证项) |
| 新壳回归无法快速回退 | `zmx_shell` 开关一键回 v1 |
| 分诊「error」误报(上一轮出错但用户已处理) | `lastViewedMs` 判定;看过即降级为 idle |
