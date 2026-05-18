# Markdown 渲染升级 Design Spec

- **日期**: 2026-05-17
- **作者**: keith + Claude
- **状态**: Draft，待用户复核
- **影响范围**: `frontend/src/components/AcpChatView.tsx`、`MarkdownViewer.tsx`、新建 `frontend/src/components/markdown/`
- **不影响**: Rust 后端、ws 协议、systemd 服务、AWS 资源

## 实施状态（2026-05-18）

✅ **已实施并通过 review** —— 13 个 task 全部 commit 到 `feat/md-rendering` 分支，自动化测试 24/24 pass，final code review 通过。

### 实测包体（生产构建）

| 资源 | 大小 | 备注 |
|---|---|---|
| 主 bundle (`index-*.js`) | 1.1MB minified, ~302KB gz | eager：react + react-markdown + remark-gfm + remark-math + rehype-highlight + 12 hljs 语言 |
| KaTeX chunk | 254KB minified, 78KB gz + 29KB CSS + ~600KB 字体 | lazy，首次出现 `$` 才下载 |
| Mermaid chunk | 2.8MB minified, 764KB gz | lazy，首次出现 \`\`\`mermaid 才下载，含按图表类型的二级 lazy chunks |
| 二进制（rust-embed 后） | 11MB（pre-feature 6.4M，+4.6M） | 超过最初 ≤1MB 目标，但 lazy load 行为正确 |

### 偏离及决策

- 最初 §1 目标 4 写「二进制增长 ≤1MB」属于估算偏低。已修订目标聚焦在「lazy load 行为」而非绝对体积。
- §8 manualChunks 写的是 object 形式 `{ mermaid: ['mermaid'] }`，实际 Vite 8 / Rolldown 1 要求 function 形式，已改为 `id => id.includes('/node_modules/mermaid/') || id.includes('/node_modules/mermaid-')`。
- KaTeX 块级公式语法在 remark-math v6 下需要 `$$` 单独占行（不能 inline），实测后微调测试用例。

### 用户手动验收（§7 12 项 checklist）

待用户在浏览器走完。reviewer 认为生产构建已就绪、服务已重启上线（`zeromux.keithyu.cloud` HTTPS 200，systemctl is-active）。

## 1. 目标 / 非目标

### 目标
1. 在 AcpChatView 聊天流和 MarkdownViewer 笔记查看器渲染 **数学公式（KaTeX）、流程图（Mermaid）、代码语法高亮（highlight.js）、GFM 表格/任务列表**
2. 流式期间不卡顿：每秒 20+ token 仍能流畅滚动 + 输入
3. 不发对应内容的用户**不下载**对应库（lazy chunks）
4. 单文件部署优势保留：lazy chunks 确保不发对应内容的用户不下载对应库
   （实测 binary 6.4M → 11M / +4.6M，超过最初 ≤1MB 估算；mermaid 全图表类型
   bundle 比预估大，但 lazy load 已实现核心意图）

### 非目标
- ❌ 不引入 SSR / 服务端渲染
- ❌ 不实现离线缓存（service worker）
- ❌ 不做视觉回归（截图 diff）测试
- ❌ 不替换 react-markdown 为其它引擎
- ❌ 不实现 Mermaid Web Worker（v1 主线程渲染足够；瓶颈出现再升）

## 2. 背景

### 当前状态
- `react-markdown@10` + `remark-gfm@4` 是 zeromux 现有 MD 栈
- 聊天流和笔记查看器都直接 `<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>`
- **缺**：数学、Mermaid、代码高亮
- **隐患**：`messages.map((m, i) => <MessageBubble key={i}>)` 用数组下标当 key + 每 token 一次 `setMessages(prev => [...prev])` ⇒ 即使加 `React.memo` 也无法浅比较命中

### 借鉴对象
[KevinZhao/naozhi](https://github.com/KevinZhao/naozhi) 的 dashboard.html / dashboard.js：
- KaTeX、Mermaid 懒加载（首次遇到对应语法才注入 CSS / 拉 bundle）
- 流式增量渲染：仅对新插入的 DOM 片段跑 KaTeX/Mermaid，不重渲整体
- 模块级缓存 dedup

zeromux 是 React 19 项目，不能照搬手动 DOM 操作（与 React 模型反着），但**「懒加载 + 模块级缓存 + 增量更新」三个核心思路完全适配**。

## 3. 架构总览

### 性能瓶颈与分层依据

| 渲染阶段 | 单次成本 | 在每 token 都跑会怎样 |
|---|---|---|
| markdown parse | ~1ms | 可接受 |
| highlight.js | 5-30ms / block | 一条长代码消息开始卡 |
| KaTeX render | 1-3ms / 公式 | 累积变卡 |
| Mermaid render | **50-300ms** / 图 | **直接卡死** |

### 三层 + 状态槽 + 内容寻址缓存

```
                    ┌─────────────────────────────────────────┐
                    │  消息状态：text + isComplete            │
                    └────────┬─────────────────────┬──────────┘
                             │ React.memo by id    │ 仅活跃消息变化
                             ▼                     ▼
                  ┌──────────────────┐   ┌──────────────────────┐
                  │  历史消息（冻结）│   │  正在流式的消息（活跃）│
                  │  零重渲染         │   │  每 token 重渲染      │
                  └──────────────────┘   └─────────┬────────────┘
                                                   │
                          ┌────────────────────────┼─────────────────────────┐
                          ▼                        ▼                         ▼
                   ┌─────────────┐        ┌────────────────┐        ┌──────────────┐
                   │ 第 1 层：   │        │ 第 2 层：      │        │ 第 3 层：    │
                   │ Markdown    │        │ 代码高亮       │        │ KaTeX/Mermaid│
                   │ AST 解析    │        │ rehype-        │        │ 仅 isComplete│
                   │ <1ms        │        │ highlight       │        │ =true 时触发 │
                   └─────────────┘        └────────────────┘        └──────┬───────┘
                                                                            │
                                          ┌─────────────────────────────────┘
                                          │ useEffect (off render path)
                                          ▼
                                  ┌──────────────────────────┐
                                  │ 模块级 Map<hash, SVG>    │
                                  │ 跨消息/会话 dedup        │
                                  └──────────────────────────┘
