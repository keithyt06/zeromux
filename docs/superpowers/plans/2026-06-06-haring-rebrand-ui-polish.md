# Keith Haring 品牌焕新 + 工作区 UI/UX 优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ZeroMux 的 logo 换成 Keith Haring 风格的「黄底黑 Z」并接入 favicon/登录页，同时把暗色工作区调得更适合长时间使用（护眼配色 + 呼吸感 + 视觉层级）。

**Architecture:** 纯前端改动，后端零改动。视觉提升的主体是 `frontend/src/index.css` 的全局主题 token 调整（一处改、全局生效，最低风险）；logo 为内联 SVG，延续 `BrandIcons.tsx` 既有做法；少量组件做层级/间距微调。终端 xterm 配色、布局结构、交互逻辑一律不动。

**Tech Stack:** React 19 + Vite + Tailwind v4 + lucide-react；构建 `vite build`，后端 `cargo build --release`，部署 `./deploy.sh`。

**重要约定（来自仓库 CLAUDE.md）：** 外科手术式改动——每个改动行都能追溯到本计划；不顺手"改进"邻近代码；匹配现有风格。真实聊天界面**不是气泡卡片**结构（assistant/user 是带标签的文本流），**不要**新增气泡底色容器。

参考设计 spec：`docs/superpowers/specs/2026-06-06-haring-rebrand-ui-polish-design.md`

> **验证说明：** 本仓库前端无视觉回归测试框架，视觉改动以「`tsc -b` + `vite build` 通过」+「肉眼核对」为验收，不强行编造单测。仅在确有纯函数逻辑时才写单测（本计划无此类）。

---

## 文件清单

- 替换：`frontend/public/favicon.svg`（Haring 黄底黑 Z）
- 修改：`frontend/index.html`（补 favicon 引用 + theme-color）
- 新增：`frontend/src/components/HaringLogo.tsx`（内联 SVG logo 组件，供登录页/空状态复用）
- 修改：`frontend/src/index.css`（暗色 token 调整 + 新增 `--accent-brand`；light 模式同步新增该变量）
- 修改：`frontend/src/components/LoginPage.tsx`（`KeyRound` → `HaringLogo`）
- 修改：`frontend/src/components/Sidebar.tsx`（当前会话黄色左条；两处 active row）
- 修改：`frontend/src/components/AcpChatView.tsx`（消息列表间距微调）

---

## Task 1: Haring 黄底黑 Z 的 favicon

**Files:**
- Replace: `frontend/public/favicon.svg`

- [ ] **Step 1: 用新 SVG 覆盖 favicon.svg**

把 `frontend/public/favicon.svg` 整个文件内容替换为（黄底 `#f7b500`、黑 Z `#111`、粗描边、四角放射线）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
  <rect x="7" y="7" width="106" height="106" rx="22" fill="#f7b500" stroke="#111" stroke-width="8"/>
  <path d="M76 30 H46 L42 47 H62 L40 90 H72 L76 73 H58 L80 30 Z" fill="#111" stroke="#111" stroke-width="4" stroke-linejoin="round"/>
  <g stroke="#111" stroke-width="5" stroke-linecap="round">
    <line x1="26" y1="24" x2="17" y2="14"/>
    <line x1="94" y1="24" x2="103" y2="14"/>
    <line x1="26" y1="96" x2="17" y2="106"/>
    <line x1="94" y1="96" x2="103" y2="106"/>
  </g>
</svg>
```

- [ ] **Step 2: 浏览器中肉眼核对**

Run: 在浏览器直接打开 `frontend/public/favicon.svg`（或构建后看标签页）。
Expected: 黄底黑 Z 圆角方块，四角有短斜线，清晰无糊。

- [ ] **Step 3: Commit**

```bash
git add frontend/public/favicon.svg
git commit -m "feat(brand): Haring-style yellow/black Z favicon"
```

---

## Task 2: index.html 引用 favicon + theme-color

**Files:**
- Modify: `frontend/index.html`

- [ ] **Step 1: 在 `<head>` 内补两行**

把 `frontend/index.html` 的 `<head>` 段从：

```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ZeroMux</title>
```

改为：

```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="theme-color" content="#f7b500" />
    <title>ZeroMux</title>
```

- [ ] **Step 2: 构建并核对**

Run: `cd frontend && npm run build`
Expected: 构建成功；`dist/index.html` 含 `favicon.svg` 引用。

- [ ] **Step 3: Commit**

```bash
git add frontend/index.html
git commit -m "feat(brand): wire favicon + theme-color into index.html"
```

---

## Task 3: HaringLogo 内联 SVG 组件

**Files:**
- Create: `frontend/src/components/HaringLogo.tsx`

- [ ] **Step 1: 新建组件文件**

创建 `frontend/src/components/HaringLogo.tsx`，内容：

```tsx
/** ZeroMux 品牌 logo —— Keith Haring 风格「黄底黑 Z」。内联 SVG，延续
 *  BrandIcons.tsx 的做法（不引外部依赖）。size 控制边长（px）。 */
