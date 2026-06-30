import { findAndReplace } from 'mdast-util-find-and-replace'
import type { Root, PhrasingContent } from 'mdast'

// Obsidian wikilink grammar (phase 1):
//   [[Target]]                 → link, display = Target
//   [[Target|Display]]         → link, display = Display
//   [[Target#heading]]         → link to Target (heading stripped — phase 1 has no anchors)
//   [[folder/Target]]          → link, resolve key = "folder/Target" (backend resolves basename)
//   ![[embed]]                 → NOT a link (phase 2). Left as literal text, not a broken image.
//
// The resolve key is the cleaned target (alias + heading removed). The href is
// `#wikilink:<encoded key>`; the `a` renderer in MarkdownContent intercepts that prefix
// and calls onWikiLink. Display text falls back to the target when no `|alias` is given.

export interface ParsedWikilink {
  /** Resolve key sent to the backend (alias + heading stripped). */
  target: string
  /** Text shown to the reader. */
  display: string
}

export function parseWikilinkInner(inner: string): ParsedWikilink {
  const pipe = inner.indexOf('|')
  const left = (pipe >= 0 ? inner.slice(0, pipe) : inner)
  const aliasRaw = pipe >= 0 ? inner.slice(pipe + 1) : ''
  // Strip a heading/block anchor (#heading, #^block) from the resolve target.
  const hash = left.indexOf('#')
  const targetRaw = hash >= 0 ? left.slice(0, hash) : left
  const target = targetRaw.trim()
  const display = (aliasRaw.trim() || left.trim())
  // Pure-heading link [[#section]] has no target; fall back to the left text so the
  // click still does something deterministic (404 alert) rather than resolving "".
  return { target: target || left.trim(), display }
}

// Matches [[...]] and ![[...]] (captures the leading bang so embeds can be skipped).
// `[^\]\n]+` keeps it on one line and stops at the first `]`.
const WIKILINK_RE = /(!?)\[\[([^\]\n]+)\]\]/g

/**
 * remark plugin: rewrite Obsidian `[[wikilinks]]` into link nodes carrying a
 * `#wikilink:<target>` href. Operates on mdast text nodes only, so `[[...]]` inside
 * fenced or inline code is never touched (code is a leaf node with no text children) —
 * this is why we do NOT pre-process the raw markdown string with a regex.
 */
export function remarkWikilink() {
  return (tree: Root) => {
    findAndReplace(tree, [
      [
        WIKILINK_RE,
        (_full: string, bang: string, inner: string): PhrasingContent | false => {
          if (bang) {
            // Embed (![[...]]) — phase 2. Emit the literal text so it neither resolves
            // nor becomes a broken <img>. Returning false would let findAndReplace
            // re-scan and match the inner [[...]] as a normal link.
            return { type: 'text', value: `![[${inner}]]` }
          }
          const { target, display } = parseWikilinkInner(inner)
          return {
            type: 'link',
            url: `#wikilink:${encodeURIComponent(target)}`,
            children: [{ type: 'text', value: display }],
          }
        },
      ],
    ])
  }
}
