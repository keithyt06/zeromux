# Vault Inline HTML Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render inline HTML (tables, styled spans, `<br>`, `<details>`) in Obsidian vault notes as rendered output instead of raw source, safely (allowlist-sanitized), and legibly in the dark app (light reading surface).

**Architecture:** react-markdown@10 drops raw HTML by default (renders it as text). Enable `rehype-raw` → `rehype-sanitize` (allowlist from `defaultSchema`) → `rehype-highlight` → `rehype-katex`, gated behind an explicit `enableRawHtml` prop set only by `VaultReader`. Chat/other markdown paths are untouched. A light reading surface on the read-mode container fixes the ~365 light-`background`-no-`color` cells that would otherwise be invisible on the dark theme.

**Tech Stack:** React 19, react-markdown 10, rehype-raw, rehype-sanitize (unified v11), Tailwind v4, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-03-vault-inline-html-design.md`.
- Enable raw HTML ONLY via explicit `enableRawHtml` prop (never infer from `onWikiLink`/`resolveSrc`). Chat + FileBrowser/MarkdownViewer paths must render exactly as today (no raw HTML).
- Plugin order is fixed: `rehype-raw` → `rehype-sanitize` → `rehype-highlight` → `rehype-katex`.
- Sanitize schema MUST allow `code` className `math-inline`/`math-display` (else `$math$` regresses) and keep `/^language-./` (mermaid/highlight rely on it).
- `style` attribute is allowed; its safety rests on the global CSP `img-src 'self' data:` (`src/web.rs:212`) — record this coupling in a code comment + test.
- `className` is allowed per-element (code/span), NOT globally.
- `data:` protocol allowed for `img` (CSP already permits `img-src data:`).
- Frontend tests: vitest. Must keep `tsc -b` + eslint clean.

---

### Task 1: Install deps + build the sanitize schema module

**Files:**
- Modify: `frontend/package.json` (deps)
- Create: `frontend/src/components/markdown/sanitizeSchema.ts`
- Test: `frontend/src/components/markdown/__tests__/sanitizeSchema.test.ts`

**Interfaces:**
- Produces: `export const vaultSanitizeSchema` — a hast-util-sanitize schema object extending `defaultSchema` per the spec.

- [ ] **Step 1: Install dependencies**

Run: `cd frontend && npm install rehype-raw rehype-sanitize`
Expected: both added to `dependencies`; `npm ls rehype-raw rehype-sanitize` resolves within the unified v11 tree.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/components/markdown/__tests__/sanitizeSchema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { vaultSanitizeSchema } from '../sanitizeSchema'

describe('vaultSanitizeSchema', () => {
  it('allows math marker classes on code (else $math$ regresses)', () => {
    const codeAttrs = vaultSanitizeSchema.attributes!.code as unknown[]
    const cls = codeAttrs.find((a) => Array.isArray(a) && a[0] === 'className') as unknown[]
    expect(cls).toContain('math-inline')
    expect(cls).toContain('math-display')
    // language-* must still be allowed (mermaid/highlight)
    expect(cls.some((v) => v instanceof RegExp && (v as RegExp).test('language-rust'))).toBe(true)
  })
  it('allows style + table structural attrs', () => {
    const star = vaultSanitizeSchema.attributes!['*'] as unknown[]
    expect(star).toContain('style')
    const td = vaultSanitizeSchema.attributes!.td as unknown[]
    expect(td).toContain('colSpan')
  })
  it('allows table/details/span/img tags', () => {
    const tags = vaultSanitizeSchema.tagNames!
    for (const t of ['table','thead','tbody','tr','th','td','details','summary','span','div','br','img','sub','sup','kbd','mark']) {
      expect(tags).toContain(t)
    }
  })
  it('does NOT allow script/iframe', () => {
    expect(vaultSanitizeSchema.tagNames).not.toContain('script')
    expect(vaultSanitizeSchema.tagNames).not.toContain('iframe')
  })
  it('allows data: protocol for img src', () => {
    expect(vaultSanitizeSchema.protocols!.src).toContain('data')
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd frontend && npx vitest run src/components/markdown/__tests__/sanitizeSchema.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement the schema**

Create `frontend/src/components/markdown/sanitizeSchema.ts`:

```ts
import { defaultSchema } from 'rehype-sanitize'
import type { Schema } from 'rehype-sanitize'

