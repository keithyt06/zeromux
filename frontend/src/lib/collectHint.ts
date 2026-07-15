// collect(合并追加)排队提示的清零决策 —— 从 AcpChatView 的事件处理中抽出的纯函数。
//
// 后端在 turn 进行中追加 prompt 时广播 ephemeral `System{subtype:"queued"}`,
// 前端据此显示"已排队 N 条,本轮结束后合并发送"。这条提示必须在两种时机清零:
//   1. 合并 turn 真正发出(下一个 Running 的首个 `content_block`);
//   2. **turn 结束**时 —— 无论正常 `result` 还是 `error`/`exit`。
//
// 第 2 类里 error/exit 尤其关键:agent 崩溃/进程退出时后端会丢弃排队队列
// (queue.clear),但若前端只在 content_block 清零,合并 turn 永不发出 →
// 提示永久卡住,谎报"还有 N 条待合并"。此谓词把该契约变成可测的单点真理。
//
// `replay_done`(重连重放结束)另有其清零点(后端 queued 事件本就 ephemeral,
// 那里是安全网),不在本谓词覆盖范围。
export function shouldClearQueuedHint(eventType: string): boolean {
  switch (eventType) {
    case 'content_block': // 合并 turn 开始产出 → 提示已兑现
    case 'result':        // turn 正常结束
    case 'error':         // turn 异常结束(后端已 clear 队列)
    case 'exit':          // 进程退出(后端已 clear 队列)
      return true
    default:
      return false
  }
}
