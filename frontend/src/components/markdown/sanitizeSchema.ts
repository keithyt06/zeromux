import { defaultSchema } from 'rehype-sanitize'
import type { Schema } from 'hast-util-sanitize'

// PropertyDefinition is not re-exported at the package root; derive it locally.
type PropertyDefinition = NonNullable<Schema['attributes']>[string][number]

// Allowlist for vault (Obsidian) note HTML. Extends the safe defaultSchema.
// SECURITY: `style` is allowed for the note's own layout (tables/spans). Its
// safety rests on the global CSP `img-src 'self' data:` (src/web.rs:212), which
// blocks the url()/image-set() CSS exfiltration channel. If that CSP is ever
// loosened, revisit this (or strip url() from style values). See spec §改动5.
export const vaultSanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // Table elements (not in defaultSchema)
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    // Inline/block elements
    'span', 'sub', 'sup', 'kbd', 'mark', 'u', 's', 'ins', 'summary',
    // Note: 'div', 'br', 'hr', 'details' already in defaultSchema
  ],
  attributes: {
    ...defaultSchema.attributes,
    // Per-element className: explicitly list allowed values so math markers
    // (katex input) and language-* (mermaid/highlight) are preserved.
    // The defaultSchema's {"className": [["className", {}]]} wildcard is
    // intentionally replaced with a specific allowlist.
    code: [
      ['className', /^language-./, 'math-inline', 'math-display'],
    ],
    // span: allow style for inline layout from vault notes
    span: [
      ...((defaultSchema.attributes?.span as PropertyDefinition[]) ?? []),
      'style',
    ],
    // Table cell attrs (td/th not in defaultSchema, so start fresh)
    td: ['colSpan', 'rowSpan', 'align', 'style'],
    th: ['colSpan', 'rowSpan', 'align', 'scope', 'style'],
    // Global attrs: extend defaultSchema's '*' with style
    // (defaultSchema already includes colSpan, rowSpan, align, etc.)
    '*': [
      ...((defaultSchema.attributes?.['*'] as PropertyDefinition[]) ?? []),
      'style',
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    // Allow data: URIs for embedded images in vault notes
    src: [...(defaultSchema.protocols?.src ?? []), 'data'],
  },
}
