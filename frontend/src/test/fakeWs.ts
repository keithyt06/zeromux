// 最小 WebSocket 替身。AcpChatView 一挂载就 `new WebSocket(...)`，happy-dom 不提供
// 构造器，所以任何 mount 该组件的测试都必须先装这个。它同时是测试驱动 handleEvent
// 的唯一入口：拿到实例后调 `emit({...})` 就等于服务端推了一帧。
export interface FakeSocket {
  readyState: number
  sent: string[]
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((e: { data: string }) => void) | null
  /** 推一帧到组件（等价于服务端 broadcast）。 */
  emit(evt: unknown): void
}

/** 装上替身，返回「取最近一个实例」的句柄。调用方在 afterEach 里 restore。 */
export function installFakeWebSocket(): { latest: () => FakeSocket; all: FakeSocket[] } {
  const all: FakeSocket[] = []
  class Fake implements FakeSocket {
    static OPEN = 1
    readyState = 1              // OPEN：sendPrompt / interrupt / approval 的守卫要求
    sent: string[] = []
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    // `public url` 参数属性在 erasableSyntaxOnly 下不允许（tsconfig.app.json:26）——
    // 写成 `constructor(public url: string)` 会 TS1294 编译失败（实测撞到）。
    url: string
    constructor(url: string) { this.url = url; all.push(this) }
    send(data: string) { this.sent.push(data) }
    close() { this.readyState = 3 }
    emit(evt: unknown) { this.onmessage?.({ data: JSON.stringify(evt) }) }
  }
  // WebSocket.OPEN 是组件里 readyState 比较的来源，必须一并提供。
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = Fake
  return { latest: () => all[all.length - 1], all }
}
