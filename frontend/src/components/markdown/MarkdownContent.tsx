import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import { common } from 'lowlight'
import 'highlight.js/styles/github-dark.css'
import { markdownComponents } from '../markdownStyles'
import { MarkdownContext } from './context'
import CodeBlock from './CodeBlock'
import { sanitizeStreamingMarkdown, unwrapMarkdownFence } from './sanitize'

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
    [rehypeHighlight, {
      subset: HLJS_LANGS,
      detect: true,
      languages: { ...common, dockerfile },
    }],
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
          {rendered}
        </ReactMarkdown>
      </div>
    </MarkdownContext.Provider>
  )
}
