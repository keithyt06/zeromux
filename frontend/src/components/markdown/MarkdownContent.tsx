import { useDeferredValue } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import { common } from 'lowlight'
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
              languages: { ...common, dockerfile },
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
