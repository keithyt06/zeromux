import { describe, it, expect, vi } from 'vitest'
import type { ClipboardSelectionType } from '@xterm/addon-clipboard'
import { writeOnlyClipboard } from '../clipboard'

// Ambient const enum (not importable at runtime under isolatedModules).
const SYS = 'c' as ClipboardSelectionType
const PRIMARY = 'p' as ClipboardSelectionType

describe('writeOnlyClipboard', () => {
  it('refuses OSC52 reads, keeps clipboard writes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const p = writeOnlyClipboard({ writeText })
    expect(await p.readText(SYS)).toBe('')
    await p.writeText(SYS, 'hi')
    expect(writeText).toHaveBeenCalledWith('hi')
    await p.writeText(PRIMARY, 'primary')
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})
