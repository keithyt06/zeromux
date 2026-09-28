import { useEffect } from 'react'

/** The only shortcuts (spec M21): ⌘K/Ctrl+K palette, ⌘]/Ctrl+] next, J next outside inputs/xterm. */
export function useNextKeys({ onNext, onPalette }: { onNext(): void; onPalette(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); onPalette(); return }
      if (mod && e.key === ']') { e.preventDefault(); onNext(); return }
      const t = e.target as HTMLElement | null
      const typing = !!t && typeof t.closest === 'function' && (t.closest('input, textarea, [contenteditable="true"], .xterm, [role="menu"], [role="listbox"], dialog') != null)
      if (!mod && !e.altKey && e.key === 'j' && !typing) { e.preventDefault(); onNext() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onNext, onPalette])
}
