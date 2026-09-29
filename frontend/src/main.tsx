import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { resyncPush } from './lib/push'
import { reloadOnceForStaleChunk, markPageStable, STABLE_AFTER_MS } from './lib/lazyWithReload'

// Vite's modulepreload of a chunk the new binary no longer embeds (A1).
window.addEventListener('vite:preloadError', (e) => {
  if (reloadOnceForStaleChunk()) e.preventDefault()
})
// Re-arm the one-shot chunk reload once this page has loaded cleanly for a while.
setTimeout(markPageStable, STABLE_AFTER_MS)

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(() => resyncPush())
    .catch(() => { /* push is non-critical */ })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