interface HaringLogoProps {
  size?: number
  className?: string
}

export default function HaringLogo({ size = 24, className }: HaringLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" className={className} xmlns="http://www.w3.org/2000/svg">
      <title>ZeroMux</title>
      <rect x="7" y="7" width="106" height="106" rx="22" fill="#f7b500" stroke="#111" strokeWidth="8" />
      <path d="M76 30 H46 L42 47 H62 L40 90 H72 L76 73 H58 L80 30 Z" fill="#111" stroke="#111" strokeWidth="4" strokeLinejoin="round" />
      <g stroke="#111" strokeWidth="5" strokeLinecap="round">
        <line x1="26" y1="24" x2="17" y2="14" />
        <line x1="94" y1="24" x2="103" y2="14" />
        <line x1="26" y1="96" x2="17" y2="106" />
        <line x1="94" y1="96" x2="103" y2="106" />
      </g>
    </svg>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend && npx tsc -b`
Expected: exit 0（无类型错误）。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/HaringLogo.tsx
git commit -m "feat(brand): add HaringLogo inline SVG component"
```

---

## Task 4: 登录页用新 logo 替换钥匙图标

**Files:**
- Modify: `frontend/src/components/LoginPage.tsx`

- [ ] **Step 1: 改 import**

把 `frontend/src/components/LoginPage.tsx` 顶部：

```tsx
import { KeyRound } from 'lucide-react'
import type { AuthMode } from '../lib/api'
import { getAuthMode } from '../lib/api'
```

改为：

```tsx
import type { AuthMode } from '../lib/api'
import { getAuthMode } from '../lib/api'
import HaringLogo from './HaringLogo'
```

- [ ] **Step 2: 替换标题处图标**

把：

```tsx
        <div className="flex items-center gap-2 text-[var(--accent-blue)]">
          <KeyRound size={20} />
          <h1 className="text-lg font-bold">ZeroMux</h1>
        </div>
```

改为：

```tsx
        <div className="flex items-center gap-2.5">
          <HaringLogo size={28} />
          <h1 className="text-lg font-bold text-[var(--text-primary)]">ZeroMux</h1>
        </div>
```

- [ ] **Step 3: 构建 + lint 核对**

Run: `cd frontend && npx tsc -b && npx eslint src/components/LoginPage.tsx`
Expected: tsc exit 0；eslint 对该文件无 **新增** error（`KeyRound` 已移除，不应有未用 import 报错）。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/LoginPage.tsx
git commit -m "feat(brand): use HaringLogo on login page"
```

---

## Task 5: 暗色主题 token 调整 + 点睛黄变量

**Files:**
- Modify: `frontend/src/index.css:6-31`（`:root` 暗色块）
- Modify: `frontend/src/index.css:33-58`（`:root.light` 块，仅新增一个变量）

- [ ] **Step 1: 调整 `:root`（暗色）token**

把 `frontend/src/index.css` 的 `:root { ... }` 块中以下行逐一替换为新值（其余行保持不变）：

```css
  --bg-primary:   #11161d;
  --bg-secondary: #161c25;
  --bg-tertiary:  #1f2630;
  --bg-hover:     #243040;
  --border:       #2a323d;
  --text-primary: #cdd6e0;
  --text-secondary: #9aa5b1;
  --accent-green-text: #56d364;
```

并在该 `:root` 块**末尾**（`--code-bg:` 行之后、`}` 之前）新增一行：

```css
  --accent-brand: #f7b500;
```

- [ ] **Step 2: 在 `:root.light` 块新增同名变量**

在 `:root.light { ... }` 块末尾（`--code-bg:` 行之后、`}` 之前）新增（白底用稍深的黄保证可读）：

```css
  --accent-brand: #d39e00;
```

- [ ] **Step 3: 构建 + 肉眼核对暗色**

Run: `cd frontend && npm run build`
Expected: 构建成功。本地预览暗色：主背景为柔黑（非纯黑），正文清晰不刺眼，整体协调无突兀色块。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css
git commit -m "feat(ui): softer dark palette + --accent-brand token for eye comfort"
```

---

## Task 6: 当前会话黄色左条（视觉层级）

**Files:**
- Modify: `frontend/src/components/Sidebar.tsx:304-307`（展开态 active row）
- Modify: `frontend/src/components/Sidebar.tsx:187-190`（折叠态 active row）

> 两处都是「当前选中会话」的高亮样式。用黄色左条（`--accent-brand`）呼应新 logo，让"我在看哪个会话"一眼可辨。两处独立、需分别改（不要只改一处）。

