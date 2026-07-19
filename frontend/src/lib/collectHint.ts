// collect(合并追加)排队提示的清零决策 —— 从 AcpChatView 的事件处理中抽出的纯函数。
//
// 后端在 turn 进行中追加 prompt 时广播 ephemeral `System{subtype:"queued"}`,
// 前端据此显示"已排队 N 条,本轮结束后合并发送"。这条提示只在 **turn 结束**
// 时清零 —— 无论正常 `result` 还是 `error`/`exit`。
//
// **不能**在 content_block 清零:后端保证合并 turn 只在原 turn 结束后才 arm+flush
// (queue.arm 仅在 !local_running 时,flush select-arm 仅在 Idle 时),故合并 turn
// 的首个 content_block 之前必先有原 turn 的 result/error/exit —— 那已清零。若在
// content_block 清零,清的却是**仍在跑的原 turn**自己的输出:提示在 agent 明明还
// 在干活时闪一下就消失,谎报队列已发/已丢(排队项其实仍在,turn 结束才合并发)。
//
// error/exit 尤其关键:agent 崩溃/进程退出时后端丢弃排队队列(queue.clear),合并
// turn 永不发出,若不在此清零则提示永久卡住。此谓词把该契约变成可测的单点真理。
//
// `replay_done`(重连重放结束)另有其清零点(后端 queued 事件本就 ephemeral,
// 那里是安全网),不在本谓词覆盖范围。
export function shouldClearQueuedHint(eventType: string): boolean {
  switch (eventType) {
    case 'result':        // turn 正常结束
    case 'error':         // turn 异常结束(后端已 clear 队列)
    case 'exit':          // 进程退出(后端已 clear 队列)
      return true
    default:              // content_block 属仍在跑的当前 turn,不清(合并 turn 必在 result 之后)
      return false
  }
}

// 重连重放结束时(`replay_done`)是否应把 busy 置为「仍在运行」。
//
// 旧逻辑无条件 `setBusy(false)`:重放把历史 content_block 设 busy=true,末尾的
// `replay_done` 又把它清成 false。若此刻后端 turn **仍在 Running**(mid-turn 重连,
// 常见于经 idle-proxy 掉线的静默工具调用期),前端就误判 turn 已结束 —— 运行指示
// 与**中断按钮**一并消失,直到下一条 live 事件才恢复;对真卡住的 turn 则永不恢复,
// 用户再也无法从聊天视图中断它。
//
// 后端现在在 `replay_done` 里带上权威的 `running` 标志(取自 turn_state==Running),
// 前端据此设 busy。缺失/非布尔值按 false 处理(旧行为),保证老后端兼容。
export function busyAfterReplay(running: unknown): boolean {
  return running === true
}