```

### 6 条核心原则

1. **状态槽模式**：重渲染器永远在 `useEffect` 跑，不在 render 里同步执行。组件渲染上一次的缓存输出。
2. **内容寻址缓存**：`Map<hash(code), svg>` 模块级单例，跨消息、跨会话存活。
3. **`isComplete` 流式护栏**：消息未完成前 KaTeX/Mermaid 不渲染，显示 raw 源码占位。
4. **React 19 `useDeferredValue`**：流式 token 高频更新让位给键入/滚动，markdown 解析跑 transition 优先级。
5. **懒分包**：KaTeX、Mermaid 各自独立 chunk，不发对应内容就不下载。
6. **单一共享组件**：`<MarkdownContent text isComplete />` 同时服务 AcpChatView + MarkdownViewer。

## 4. 组件契约

### 前置改造（先做）

```ts
// AcpChatView.tsx
interface AssistantMsg {
  id: string                // 新增：crypto.randomUUID() on creation
  kind: 'assistant'
  blocks: ContentBlock[]
  cost?: number
  complete: boolean         // 新增：result/error/exit/replay_done/ws-close 时翻 true
}
// SystemMsg / UserMsg / ErrorMsg 同样加 id（任意短 id 即可）
```

`<MessageBubble key={msg.id} />` 取代 `key={i}`。`MessageBubble = React.memo(impl, (a,b) => a.msg === b.msg && a.agentName === b.agentName)`。

### 公共 API

```ts
interface MarkdownContentProps {
  text: string
  isComplete: boolean       // false → KaTeX/Mermaid 退化为 raw
  className?: string
}
function MarkdownContent(props: MarkdownContentProps): JSX.Element
```

调用方：
```tsx
// AcpChatView 流式中
<MarkdownContent text={blockText} isComplete={msg.complete} />
// MarkdownViewer 静态文件
<MarkdownContent text={fileContent} isComplete={true} />
```

### 内部结构

```
MarkdownContent
└─ ReactMarkdown
   ├─ remarkPlugins:  [remarkGfm, remarkMath]
   ├─ rehypePlugins:  [[rehypeHighlight, { detect:true, ignoreMissing:true }],
   │                   ...(katexPlugin ? [[katexPlugin, { strict:'ignore' }]] : [])]
   └─ components:     { code: CodeBlock, ...markdownComponents }

