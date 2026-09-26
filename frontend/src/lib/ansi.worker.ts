import { parseAnsiLine } from './ansi'

// chunk text → per-line spans, off the main thread (50k lines on a phone).
self.onmessage = (e: MessageEvent<string[]>) => {
  self.postMessage(e.data.map(chunk => chunk.split('\n').map(parseAnsiLine)))
}
