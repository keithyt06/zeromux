import { createContext, useContext } from 'react'

export interface MarkdownContextValue {
  isComplete: boolean
}

export const MarkdownContext = createContext<MarkdownContextValue>({ isComplete: true })
export const useMarkdownContext = () => useContext(MarkdownContext)
