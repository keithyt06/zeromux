# Markdown Rendering Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add KaTeX (math), Mermaid (flowcharts), highlight.js (code coloring), and streaming-aware rendering to zeromux's chat and notes views without bloating the initial bundle or stuttering during stream.

**Architecture:** Three-tier rendering (cheap markdown parse → eager hljs → deferred KaTeX/Mermaid). Module-level `Map<hash,svg>` for cross-message Mermaid dedup. `isComplete` streaming guard via React Context. Lazy chunks for KaTeX (~100KB gz) and Mermaid (~200KB gz) so first-paint is unaffected when content has none.

**Tech Stack:** React 19, Vite + Rolldown, react-markdown 10, remark-math, remark-gfm, rehype-highlight, rehype-katex, mermaid 11, vitest + @testing-library/react + happy-dom.

**Spec reference:** `docs/specs/2026-05-17-md-rendering-design.md`

**Working directory:** All paths below are relative to `frontend/` unless prefixed with `/` (project root). Most commands assume `cd frontend` first.

---

## Task 1: Vitest test infrastructure

**Files:**
- Modify: `frontend/package.json` (devDeps + scripts)
- Create: `frontend/vitest.config.ts`
- Create: `frontend/src/test/setup.ts`
- Create: `frontend/src/test/__tests__/smoke.test.ts`

- [ ] **Step 1: Install dev deps**

```bash
cd frontend
npm install --save-dev vitest@^3 @testing-library/react@^16 @testing-library/jest-dom@^6 happy-dom@^15
```

Expected: deps added to `package.json`. No errors.

- [ ] **Step 2: Add test scripts to `package.json`**

In the `"scripts"` block, add two entries:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
```

- [ ] **Step 4: Create `src/test/setup.ts`**

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 5: Add a smoke test to verify setup works**

Create `src/test/__tests__/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('test infra', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })

  it('has happy-dom globals', () => {
    expect(typeof document).toBe('object')
    expect(typeof window).toBe('object')
  })
})
```

- [ ] **Step 6: Run tests to verify infra**

```bash
cd frontend && npm test
```

Expected: 2 tests pass, no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/src/test/
git commit -m "chore(frontend): add vitest test infrastructure"
```

---

## Task 2: fnv1a hash utility

**Files:**
- Create: `frontend/src/components/markdown/hash.ts`
- Create: `frontend/src/components/markdown/__tests__/hash.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/components/markdown/__tests__/hash.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fnv1a } from '../hash'

describe('fnv1a', () => {
  it('returns a string', () => {
    expect(typeof fnv1a('hello')).toBe('string')
  })

  it('is deterministic', () => {
    expect(fnv1a('graph TD; A-->B')).toBe(fnv1a('graph TD; A-->B'))
  })

  it('differs for different inputs', () => {
    expect(fnv1a('a')).not.toBe(fnv1a('b'))
  })

  it('handles empty string', () => {
    expect(fnv1a('')).toBe(fnv1a(''))
  })

  it('handles unicode', () => {
    expect(fnv1a('节点 → 边')).not.toBe(fnv1a('节点 → 边2'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd frontend && npm test -- hash.test.ts
```

Expected: FAIL — `Cannot find module '../hash'`.

- [ ] **Step 3: Implement `hash.ts`**

Create `src/components/markdown/hash.ts`:

```ts
// FNV-1a 32-bit hash. Used for content-addressed mermaid cache keys.
// Not cryptographic. Fast, deterministic, low collision rate for our scale.
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd frontend && npm test -- hash.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/markdown/hash.ts frontend/src/components/markdown/__tests__/hash.test.ts
git commit -m "feat(markdown): add fnv1a hash util for cache keys"
```

---

## Task 3: Mermaid cache module

**Files:**
- Create: `frontend/src/components/markdown/cache.ts`
- Create: `frontend/src/components/markdown/__tests__/cache.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/components/markdown/__tests__/cache.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mermaidCache } from '../cache'

describe('mermaidCache', () => {
  beforeEach(() => mermaidCache.clear())

  it('starts empty', () => {
    expect(mermaidCache.size).toBe(0)
  })

  it('stores and retrieves svg by hash', () => {
    mermaidCache.set('abc', '<svg/>')
    expect(mermaidCache.get('abc')).toBe('<svg/>')
    expect(mermaidCache.has('abc')).toBe(true)
  })

  it('is the same Map across imports (module singleton)', async () => {
    mermaidCache.set('x', 'y')
    const reimported = (await import('../cache')).mermaidCache
    expect(reimported.get('x')).toBe('y')
  })
})
```

- [ ] **Step 2: Run test to verify failure**

```bash
cd frontend && npm test -- cache.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `cache.ts`**

```ts
// Module-level singleton for cross-message mermaid SVG dedup.
// Survives component unmounts; cleared only on full page reload.
export const mermaidCache = new Map<string, string>()
```

- [ ] **Step 4: Run test to verify passing**

```bash
cd frontend && npm test -- cache.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/markdown/cache.ts frontend/src/components/markdown/__tests__/cache.test.ts
git commit -m "feat(markdown): add module-level mermaid SVG cache"
```

---

## Task 4: Add `id` and `complete` to ChatMessage types

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx` (lines 8-19, message creation sites)

- [ ] **Step 1: Update the type definitions**

In `AcpChatView.tsx`, replace the message type block (lines 8-19) with:

```ts
// ── Message types ──

interface BaseMsg { id: string }
interface SystemMsg    extends BaseMsg { kind: 'system'; text: string }
interface UserMsg      extends BaseMsg { kind: 'user'; text: string }
interface AssistantMsg extends BaseMsg {
  kind: 'assistant'
  blocks: ContentBlock[]
  cost?: number
  complete: boolean
}
interface ErrorMsg     extends BaseMsg { kind: 'error'; text: string }

type ChatMessage = SystemMsg | UserMsg | AssistantMsg | ErrorMsg

const newId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
```

- [ ] **Step 2: Update message creation sites to include `id`**

In `handleEvent`'s `case 'system'`:
```ts
pushMessage({ id: newId(), kind: 'system', text: `${label}${sid}` })
```

In `case 'content_block'` where `currentAssistant.current` is created:
```ts
const msg: AssistantMsg = { id: newId(), kind: 'assistant', blocks: [], complete: false }
```

In `case 'error'`:
```ts
pushMessage({ id: newId(), kind: 'error', text: evt.message || 'Unknown error' })
```

In `case 'exit'`:
```ts
pushMessage({ id: newId(), kind: 'system', text: `Process exited (code: ${evt.code || 0})` })
```

In `sendPrompt`:
```ts
pushMessage({ id: newId(), kind: 'user', text })
```

- [ ] **Step 3: Build to verify no TS errors**

```bash
cd frontend && npx vite build
```

Expected: build succeeds. `dist/` populated.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "refactor(chat): add stable id + complete fields to messages"
```

---

## Task 5: React.memo on MessageBubble + key-by-id

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx`

- [ ] **Step 1: Wrap MessageBubble in React.memo**

At the bottom of `AcpChatView.tsx` (around line 233), rename current `MessageBubble` to `MessageBubbleImpl` and add a memoized export:

```tsx
function MessageBubbleImpl({ msg, agentName = 'Claude' }: { msg: ChatMessage; agentName?: string }) {
  switch (msg.kind) {
    // ... existing switch body unchanged ...
  }
}

const MessageBubble = React.memo(
  MessageBubbleImpl,
  (prev, next) => prev.msg === next.msg && prev.agentName === next.agentName
)
```

Add `import { memo } from 'react'` to top imports OR import `React` and use `React.memo`. zeromux already imports specific React hooks; add `memo` to that named import:

```ts
import { useState, useEffect, useRef, useCallback, memo, type KeyboardEvent } from 'react'
```

then use `memo(MessageBubbleImpl, ...)`.

- [ ] **Step 2: Change React key from index to msg.id**

Find the messages render (around line 187):

```tsx
{messages.map((msg, i) => (
  <MessageBubble key={i} msg={msg} agentName={...} />
))}
```

Replace with:

```tsx
{messages.map(msg => (
  <MessageBubble key={msg.id} msg={msg} agentName={agentType === 'kiro' ? 'Kiro' : 'Claude'} />
))}
```

- [ ] **Step 3: Build**

```bash
cd frontend && npx vite build
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "perf(chat): memoize MessageBubble keyed by stable id"
```

---

## Task 6: Immutable streaming state updates

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx` (`handleEvent` function)

- [ ] **Step 1: Replace mutation pattern with immutable map in `content_block`**

Current `case 'content_block'` mutates `currentAssistant.current.blocks` then calls `setMessages(prev => [...prev])`. Replace with:

```ts
case 'content_block': {
  const delta = evt.text || ''
  // Ensure there's an active assistant message
  if (!currentAssistant.current) {
    const msg: AssistantMsg = { id: newId(), kind: 'assistant', blocks: [], complete: false }
    currentAssistant.current = msg
    setMessages(prev => [...prev, msg])
  }
  const activeId = currentAssistant.current.id
  setMessages(prev => prev.map(m => {
    if (m.kind !== 'assistant' || m.id !== activeId) return m   // reference stable, memo skips
    const blocks = [...m.blocks]
    if (evt.streaming && evt.block_type === 'text' && blocks.length > 0
        && blocks[blocks.length - 1].type === 'text') {
      const last = blocks[blocks.length - 1]
      blocks[blocks.length - 1] = { ...last, text: (last.text || '') + delta }
    } else {
      blocks.push({
        type: (evt.block_type as ContentBlock['type']) || 'text',
        text: evt.text,
        name: evt.name,
        input: evt.input,
      })
    }
    // Mirror onto the ref so subsequent events still see the latest blocks.
    const next = { ...m, blocks }
    currentAssistant.current = next
    return next
  }))
  setBusy(true)
  scrollBottom()
  break
}
```

- [ ] **Step 2: Flip `complete=true` on stream-end events**

Replace the four termination cases:

```ts
case 'result': {
  const activeId = currentAssistant.current?.id
  if (activeId) {
    const cost = evt.cost_usd
    setMessages(prev => prev.map(m =>
      m.kind === 'assistant' && m.id === activeId
        ? { ...m, complete: true, ...(cost ? { cost } : {}) }
        : m
    ))
  }
  currentAssistant.current = null
  setBusy(false)
  break
}

case 'error': {
  const activeId = currentAssistant.current?.id
  if (activeId) {
    setMessages(prev => prev.map(m =>
      m.kind === 'assistant' && m.id === activeId ? { ...m, complete: true } : m
    ))
  }
  pushMessage({ id: newId(), kind: 'error', text: evt.message || 'Unknown error' })
  currentAssistant.current = null
  setBusy(false)
  break
}

