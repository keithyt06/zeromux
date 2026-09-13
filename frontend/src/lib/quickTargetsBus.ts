// quick_targets 变更的进程内广播。
//
// bump 发生在后端（create_session / vault_file 的副作用），前端只有在自己触发了
// 那些动作时才知道要刷新——所以由动作发起方 notify()，所有挂载中的 QuickTargets
// 重新 GET。没有它，列表就是「挂载时取一次」的静态快照：VaultReader 在 App.tsx
// 里常驻挂载（用 hidden 切换可见性，刻意不 unmount 以保留滚动状态），会一直显示
// 几小时前的顺序。
//
// 刻意不用 props refreshKey：三个入口分布在 Sidebar / FileBrowser(modal) /
// ScheduledTasksPanel / VaultReader 四条不同的树路径上，穿 props 会让「一份实现
// 多处复用」退化成每加一个入口改一次调用链。
const listeners = new Set<() => void>()

export function notifyQuickTargetsChanged(): void {
  // 复制一份再遍历：监听者在回调里退订（组件 unmount）不会破坏本次迭代。
  for (const f of Array.from(listeners)) f()
}

export function subscribeQuickTargets(f: () => void): () => void {
  listeners.add(f)
  return () => { listeners.delete(f) }
}