CodeBlock({ className, children, ...props })   // react-markdown v10 API：无 inline prop
  isBlock = className?.startsWith('language-')   // 与现有 markdownStyles.tsx 一致
  ├─ !isBlock → <code> 行内代码 </code>
  ├─ language === 'mermaid' && isComplete → <MermaidBlock code={String(children)} />
  ├─ language === 'mermaid' && !isComplete → <pre.mermaid-pending>{String(children)}</pre>
  └─ else → <pre><code class={hljsClass}>...</code></pre>   // rehype-highlight 已染色
```

**children 的形态**：rehype-highlight 不识别 / 不在 `subset` 里的语言（如 `mermaid`），会让 `<code>` 子节点保持纯文本字符串，`String(children)` 即得到 raw 源码。被 hljs 染色的语言里 children 是 React 节点树，不能直接当字符串用——这是为何把 mermaid 排除在 `subset` 之外的原因。

### 文件布局

```
frontend/src/components/markdown/
  ├─ MarkdownContent.tsx     # 入口，含 KaTeX 两段式加载
  ├─ CodeBlock.tsx           # mermaid 分流
  ├─ MermaidBlock.tsx        # 状态槽 + lazy import
  ├─ context.ts              # MarkdownContext (isComplete)
  ├─ cache.ts                # mermaidCache: Map<string,string>
  ├─ hash.ts                 # fnv1a，足够防碰撞
  └─ katexBundle.ts          # lazy chunk 入口：import katex.css + rehype-katex
```

`components/markdownStyles.tsx` 现有 `markdownComponents` 字典保留，被 `MarkdownContent` 内部 spread（除 `code` 外）。

## 5. 数据流

### 端到端时序

```
WS event → AcpChatView.handleEvent → setMessages (immutable) → MessageBubble (memo)
         → MarkdownContent (Context: isComplete) → ReactMarkdown → CodeBlock
         → MermaidBlock (useEffect → cache → dynamic import → render → setSvg)
```

### 关键状态转换

```ts
// content_block：仅替换活跃消息引用
case 'content_block': {
  setMessages(prev => prev.map(m => {
    if (m.id !== currentAssistant.current?.id) return m   // 引用稳定
    const blocks = [...m.blocks]
    if (evt.streaming && evt.block_type === 'text' && blocks.length > 0
        && blocks[blocks.length - 1].type === 'text') {
      const last = blocks[blocks.length - 1]
      blocks[blocks.length - 1] = { ...last, text: (last.text || '') + (evt.text || '') }
    } else {
      blocks.push({ type: ..., text: evt.text, name: evt.name, input: evt.input })
    }
    return { ...m, blocks }
  }))
  break
}

// 流结束：将活跃消息 complete=true
case 'result':
case 'error':
case 'exit':
case 'replay_done': {
  const activeId = currentAssistant.current?.id
  if (activeId) {
    setMessages(prev => prev.map(m => m.id === activeId ? { ...m, complete: true } : m))
  }
  currentAssistant.current = null
  setBusy(false)
  break
}
```

### Mermaid 两阶段时序

```
T0  msg.complete=false, 消息含 ```mermaid\nA-->B\n```
    → CodeBlock: lang=mermaid + isComplete=false → <pre.mermaid-pending>{code}</pre>

T1  result 事件 → setMessages 翻 m.complete=true
    → 仅活跃消息那条 MessageBubble 重渲染
    → CodeBlock 切换到 <MermaidBlock code={...} />

