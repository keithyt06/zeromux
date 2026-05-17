import { useMarkdownContext } from './context'

type CodeProps = {
  className?: string
  children?: React.ReactNode
} & React.HTMLAttributes<HTMLElement>

export default function CodeBlock({ className, children, ...props }: CodeProps) {
  const { isComplete } = useMarkdownContext()
  const isBlock = className?.includes('language-') ?? false
  const lang = className?.match(/language-(\S+)/)?.[1] ?? ''

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