- [ ] **Step 1: 改展开态 active row**

`frontend/src/components/Sidebar.tsx` 中展开态行（约 304 行）的三元：

```tsx
              s.id === activeId
                ? 'bg-[var(--bg-primary)] text-[var(--accent-blue)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
```

改为（更亮底 + 黄色左内阴影条）：

```tsx
              s.id === activeId
                ? 'bg-[var(--bg-tertiary)] text-[var(--text-bright)] shadow-[inset_2px_0_0_var(--accent-brand)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
```

- [ ] **Step 2: 改折叠态 active row**

折叠态图标按钮（约 187 行）的三元：

```tsx
              s.id === activeId
                ? 'bg-[var(--bg-primary)] text-[var(--accent-blue)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
```

改为：

```tsx
              s.id === activeId
                ? 'bg-[var(--bg-tertiary)] text-[var(--text-bright)] shadow-[inset_2px_0_0_var(--accent-brand)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
```

- [ ] **Step 3: 构建 + 核对**

Run: `cd frontend && npx tsc -b && npm run build`
Expected: 成功。预览：选中会话有黄色左条且底色更亮；展开/折叠两态都生效。

> 注意：Tailwind v4 任意值里空格用下划线。若 `shadow-[inset_2px_0_0_var(--accent-brand)]` 在该项目的 Tailwind 配置下不生效（构建后无左条），改用内联 style 兜底：在该元素加 `style={s.id === activeId ? { boxShadow: 'inset 2px 0 0 var(--accent-brand)' } : undefined}`，并从 className 去掉该 shadow 任意值。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Sidebar.tsx
git commit -m "feat(ui): brand-yellow left bar marks the active session"
```

---

## Task 7: 聊天消息列表呼吸感

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx:324`（消息列表容器）

> 真实聊天是文本流非气泡，**不新增气泡底色**。仅加大消息间距与内边距，提升呼吸感。

- [ ] **Step 1: 加大列表间距**

`frontend/src/components/AcpChatView.tsx` 中：

```tsx
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
```

改为：

```tsx
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
```

- [ ] **Step 2: 构建 + 核对**

Run: `cd frontend && npm run build`
Expected: 成功。预览聊天：消息之间更松、不挤；终端视图不受影响。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "feat(ui): more breathing room in chat message list"
```

---

## Task 8: 全量验证 + 部署

**Files:** 无（验证与发布）

- [ ] **Step 1: 前端完整构建**

Run: `cd frontend && npx tsc -b && npm run build`
Expected: 两者均 exit 0。

- [ ] **Step 2: lint 核对无新增问题**

Run: `cd frontend && npx eslint src/components/HaringLogo.tsx src/components/LoginPage.tsx src/components/Sidebar.tsx src/components/AcpChatView.tsx`
Expected: 无与本次改动相关的 **新增** error（既有的 `react-hooks/set-state-in-effect` 基线警告不在本次范围，可忽略）。

- [ ] **Step 3: 后端重建（rust-embed 重新嵌入新 dist）**

Run: `cd .. && cargo build --release`
Expected: exit 0（仅警告可接受）。

- [ ] **Step 4: 用 deploy.sh 原子部署**

Run: `./deploy.sh`
Expected: 输出 `OK: HTTP 200, deploy complete.`

- [ ] **Step 5: 线上核对**

Run: `curl -s -o /dev/null -w "%{http_code}\n" https://zeromux.keithyu.cloud/`
Expected: `200`。浏览器硬刷新后：标签页是黄底黑 Z favicon；登录页是新 logo；暗色更柔和；当前会话有黄色左条。

- [ ] **Step 6: 最终提交（若有未提交的收尾改动）**

```bash
git add -A && git commit -m "chore: finalize Haring rebrand + UI polish" || echo "nothing to commit"
```

---

## Self-Review 记录

- **Spec 覆盖**：logo（Task 1-4）、暗色护眼 token + 点睛黄（Task 5）、视觉层级黄色左条（Task 6）、呼吸感（Task 7）、favicon/登录页点睛（Task 1/2/4）、构建+部署验收（Task 8）。空状态点睛在 spec 中为"最小集"，因真实空状态文案位置在本次探查中未定位到稳定锚点，**降级为可选增强、不强行编造锚点**，避免占位式步骤——如需，后续单独追加一个 Task。
- **Placeholder 扫描**：无 TBD/TODO；每个改动步骤都给了完整代码与确切命令。
- **类型/命名一致**：`HaringLogo`（默认导出）在 Task 3 定义、Task 4 引用一致；`--accent-brand` 在 Task 5 定义、Task 6 使用一致；favicon SVG 路径数据 Task 1 与 Task 3 组件完全一致。
- **边界**：终端 xterm、布局、交互逻辑、后端均未触碰；无新依赖。