T2  MermaidBlock useEffect：
    → cache miss
    → await import('mermaid')   ← 第一次出现 mermaid 才下 chunk
    → mermaid.parse(code)        ← 校验
    → mermaid.render(...) → svg
    → cache.set(hash, svg) + setSvg

T3  MermaidBlock 重渲染，dangerouslySetInnerHTML 显示 SVG
```

二次出现同图：T2 直接 cache hit，零延迟。

### 不变量

1. 历史消息对象引用稳定：流式中 `messages[i] === prev_messages[i]` 对所有非活跃消息成立
2. `complete` 单调：一旦 `true` 不会回 `false`
3. Mermaid 不在流式中渲染：`MermaidBlock` 的 useEffect 第一行 `if (!isComplete) return`
4. 同图全局只渲一次：`mermaidCache` 模块级，组件卸载不清

## 6. 错误处理

### 渲染层

| 失败点 | 处理 | 用户看到 |
|---|---|---|
| Mermaid 语法错误 | `mermaid.parse()` catch | raw 源码 + 红字 `Mermaid: <err>` |
| Mermaid 渲染错误 | catch | 同上 |
| KaTeX 公式错误 | `rehypeKatex({ strict: 'ignore' })`，KaTeX 自身 inline 红色 | 红色 raw TeX |
| highlight.js 不识别语言 | `rehypeHighlight({ ignoreMissing: true })` | 退化为无色 `<pre><code>` |
| lazy chunk 拉取失败（断网） | `import('mermaid').catch()` 进同 mermaid 错误 | raw + 红字 + 重试按钮 |

### 流状态层

**E1. WS 断开时活跃消息卡 `complete=false` 修复**

当前 `ws.onclose` 不动消息状态，会留下卡死的 raw 占位。改为：

```ts
ws.onclose = () => {
  wsRef.current = null
  const activeId = currentAssistant.current?.id
  if (activeId) {
    setMessages(prev => prev.map(m =>
      m.id === activeId ? { ...m, complete: true } : m
    ))
  }
  currentAssistant.current = null
  setBusy(false)
}
```

**E2. Scrollback replay** 已经被 `replay_done` 路径自然覆盖（§5 状态转换里的代码）。

### 安全

Mermaid 使用 `dangerouslySetInnerHTML` 渲染 SVG —— 信任 npm `mermaid` 包对节点文本的 escape。这是已接受的安全假设；高安全场景需后端 SVG sanitizer 网关或 server-side 渲染（不在本 spec 范围）。

KaTeX `output: 'html'` 模式只产 spans + 数学符号，攻击面更小，无需额外处理。

### 不做（YAGNI）

- ❌ Mermaid 渲染超时（mermaid 内部已有循环保护）
- ❌ KaTeX 公式过长截断
- ❌ 用 DOMPurify 清洗 mermaid 输出（会破坏样式）

## 7. 测试策略

### 框架
- `vitest` + `@testing-library/react` + `happy-dom`
- `package.json` 加 `"test": "vitest run"` 和 `"test:watch": "vitest"`

### 单元测试（约 11 个 case）

```
frontend/src/components/markdown/__tests__/
  ├─ MarkdownContent.test.tsx    # 7 case
  ├─ MermaidBlock.test.tsx       # 3 case
  └─ cache.test.ts               # 1 case
