# 移动端 KeyBar 精简 + 一键启动 CLI

日期:2026-06-09
状态:待评审

## 背景

2026-06-07 上线的移动端 composer 同时引入了 `MobileKeyBar`,当前渲染 9 个键:
`← ↑ ↓ → Enter` 五个方向/Enter 键 + `Esc ^C y n` 四个控制键。

实际使用反馈:终端里主要就是用 Claude Code / Codex / Kiro 三个 CLI。
- 上下方向键 + `^C`(中断)经常用 → 保留。
- `Esc`、左右方向键、`Enter`、`y`、`n` 几乎不用 → 删除。
- 缺一个高频动作:在当前 shell 直接启动这三个 CLI。手机上手打 `claude` 很烦。

## 目标

把 KeyBar 改成**单行 6 键**:

```
┌──────────────────────────────────────────────┐
│  ↑  │  ↓  │  ^C  │ claude │ codex │ kiro │
└──────────────────────────────────────────────┘
```

- `↑` `↓`:方向键,行为不变(按 DECCKM 模式发 CSI/SS3)。
- `^C`:发 `\x03`,行为不变。
- `claude` `codex` `kiro`:点一下向终端发 `<别名>\r`,在当前 shell 立即启动对应 CLI。

> 别名 `claude`/`codex`/`kiro` 已在用户 shell 里配置为最高权限模式(可读写任意路径、全部权限),
> 因此按钮只发命令名 + 回车,**不带任何参数**。

## 非目标(YAGNI)

- 不做按钮可配置 / 自定义命令(写死这三个别名)。
- 不动 Composer(打字区)、不动 toggle「打字/收起」按钮。
- 不改后端、不改 PTY 输入通道(全部复用现有 `sendInput`)。
- 删除的键不保留隐藏开关。

## 单行布局取舍

曾考虑双行(方向/控制一行、CLI 一行)以避免文字键过窄。用户明确选择**单行**:双行会把打字区往上挤,手机上打字更难。单行 6 键等宽,文字键(claude/codex/kiro)与图标键(↑/↓/^C)共用 `flex-1`,可接受。

## 改动清单

### 1. `frontend/src/lib/terminalInput.ts`(纯函数,先测)

- `ControlKey`:从 `'esc' | 'ctrl-c' | 'y' | 'n'` 收窄为 **`'ctrl-c'`**。`CONTROL` 表同步只留 `ctrl-c`。
- `ArrowKey` 类型不变(`up/down/left/right/enter`);`arrowSequence` 不动。MobileKeyBar 只渲染 `up`/`down`,但 `left/right/enter` 的序列函数保留(零成本,且 `enter='\r'` 被 launchSequence 间接复用的逻辑无关)。
- 新增:
  ```ts
  export type AgentKey = 'claude' | 'codex' | 'kiro'
  // 在当前 shell 启动 agent CLI:发别名 + 回车。别名已配置为最高权限,不带参数。
  export function launchSequence(agent: AgentKey): string {
    return `${agent}\r`
  }
  ```

### 2. `frontend/src/components/MobileKeyBar.tsx`

- `BarKey` = `'up' | 'down' | 'ctrl-c' | AgentKey`(从 `ArrowKey | ControlKey` 改为显式联合)。
- `ARROW_KEYS`:只留 `{up, ArrowUp}`、`{down, ArrowDown}`。
- `CONTROL_KEYS`:只留 `{ctrl-c, '^C'}`。
- 新增 `AGENT_KEYS: { key: AgentKey; label: string }[]` = claude/codex/kiro,文字标签。
- 渲染顺序:方向键 → ^C → agent 键,全部 `flex-1` 单行。agent 按钮复用 `^C` 的 `text-xs font-mono` 类(等宽小字,放得下 `claude`)。
- 交互保持:`onPointerDown` + `preventDefault`(避免抢终端焦点 / 弹软键盘),`touchAction: 'manipulation'`,`aria-label` 用逻辑键名。

### 3. `frontend/src/components/TerminalView.tsx`

`handleBarKey` 增加 agent 分支:

```ts
const handleBarKey = useCallback((key: BarKey) => {
  const term = termRef.current
  if (!term) return
  term.scrollToBottom()
  if (key === 'ctrl-c') {
    sendInput(controlSequence(key))
  } else if (key === 'claude' || key === 'codex' || key === 'kiro') {
    sendInput(launchSequence(key))
  } else {
    sendInput(arrowSequence(key as ArrowKey, term.modes.applicationCursorKeysMode))
  }
}, [sendInput])
```

(原先 `esc/y/n` 分支删除;import 同步去掉不再用的符号,加 `launchSequence`。)

## 测试

### `terminalInput.test.ts`
- `launchSequence('claude') === 'claude\r'`,codex/kiro 同理。
- (现有 `controlSequence` 测试若覆盖 esc/y/n 则一并删除对应断言。)

### `MobileKeyBar.test.tsx`
- 渲染断言改为:存在 `up` `down` `ctrl-c` `claude` `codex` `kiro` 六个 `aria-label`;且 `esc` `left` `right` `enter` `y` `n` **不**存在(`queryByLabelText(...)` 为 null)。
- pointerDown:`claude` → `onKey('claude')`;`ctrl-c` → `onKey('ctrl-c')`;`up` → `onKey('up')`。

## 验收标准

1. `npm test` 全绿(含新增/改写的两组测试)。
2. `npm run lint` 无新增告警(删干净不用的 import:ArrowLeft/ArrowRight/CornerDownLeft 等)。
3. `npm run build` + `cargo build` 通过(rust-embed 需要 dist)。
4. 手机端实测:KeyBar 单行 6 键;点 claude 终端出现 `claude` 并回车启动;↑↓ 可翻历史命令;^C 中断。

## 风险

- 文字键在窄屏(iPhone SE 375px)是否挤:6 等宽 ≈ 62px/键,`claude`(6 字符 `text-xs`)放得下,实测确认。若极端窄屏溢出,回退方案是 agent 标签缩写(cl/cx/ki)——但先按全名做,实测再说。
- `kiro` 别名是否存在于用户 shell:属用户环境配置,不在本次代码范围;按钮只负责发命令名。