case 'exit': {
  const activeId = currentAssistant.current?.id
  if (activeId) {
    setMessages(prev => prev.map(m =>
      m.kind === 'assistant' && m.id === activeId ? { ...m, complete: true } : m
    ))
  }
  pushMessage({ id: newId(), kind: 'system', text: `Process exited (code: ${evt.code || 0})` })
  currentAssistant.current = null
  setBusy(false)
  break
}

case 'replay_done': {
  const activeId = currentAssistant.current?.id
  if (activeId) {
    setMessages(prev => prev.map(m =>
      m.kind === 'assistant' && m.id === activeId ? { ...m, complete: true } : m
    ))
  }
  currentAssistant.current = null
  setBusy(false)
  break
}
```

- [ ] **Step 3: Remove the now-unused `updateAssistant` function**

The original `updateAssistant` (around lines 70-73) is no longer called. Delete it.

- [ ] **Step 4: Build to verify**

```bash
cd frontend && npx vite build
```

Expected: build succeeds, no warnings about unused vars.

- [ ] **Step 5: Build + restart zeromux to smoke test**

The vite dev proxy in `vite.config.ts` targets `localhost:8080`. On this server port 8080 is code-server, not zeromux (which runs on 8090). So **always use the production build path** for verification, not `npm run dev`:

```bash
cd frontend && npx vite build && cd ..
source $HOME/.cargo/env
cargo build --release
sudo install -m 0755 target/release/zeromux /usr/local/bin/zeromux
sudo systemctl restart zeromux
```

Open https://zeromux.keithyu.cloud, send a message in any session, verify chat still streams + renders.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "refactor(chat): immutable state updates + complete flag on stream end"
```

---

## Task 7: Fix WS onclose to flip active complete=true (E1)

**Files:**
- Modify: `frontend/src/components/AcpChatView.tsx` (the `useEffect` setting up the WebSocket)

- [ ] **Step 1: Update `ws.onclose` to mark active message complete**

In the WS setup `useEffect` (around line 86), replace:

```ts
ws.onclose = () => { wsRef.current = null }
```

with:

```ts
ws.onclose = () => {
  wsRef.current = null
  const activeId = currentAssistant.current?.id
  if (activeId) {
    setMessages(prev => prev.map(m =>
      m.kind === 'assistant' && m.id === activeId ? { ...m, complete: true } : m
    ))
  }
  currentAssistant.current = null
  setBusy(false)
}
```

- [ ] **Step 2: Build**

```bash
cd frontend && npx vite build
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/AcpChatView.tsx
git commit -m "fix(chat): mark active assistant message complete on ws disconnect"
```

---

## Task 8: MarkdownContext + MarkdownContent skeleton (1:1 replacement)

**Files:**
- Create: `frontend/src/components/markdown/context.ts`
- Create: `frontend/src/components/markdown/MarkdownContent.tsx`
- Modify: `frontend/src/components/AcpChatView.tsx` (replace local `Markdown` helper)
- Modify: `frontend/src/components/MarkdownViewer.tsx` (replace `ReactMarkdown` calls)

- [ ] **Step 1: Create `context.ts`**

```ts
import { createContext, useContext } from 'react'

export interface MarkdownContextValue {
  isComplete: boolean
}

export const MarkdownContext = createContext<MarkdownContextValue>({ isComplete: true })
export const useMarkdownContext = () => useContext(MarkdownContext)
```

- [ ] **Step 2: Create `MarkdownContent.tsx`**

```tsx
import { useDeferredValue } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from '../markdownStyles'
import { MarkdownContext } from './context'

interface Props {
  text: string
  isComplete: boolean
  className?: string
}

export default function MarkdownContent({ text, isComplete, className }: Props) {
  const deferredText = useDeferredValue(text)
  return (
    <MarkdownContext.Provider value={{ isComplete }}>
      <div className={className}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {deferredText}
        </ReactMarkdown>
      </div>
    </MarkdownContext.Provider>
  )
}
```

- [ ] **Step 3: Replace `Markdown` helper in AcpChatView**

In `AcpChatView.tsx` top imports, remove these three lines:

```ts
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownComponents } from './markdownStyles'
```

Add:

```ts
import MarkdownContent from './markdown/MarkdownContent'
```

Delete the local `Markdown` function (lines ~221-229):

```tsx
function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {children}
    </ReactMarkdown>
  )
}
```

Update `MessageBubble` (the assistant case, line ~250) to pass `isComplete` to `BlockView`:

```tsx
case 'assistant':
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold text-[var(--accent-purple)] mb-0.5">{agentName}</p>
      {msg.blocks.map((b, i) => <BlockView key={i} block={b} isComplete={msg.complete} />)}
      {msg.cost != null && (
        <p className="text-[10px] text-[var(--text-muted)] border-t border-[var(--border-light)] pt-1 mt-1">
          cost: ${msg.cost.toFixed(4)}
        </p>
      )}
    </div>
  )
```

Update `BlockView` (line ~269) to accept `isComplete` and use `MarkdownContent`:

