# Vault 内嵌 HTML 渲染 — 设计文档（v2，经 CTO + PM 双评审修订）

日期：2026-07-03
分支：`feat/vault-inline-html`

## 问题陈述

从左上角打开 Obsidian vault 笔记时，笔记里**内嵌的 HTML（表格、`<span style>`、
`<br>`、`<details>` 等）显示为源码而非渲染结果**。用户期望"打开后看到内容结果"。

## 背景澄清：为什么不能"嵌套 Obsidian 编辑器"

用户初始诉求（Plan A）是"直接嵌套 Obsidian 编辑器"。这**技术上不成立**：
Obsidian 是闭源 Electron 桌面应用，官方不提供任何可嵌入网页的编辑器组件 / SDK /
iframe 方案。当前"左上角看 md"本质是自研 React 只读查看器（`VaultReader` +
`react-markdown`），从来不是真 Obsidian。

**但 Plan A 想要的"渲染正确的效果"无需 Obsidian 本体即可拿到**——用户笔记里的内嵌
HTML 表格 / 样式正是可渲染的内容。故本方案 = 修好现有查看器的 HTML 渲染，即达成
Plan A 的目标。经与用户确认，采纳此方案，**只读，不做编辑**。（CTO + PM 均背书此决策：
真实需求是"看得对"，手机上编辑长笔记是伪需求，编辑回桌面端完成。交付时向用户明确这句话，
管理预期。）

## 根因诊断（已实证）

`MarkdownContent.tsx` 使用 `react-markdown@10`，**未启用 `rehype-raw`**（已确认
`rehype-raw` 未安装）。react-markdown@10 内部以 `allowDangerousHtml:true` 进
remark-rehype，raw 节点在渲染层被替换为**纯文本节点**
（实证 `node_modules/react-markdown/lib/index.js:123,360-366`）——与"显示为源码"逐字吻合。

实测用户真实 vault（`/home/ubuntu/s3-workspace/keith-space/obsidian`，599 篇笔记）中
大量笔记内嵌 HTML（如 SGLang 系列整用 `<table style=...>` 排版、`<br>`、
`<span style="font-size:11px">` 等），且 20+ 篇含 `$$` 数学公式。

## 方案：A — rehype-raw + rehype-sanitize 白名单净化（+ 深色可读性 + 显式启用）

安全策略经用户确认选 A。以下并入两位评审的必改项。

### 改动 1：新增依赖

`rehype-raw`、`rehype-sanitize`（重导出 `defaultSchema`）。rehype-raw@7 / rehype-sanitize
与 `react-markdown@10` 同属 unified v11 生态，兼容。锁定版本。

### 改动 2：`MarkdownContent.tsx` 显式 prop 启用（CTO P2-2，纠正 v1 的隐式判据）

- v1 用"`onWikiLink`/`resolveSrc` 存在"推断 vault 路径 → 脆弱（未来 FileBrowser 传
  `resolveSrc` 会静默连带开启 raw HTML）。**改为显式 `enableRawHtml?: boolean` prop**，
  仅 `VaultReader` 传 `true`。
- **聊天路径（agent 输出）、FileBrowser/MarkdownViewer 预览不传 → 零新增风险**，维持
  现状（同一 .md 在 VaultReader 渲染 HTML、在别处显示退化文本——不一致但有意为之，
  agent 输出是更不可信输入面；spec 明确记录）。
- **插件顺序（关键，写死）**：`rehype-raw`（raw HTML→hast 节点）→ `rehype-sanitize`
  （白名单净化）→ `rehype-highlight` → `rehype-katex`（按需异步）。sanitize 必须先于
  可信插件（rehype-sanitize README 推荐形态）。react-markdown@10 的 `rehypePlugins`
  数组顺序即执行顺序（已核实）。

### 改动 3：sanitize 白名单 schema（含 CTO P1 必修的 math marker）

基于 `defaultSchema` 增量扩展：