// Allowlist for vault (Obsidian) note HTML. Extends the safe defaultSchema.
// SECURITY: `style` is allowed for the note's own layout (tables/spans). Its
// safety rests on the global CSP `img-src 'self' data:` (src/web.rs:212), which
// blocks the url()/image-set() CSS exfiltration channel. If that CSP is ever
// loosened, revisit this (or strip url() from style values). See spec §改动5.
export const vaultSanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames || []),
    'div', 'span', 'br', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'details', 'summary',
    'sub', 'sup', 'kbd', 'mark', 'u', 's', 'ins',
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Per-element className: math markers (katex input) + language-* (mermaid/highlight).
    code: [
      ...((defaultSchema.attributes && defaultSchema.attributes.code) || []),
      ['className', /^language-./, 'math-inline', 'math-display'],
    ],
    span: [
      ...((defaultSchema.attributes && defaultSchema.attributes.span) || []),
      'style',
    ],
    td: [...((defaultSchema.attributes && defaultSchema.attributes.td) || []), 'colSpan', 'rowSpan', 'align', 'style'],
    th: [...((defaultSchema.attributes && defaultSchema.attributes.th) || []), 'colSpan', 'rowSpan', 'align', 'style'],
    // Global attrs allowed on any element (NOT className — that stays per-element).
    '*': [
      ...((defaultSchema.attributes && defaultSchema.attributes['*']) || []),
      'style', 'title', 'align',
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: [...((defaultSchema.protocols && defaultSchema.protocols.src) || []), 'data'],
  },
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/markdown/__tests__/sanitizeSchema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/components/markdown/sanitizeSchema.ts frontend/src/components/markdown/__tests__/sanitizeSchema.test.ts
git commit -m "feat(vault): rehype-raw/rehype-sanitize deps + vault allowlist schema"
```

---

### Task 2: Wire raw+sanitize into MarkdownContent behind enableRawHtml prop

**Files:**
- Modify: `frontend/src/components/markdown/MarkdownContent.tsx`
- Test: `frontend/src/components/markdown/__tests__/MarkdownContent.vault.test.tsx`

**Interfaces:**
- Consumes: `vaultSanitizeSchema` (Task 1).
- Produces: `MarkdownContent` accepts `enableRawHtml?: boolean`. When true, rehype plugin chain becomes `[rehype-raw, [rehype-sanitize, vaultSanitizeSchema], rehype-highlight, ...katex]`. When false/absent, chain is exactly as today.

- [ ] **Step 1: Write failing tests**

Add to `MarkdownContent.vault.test.tsx`:

```ts
it('renders inline HTML table when enableRawHtml (not raw source)', () => {
  render(<MarkdownContent text={'<table><tr><td>Cell</td></tr></table>'} isComplete enableRawHtml />)
  expect(document.querySelector('table td')?.textContent).toBe('Cell')
})
it('strips <script> under enableRawHtml', () => {
  render(<MarkdownContent text={'<div>ok</div><script>window.__x=1</script>'} isComplete enableRawHtml />)
  expect(document.querySelector('script')).toBeNull()
  expect(document.body.textContent).toContain('ok')
})
it('without enableRawHtml, inline HTML stays as text (chat path unchanged)', () => {
  render(<MarkdownContent text={'<table><tr><td>Cell</td></tr></table>'} isComplete />)
  expect(document.querySelector('table')).toBeNull()
})
it('preserves table inline style under enableRawHtml', () => {
  render(<MarkdownContent text={'<table><tr><td style="background:#fff">x</td></tr></table>'} isComplete enableRawHtml />)
  const td = document.querySelector('td') as HTMLElement
  expect(td.getAttribute('style')).toContain('background')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/components/markdown/__tests__/MarkdownContent.vault.test.tsx`
Expected: FAIL (`enableRawHtml` unknown; table rendered as text).

- [ ] **Step 3: Implement**

In `MarkdownContent.tsx`:
- Add imports:
  ```ts
  import rehypeRaw from 'rehype-raw'
  import rehypeSanitize from 'rehype-sanitize'
  import { vaultSanitizeSchema } from './sanitizeSchema'
  ```
- Add `enableRawHtml?: boolean` to `Props` and destructure it.
- Build `rehypePlugins` with raw+sanitize FIRST when enabled (order is load-bearing):
  ```ts
  const rehypePlugins: RehypePlugin[] = [
    ...(enableRawHtml ? [rehypeRaw, [rehypeSanitize, vaultSanitizeSchema]] : []),
    [rehypeHighlight, { subset: HLJS_LANGS, detect: true, languages: { ...common, dockerfile } }],
    ...(katexPlugin ? [[katexPlugin, { strict: 'ignore' }]] : []),
  ]
  ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/markdown/__tests__/MarkdownContent.vault.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/markdown/MarkdownContent.tsx frontend/src/components/markdown/__tests__/MarkdownContent.vault.test.tsx
git commit -m "feat(vault): render+sanitize inline HTML behind explicit enableRawHtml prop"
```

---

### Task 3: Guard math/mermaid/highlight coexistence (regression pins)

**Files:**
- Test: `frontend/src/components/markdown/__tests__/MarkdownContent.vault.test.tsx`

**Interfaces:**
- Consumes: Task 2 wiring.
- Produces: pinning tests proving `$math$`, mermaid, and highlight survive sanitize under `enableRawHtml`.

- [ ] **Step 1: Write pinning tests**

Add:

```ts
it('keeps math marker class so katex can process $x$ under enableRawHtml', () => {
  render(<MarkdownContent text={'inline $a+b$ math'} isComplete enableRawHtml />)
  // remark-math emits <code class="math-inline">; sanitize must not strip the class.
  const el = document.querySelector('code.math-inline, .katex')
  expect(el).not.toBeNull()
})
it('keeps language-* so mermaid/highlight class survives sanitize', () => {
  render(<MarkdownContent text={'```rust\nfn main(){}\n```'} isComplete enableRawHtml />)
  expect(document.querySelector('code.language-rust, code.hljs')).not.toBeNull()
})
```

Note: if the environment lacks the async katex bundle, assert on `code.math-inline` (the marker) which is the true regression surface; the marker's survival is what Task 1's schema guarantees.

- [ ] **Step 2: Run to verify (should PASS if Task 1+2 correct)**

Run: `cd frontend && npx vitest run src/components/markdown/__tests__/MarkdownContent.vault.test.tsx`
Expected: PASS. If FAIL on `math-inline`, the schema in Task 1 is wrong — fix there, not here.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/markdown/__tests__/MarkdownContent.vault.test.tsx
git commit -m "test(vault): pin math/mermaid/highlight survival through sanitize"
```

---

### Task 4: VaultReader passes enableRawHtml + light reading surface (dark-theme fix)

**Files:**
- Modify: `frontend/src/components/VaultReader.tsx`
- Test: `frontend/src/components/__tests__/VaultReader.test.tsx` (create if absent) — or extend existing vault tests.

**Interfaces:**
- Consumes: `MarkdownContent enableRawHtml` (Task 2).
- Produces: read-mode `<article>` wrapped in a light-surface container (white bg / dark text) so light-`background`-no-`color` cells are legible; `MarkdownContent` called with `enableRawHtml`.

- [ ] **Step 1: Write failing test**

Create `frontend/src/components/__tests__/VaultReader.test.tsx` (mock `../lib/api` so `getVaultFile` resolves note content with an inline table):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import VaultReader from '../VaultReader'

vi.mock('../../lib/api', () => ({
  listVault: vi.fn().mockResolvedValue({ entries: [{ name: 'n.md', type: 'file' }] }),
  getVaultFile: vi.fn().mockResolvedValue({ content: '<table><tr><td>Cell</td></tr></table>', truncated: false }),
  getVaultSearch: vi.fn().mockResolvedValue({ results: [], truncated: false }),
  resolveWikiLink: vi.fn(),
}))

describe('VaultReader', () => {
  beforeEach(() => vi.clearAllMocks())
  it('renders inline HTML table (enableRawHtml) inside a light surface', async () => {
    render(<VaultReader onClose={() => {}} />)
    fireEvent.click(await screen.findByText('n.md'))
    await waitFor(() => expect(document.querySelector('table td')?.textContent).toBe('Cell'))
    // light reading surface marker class present on the read container
    expect(document.querySelector('.vault-reading-surface')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/components/__tests__/VaultReader.test.tsx`
Expected: FAIL (no `enableRawHtml`, no `.vault-reading-surface`, table not rendered).

- [ ] **Step 3: Implement**

In `VaultReader.tsx` read-mode block, wrap the `<article>` and pass the prop:

```tsx
<div className="flex-1 overflow-auto">
  <div className="vault-reading-surface bg-white text-neutral-900 min-h-full">
    <article className="mx-auto max-w-[72ch] px-4 py-6 leading-relaxed text-[15px]">
      {truncated && <div className="mb-3 px-3 py-2 text-xs rounded bg-neutral-100 text-amber-700">内容过长,仅显示前 1MB</div>}
      <MarkdownContent text={content} isComplete enableRawHtml
        resolveSrc={(s) => resolveVaultImageSrc(s, openPath)}
        onWikiLink={onWikiLink} />
    </article>
  </div>
</div>
```

Rationale (comment in code): the notes are authored for a light theme (dark text like `#111`, light `background`s often without an explicit `color`); a light reading surface makes all inline styles coherent and legible. Code blocks keep their own `github-dark.css` background.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/__tests__/VaultReader.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/VaultReader.tsx frontend/src/components/__tests__/VaultReader.test.tsx
git commit -m "feat(vault): enable inline HTML + light reading surface for dark-theme legibility"
```

---

### Task 5: Full sweep + real-vault e2e verification

**Files:** none (verification).

- [ ] **Step 1: Frontend sweep**

Run: `cd frontend && npm run lint && npx vitest run && npm run build`
Expected: lint clean (or only pre-existing warnings), all tests pass, `tsc -b` + build succeed.

- [ ] **Step 2: Real-vault e2e (manual, after deploy)**

Document in PR body — open in the running app (dark mode):
1. `.../SGLang/01_推理全景与定位/1.1_LLM推理为什么难.md` → HTML tables render as tables, `$$` formulas render, ALL cells legible (no white-on-light).
2. One note with HTML interleaved with markdown → renders coherently (rehype-raw parser semantics ok).
3. A note with `[[wikilink]]` → still clickable (contract preserved).

- [ ] **Step 3: Commit (if any doc)**

```bash
git commit --allow-empty -m "test(vault): sweep green; real-vault e2e recorded in PR"
```

---

## Self-Review

**Spec coverage:**
- 改动1 deps → Task 1. ✓
- 改动2 explicit `enableRawHtml` + plugin order → Task 2. ✓
- 改动3 schema (math marker, style, tags, per-element className, data: img) → Task 1; regression pins → Task 3. ✓
- 改动4 light reading surface (dark-theme fix) → Task 4. ✓
- 改动5 CSP coupling documented → Task 1 (comment + test asserts data: allowed / script blocked). ✓
- wikilink/mermaid unaffected → Tasks 3,4 (pins + preserved). ✓
- Chat path unchanged → Task 2 (test: no enableRawHtml → HTML stays text). ✓
- e2e on real vault → Task 5. ✓

**Placeholder scan:** No TBD/TODO; all steps concrete. ✓

**Type consistency:** `enableRawHtml` prop name stable (Tasks 2,4); `vaultSanitizeSchema` export stable (Tasks 1,2); `.vault-reading-surface` marker stable (Task 4 impl+test). ✓

**Note on schema attr casing:** react-markdown/hast use DOM prop casing (`colSpan`, `className`); tests assert `colSpan`. If runtime shows `colspan` needed, adjust schema + test together (they are the same commit in Task 1).
