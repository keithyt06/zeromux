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

**做法**（在 `TerminalView` 的 init effect 内，`term.open()` 之后）：
- 在 `containerRef.current` 上加监听：
  - `touchstart`：记录起点 `y`。
  - `touchmove`（`{ passive: false }`）：计算 `dy = startY - currentY`，换算成行 `lines = Math.round(dy / rowHeight)`；若 `lines !== 0` 则 `term.scrollLines(lines)`、`preventDefault()`、更新基准 `y`。
    - `dy` 为正（手指上移）= 向下滚（看更新内容）；手指下移 = 向上滚（看历史）。实现以真机方向为准，必要时取反。
  - 行高来源：`term._core._renderService.dimensions.css.cell.height`，拿不到回落 `fontSize * 1.2`。
- 卸载时 `removeEventListener`（与现有 cleanup 一致）。
- CSS：`.xterm-container .xterm-viewport { touch-action: pan-y; -webkit-overflow-scrolling: touch; }`

## 组件 2：虚拟方向键条

**新文件 `MobileKeyBar.tsx`** —— 无状态展示组件：

```
Props: { onKey: (seq: string) => void }
渲染: 一排 5 个按钮 ←  ↑  ↓  →  Enter
```

- 按键 → 转义序列：
  - `↑ = \x1b[A`，`↓ = \x1b[B`，`→ = \x1b[C`，`← = \x1b[D`，`Enter = \r`
- 每个按钮 `onClick={() => onKey(seq)}`。
- 按钮加 `touch-action: manipulation` 防双击缩放；`onMouseDown` 内 `preventDefault()` 防止抢终端焦点。

**接入 `TerminalView`**：
- 抽出 `sendInput(data: string)`：复用 `term.onData` 里那段
  `ws.send(JSON.stringify({ type: 'input', data: b64encode(new TextEncoder().encode(data)) }))`，
  并保留 `readyState === OPEN` 判断。`term.onData` 与 `MobileKeyBar` 都走这一条。
- **仅手机渲染**：`matchMedia('(pointer: coarse)')` 判断粗指针（触摸设备），存入 state；非触摸不渲染键条。比 `max-width` 更准。
- **布局**：键条放在终端区与底部状态栏之间，`flex` 横向均分，始终可见。高度约 40px。

## 数据流

```
触摸滑动 → touchmove → term.scrollLines()              [本地，不发网络]
点虚拟键 → onKey(seq) → sendInput → WS input → PTY     [复用现有通道]
```

## 错误处理 / 边界

- 拿不到行高 → 回落常量，不崩。
- WS 未连接 → `sendInput` 复用 `readyState === OPEN` 判断，静默丢弃（与 `term.onData` 现有行为一致）。
- 桌面端 `pointer: fine` → 键条不渲染、触摸监听不影响（鼠标不触发 touch 事件），零影响。

## 测试

- vitest：给 `MobileKeyBar` 加测试，断言点击各按钮触发 `onKey` 且转义序列正确（纯函数易测）。
- 触摸滚动依赖真实手势，单测价值低 → 真机手测按验收标准 1 验证。

## 不做（YAGNI）

- 不加 Esc/Tab/Ctrl/Fn/翻页等额外虚拟键（本次最小集）。
- 不引入第三方移动端终端库 / addon（新依赖 + 体积，与 size-optimized 单二进制目标冲突）。
- 不改后端、不改 `AcpChatView`。
