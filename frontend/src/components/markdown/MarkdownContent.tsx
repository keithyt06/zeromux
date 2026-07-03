import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components, ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import { common } from 'lowlight'
import 'highlight.js/styles/github-dark.css'
import { markdownComponents } from '../markdownStyles'
import { vaultSanitizeSchema } from './sanitizeSchema'
import { MarkdownContext } from './context'
import CodeBlock from './CodeBlock'
import { sanitizeStreamingMarkdown, unwrapMarkdownFence } from './sanitize'
import { remarkWikilink } from './remarkWikilink'

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
  resolveSrc?: (src: string) => string
  onWikiLink?: (basename: string) => void
  enableRawHtml?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RehypePlugin = any

export default function MarkdownContent({ text, isComplete, className, resolveSrc, onWikiLink, enableRawHtml }: Props) {
  const deferredText = useDeferredValue(text)
  // Streaming: sanitize unclosed fences/tables/math. Complete: strip a whole-reply
  // ```markdown wrapper (kiro habit — nested fences mis-render) then use raw text.
  // Unwrap only on the completed text so we never act on a half-streamed wrapper.
  const rendered = isComplete
    ? unwrapMarkdownFence(deferredText)
    : sanitizeStreamingMarkdown(deferredText)
  const needsKatex = useMemo(() => hasMathSyntax(rendered), [rendered])
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
    ...(enableRawHtml ? [rehypeRaw, [rehypeSanitize, vaultSanitizeSchema]] : []),
    [rehypeHighlight, {
      subset: HLJS_LANGS,
      detect: true,
      languages: { ...common, dockerfile },
    }],
    ...(katexPlugin ? [[katexPlugin, { strict: 'ignore' }]] : []),
  ]

  // Vault wikilinks: only when onWikiLink is provided, a remark plugin rewrites
  // [[X]] into link nodes the custom `a` renderer intercepts. It runs on mdast text
  // nodes, so [[...]] inside code blocks is left untouched. Default chat path
  // (no onWikiLink) never adds the plugin → [[X]] stays literal text.
  const remarkPlugins = onWikiLink
    ? [remarkGfm, remarkMath, remarkWikilink]
    : [remarkGfm, remarkMath]

  const vaultComponents: Components = {
    ...markdownComponents,
    code: CodeBlock,
    // When enableRawHtml, vault notes may carry inline style + colSpan/rowSpan/align on
    // td/th (the sanitize schema allows all of these). The default markdownStyles components
    // destructure only { children } and drop the rest; forward them via rest-spread.
    ...(enableRawHtml ? {
      td: ({ children, ...rest }: React.ComponentPropsWithoutRef<'td'>) =>
        <td className="border border-[var(--border)] px-2 py-1" {...rest}>{children}</td>,
      th: ({ children, ...rest }: React.ComponentPropsWithoutRef<'th'>) =>
        <th className="border border-[var(--border)] px-2 py-1 bg-[var(--bg-secondary)] text-left font-semibold" {...rest}>{children}</th>,
    } : {}),
    ...(resolveSrc ? {
      img: ({ src, alt, title }: React.ComponentPropsWithoutRef<'img'> & ExtraProps) =>
        <img src={resolveSrc(src || '')} alt={alt} title={title} />,
    } : {}),
    ...(onWikiLink ? {
      a: ({ href, children }: React.ComponentPropsWithoutRef<'a'> & ExtraProps) => {
        if ((href || '').startsWith('#wikilink:')) {
          const name = decodeURIComponent((href || '').slice('#wikilink:'.length))
          return <a href="#" onClick={(e) => { e.preventDefault(); onWikiLink(name) }}
                    className="text-[var(--accent-blue)] underline cursor-pointer">{children}</a>
        }
        const A = markdownComponents.a as React.FC<React.ComponentPropsWithoutRef<'a'> & ExtraProps>
        return <A href={href}>{children}</A>
      },
    } : {}),
  }

  return (
    <MarkdownContext.Provider value={{ isComplete }}>
      <div className={className}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={vaultComponents}
        >
          {rendered}
        </ReactMarkdown>
      </div>
    </MarkdownContext.Provider>
  )
}
