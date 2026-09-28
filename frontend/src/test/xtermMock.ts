// Shared xterm module doubles for App-level tests. vi.mock must live in the test
// file itself (vitest only hoists a test file's own vi.mock), so this module only
// exports the mock objects: `vi.mock('@xterm/xterm', async () => (await import('../test/xtermMock')).xtermModule)`.
/** Every `new Terminal()` pushes itself here (I-1: switching must not recreate xterm). */
export const xtermInstances: unknown[] = []
const disp = { dispose() {} }
export const xtermModule = {
  Terminal: class {
    cols = 80; rows = 24; options: Record<string, unknown> = {}; modes = { bracketedPasteMode: false }
    element = document.createElement('div')
    buffer = { active: { length: 0, getLine: () => undefined, viewportY: 0, baseY: 0 } }
    constructor() { xtermInstances.push(this) }
    open() {} write() {} reset() {} focus() {} blur() {} dispose() {} clear() {} scrollToBottom() {} scrollLines() {} refresh() {} resize() {}
    loadAddon() {} attachCustomKeyEventHandler() {}
    onData() { return disp } onBinary() { return disp } onResize() { return disp } onSelectionChange() { return disp } onScroll() { return disp } onRender() { return disp }
    hasSelection() { return false } getSelection() { return '' }
  },
}
export const fitModule = { FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } activate() {} dispose() {} } }
export const webglModule = { WebglAddon: class { onContextLoss() { return disp } activate() {} dispose() {} } }
export const searchModule = { SearchAddon: class { activate() {} dispose() {} findNext() { return false } findPrevious() { return false } clearDecorations() {} } }
export const clipboardModule = { ClipboardAddon: class { activate() {} dispose() {} } }