```tsx
function BlockView({ block, isComplete }: { block: ContentBlock; isComplete: boolean }) {
  switch (block.type) {
    case 'text':
      return (
        <div className="text-sm text-[var(--text-primary)] leading-relaxed">
          <MarkdownContent text={block.text || ''} isComplete={isComplete} />
        </div>
      )

    case 'thinking':
      return (
        <details className="border-l-2 border-[var(--accent-purple-dim)] pl-2.5 text-xs text-[var(--accent-purple-text)]">
          <summary className="cursor-pointer text-[var(--accent-purple-dim)] font-medium flex items-center gap-1 select-none">
            <Brain size={12} />
            <span>thinking...</span>
            <ChevronDown size={12} />
          </summary>
          <div className="mt-1 leading-relaxed">
            <MarkdownContent text={block.text || ''} isComplete={isComplete} />
          </div>
        </details>
      )

    case 'tool_use': {
      // unchanged
      const inputStr = block.input ? JSON.stringify(block.input, null, 2) : null
      const truncated = inputStr && inputStr.length > 2000
        ? inputStr.substring(0, 2000) + '\n...(truncated)'
        : inputStr
      return (
        <div className="border-l-2 border-[var(--accent-yellow)] pl-2.5 py-1 text-xs">
          <div className="flex items-center gap-1 text-[var(--accent-yellow)] font-medium">
            <Wrench size={12} />
            <span>{block.name || 'tool'}</span>
          </div>
          {truncated && truncated !== '{}' && truncated !== 'null' && (
            <pre className="mt-1 text-[11px] text-[var(--text-secondary)] whitespace-pre-wrap break-words bg-[var(--bg-secondary)] rounded p-2 border border-[var(--border)] overflow-x-auto">
              {truncated}
            </pre>
          )}
        </div>
      )
    }

    default:
      return null
  }
}
```

