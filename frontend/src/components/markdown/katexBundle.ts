// Lazy-loaded chunk: triggered when MarkdownContent detects "$" in text.
// Importing katex.css here makes Vite bundle the CSS into this same chunk,
// so it ships only when the chunk is fetched.
import 'katex/dist/katex.min.css'
import rehypeKatex from 'rehype-katex'

export { rehypeKatex }