```

**MarkdownContent.test.tsx**:
1. `text="$E=mc^2$"`, `isComplete=true` → DOM 含 `.katex`
2. `text="$$\sum x_i$$"`, `isComplete=true` → DOM 含 `.katex-display`
3. ` ```mermaid\nA-->B\n``` `, `isComplete=false` → `pre.mermaid-pending`
4. ` ```mermaid\nA-->B\n``` `, `isComplete=true` → 触发 dynamic import（mock）
5. ` ```rust\nfn x(){}\n``` `, `isComplete=true` → `code.hljs.language-rust`
6. KaTeX 错误 `$\frac{$` → 红色 raw，**不抛**
7. 空文本 → 空 div，无报错

**MermaidBlock.test.tsx**（mock `mermaid` 模块）:
1. cache miss → import → render → svg 出现
2. cache hit → 不调 `import()`（vi.fn spy 验证）
3. `mermaid.parse` 抛错 → 状态切到 `error`，DOM 含 raw + 红字

**cache.test.ts**:
- `mermaidCache.set('abc', '<svg/>')`，跨模块 import 后命中

### 不做的
- ❌ 不测 KaTeX/Mermaid/highlight.js 库内部
- ❌ 不引 Playwright/Cypress E2E
- ❌ 不做截图回归

### 手动验收清单（PR 合入硬指标）

```
□ 1.  发 "$E = mc^2$"               → 内联 KaTeX 渲染
□ 2.  发 "$$\sum_{i=1}^n x_i$$"      → 块级 KaTeX 居中
□ 3.  发 ```mermaid\ngraph TD; A-->B; B-->C\n```
                                     → 流式中 raw，result 后 200ms 内出 SVG
□ 4.  重发同一段 mermaid              → 立即出 SVG，Network 不再下 chunk
□ 5.  发 ```mermaid\nfoo bar nope\n``` → raw + 红字错误
□ 6.  发 ```rust\nfn main() {}\n```   → 关键字着色
□ 7.  发长消息夹带 mermaid，流式中观察 → mermaid 在 result 前不渲染，文本流正常
□ 8.  全新打开 + 发不含 mermaid 消息   → Network 无 mermaid chunk
□ 9.  同上，发首条含 mermaid 消息       → mermaid-*.js chunk 请求出现
□ 10. 切到 Notes 文件查看 .md          → KaTeX/Mermaid/hljs 全部生效
□ 11. 关后端进程触发 ws onclose         → 最后一条消息从 raw 升级到完整渲染（E1 验证）
□ 12. 重连恢复 scrollback              → 历史消息全部完整渲染
```

### 性能验收（建议）

DevTools Performance 录制「发 5KB 文本流式回复 + 一段 mermaid」：

- ✅ 流式期间主线程 long task ≤ 50ms（除 result 那一帧的 mermaid render）
- ✅ Mermaid 渲染只发生 1 次（不在每个 token tick 跑）
- ✅ React Profiler 「why did this render」不出现历史消息

## 8. 包体策略

### 三层分包

```
┌──────────────────────────────────────────────────────────────┐
│ 主 chunk（eager）  ~310KB gzipped                             │
│   react / react-dom（现有）                                   │
│   react-markdown + remark-gfm                                 │
│   remark-math                  ← 仅做 $...$ 解析，~3KB gz     │
│   rehype-highlight + hljs core + 12 常用语言                  │
│   highlight.js theme CSS（github-dark）                       │
└──────────────────────────────────────────────────────────────┘
              ▲ (首次 $)                  ▲ (首次 ```mermaid)
              │                            │
┌─────────────┴──────────────┐  ┌─────────┴──────────────────┐
│ katex chunk    ~100KB gz   │  │ mermaid chunk   ~200KB gz  │
│   katex                    │  │   mermaid (含 dagre)       │
│   rehype-katex             │  │                            │
│   katex.min.css            │  │                            │
└────────────────────────────┘  └────────────────────────────┘
```

### KaTeX 两段式加载

`MarkdownContent` 内部 useEffect 检测 `text.includes('$')` 时动态 `import('./katexBundle')`，加载完后 setState 把 `rehypeKatex` 加入 plugin 链。加载未完成期间公式以 raw `$E=mc^2$` 显示，与 isComplete 未到时的占位状态一致。

`katexBundle.ts`:
```ts
import 'katex/dist/katex.min.css'   // vite 打进同一 chunk
import rehypeKatex from 'rehype-katex'
export { rehypeKatex }
export function ensureCss() { /* import 副作用已注入 link */ }
```

Mermaid 不需要这套：MermaidBlock 是叶子组件，内部 `await import('mermaid')` 自然懒加载。

### 高亮语言默认捆绑

`bash, json, yaml, ts, js, tsx, rust, python, go, java, sql, dockerfile`（12 个，覆盖 Claude Code 9 成输出）。

`rehype-highlight` 配置：

```ts
[rehypeHighlight, {
  subset: ['bash','json','yaml','typescript','javascript','tsx','rust','python','go','java','sql','dockerfile'],
  detect: true,            // subset 内自动检测无 className 的代码块
  ignoreMissing: true,     // 显式 className 但语言未知时静默退化
}]
```

**关键：`mermaid` 不在 subset 里**——保证 ` ```mermaid ` 块不被 hljs 染色，`<code>` children 保持为字符串，便于 MermaidBlock 取 raw 源码。

### Vite 配置

```ts
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: { mermaid: ['mermaid'] },
      },
    },
    chunkSizeWarningLimit: 800,
  },
})
```

`katexBundle.ts` 走相对路径动态 import，Rolldown 自动分包。

### Rust-embed 影响

| 项 | 现状 | 新方案 |
|---|---|---|
| 主 JS bundle (gz) | ~246KB | ~310KB |
| mermaid chunk (gz) | – | ~200KB |
| katex chunk (gz) | – | ~100KB |
| 二进制大小 | 6.4MB | ~7.0MB（rust-embed zstd 压缩后） |

单文件部署优势保留。

### 构建验收

```bash
cd frontend && npx vite build
ls -lh dist/assets/
# 期望：
#   ~250-350K  main-[hash].js
#   ~600-700K  mermaid-[hash].js  (gz~200K)
#   ~250-300K  katex-[hash].js    (gz~100K)
#   ~10-30K    index-[hash].css
```

如果 mermaid / katex 没分出来，说明动态 import 写错了或 manualChunks 没生效——硬阻断，必须分对。

### 不做（YAGNI）

- ❌ service worker 离线缓存
- ❌ SSR / 预渲染
- ❌ module federation
- ❌ `<link rel="modulepreload">` 预拉 mermaid（违背「不用就不下」）

## 9. 已知风险

| 风险 | 应对 |
|---|---|
| Mermaid 200KB chunk 是这次最大体积增量 | 已是行业最优解；如不满意未来可换 [@mermaid-js/mermaid-mindmap](https://www.npmjs.com/package/@mermaid-js/mermaid-mindmap) 这种按 sub-package 分 |
| `mermaid.parse` 在某些边角语法（含中文节点名）有误报历史 | 渲染失败已有兜底（raw + 错误提示），不会 crash 页面 |
| `useDeferredValue` + 大量 token 在低端设备可能感觉「滞后」 | React 19 自动平衡；如果实测明显，加 `startTransition` 包裹 setMessages |
| 上游 `lucide-react@1.16.0` 类型缺失（已知现存问题） | 与本 spec 无关，构建时已用 `vite build` 跳过 tsc，不阻塞 |

## 10. 验收标准（合 PR 唯一硬指标）

§7 的 12 项手动验收清单全过。性能验收建议项可选。

## 11. 实现拆分建议（交给 writing-plans）

设计层面的逻辑拆分如下，writing-plans 会基于此出可执行步骤：

1. **前置改造**：消息加 id + complete，MessageBubble React.memo（独立 PR，单测可加可不加）
2. **共享组件骨架**：建 `markdown/` 目录，`MarkdownContent` 不带任何高级功能，等价替换两处现有 `<ReactMarkdown>`
3. **highlight.js 接入**：`rehype-highlight` + 12 语言 + 主题 CSS
4. **KaTeX 两段式**：检测 + 懒加载 katex chunk
5. **Mermaid 状态槽 + 模块缓存 + 懒加载**
6. **WS onclose / replay_done E1 修复**
7. **测试基础设施 + 单测**
8. **手动验收 + 性能验收**

每步独立可验证，建议 1 个步骤 = 1 次 commit / 1 个 PR。