(Note: `system`, `user`, and `error` message kinds don't go through `BlockView` — they render plain text directly via `MessageBubble`'s switch and don't need `MarkdownContent`. The current code uses plain `<p>` for them; leave that alone.)

- [ ] **Step 4: Replace ReactMarkdown in MarkdownViewer**

In `MarkdownViewer.tsx`, top imports — remove these two lines:

```ts
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
```

Add:

```ts
import MarkdownContent from './markdown/MarkdownContent'
```

The existing `markdownComponents` import on line 4 stays (MarkdownContent uses it internally).

Find this block at line 495:

```tsx
<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
  {content}
</ReactMarkdown>
```

Replace with:

```tsx
<MarkdownContent text={content} isComplete={true} />
```

(The state variable is `content`, declared at line 34: `const [content, setContent] = useState<string>('')`.)

- [ ] **Step 5: Production build + restart zeromux for smoke test**

```bash
cd frontend && npx vite build && cd ..
source $HOME/.cargo/env
cargo build --release
sudo install -m 0755 target/release/zeromux /usr/local/bin/zeromux
sudo systemctl restart zeromux
```

Open https://zeromux.keithyu.cloud, click any session, send "Hello world". Verify:
- Chat still renders messages
- Notes file viewer still renders markdown

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/markdown/ frontend/src/components/AcpChatView.tsx frontend/src/components/MarkdownViewer.tsx
git commit -m "feat(markdown): introduce shared MarkdownContent component"
```

---

## Task 9: CodeBlock with mermaid placeholder

**Files:**
- Create: `frontend/src/components/markdown/CodeBlock.tsx`
- Modify: `frontend/src/components/markdown/MarkdownContent.tsx` (use CodeBlock)
- Create: `frontend/src/components/markdown/__tests__/MarkdownContent.test.tsx`

- [ ] **Step 1: Create `CodeBlock.tsx`**

```tsx
import { useMarkdownContext } from './context'

type CodeProps = {
  className?: string
  children?: React.ReactNode
} & React.HTMLAttributes<HTMLElement>

export default function CodeBlock({ className, children, ...props }: CodeProps) {
  const { isComplete } = useMarkdownContext()
  const isBlock = className?.startsWith('language-') ?? false
  const lang = className?.replace('language-', '') ?? ''

  if (!isBlock) {
    return (
      <code className="px-1 py-0.5 bg-[var(--code-bg)] border border-[var(--border)] rounded text-[12px] text-[var(--text-bright)] font-mono" {...props}>
        {children}
      </code>
    )
  }

  if (lang === 'mermaid') {
    const raw = String(children).replace(/\n$/, '')
    if (!isComplete) {
      return (
        <pre className="mermaid-pending bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md p-3 my-2 overflow-x-auto text-[12px] text-[var(--text-secondary)] opacity-60 font-mono">
          {raw}
        </pre>
      )
    }
    // MermaidBlock added in Task 12; for now show raw with a "rendered when implemented" marker
    return (
      <pre className="mermaid-pending bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md p-3 my-2 overflow-x-auto text-[12px] text-[var(--text-secondary)] font-mono">
        {raw}
      </pre>
    )
  }

  // Generic block code (will be picked up by hljs via rehype-highlight in Task 10)
  return (
    <code className={`text-[12px] ${className ?? ''}`} {...props}>
      {children}
    </code>
  )
}
```

- [ ] **Step 2: Wire CodeBlock into MarkdownContent**

In `MarkdownContent.tsx`, modify the `components` prop:

```tsx
import CodeBlock from './CodeBlock'

// inside the component:
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  components={{ ...markdownComponents, code: CodeBlock }}
>
  {deferredText}
</ReactMarkdown>
```

- [ ] **Step 3: Write tests (cases 3, 7 from spec §7)**

Create `src/components/markdown/__tests__/MarkdownContent.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import MarkdownContent from '../MarkdownContent'

describe('MarkdownContent — codeblock dispatch', () => {
  it('renders empty string without crashing', () => {
    const { container } = render(<MarkdownContent text="" isComplete />)
    expect(container).toBeInTheDocument()
  })

  it('renders mermaid block as pending pre when isComplete=false', () => {
    const text = '```mermaid\ngraph TD; A-->B\n```'
    const { container } = render(<MarkdownContent text={text} isComplete={false} />)
    const pending = container.querySelector('pre.mermaid-pending')
    expect(pending).toBeInTheDocument()
    expect(pending?.textContent).toContain('graph TD; A-->B')
  })

  it('renders mermaid block as pending pre when isComplete=true (until Task 12)', () => {
    const text = '```mermaid\ngraph TD; A-->B\n```'
    const { container } = render(<MarkdownContent text={text} isComplete={true} />)
    expect(container.querySelector('pre.mermaid-pending')).toBeInTheDocument()
  })

  it('renders inline code with highlight border', () => {
    const text = 'use `npm test` to run tests'
    render(<MarkdownContent text={text} isComplete />)
    const code = screen.getByText('npm test')
    expect(code.tagName).toBe('CODE')
  })
})
```

- [ ] **Step 4: Run tests**

```bash
cd frontend && npm test -- MarkdownContent.test.tsx
```

Expected: 4 tests pass.

- [ ] **Step 5: Build to confirm prod build still works**

```bash
cd frontend && npx vite build
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/markdown/CodeBlock.tsx frontend/src/components/markdown/MarkdownContent.tsx frontend/src/components/markdown/__tests__/MarkdownContent.test.tsx
git commit -m "feat(markdown): add CodeBlock with mermaid placeholder routing"
```

---

## Task 10: highlight.js integration (eager)

**Files:**
- Modify: `frontend/package.json` (deps)
- Modify: `frontend/src/components/markdown/MarkdownContent.tsx` (add rehype-highlight + theme)
- Modify: `frontend/src/components/markdown/__tests__/MarkdownContent.test.tsx` (cases 5)

- [ ] **Step 1: Install deps**

```bash
cd frontend
npm install rehype-highlight@^7 highlight.js@^11
```

- [ ] **Step 2: Add rehype-highlight + theme to MarkdownContent**

Edit `MarkdownContent.tsx`:

```tsx
import { useDeferredValue } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import { markdownComponents } from '../markdownStyles'
import { MarkdownContext } from './context'
import CodeBlock from './CodeBlock'

const HLJS_LANGS = [
  'bash', 'json', 'yaml',
  'typescript', 'javascript', 'tsx',
  'rust', 'python', 'go', 'java', 'sql', 'dockerfile',
]

interface Props {
  text: string
  isComplete: boolean
  className?: string
}

export default function MarkdownContent({ text, isComplete, className }: Props) {
  const deferredText = useDeferredValue(text)
  return (
    <MarkdownContext.Provider value={{ isComplete }}>
      <div className={className}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[
            [rehypeHighlight, {
              subset: HLJS_LANGS,
              detect: true,
              ignoreMissing: true,
            }],
          ]}
          components={{ ...markdownComponents, code: CodeBlock }}
        >
          {deferredText}
        </ReactMarkdown>
      </div>
    </MarkdownContext.Provider>
  )
}
```

- [ ] **Step 3: Add hljs test case**

Append to `MarkdownContent.test.tsx`:

```tsx
describe('MarkdownContent — code highlighting', () => {
  it('applies hljs class to fenced rust code block', () => {
    const text = '```rust\nfn main() { println!("hi"); }\n```'
    const { container } = render(<MarkdownContent text={text} isComplete />)
    const code = container.querySelector('code.language-rust')
    expect(code).toBeInTheDocument()
    // rehype-highlight wraps tokens in spans
    expect(code?.querySelector('span.hljs-keyword')).toBeInTheDocument()
  })

  it('leaves non-subset language untouched (no hljs spans)', () => {
    const text = '```mermaid\ngraph TD; A-->B\n```'
    const { container } = render(<MarkdownContent text={text} isComplete={false} />)
    const pending = container.querySelector('pre.mermaid-pending')
    expect(pending?.querySelector('span.hljs-keyword')).toBeNull()
  })
})
```

- [ ] **Step 4: Run tests**

```bash
cd frontend && npm test
```

Expected: all tests pass (existing + 2 new).

- [ ] **Step 5: Production build + rebuild binary + visually verify**

```bash
cd frontend && npx vite build && cd ..
source $HOME/.cargo/env
cargo build --release
sudo install -m 0755 target/release/zeromux /usr/local/bin/zeromux
sudo systemctl restart zeromux
```

Visit https://zeromux.keithyu.cloud, send a message containing ` ```rust\nfn main() {}\n``` ` to a Claude session. Verify keywords colored.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/components/markdown/MarkdownContent.tsx frontend/src/components/markdown/__tests__/MarkdownContent.test.tsx
git commit -m "feat(markdown): syntax-highlight code blocks via rehype-highlight"
```

---

## Task 11: KaTeX two-stage lazy loading

**Files:**
- Modify: `frontend/package.json` (deps)
- Create: `frontend/src/components/markdown/katexBundle.ts`
- Modify: `frontend/src/components/markdown/MarkdownContent.tsx` (lazy plugin chain)
- Modify: `frontend/src/components/markdown/__tests__/MarkdownContent.test.tsx` (cases 1, 2, 6)

- [ ] **Step 1: Install deps**

```bash
cd frontend
npm install katex@^0.16 rehype-katex@^7 remark-math@^6
```

- [ ] **Step 2: Create `katexBundle.ts`**

```ts
// Lazy-loaded chunk: triggered when MarkdownContent detects "$" in text.
// Importing katex.css here makes Vite bundle the CSS into this same chunk,
// so it ships only when the chunk is fetched.
import 'katex/dist/katex.min.css'
import rehypeKatex from 'rehype-katex'

export { rehypeKatex }
```

