// Shared xterm module doubles for App-level tests. vi.mock must live in the test
// file itself (vitest only hoists a test file's own vi.mock), so this module only
// exports the mock objects: `vi.mock('@xterm/xterm', async () => (await import('../test/xtermMock')).xtermModule)`.
/** Every `new Terminal()` pushes itself here (I-1: switching must not recreate xterm). */
export const xtermInstances: unknown[] = []
const disp = { dispose() {} }
/** Configurable selection state read by every Terminal's hasSelection/getSelection. */
export const selection = { has: false, text: '' }
/** What FitAddon.proposeDimensions() returns; fit() also applies it to the latest Terminal. */
export const fitDims = { cols: 80, rows: 24 }
export const xtermModule = {
  Terminal: class {
    cols = 80; rows = 24; options: Record<string, unknown> = {}
    modes = { bracketedPasteMode: false, applicationCursorKeysMode: false }
    element = document.createElement('div')
    buffer = { active: { length: 0, getLine: () => undefined, viewportY: 0, baseY: 0 } }
    /** Call counts for characterization assertions. */
    calls = { reset: 0, write: 0, focus: 0 }
    dataHandlers: ((d: string) => void)[] = []
    selectionHandlers: (() => void)[] = []
    binaryHandlers: ((d: string) => void)[] = []
    constructor() { xtermInstances.push(this) }
    open() {} blur() {} dispose() {} clear() {} scrollToBottom() {} scrollLines() {} refresh() {} resize() {}
    reset() { this.calls.reset++ }
    write(_d: unknown, cb?: () => void) { this.calls.write++; cb?.() }
    focus() { this.calls.focus++ }
    loadAddon() {} attachCustomKeyEventHandler() {}
    onData(h: (d: string) => void) { this.dataHandlers.push(h); return disp }
    onSelectionChange(h: () => void) { this.selectionHandlers.push(h); return disp }
    onBinary(h: (d: string) => void) { this.binaryHandlers.push(h); return disp }
    onResize() { return disp } onScroll() { return disp } onRender() { return disp }
    hasSelection() { return selection.has } getSelection() { return selection.text }
  },
}
type MockTerminal = { calls: { reset: number; write: number; focus: number }; dataHandlers: ((d: string) => void)[]; binaryHandlers: ((d: string) => void)[]; selectionHandlers: (() => void)[]; cols: number; rows: number }
export const lastTerminal = () => xtermInstances[xtermInstances.length - 1] as MockTerminal
/** Call count for characterization assertions (e.g. ResizeObserver-triggered refits). */
export const fitCalls = { count: 0 }
export const fitModule = { FitAddon: class {
  fit() { fitCalls.count++; const t = xtermInstances.length ? lastTerminal() : undefined; if (t) { t.cols = fitDims.cols; t.rows = fitDims.rows } }
  proposeDimensions() { return { ...fitDims } } activate() {} dispose() {}
} }
export const webglModule = { WebglAddon: class { onContextLoss() { return disp } activate() {} dispose() {} } }
export const searchModule = { SearchAddon: class { activate() {} dispose() {} findNext() { return false } findPrevious() { return false } clearDecorations() {} } }
export const clipboardModule = { ClipboardAddon: class { activate() {} dispose() {} } }
