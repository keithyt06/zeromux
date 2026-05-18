// FNV-1a 32-bit hash. Used for content-addressed mermaid cache keys.
// Not cryptographic. Fast, deterministic, low collision rate for our scale.
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