- [ ] **Step 3: Wire two-stage loading into MarkdownContent**

Replace the body of `MarkdownContent.tsx` with:

```tsx
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import { markdownComponents } from '../markdownStyles'
import { MarkdownContext } from './context'
import CodeBlock from './CodeBlock'

const HLJS_LANGS = [
  'bash', 'json', 'yaml',
  'typescript', 'javascript', 'tsx',
  'rust', 'python', 'go', 'java', 'sql', 'dockerfile',
]

// Detect $... or $$... — matches both inline and block math syntax.
// False positives (e.g. "$5") only cost us an unnecessary chunk load; harmless.
function hasMathSyntax(text: string): boolean {
  return /\$/.test(text)
}

interface Props {
  text: string
  isComplete: boolean
  className?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RehypePlugin = any

export default function MarkdownContent({ text, isComplete, className }: Props) {
  const deferredText = useDeferredValue(text)
  const needsKatex = useMemo(() => hasMathSyntax(deferredText), [deferredText])
  const [katexPlugin, setKatexPlugin] = useState<RehypePlugin | null>(null)

  useEffect(() => {
    if (!needsKatex || katexPlugin) return
    let cancelled = false
    import('./katexBundle').then(m => {
      if (!cancelled) setKatexPlugin(() => m.rehypeKatex)
    }).catch(() => { /* network glitch — math stays raw, no crash */ })
    return () => { cancelled = true }
  }, [needsKatex, katexPlugin])

  const rehypePlugins: RehypePlugin[] = [
    [rehypeHighlight, { subset: HLJS_LANGS, detect: true, ignoreMissing: true }],
    ...(katexPlugin ? [[katexPlugin, { strict: 'ignore' }]] : []),
  ]

  return (
    <MarkdownContext.Provider value={{ isComplete }}>
      <div className={className}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={rehypePlugins}
          components={{ ...markdownComponents, code: CodeBlock }}
        >
          {deferredText}
        </ReactMarkdown>
      </div>
    </MarkdownContext.Provider>
  )
}
```

- [ ] **Step 4: Add KaTeX test cases (note: dynamic import means async)**

Append to `MarkdownContent.test.tsx`:

```tsx
import { waitFor } from '@testing-library/react'

describe('MarkdownContent — KaTeX lazy', () => {
  it('renders inline math after lazy load', async () => {
    const { container } = render(<MarkdownContent text="$E=mc^2$" isComplete />)
    await waitFor(() => {
      expect(container.querySelector('.katex')).toBeInTheDocument()
    }, { timeout: 3000 })
  })

  it('renders display math after lazy load', async () => {
    const { container } = render(<MarkdownContent text="$$\\sum x_i$$" isComplete />)
    await waitFor(() => {
      expect(container.querySelector('.katex-display')).toBeInTheDocument()
    }, { timeout: 3000 })
  })

  it('does not crash on invalid latex (strict ignore)', async () => {
    const text = '$\\frac{$'
    const { container } = render(<MarkdownContent text={text} isComplete />)
    // Should not throw; KaTeX renders error inline in red. Wait for plugin.
    await waitFor(() => {
      expect(container.textContent).toContain('\\frac')
    }, { timeout: 3000 })
  })

  it('skips katex chunk when text has no $', () => {
    const { container } = render(<MarkdownContent text="just plain text" isComplete />)
    // Should render synchronously without loading katex (cannot directly assert
    // chunk fetch without mocking import; test that DOM doesn't have .katex)
    expect(container.querySelector('.katex')).toBeNull()
  })
})
```

- [ ] **Step 5: Run tests**

```bash
cd frontend && npm test
```

Expected: all tests pass (test runtime increases by ~2s for the async cases).

- [ ] **Step 6: Build + verify chunk split**

```bash
cd frontend && npx vite build
ls -lh dist/assets/ | grep -E 'katex|main'
```

Expected: separate `katex-[hash].js` chunk visible (~250-350K minified).

- [ ] **Step 7: Rebuild binary + visual verify**

```bash
source $HOME/.cargo/env
cargo build --release
sudo install -m 0755 target/release/zeromux /usr/local/bin/zeromux
sudo systemctl restart zeromux
```

Visit zeromux. Open DevTools Network tab. Send a Claude message with `$E = mc^2$`. Confirm:
- katex chunk loads on first $
- Formula renders styled

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/components/markdown/katexBundle.ts frontend/src/components/markdown/MarkdownContent.tsx frontend/src/components/markdown/__tests__/MarkdownContent.test.tsx
git commit -m "feat(markdown): lazy-load KaTeX for math rendering"
```

---

## Task 12: MermaidBlock with state slot, cache, lazy

**Files:**
- Modify: `frontend/package.json` (mermaid dep)
- Modify: `frontend/vite.config.ts` (manualChunks)
- Create: `frontend/src/components/markdown/MermaidBlock.tsx`
- Modify: `frontend/src/components/markdown/CodeBlock.tsx` (use MermaidBlock when complete)
- Create: `frontend/src/components/markdown/__tests__/MermaidBlock.test.tsx`

- [ ] **Step 1: Install dep**

```bash
cd frontend
npm install mermaid@^11
```

- [ ] **Step 2: Update `vite.config.ts` for manualChunks + raised warning limit**

Replace `vite.config.ts` with:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: {
          mermaid: ['mermaid'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
})
```

