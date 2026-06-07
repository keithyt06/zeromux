# 移动端连接终端 Composer 设计

日期：2026-06-07
状态：设计已确认，待写实现计划
评审：CTO（工程）+ PM（产品）双层 review 已完成，结论已并入本文

## 背景与问题

zeromux 的「连接终端」（`/ws/term`，xterm.js 桥接服务器 PTY）在手机浏览器上有两个真实痛点，用户（Keith，重度单用户，手机远程操作 Claude Code / Codex / kiro）反复遇到：

1. **软键盘遮挡终端输出**：终端是全屏绝对定位布局，软键盘弹出后可视区被腰斩，xterm 内容区不跟随收缩，agent 输出被键盘盖住，要反复收起/弹出键盘。
2. **输入延迟、字母数字标点丢字**：根因是 xterm 的隐藏 textarea 逐字符喂 PTY，对手机 IME（中文/拼音/九宫格/滑行输入）的 composition 合成事件支持差；且每字符一个 WebSocket round-trip，网络抖动直接体现为回显卡顿。

用户在终端里**主要是打整段 prompt 文字**给 agent（场景 A 为主），但**两种模式都会用**——既会让 Claude Code/Codex 在终端里跑对话，也会真的操作 shell / tmux / 其他 TUI。因此终端通道不可被聊天视图（`/ws/acp`）替代，这个优化有不可替代的价值。

## 不做什么（范围边界）

- 不治理「小屏 TUI 输出看不清」——这是输出端的痛，本方案只解决输入端。诚实记录：输入修好后，窄屏 TUI 阅读体验依旧。
- 不改 xterm 的 IME / composition 内部逻辑（上游老问题，应用层改不动，fork 维护无底洞）。
- 不用 `term.onKey` 替代 textarea（keydown 级事件对中文 IME 合成拿不到正确字符）。
- 不做提交键可配置矩阵、不做多 TUI 适配矩阵。MVP 锁定 bracketed paste + 探测式回车，覆盖 Claude Code / Codex / bash 主路径。

## 核心方案

在触摸设备的 `TerminalView` 底部，MobileKeyBar 上方，加一个**默认收起**的 composer 输入框。用浏览器原生 textarea 打字（IME 完善、不丢字），按发送时**整段一次性**写进 PTY，绕开 xterm textarea 的所有毛病。

### 职责切分（降低心智困惑——PM 标记的最大产品风险）

终端里跑的是**有状态全屏 TUI**。当 Claude Code 弹 y/n 确认、箭头选菜单（选 model/permission）时，往 composer 打整段字会破坏 TUI 状态。因此明确切分，并通过「默认收起」让 composer 不在视野里暗示「该往这打字」：

- **单键 / 控制键**（Esc / Ctrl-C / y / n / 方向键 / Enter）→ 走 **MobileKeyBar**，直发字节，不抢焦点。
- **整段文字 / prompt / 粘贴代码** → 主动召唤 **composer**。

### 收起 / 展开

- 默认收起。底部一个键盘图标按钮。点击升起 composer（聚焦 textarea，软键盘弹出，VisualViewport 顶起）。
- 发送后保持展开（连续对话），用户点收起按钮或下滑收起则落下，把高度还给输出区。
- 收起态只占一个按钮条的高度，确保「只读浏览 agent 输出」时输出区最大化（PM：常驻会吃掉 140px+，加剧阅读痛点）。
- 触摸设备进入会话**不自动聚焦任何输入**（不自动弹键盘）；桌面端保持现有 `term.focus()`。

## 输入正确性（CTO 工程红线 — 方案成立的关键）

**绝不裸 `sendInput(text)`。** 多行文本里的 `\n` 会被 Claude Code/Codex 的 TUI 逐行解释，第一个 `\n` 即提交，多行 prompt 必碎。

### Bracketed paste

发送时用 bracketed paste 包整段：

```
\x1b[200~  +  文本（内部 \n 原样保留）  +  \x1b[201~
```

支持 bracketed paste 的 TUI（Claude Code / Codex / bash readline 都认 DECSET 2004）收到后把整段当「粘贴内容」塞进自己的多行输入区，不会逐行提交。

### 提交键探测

paste 之后是否自动发回车，取决于对端是否开启 bracketed paste 模式，用 xterm 公开 API `term.modes.bracketedPasteMode` 探测（与现有 `applicationCursorKeysMode` 同源）：

- **已开启**（TUI 输入框，如 Claude Code）→ paste 后发 `\r` 提交。
- **未开启**（裸 shell 等命令）→ 只 paste 不自动回车，避免多行命令被误执行。

### 两个发送动作

- **「发送」**：bracketed paste + 按探测结果决定回车。主路径。
- **「仅插入」**：bracketed paste，不发回车。给「填了再上下检查 / 填 commit message」场景。

### 纯函数 + 单测

paste / 提交序列做成 `frontend/src/lib/terminalInput.ts` 的纯函数，与 `arrowSequence` 同源，锁进单测：

```ts
// 拟新增
export function bracketedPaste(text: string): string  // \x1b[200~ + text + \x1b[201~
export function submitSequence(bracketedPasteMode: boolean): string  // 开→'\r'，关→''
```

## 键盘遮挡处理

