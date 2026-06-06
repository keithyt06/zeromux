# 终端移动端适配设计

日期：2026-06-06
状态：待实现

## 背景与问题

手机浏览器登录 ZeroMux 后，`TerminalView`（Tmux/PTY 的 xterm 终端）上有两个硬伤：

1. **划不动历史**：手指上下滑动看不到之前输出的内容。
2. **没法上下选菜单**：终端里运行 `claude` 时，权限确认菜单靠 `↑/↓ + 回车` 操作，手机软键盘没有方向键，只能确认或切换，无法在选项间移动。

两个问题同根：移动端软键盘缺方向键，且触摸手势没有映射到 xterm 的滚动缓冲。桌面端有物理键盘，无此问题。

> 经确认，问题出在终端（xterm）会话，不在 `AcpChatView` 聊天视图（该视图无上下选菜单）。

## 目标与验收标准

1. **手机能划看历史**：普通 shell/tmux 输出（非备用屏）下，手指上下滑 → 终端滚动缓冲跟随移动。
   - 验收：真机上向下滑能看到之前的输出，松手停在该位置不回弹。
2. **手机能上下选菜单**：claude 权限菜单出现时，点虚拟 `↑/↓/←/→` 移动高亮、`Enter` 确认。
   - 验收：真机上不调出软键盘即可完成一次权限选择。

## 关键技术事实（对齐过）

- claude 的权限菜单跑在终端**备用屏缓冲（alternate screen）**里，该模式**没有 scrollback**。因此「在菜单界面上下滑看历史」不存在。
- 两个能力作用在不同场景，互不重叠：
  - **触摸滚动** → 普通输出看历史。
  - **虚拟方向键** → 备用屏菜单里上下选。

## 范围

- **纯前端改动，后端零改动**。按键复用现有 `term.onData → WS {type:'input'}` 通道；滚动用 xterm 自带滚动缓冲。
- 改动文件：
  - `frontend/src/components/TerminalView.tsx`（接入触摸滚动 + 键条）
  - `frontend/src/components/MobileKeyBar.tsx`（新增）
  - `frontend/src/index.css`（少量 viewport 触摸样式）
  - `frontend/src/components/__tests__/MobileKeyBar.test.tsx`（新增，可选目录按现有约定）
- 只作用于 `TerminalView`。`AcpChatView` 不动。
- **最小集**：方向键 5 键（`↑ ↓ ← → Enter`），历史滚动靠手指触摸（不占键位）。

## 组件 1：触摸滚动

**根因**：xterm 的 `.xterm-viewport` 在移动端 WebGL 渲染下触摸默认不驱动滚动；隐藏 textarea 会抢焦点，纯 CSS 滚动真机不可靠。

**策略：完全接管手势**（JS 独占滚动，禁止浏览器原生滚动 / 橡皮筋）。这是 codex 评审后的决定——`touch-action: pan-y` 会让浏览器原生滚动与 `scrollLines()` 抢手势、双重滚动、iOS 上橡皮筋。

**做法**（在 `TerminalView` 的 init effect 内，`term.open()` 之后）：
- 监听挂在 `containerRef.current`（事件冒泡，覆盖内部 `.xterm-screen` 画布与 `.xterm-viewport`）：
  - `touchstart`：只在 `e.touches.length === 1` 时记录起点 `y` 与 `touch.identifier`；多指（pinch）不进入滚动逻辑。
  - `touchmove`（`{ passive: false }`）：跟踪同一 `identifier` 的触点；`dy = startY - currentY`，`lines = Math.round(dy / rowHeight)`；**全程 `preventDefault()`**（不等到 `lines !== 0`，避免起手就被浏览器抢去滚动），`lines !== 0` 时 `term.scrollLines(lines)` 并更新基准 `y`。
    - 方向：`dy` 为正（手指上移）= 向下滚（看更新内容）；手指下移 = 向上滚（看历史）。实现以真机方向为准，必要时取反。
  - 行高来源：用公开 API `term.element.clientHeight / term.rows`（`element`、`rows` 均为 xterm 6.x 公开类型）；`element` 未就绪或算出非正数时回落 `fontSize * 1.2`。不使用私有 `_core` 内部，避免小版本升级悄悄失效。
- 用稳定的 handler 引用，卸载时 `removeEventListener`（与现有 cleanup 一致）。
- CSS（作用于容器 + screen + viewport，统一禁止原生滚动）：
  ```css
  .xterm-container, .xterm-container .xterm-screen, .xterm-container .xterm-viewport {
    touch-action: none;
    overscroll-behavior: contain;
  }
  ```

## 组件 2：虚拟方向键条

**新文件 `MobileKeyBar.tsx`** —— 无状态展示组件：

```
Props: { onKey: (key: ArrowKey) => void }   // key 是逻辑键名，不是序列
渲染: 一排 5 个按钮 ←  ↑  ↓  →  Enter
```

