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
