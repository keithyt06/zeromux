# Keith Haring 品牌焕新 + 工作区 UI/UX 优化设计

日期：2026-06-06
状态：待实现

## 背景与目标

ZeroMux 当前视觉有两处可提升：

1. **品牌不出彩**：现 logo 是紫色闪电「Z」（`frontend/public/favicon.svg`），且 `index.html` 根本没引用它 —— 浏览器标签页是空白图标。
2. **工作区长时间盯着累**：纯黑系 `#0d1117` 对比偏硬，界面普遍紧凑（大量 `text-xs` / `py-1.5`），缺呼吸感与层级。

用户偏好 **Keith Haring**（粗黑描边、扁平高饱和红黄蓝、动感）。经确认，方向定为 **B 类「logo 出彩 + 关键空白处点睛」**，而工作区**不做 Haring 涂鸦化**，改为人体工学优化（护眼配色 + 呼吸感 + 视觉层级），让长时间工作更舒适。

两块性质不同，分开处理。

## 范围

**纯前端改动，后端零改动。** 涉及文件：

- `frontend/public/favicon.svg`（替换为 Haring 风格闪电 Z）
- `frontend/index.html`（补 favicon 引用 + `theme-color`）
- `frontend/src/index.css`（暗色主题 token 调整 + 新增点睛色变量；light 模式同步微调）
- `frontend/src/components/LoginPage.tsx`（用新 logo 替换 `KeyRound` 占位图标）
- `frontend/src/components/Sidebar.tsx`（当前会话黄色左条标记；间距/字号微调）
- 聊天/空状态等"空白处"点睛（见下，最小集）

**不动的边界：**

- 终端 xterm 区域配色不碰（用户自己的 shell 主题说了算）。
- 不改布局结构、不动任何交互逻辑，只在样式 token / className 层调整。
- Haring 只体现在 logo + 一个黄色点睛强调色；工作区不涂鸦、不撞色。
- 不重构组件、不引入新依赖（logo 为内联 SVG，延续 `BrandIcons.tsx` 的既有做法）。

## 设计

### 一、Logo（方向 A1：黄底黑 Z）

Haring 语言重做现有「闪电 Z」骨架，**认知零成本**（升级而非换标）、小尺寸可辨（单一主体）。

- 圆角方块底 `#f7b500`（明黄），黑色描边 `stroke-width` 较粗。
- 黑色闪电「Z」`#111` 居中。
- 四角放射动感短线（Haring 标志性"发光/动感"线），small/16px 尺寸时省略放射线只留 Z（已在陪看 16px 预览验证清晰）。
- viewBox `0 0 120 120`，导出为 `favicon.svg`。
- 同一图形抽成内联 SVG 组件复用于：浏览器 favicon、登录页标题、（可选）侧栏底部品牌位。

定稿配色：底 `#f7b500` / 字 `#111` / 描边 `#111`。点睛黄统一为 `#f7b500`。

### 二、工作区主题 token（暗色）

在 `index.css` `:root` 调整（不新增组件、不改类名结构）：

| token | 现在 | 优化后 | 理由 |
|---|---|---|---|
| `--bg-primary` | `#0d1117` | `#11161d` | 柔黑，去纯黑刺眼 |
| `--bg-secondary` | `#161b22` | `#161c25` | 与 primary 拉开层次 |
| `--bg-tertiary` | `#1c2128` | `#1f2630` | 当前项/卡片更可见 |
| `--bg-hover` | `#263040` | `#243040` | — |
| `--border` | `#30363d` | `#2a323d` | 略柔 |
| `--text-primary` | `#c9d1d9` | `#cdd6e0` | 正文对比"恰好不费力" |
| `--text-secondary` | `#8b949e` | `#9aa5b1` | 次要信息可读但不抢 |
| `--accent-green-text` | `#3fb950` | `#56d364` | 运行态绿点更醒目 |
| **新增** `--accent-brand` | — | `#f7b500` | Haring 点睛黄，用于当前会话标记等 |

> 数值为陪看 mockup 已验证的近似值，实现时以"真机暗色下不刺眼、对比达 WCAG AA 正文"为准，可微调 ±数个色阶。

light 模式（`:root.light`）仅同步新增 `--accent-brand`（取稍深的 `#d39e00` 保证白底可读），其余保持，避免改动面扩大。

### 三、呼吸感与层级（b + c）

- **b 呼吸感**：聊天气泡 `padding` 与 `gap` 上调、行高 `leading` 提到约 1.6；sidebar 行 `py` 微增。仅调 Tailwind 间距类，不改结构。
- **c 视觉层级**：
  - 当前选中会话：更亮底 `--bg-tertiary` + **黄色左条**（`box-shadow: inset 2px 0 0 var(--accent-brand)` 或左 border），呼应新 logo。
  - 运行中绿点：用新 `--accent-green-text`，可加极淡 glow。
  - 工具调用块（`✎ edit · …`）：独立弱化色块，和正文气泡区分。

### 四、空白处点睛（最小集）

只在"空旷/欢迎"处加 Haring 元素，避免喧宾夺主：

- **登录页**：`KeyRound` 占位 → 新 Haring logo。
- **会话空状态**（"还没有会话"等）：放一个小号 Haring logo 或一个跳舞小人线描，配一句引导语。

> 加载动画等更多点睛点列为"可选增强"，本期不强制，避免范围蔓延。

## 验收标准

1. **favicon 生效**：浏览器标签页显示黄底黑 Z（现在是空白）。16px 下清晰可辨。
2. **登录页**：标题处是新 logo，不再是钥匙图标。
3. **暗色护眼**：主背景为柔黑（非纯黑），正文对比达 AA；主观上长时间看更舒适。
4. **层级**：当前会话有黄色左条且底色更亮，一眼可辨"我在看哪个"。
5. **呼吸感**：聊天/侧栏间距加大，不再拥挤。
6. **边界守住**：终端 xterm 配色未变；布局与交互逻辑未变；无新依赖。
7. **构建**：`tsc -b`、`vite build`、`cargo build --release` 均通过；`deploy.sh` 部署后线上 200。

## 不在本期范围

- 工作区 Haring 涂鸦化 / 全面撞色主题（明确否决：长时间工作不适）。
- 终端 xterm 配色主题。
- 字体替换（仅在 b 中按需微调字号/行高，不换字体家族）。
- 移动端专门的视觉适配（已有独立 mobile-terminal 工作）。
