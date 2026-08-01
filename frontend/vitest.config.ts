import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Never glob into detached agent worktrees: `--worktree-isolation` (and leftover
    // dirs from prior sessions) create `<repo>/.zeromux-worktrees/<id>/frontend/…` with
    // full copies of these test files but no `node_modules`, so vitest's default
    // `**/*.test.*` glob would pick them up and they'd fail en masse with
    // "Cannot find package '@testing-library/react'" / "document is not defined",
    // masking the real suite result. Exclude them alongside vitest's built-in defaults.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.zeromux-worktrees/**',
    ],
  },
})