- **【CTO P1，必修】放行 remark-math 的 marker class**，否则**所有 `$x$`/`$$x$$`
  静默变回原文**（必现回归）。`remark-math`→remark-rehype 产出带 `math-inline`/
  `math-display` class 的 `code`，而 `defaultSchema` 对 `code.className` 只放行
  `/^language-./`（[hast-util-sanitize schema](https://github.com/syntax-tree/hast-util-sanitize/blob/main/lib/schema.js)）。
  按 [rehype-sanitize README](https://github.com/rehypejs/rehype-sanitize) 官方修法：
  ```js
  code: [...(defaultSchema.attributes.code || []),
         ['className', /^language-./, 'math-inline', 'math-display']]
  ```
  `language-mermaid` 匹配 `/^language-./` 幸存，**mermaid 不受影响**（单测钉住）。
  katex/highlight 的**输出**类因运行在 sanitize 之后而免疫（无需放行），但**输入
  marker 在 sanitize 之前存在**，必须显式放行——这是 v1 正文写错的方向。
- **放行安全 `style` 属性**（用户笔记依赖 `background`/`padding`/`text-align`/
  `font-size`/`width`/`color`/`border-collapse` 等排版）。安全依据见改动 5。
- **放行标签**：`table thead tbody tr th td`、`div span br hr`、`details summary`、
  `sub sup kbd mark u b i em strong s del ins`、`code pre`、`a`（默认拦 `javascript:`）、
  `img`（默认限 http/https；`data:` 见 P3）。
- **放行属性**：`style`、`colspan`、`rowspan`、`align`、`title`；**`className` 按元素
  放行**（code/span 如上），**不进全局属性表**（CTO P3-2：全局放行 className 让笔记
  HTML 可借 app 的 Tailwind 工具类做 UI spoof，admin-only 危害低但没必要）。
- **剥掉**（默认即拒）：`script`、`iframe`、`object`、`embed`、事件属性、`javascript:`/
  非白名单协议 URL。
- react-markdown@10 渲染层带 `ignoreInvalidStyle:true`（`index.js:351`）：笔记里写坏的
  style 不会崩渲染（消一个隐忧）。

### 改动 4（PM 必修，有实证）：深色主题「白底浅字」可读性修复

- **实测**：单篇 SGLang 笔记就有 **365 处** style 设了浅色 `background`（`#fff`/
  `#e8eaf6`/`#c8e6c9`…）但**没设 `color`**（vs 1382 处 bg+color 成对）。整套配色是亮色系
  （深文字 `#111`/`#1b5e20`）。ZeroMux 深色主题（`--text-primary` 浅色）下，这些无 color
  单元格 → **浅底 + 继承浅字 = 不可见**。渲染"生效"却读不了 = 另一种坏。
- **方案甲（采纳）**：vault 阅读内容区整体做成**浅色阅读纸面**——`VaultReader` 的 read-mode
  容器给白底深字（正文/标题/普通表格用浅色变量），像 Obsidian 亮色主题 / 多数阅读模式。
  用户笔记本就按亮色排版，纸面化后所有内联样式天然协调。代码高亮块自带 `github-dark.css`
  背景不受影响（验收确认对比度可接受）。
- 验收：SGLang 表格笔记在**真机深色模式**下所有单元格可读。

### 改动 5（CTO P2-1）：保留 style 的安全依据 = 显式依赖 CSP，非"CSS 无脚本"

- v1 依据"CSS 无脚本执行面"**已过时**：2025 有纯 `style` 属性经 CSS `if()`+`attr()`+
  `image-set()` / `background:url()` 条件外发请求、逐字符外传的手法
  （[PortSwigger Inline Style Exfiltration](https://portswigger.net/research/inline-style-exfiltration)、
  [OWASP CSS Injection](https://owasp.org/www-project-web-security-testing-guide/stable/4-Web_Application_Security_Testing/11-Client-side_Testing/05-Testing_for_CSS_Injection)）。
- **本项目结论仍成立**，真正 load-bearing 的是全局 CSP `img-src 'self' data:`
  （已确认 `src/web.rs:212`），掐断外传信道；叠加 vault 端点 admin-only + 内容是 admin
  自己的笔记。**spec 把"style 可保留"的依据显式写为依赖 CSP img-src，并加注释/测试钉死
  这个耦合**，防未来"放开 img-src 支持外链图"的改动静默拆墙。

## 不改动

后端 vault 读取（只读 + 敏感目录守卫 + symlink canonicalize，已多轮 review）、
wikilink 解析后端、图片 `resolveVaultImageSrc`。remarkWikilink 在 mdast 阶段、raw 在
hast 阶段，二者不冲突（`#wikilink:` href 靠 `#` 先于 `:` 判为 fragment 过 sanitize——
现有单测是契约，不删）。

## 验证

- **单测**：`<script>` 被剥；`<img onerror=>` 事件属性被剥；`<a href="javascript:">`
  中和；`<table style=...>` 标签+style 完整保留；**`$x$`/`$$x$$` 渲染为 katex（marker
  class 保留，钉死 CTO P1）**；`language-mermaid` 幸存；代码块 `hljs-*` 保留；
  `[[wikilink]]` 仍为可点链接；style 内 `background:url(http://evil)` 保留但 CSP 拦截
  （或按可选强化直接拒 url()）。
- **端到端（真机深色模式）**：SGLang HTML 表格笔记（`.../SGLang/01_推理全景与定位/
  1.1_LLM推理为什么难.md`）渲染为真表格、公式正常、**所有单元格可读**；再挑一篇
  "HTML 与 markdown 交错"的笔记验证 rehype-raw 解析器语义（CTO P3-4）。
- `tsc -b` + `eslint` + `vitest run` 全过。

## 已知不支持 / 可选

- P3：`data:` 内嵌图默认被剥（Obsidian web 剪藏常见 base64 图）——放行 `img` 的 `data:`
  协议（CSP 本就允许 `img-src data:`）或写入"已知不支持"。**采纳：放行 `data:` img。**
- 可选强化（CTO P2-1）：对 style 值做属性名白名单解析，直接拒 `url()`/`image-set()`。
  单用户自托管 + CSP 已封 → 本期不做，记录为可选。
- 可选下期（PM）：长技术笔记浮动大纲 / 标题跳转（手机读长笔记的滚动之痛）。

## 风险

- schema 过严误剥用户样式 / 过松致 XSS：从 `defaultSchema` 增量放行 + 两端单测钉死。
- 插件顺序错致高亮/公式丢失、或 math marker 被剥：spec 写死顺序 + 单测钉 katex/mermaid/
  hljs 三类。
- rehype-raw 解析器语义与 Obsidian 略有出入（未闭合 `<details>` 吞后续等）：e2e 覆盖
  主路径 + 交错笔记。
