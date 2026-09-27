import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    // No manualChunks: a 'mermaid' group (rolldown) also captured vite's shared
    // preload helper, so the entry statically imported + modulepreloaded the
    // whole mermaid chunk (~534KB br). MermaidBlock's dynamic import('mermaid')
    // splits it naturally.
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
})
