import { useState, useEffect, useCallback } from 'react'

export type ThemePref = 'system' | 'dark' | 'light'
/** Resolved theme actually painted. Name kept for existing importers. */
export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'zeromux_theme'
const LIGHT_MQ = '(prefers-color-scheme: light)'

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* storage blocked */ }
  return 'system'
}

function systemLight(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia(LIGHT_MQ).matches
}

export function resolveTheme(pref: ThemePref, sysLight: boolean): Theme {
  return pref === 'system' ? (sysLight ? 'light' : 'dark') : pref
}

/** Synchronous DOM write. Must run BEFORE the React state update so child
 *  effects (xterm, mermaid) that read CSS variables see the new theme. */
export function applyResolvedTheme(t: Theme) {
  const el = document.documentElement
  el.classList.toggle('light', t === 'light')
  el.style.colorScheme = t
}

export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(readPref)
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(readPref(), systemLight()))

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return
    const mq = matchMedia(LIGHT_MQ)
    const on = (e: { matches: boolean }) => {
      if (readPref() !== 'system') return
      const t: Theme = e.matches ? 'light' : 'dark'
      applyResolvedTheme(t)
      setTheme(t)
    }
    // Safari < 14 has no addEventListener on MediaQueryList; fall back to
    // the deprecated addListener/removeListener pair it replaced.
    if (mq.addEventListener) {
      mq.addEventListener('change', on)
      return () => mq.removeEventListener('change', on)
    }
    mq.addListener?.(on)
    return () => mq.removeListener?.(on)
  }, [])

  const setPref = useCallback((p: ThemePref) => {
    try { localStorage.setItem(STORAGE_KEY, p) } catch { /* ignore */ }
    const t = resolveTheme(p, systemLight())
    applyResolvedTheme(t)
    setPrefState(p)
    setTheme(t)
  }, [])

  const toggle = useCallback(() => setPref(theme === 'dark' ? 'light' : 'dark'), [theme, setPref])

  return { pref, theme, setPref, toggle }
}