- [ ] **Step 3: Create `MermaidBlock.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { mermaidCache } from './cache'
import { fnv1a } from './hash'

interface Props { code: string }

type State =
  | { kind: 'pending' }
  | { kind: 'svg'; svg: string }
  | { kind: 'error'; msg: string }

export default function MermaidBlock({ code }: Props) {
  const cached = mermaidCache.get(code)
  const [state, setState] = useState<State>(
    cached ? { kind: 'svg', svg: cached } : { kind: 'pending' }
  )

  useEffect(() => {
    if (state.kind === 'svg') return
    let cancel = false
    ;(async () => {
      try {
        const m = (await import('mermaid')).default
        m.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
        await m.parse(code)
        const id = `mid-${fnv1a(code)}`
        const { svg } = await m.render(id, code)
        if (cancel) return
        mermaidCache.set(code, svg)
        setState({ kind: 'svg', svg })
      } catch (e) {
        if (cancel) return
        setState({ kind: 'error', msg: String(e).slice(0, 200) })
      }
    })()
    return () => { cancel = true }
  }, [code, state.kind])

  if (state.kind === 'svg') {
    return (
      <div
        className="mermaid-rendered bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md p-3 my-2 overflow-x-auto text-center"
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="mermaid-err bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md p-3 my-2">
        <pre className="text-[12px] text-[var(--text-secondary)] font-mono overflow-x-auto">{code}</pre>
        <p className="text-[var(--accent-red)] text-xs mt-1">Mermaid: {state.msg}</p>
      </div>
    )
  }
  return (
    <pre className="mermaid-pending bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md p-3 my-2 overflow-x-auto text-[12px] text-[var(--text-secondary)] opacity-60 font-mono">
      {code}
    </pre>
  )
}
```

- [ ] **Step 4: Update CodeBlock to use MermaidBlock when complete**

In `CodeBlock.tsx`, replace the placeholder branch:

```tsx
import MermaidBlock from './MermaidBlock'

// inside CodeBlock, replace the second mermaid branch:
if (lang === 'mermaid') {
  const raw = String(children).replace(/\n$/, '')
  if (!isComplete) {
    return (
      <pre className="mermaid-pending bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md p-3 my-2 overflow-x-auto text-[12px] text-[var(--text-secondary)] opacity-60 font-mono">
        {raw}
      </pre>
    )
  }
  return <MermaidBlock code={raw} />
}
```

- [ ] **Step 5: Write MermaidBlock tests with mocked mermaid module**

Create `__tests__/MermaidBlock.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { mermaidCache } from '../cache'

const renderMock = vi.fn()
const parseMock = vi.fn()
const initMock = vi.fn()

vi.mock('mermaid', () => ({
  default: {
    initialize: initMock,
    parse: parseMock,
    render: renderMock,
  },
}))

beforeEach(() => {
  mermaidCache.clear()
  renderMock.mockReset()
  parseMock.mockReset()
  initMock.mockReset()
})

describe('MermaidBlock', () => {
  it('imports mermaid, renders, and caches SVG on cache miss', async () => {
    parseMock.mockResolvedValue(true)
    renderMock.mockResolvedValue({ svg: '<svg id="ok"/>' })
    const { default: MermaidBlock } = await import('../MermaidBlock')
    const code = 'graph TD; A-->B'

    const { container } = render(<MermaidBlock code={code} />)
    await waitFor(() => {
      expect(container.querySelector('.mermaid-rendered')).toBeInTheDocument()
    })
    expect(parseMock).toHaveBeenCalledWith(code)
    expect(renderMock).toHaveBeenCalled()
    expect(mermaidCache.get(code)).toBe('<svg id="ok"/>')
  })

  it('skips render when cache already has the svg', async () => {
    mermaidCache.set('cached-code', '<svg id="cached"/>')
    const { default: MermaidBlock } = await import('../MermaidBlock')

    const { container } = render(<MermaidBlock code="cached-code" />)
    expect(container.querySelector('.mermaid-rendered')).toBeInTheDocument()
    expect(renderMock).not.toHaveBeenCalled()
    expect(parseMock).not.toHaveBeenCalled()
  })

  it('renders raw + error message when parse throws', async () => {
    parseMock.mockRejectedValue(new Error('Syntax error in line 1'))
    const { default: MermaidBlock } = await import('../MermaidBlock')

    const { container } = render(<MermaidBlock code="this is not mermaid" />)
    await waitFor(() => {
      expect(container.querySelector('.mermaid-err')).toBeInTheDocument()
    })
    expect(container.textContent).toContain('this is not mermaid')
    expect(container.textContent).toContain('Syntax error')
  })
})
```

- [ ] **Step 6: Run all tests**

```bash
cd frontend && npm test
```

Expected: all tests pass.

- [ ] **Step 7: Build + verify chunk split**

```bash
cd frontend && npx vite build
ls -lh dist/assets/ | grep -E 'mermaid|katex|main'
```

Expected: separate `mermaid-[hash].js` chunk (~600-800K minified, ~200K gz). Individual file sizes printed.

If `mermaid` chunk is missing or merged into main, **stop and debug** — the manualChunks config is wrong.

- [ ] **Step 8: Rebuild binary + visual verify**

```bash
source $HOME/.cargo/env
cargo build --release
sudo install -m 0755 target/release/zeromux /usr/local/bin/zeromux
sudo systemctl restart zeromux
```

In a Claude session send:
```
请画一个简单的流程图：
\`\`\`mermaid
graph TD
  A[开始] --> B{条件?}
  B -->|Yes| C[做事]
  B -->|No| D[跳过]
\`\`\`
```

