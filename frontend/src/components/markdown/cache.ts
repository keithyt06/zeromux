// Module-level singleton for cross-message mermaid SVG dedup.
// Survives component unmounts; cleared only on full page reload.
export const mermaidCache = new Map<string, string>()