用 VisualViewport API，但**只改外层容器高度 / paddingBottom，不动 xterm 的 cols/rows**：

- 键盘补偿：`window.innerHeight - visualViewport.height - visualViewport.offsetTop` → 调容器高度，让 composer + 终端区往上顶。纯 CSS，零 WS 流量，无抖动。
- 真正的 fit（改 PTY 列宽）只在屏幕朝向变化等非键盘尺寸变化时做，且：
  - 对 VisualViewport resize 回调 debounce 150–200ms，末值生效；
  - dims 未变则跳过 WS resize send（现有 `handleResize` 无脑发，需加 `if (cols===prev && rows===prev) return`）。
- iOS Safari 软键盘不触发 `window.resize`（必须靠 VisualViewport）；Android Chrome 会触发 `window.resize`。两路最终汇流到同一个 debounced fit，靠「dims 没变不发」去重，不开两套各发各的。
- 所有 viewport / resize 副作用加 `if (!active) return` 守卫——App.tsx 里所有 session 常驻挂载（CSS 隐藏），否则 N 个隐藏终端会同时响应键盘事件。

## 组件复用：抽共享 `<Composer>`

AcpChatView（511 行）已有调好的 composer 块（330–382 行）：textarea autoResize、MicButton 接线、发送按钮、partial/error 提示。抽出共享壳，避免重写丢细节。

**共享边界 = UI 壳；差异 = 提交语义（props 注入）。**

```ts
// frontend/src/components/Composer.tsx（新）
interface ComposerProps {
  value: string
  onChange: (v: string) => void
  onSend: (text: string) => void
  submitOnEnter: boolean      // 聊天 true；终端 false
  placeholder?: string
  // 语音为 MVP 后预留：mic?: { ...transcribe 接线 }，MVP 不传
}
```

- **AcpChatView**：`submitOnEnter={true}`，`onSend={sendPrompt}`（走 ACP `{type:'prompt'}`），保留自己的 busy/elapsed/中断逻辑（不进共享组件）。
- **TerminalView**：`submitOnEnter={false}`（Enter=换行，按钮才提交），`onSend={text => sendInput(bracketedPaste(text) + submitSequence(...))}`。

注：MVP 不接语音，但 Composer 预留 mic 接口位，后续加成本极低。抽取后 AcpChatView 反而瘦身。

## MVP 必含的小改进（PM 高性价比项）

- **发送后 `term.scrollToBottom()`**：用户可能正在 scrollback 里翻，发完必须滚到底看 agent 反应（抄 MobileKeyBar `handleArrowKey` line 109 的做法）。
- **多行粘贴 → 一次性整段提交走通**：composer 的隐藏卖点。从别处复制代码/报错粘进 textarea，bracketed paste 一次性提交，比 xterm 原生粘贴（易触发多行错乱）可靠。设计时确认不被 `\n` 拆成多次 send。

## 明确推迟（非 MVP）

- **语音输入**：终端 TUI 场景语音转长中文塞进去易出 TUI 状态事故；用户痛点是丢字不是懒得打。Composer 预留接口，验证后再加。
- **历史命令 / 上滑调出上条 prompt**：终端自身（bash/TUI 上方向键）已有历史，叠一层会冲突且重复。
- **草稿保留**（按 sessionId 存 localStorage，切会话不丢）：高性价比，列为紧随 MVP 的补强，不进首版。
- **发送视觉反馈**（发出后短暂清空 + 占位，避免重复发）：可选补强。

## 受影响文件

| 文件 | 改动 |
|------|------|
| `frontend/src/lib/terminalInput.ts` | 新增 `bracketedPaste` / `submitSequence` 纯函数 + 单测 |
| `frontend/src/components/Composer.tsx` | 新建：从 AcpChatView 抽出的共享输入壳 |
| `frontend/src/components/AcpChatView.tsx` | 用 `<Composer submitOnEnter>` 替换内联 composer 块 |
| `frontend/src/components/TerminalView.tsx` | 触摸端加收起/展开 composer；VisualViewport 容器补偿；fit debounce + dims-skip；viewport 副作用 `if(!active)` 守卫；发送后 scrollToBottom |
| `frontend/src/components/MobileKeyBar.tsx` | 补 Esc / Ctrl-C / y / n 单键（直发字节） |

## 成功标准（可验证）

- 手机上多行 prompt（含 `\n`）发给 Claude Code，**整段进入其输入框、不被逐行提交**。
- 中文/拼音/标点输入**不丢字、不延迟**（走原生 textarea）。
- 软键盘弹出时，agent 输出区**完整可见、不被遮挡**，且键盘弹出过程**无明显抖动**。
- Claude Code 的 y/n 确认能通过 MobileKeyBar 单键回应，**不需要 composer**。
- 裸 shell 下「仅插入」多行文本**不会误执行**。
- `terminalInput.ts` 新纯函数单测通过；`cargo` / `vitest` / `tsc` 全绿。
- 桌面端行为不变（composer 不出现，`term.focus()` 保留）。

## 已知遗留 / 风险

- 输出端窄屏 TUI 阅读体验本方案不改善（范围外，已知）。
- 提交键只覆盖「Enter 提交」的 TUI（Claude Code/Codex）；用 Ctrl-J/Alt-Enter 提交的 TUI 需后续扩展。
