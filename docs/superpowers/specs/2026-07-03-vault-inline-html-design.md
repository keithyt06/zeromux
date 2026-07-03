# Vault 内嵌 HTML 渲染 — 设计文档

日期：2026-07-03
分支：`feat/vault-inline-html`

## 问题陈述

从左上角打开 Obsidian vault 笔记时，笔记里**内嵌的 HTML（表格、`<span style>`、
`<br>`、`<details>` 等）显示为源码而非渲染结果**。用户期望"打开后看到内容结果"。

## 背景澄清：为什么不能"嵌套 Obsidian 编辑器"

用户初始诉求（Plan A）是"直接嵌套 Obsidian 编辑器"。这**技术上不成立**：
Obsidian 是闭源 Electron 桌面应用，官方不提供任何可嵌入网页的编辑器组件 / SDK /
iframe 方案。当前"左上角看 md"本质是自研的 React 只读查看器（`VaultReader` +
`react-markdown`），从来不是真 Obsidian。

**但 Plan A 想要的"渲染正确的效果"无需 Obsidian 本体即可拿到**——用户笔记里的内嵌
HTML 表格 / 样式正是可渲染的内容。故本方案 = 修好现有查看器的 HTML 渲染，即达成
Plan A 的目标。经与用户确认，采纳此方案，**只读，不做编辑**。

## 根因诊断（已实证）

`MarkdownContent.tsx` 使用 `react-markdown`，**未启用 `rehype-raw`**（已确认
`rehype-raw` 未安装）。react-markdown 默认丢弃所有原始 HTML，故内嵌 HTML 被当纯
文本/代码块输出 → 用户看到 HTML 源码而非渲染结果。

实测用户真实 vault（`/home/ubuntu/s3-workspace/keith-space/obsidian`，599 篇笔记）中
大量笔记内嵌 HTML（如 SGLang 系列整用 `<table style=...>` 排版、`<br>`、
`<span style="font-size:11px">` 等）。

## 方案：A — rehype-raw + rehype-sanitize 白名单净化

安全策略经用户确认选 A：既拿到全部排版渲染效果，又不破坏安全基线（vault 读端点是
信任边界，OAuth 多用户模式存在）。

### 改动 1：新增依赖

`rehype-raw`、`rehype-sanitize`（含其重导出的 `defaultSchema`）。锁定版本，pin 到
与 `react-markdown@10`（unified/rehype 生态）兼容的主版本。

### 改动 2：`MarkdownContent.tsx` 仅 vault 路径启用

- 判据：`onWikiLink` 或 `resolveSrc` 存在时（= `VaultReader` 调用）→ 启用 raw+sanitize。
  **聊天路径（agent 输出，无这些 props）不启用**，保持现状零新增风险。
- **插件顺序（关键，写死）：**
  `rehype-raw`（raw HTML → hast 节点）
  → `rehype-sanitize`（白名单净化）
  → `rehype-highlight`（代码高亮）
  → `rehype-katex`（公式，按需异步加载）
  sanitize 必须在 raw 之后、highlight/katex 之前：先净化用户 HTML，再让可信插件添加
  自己的类。

### 改动 3：sanitize 白名单 schema（最易踩坑处）

基于 `rehype-sanitize` 的 `defaultSchema` 扩展：

- **必须放行 highlight.js 的 `className`**：`hljs-*`（否则代码高亮样式被剥）。
  由于 highlight 在 sanitize **之后**运行，其加的 class 本不经过 sanitize——但需
  确认顺序确实如此，若因兼容性需调整顺序，则 schema 显式放行 `code`/`span` 的
  `className`。
- **放行 KaTeX 的类**：`katex*`（katex 同样在 sanitize 后运行，主要防御措施是顺序）。
- **放行安全 `style` 属性**：表格/span 的内联样式（用户笔记依赖 `background`、
  `padding`、`text-align`、`font-size`、`width`、`color`、`border-collapse` 等排版）。
  仅允许 style **属性存在**；不解析其内容——CSS 本身无脚本执行面（`expression()`
  早已废弃，现代浏览器不支持），保留 style 是安全的。
- **放行标签**：`table thead tbody tr th td`（全套）、`div span br hr`、
  `details summary`、`sub sup kbd mark u b i em strong s del ins`、`code pre`、
  `a`（保留 href sanitize 默认对 `javascript:` 的拦截）、`img`（保留默认 src 协议限制）。
- **放行属性**：`style`、`className`/`class`、`colspan`、`rowspan`、`align`、`title`。
- **剥掉（默认即拒 / 显式确保）**：`script`、`iframe`、`object`、`embed`、
  所有事件处理器属性（`onerror`/`onclick`/…）、`javascript:` / `data:` URL。

### 改动 4：wikilink 与 raw HTML 的相容

现有 `remarkWikilink` 在 mdast text 节点上工作，`rehype-raw` 在 hast 阶段处理 HTML，
二者不冲突。需验证：内嵌 HTML `<a href>` 不被 wikilink 逻辑误伤；`[[wikilink]]`
仍正常。

## 不改动

后端 vault 读取（只读 + 敏感目录守卫 + symlink canonicalize，已多轮 review）、
wikilink 解析后端、图片 `resolveVaultImageSrc`。

## 验证

- **单测：** `<script>alert(1)</script>` 被剥；`<img onerror=...>` 事件属性被剥；
  `<a href="javascript:...">` 被中和；`<table style=...>` 完整保留（标签+style）；
  代码块 `hljs-*` 类保留；含 `$x$` 公式的 katex 类保留；`[[wikilink]]` 仍渲染为可点链接。
- **端到端：** 用真实 vault 的 SGLang HTML 表格笔记
  （如 `.../SGLang/01_推理全景与定位/1.1_LLM推理为什么难.md`）打开 → 渲染为真表格
  而非源码。
- `tsc -b` + `eslint` + `vitest run` 全过。

## 风险

- sanitize schema 过严 → 误剥用户需要的样式；过松 → XSS。缓解：白名单从
  `defaultSchema` 出发（默认已安全），仅增量放行排版类标签/属性，单测钉死"危险项被剥
  + 表格样式保留"两端。
- 插件顺序错误 → 高亮/公式样式丢失。缓解：spec 写死顺序，单测覆盖高亮类/公式类保留。