- 组件只传**逻辑键名**（`'up'|'down'|'left'|'right'|'enter'`），转义序列由 `TerminalView` 按光标键模式生成（见下）。这样模式判断集中在一处。
- 每个按钮用 `onPointerDown` 触发并 `preventDefault()` 防止抢终端焦点（手机上 `onMouseDown` 不够）；按钮加 `touch-action: manipulation` 防双击缩放。

**接入 `TerminalView`**：
- 抽出 `sendInput(data: string)`：复用 `term.onData` 里那段
  `ws.send(JSON.stringify({ type: 'input', data: b64encode(new TextEncoder().encode(data)) }))`，
  并保留 `readyState === OPEN` 判断。`term.onData` 与 `MobileKeyBar` 都走这一条。
- **方向键序列按光标键模式（DECCKM）动态生成**（codex 评审核心修正）：读公开 API `term.modes.applicationCursorKeysMode`。
  - 为 `true`（应用光标键模式，claude TUI 菜单常用）→ `↑=\x1bOA ↓=\x1bOB →=\x1bOC ←=\x1bOD`
  - 为 `false`（普通模式）→ `↑=\x1b[A ↓=\x1b[B →=\x1b[C ←=\x1b[D`
  - `Enter` 恒为 `\r`，与模式无关。
- **点键前先 `term.scrollToBottom()`**：用户若滚到 scrollback 里，发键前先回到底部，否则输入发出去了但画面停在历史看不到反馈（codex #6）。
- **仅触摸设备渲染**：检测用 `matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0`，存入 state；比单用 `(pointer: coarse)` 少漏触屏笔记本 / iPad（codex #8）。
- **布局 + 重新 fit**：键条放在终端区与底部状态栏之间，`flex` 横向均分，始终可见，高度约 40px。键条渲染会改变终端可用高度 → 渲染后调用现有 `handleResize()`（`fit()` + 发 resize），否则底部行被遮、canvas 尺寸过期（codex #9）。

## 数据流

```
触摸滑动 → touchmove(preventDefault) → term.scrollLines()           [本地，不发网络]
点虚拟键 → onKey(逻辑键) → scrollToBottom → 按 DECCKM 生成序列
          → sendInput → WS input → PTY                              [复用现有通道]
```

## 错误处理 / 边界

- 拿不到行高 → 回落 `fontSize * 1.2`，不崩。
- WS 未连接 → `sendInput` 复用 `readyState === OPEN` 判断，静默丢弃（与 `term.onData` 现有行为一致）。
- 桌面端非触摸 → 键条不渲染、触摸监听不影响（鼠标不触发 touch 事件），零影响。
- 多指 / pinch → `touchstart` 只在单指时进入滚动逻辑，缩放手势不被误当滚动。
- 备用屏（claude 菜单）下 `scrollLines()` 是 no-op、触摸滑动无效果——这是预期：该场景靠方向键条操作，不靠滑动（两者作用域分离，见“关键技术事实”）。

## 测试

- vitest：
  - `MobileKeyBar`：点击各按钮触发 `onKey` 且传出正确逻辑键名。
  - 序列映射函数（DECCKM → 转义序列）抽成纯函数单测：两种模式 × 4 方向 + Enter，断言序列正确。这是 codex #1 修正的核心逻辑，必须覆盖。
- 触摸滚动手势（sign / preventDefault / listener cleanup / scrollLines 调用）可用 mock touch 事件 + mock terminal 做单测；真机（尤其 iOS Safari）仍需手测，按验收标准 1/2 验证。

## 不做（YAGNI）

- 不加 Esc/Tab/Ctrl/Fn/翻页等额外虚拟键（本次最小集）。
- 不接 tmux copy-mode 历史：`term.scrollLines()` 只滚 xterm 自身缓冲，够看屏幕外近期输出；翻 tmux 自己的 copy-mode 历史是独立特性，超出本次范围（codex #5）。
- 不引入第三方移动端终端库 / addon（新依赖 + 体积，与 size-optimized 单二进制目标冲突）。
- 不改后端、不改 `AcpChatView`。

## 评审记录

- 产品总监（/plan-ceo-review）：HOLD SCOPE，1 项可行性修正（行高改用公开 API）。
- 技术总监（codex 独立挑战，gpt-5.5 high）：11 项发现，采纳如下——
  - S0 方向键 DECCKM 动态序列（#1，威胁核心目标）✓
  - S1 完全接管触摸手势 + 正确 CSS 目标（#2/#3/#4）✓、点键前 scrollToBottom（#6）✓、键条后重新 fit（#9）✓
  - S2 检测改 any-pointer+maxTouchPoints（#8）✓、onPointerDown 防焦点 + 忽略多指（#7/#10）✓、序列映射纯函数单测（#11）✓
  - 范围外：tmux copy-mode 历史（#5）→ 列入“不做”。
