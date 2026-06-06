import { useState, useEffect, type FormEvent } from 'react'
import type { AuthMode } from '../lib/api'
import { getAuthMode } from '../lib/api'
import HaringLogo from './HaringLogo'

interface Props {
  onLegacyLogin: (password: string, remember?: boolean) => Promise<void>
}

export default function LoginPage({ onLegacyLogin }: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode | null>(null)
  const [remember, setRemember] = useState(false)

  useEffect(() => {
    getAuthMode().then(setAuthMode).catch(() => {})
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await onLegacyLogin(password, remember)
    } catch (err: any) {
      setError(err.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="h-full bg-[var(--bg-primary)] flex items-center justify-center">
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-8 w-80 space-y-5">
        <div className="flex items-center gap-2.5">
          <HaringLogo size={28} />
          <h1 className="text-lg font-bold text-[var(--text-primary)]">ZeroMux</h1>
        </div>

        {error && (
          <p className="text-sm text-[var(--accent-red)]">{error}</p>
        )}

        {/* Remember me checkbox */}
        {authMode && (authMode.oauth || authMode.legacy) && (
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={e => setRemember(e.target.checked)}
              className="w-3.5 h-3.5 accent-[var(--accent-blue)] cursor-pointer"
            />
            <span className="text-xs text-[var(--text-secondary)]">30 days without login</span>
          </label>
        )}

        {/* GitHub OAuth button */}
        {authMode?.oauth && (
          <a
            href={`/auth/github${remember ? '?remember=true' : ''}`}
            className="flex items-center justify-center gap-2 w-full py-2.5 bg-[#24292e] hover:bg-[#2f363d] text-white text-sm font-semibold rounded-md transition-colors"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            Sign in with GitHub
          </a>
        )}

        {/* Divider when both modes available */}
        {authMode?.oauth && authMode?.legacy && (
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-[var(--border)]" />
            <span className="text-[10px] text-[var(--text-muted)] uppercase">or</span>
            <div className="flex-1 h-px bg-[var(--border)]" />
          </div>
        )}

        {/* Legacy token login */}
        {authMode?.legacy && (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Token"
              autoFocus={!authMode?.oauth}
              className="w-full px-3 py-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded-md text-[var(--text-primary)] text-sm outline-none focus:border-[var(--accent-blue)] placeholder-[var(--text-muted)]"
            />
            <button
              type="submit"
              disabled={loading || !password}
              className="w-full py-2 bg-[var(--accent-green)] hover:bg-[var(--accent-green-hover)] disabled:bg-[var(--btn-disabled-bg)] disabled:text-[var(--btn-disabled-text)] text-white text-sm font-semibold rounded-md transition-colors"
            >
              {loading ? 'Verifying...' : 'Connect'}
            </button>
          </form>
        )}

        {/* Loading state */}
        {!authMode && (
          <div className="text-center text-sm text-[var(--text-muted)]">Loading...</div>
        )}
      </div>
    </div>
  )
}
