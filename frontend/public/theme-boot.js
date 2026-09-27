// Runs synchronously before first paint (referenced from index.html <head>).
// CSP is script-src 'self', so this cannot be inline. Mirrors lib/theme.ts.
(function () {
  var pref = 'system'
  try { pref = localStorage.getItem('zeromux_theme') || 'system' } catch (e) {}
  var light = pref === 'light' || (pref !== 'dark' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches)
  var el = document.documentElement
  if (light) el.classList.add('light')
  el.style.colorScheme = light ? 'light' : 'dark'
})()
