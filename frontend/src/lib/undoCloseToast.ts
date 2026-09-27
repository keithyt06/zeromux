import { restoreSession } from './api'
import { toast } from '../components/ui/toast'

/** toast.push payload for the undo-close toast (I-18: durationMs is computed by
 *  the caller from the server's pending_until and passed through untouched). */
export function undoCloseToast(id: string, name: string, durationMs: number, onRestore: () => Promise<void>) {
  return {
    key: `undo-${id}`,
    message: `已关闭 ${name}`,
    durationMs,
    action: {
      label: '撤销',
      onClick: async () => {
        if (await restoreSession(id)) await onRestore()
        else toast.push({ message: '撤销失败，会话已关闭' })
      },
    },
  }
}