Verify SVG renders after message completes.

Send the same message again — DevTools Network should NOT show another mermaid chunk fetch (cache hit + chunk already cached by browser).

- [ ] **Step 9: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/src/components/markdown/MermaidBlock.tsx frontend/src/components/markdown/CodeBlock.tsx frontend/src/components/markdown/__tests__/MermaidBlock.test.tsx
git commit -m "feat(markdown): lazy mermaid rendering with module-level SVG cache"
```

---

## Task 13: Manual acceptance + perf verification + rebuild binary

**Files:**
- Modify: `docs/specs/2026-05-17-md-rendering-design.md` (mark checklist items as ✅ or ❌ with notes)

- [ ] **Step 1: Final production build**

```bash
cd frontend && npx vite build && cd ..
ls -lh frontend/dist/assets/
```

Note total sizes for the design doc.

- [ ] **Step 2: Rebuild zeromux binary (frontend embedded via rust-embed)**

```bash
source $HOME/.cargo/env
cargo build --release
sudo install -m 0755 target/release/zeromux /usr/local/bin/zeromux
sudo systemctl restart zeromux
```

Note new binary size: `ls -lh /usr/local/bin/zeromux`. Spec target: ≤ 7MB.

- [ ] **Step 3: Run the 12-item manual acceptance checklist**

Open https://zeromux.keithyu.cloud, log in. Run each:

1. ☐ Send `$E = mc^2$` → inline KaTeX renders
2. ☐ Send `$$\sum_{i=1}^n x_i$$` → block KaTeX centered
3. ☐ Send a long message ending with ` ```mermaid\ngraph TD; A-->B; B-->C\n``` ` → mermaid pending during stream, SVG within 200ms after stream end
4. ☐ Send the same mermaid block again → instant render, no new chunk request in Network
5. ☐ Send ` ```mermaid\nfoo bar nope\n``` ` → raw + red error message
6. ☐ Send ` ```rust\nfn main() {}\n``` ` → keywords colored
7. ☐ Send a long streaming message that has mermaid mid-text → mermaid stays raw until result, text streams normally
8. ☐ Hard refresh, send a message with no mermaid → DevTools Network shows no mermaid chunk
9. ☐ Same fresh page, send first message containing mermaid → mermaid chunk loads
10. ☐ Open Notes file viewer on a `.md` file containing math + mermaid + code → all render
11. ☐ While a message is streaming, run `sudo systemctl restart zeromux` to force ws disconnect → after disconnect, the partial message renders math/mermaid as if completed
12. ☐ Reload, attach to existing session → scrollback replays, all historical messages fully rendered

- [ ] **Step 4: Optional perf verification**

Open DevTools → Performance. Record while sending a Claude message containing 5KB of text + one mermaid block. Check:
- Long tasks during stream stay <50ms
- Mermaid render appears once (the result frame)
- React Profiler "why did this render" doesn't list historical messages

- [ ] **Step 5: Mark checklist results in spec**

Edit `docs/specs/2026-05-17-md-rendering-design.md`. In the §7 manual checklist, replace each `□` with `✅` (pass) or `❌ <reason>` (fail). Add a "Verified 2026-05-XX" line near the top of the spec.

- [ ] **Step 6: Commit**

```bash
git add docs/specs/2026-05-17-md-rendering-design.md
git commit -m "docs: record MD rendering manual acceptance results"
```

If any checklist item failed, **do not commit the success marker**. File a follow-up task with reproduction steps and fix before claiming done.

---

## Self-Review Checklist (run before declaring plan ready)

- ✅ Vitest infra in Task 1 enables tests in Tasks 2, 3, 9, 10, 11, 12
- ✅ hash + cache (Tasks 2, 3) used by MermaidBlock (Task 12)
- ✅ Message id + complete (Task 4) used by memo (Task 5) and onclose fix (Task 7)
- ✅ Immutable state (Task 6) is the prerequisite for memo to actually skip historical messages
- ✅ MarkdownContext (Task 8) consumed by CodeBlock (Task 9) to read isComplete
- ✅ CodeBlock (Task 9) routes mermaid to MermaidBlock (Task 12) and other langs to hljs (Task 10)
- ✅ KaTeX two-stage (Task 11) detects via $ in deferred text — works whether isComplete is true or false; partial `$x = ` is fine since rehype-katex won't transform incomplete math nodes
- ✅ All 12 spec checklist items map to Step 3 in Task 13
- ✅ rust-embed binary rebuild present in Task 13

## Common pitfalls (worth re-reading before each task)

1. **Don't `cd ../..` between commands within a task** — the harness keeps cwd. State cwd at the start of each task block instead.
2. **Mock `mermaid` BEFORE importing MermaidBlock** in tests, or the real (huge) module loads.
3. **`String(children)`** on a code block only works when rehype-highlight didn't transform it. mermaid is excluded from `subset` precisely so children stay as a string.
4. **`useDeferredValue` does not bypass React.memo** — if `text` prop is unchanged, memo skips re-render anyway. The two play together correctly.
5. **Cache keying by raw `code`**, not `fnv1a(code)`, in `mermaidCache` — the hash is only used as DOM id seed for mermaid.render. Map keys are the full string (cheap).
6. After modifying any frontend source, you MUST `cargo build --release` + `sudo systemctl restart zeromux` to see changes in production. Dev server (`npm run dev`) is faster for iteration but proxy to localhost:8080 (the embedded binary) — see vite.config.ts.
