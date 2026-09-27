import { useEffect } from 'react'
import { X } from 'lucide-react'
import PromptManager from './PromptManager'
import { usePromptPresets } from '../lib/usePromptPresets'
import { Sheet, IconButton } from './ui'

/** Settings → 常用 prompt 管理, as an App-level bottom Sheet. Owns its own
 *  preset store and reloads on open (last-writer-wins, see usePromptPresets). */
export default function PromptsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = usePromptPresets()
  const { reload } = store
  useEffect(() => { if (open) reload() }, [open, reload])
  return (
    <Sheet open={open} side="bottom" onClose={onClose} title="管理常用 prompt"
      actions={<IconButton label="关闭" icon={X} onClick={onClose} />}>
      <PromptManager presets={store.presets} error={store.error} onAdd={store.add} onEdit={store.edit} onRemove={store.remove} onClose={onClose} embedded />
    </Sheet>
  )
}
