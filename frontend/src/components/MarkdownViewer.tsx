import { useState, useEffect, useCallback, useRef } from 'react'
import MarkdownContent from './markdown/MarkdownContent'
import {
  listSessionFiles, getSessionFile, writeSessionFile, deleteSessionFile,
  renameSessionFile, uploadSessionFile, createSessionDir, deleteSessionDir, renameSessionDir
} from '../lib/api'
import type { FileEntry } from '../lib/api'
import {
  FileText, RefreshCw, ChevronRight, Folder, Plus, Trash2, Pencil,
  Upload, FolderPlus, Save, X, Check, MoreHorizontal, Eye, Edit3, Settings
} from 'lucide-react'
import type { SessionType } from '../lib/api'

interface Props {
  sessionId: string
  sessionType?: SessionType
}

type ContextMenu = {
  x: number
  y: number
  type: 'file' | 'dir'
  path: string
} | null

const DOCS_BASEDIR_KEY = 'zeromux_docs_basedir'

export default function MarkdownViewer({ sessionId, sessionType }: Props) {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')
  const [loadingContent, setLoadingContent] = useState(false)

  // Editing state
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<ContextMenu>(null)

  // Inline rename
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameRef = useRef<HTMLInputElement>(null)

  // New file/dir dialog
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null)
  const [createPath, setCreatePath] = useState('')
  const createRef = useRef<HTMLInputElement>(null)

  // Upload
  const uploadRef = useRef<HTMLInputElement>(null)

  // Docs base directory (tmux sessions only)
  const [docsBaseDir, setDocsBaseDir] = useState(() => localStorage.getItem(DOCS_BASEDIR_KEY) || '')
  const [showBaseConfig, setShowBaseConfig] = useState(false)
  const [baseDirInput, setBaseDirInput] = useState(docsBaseDir)
  const isTmux = sessionType === 'tmux'
  const effectiveBaseDir = isTmux && docsBaseDir ? docsBaseDir : undefined

  const applyBaseDir = () => {
    const val = baseDirInput.trim()
    setDocsBaseDir(val)
    if (val) {
      localStorage.setItem(DOCS_BASEDIR_KEY, val)
    } else {
      localStorage.removeItem(DOCS_BASEDIR_KEY)
    }
    setShowBaseConfig(false)
    setSelectedPath(null)
    setContent('')
  }

  const loadFiles = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listSessionFiles(sessionId, '*.md', effectiveBaseDir)
      setFiles(data)
      if (data.length > 0 && !selectedPath) {
        selectFile(data[0].path)
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [sessionId, effectiveBaseDir])

  const selectFile = async (path: string) => {
    setSelectedPath(path)
    setEditing(false)
    setLoadingContent(true)
    try {
      const text = await getSessionFile(sessionId, path, effectiveBaseDir)
      setContent(text)
    } catch (e: any) {
      setContent(`*Error loading file: ${e.message}*`)
    }
    setLoadingContent(false)
  }

  useEffect(() => { loadFiles() }, [loadFiles])

  // Close context menu on click outside
  useEffect(() => {
    const handler = () => setCtxMenu(null)
    if (ctxMenu) {
      document.addEventListener('click', handler)
      return () => document.removeEventListener('click', handler)
    }
  }, [ctxMenu])

  // Focus rename input
  useEffect(() => {
    if (renamingPath && renameRef.current) {
      renameRef.current.focus()
      renameRef.current.select()
    }
  }, [renamingPath])

  // Focus create input
  useEffect(() => {
    if (creating && createRef.current) {
      createRef.current.focus()
    }
  }, [creating])

  // ── Actions ──

  const handleSave = async () => {
    if (!selectedPath) return
    setSaving(true)
    try {
      await writeSessionFile(sessionId, selectedPath, editContent)
      setContent(editContent)
      setEditing(false)
    } catch (e: any) {
      alert(`Save failed: ${e.message}`)
    }
    setSaving(false)
  }

  const handleStartEdit = () => {
    setEditContent(content)
    setEditing(true)
  }

  const handleDelete = async (path: string, type: 'file' | 'dir') => {
    const label = type === 'file' ? 'file' : 'directory'
    if (!confirm(`Delete ${label} "${path}"?`)) return
    try {
      if (type === 'file') {
        await deleteSessionFile(sessionId, path)
        if (selectedPath === path) {
          setSelectedPath(null)
          setContent('')
          setEditing(false)
        }
      } else {
        await deleteSessionDir(sessionId, path)
      }
      loadFiles()
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`)
    }
  }

  const handleRenameStart = (path: string) => {
    const parts = path.split('/')
    setRenamingPath(path)
    setRenameValue(parts[parts.length - 1])
    setCtxMenu(null)
  }

  const handleRenameSubmit = async () => {
    if (!renamingPath || !renameValue.trim()) {
      setRenamingPath(null)
      return
    }
    const parts = renamingPath.split('/')
    parts[parts.length - 1] = renameValue.trim()
    const newPath = parts.join('/')
    if (newPath === renamingPath) {
      setRenamingPath(null)
      return
    }
    try {
      // Determine if it's a file or directory
      const isDir = !files.some(f => f.path === renamingPath)
      if (isDir) {
        await renameSessionDir(sessionId, renamingPath, newPath)
      } else {
        await renameSessionFile(sessionId, renamingPath, newPath)
        if (selectedPath === renamingPath) {
          setSelectedPath(newPath)
        }
      }
      loadFiles()
    } catch (e: any) {
      alert(`Rename failed: ${e.message}`)
    }
    setRenamingPath(null)
  }

  const handleCreate = async () => {
    if (!createPath.trim() || !creating) return
    try {
      if (creating === 'file') {
        // Ensure .md extension
        let path = createPath.trim()
        if (!path.endsWith('.md')) path += '.md'
        await writeSessionFile(sessionId, path, `# ${path.replace(/\.md$/, '').split('/').pop()}\n`)
        loadFiles()
        // Select the new file after reload
        setTimeout(() => selectFile(path), 300)
      } else {
        await createSessionDir(sessionId, createPath.trim())
        loadFiles()
      }
    } catch (e: any) {
      alert(`Create failed: ${e.message}`)
    }
    setCreating(null)
    setCreatePath('')
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const reader = new FileReader()
      reader.onload = async () => {
        const base64 = (reader.result as string).split(',')[1]
        await uploadSessionFile(sessionId, file.name, base64)
        loadFiles()
      }
      reader.readAsDataURL(file)
    } catch (err: any) {
      alert(`Upload failed: ${err.message}`)
    }
    // Reset input
    if (uploadRef.current) uploadRef.current.value = ''
  }

  const handleContextMenu = (e: React.MouseEvent, type: 'file' | 'dir', path: string) => {
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, type, path })
  }

  // Group files by directory
  const grouped = groupByDir(files)

  return (
    <div className="flex h-full">
      {/* File list */}
      <div className="w-56 border-r border-[var(--border)] flex flex-col bg-[var(--bg-secondary)] shrink-0">
        <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border)]">
          <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Files
          </span>
          <div className="flex items-center gap-0.5">
            {isTmux && (
              <button
                onClick={() => { setShowBaseConfig(!showBaseConfig); setBaseDirInput(docsBaseDir) }}
                className={`p-1 rounded transition-colors ${
                  docsBaseDir
                    ? 'text-[var(--accent-blue)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
                title={docsBaseDir ? `Docs: ${docsBaseDir}` : 'Set docs base directory'}
              >
                <Settings size={12} />
              </button>
            )}
            <button
              onClick={() => { setCreating('file'); setCreatePath('') }}
              className="p-1 text-[var(--text-secondary)] hover:text-[var(--accent-green-text)] rounded transition-colors"
              title="New file"
            >
              <Plus size={12} />
            </button>
            <button
              onClick={() => { setCreating('dir'); setCreatePath('') }}
              className="p-1 text-[var(--text-secondary)] hover:text-[var(--accent-green-text)] rounded transition-colors"
              title="New directory"
            >
              <FolderPlus size={12} />
            </button>
            <button
              onClick={() => uploadRef.current?.click()}
              className="p-1 text-[var(--text-secondary)] hover:text-[var(--accent-blue)] rounded transition-colors"
              title="Upload file"
            >
              <Upload size={12} />
            </button>
            <input ref={uploadRef} type="file" className="hidden" onChange={handleUpload} />
            <button
              onClick={loadFiles}
              className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
              title="Refresh"
            >
              <RefreshCw size={12} />
            </button>
          </div>
        </div>

        {/* Docs base directory config */}
        {showBaseConfig && (
          <div className="px-2 py-1.5 border-b border-[var(--border)] bg-[var(--bg-tertiary)]">
            <div className="text-[10px] text-[var(--text-muted)] mb-1">Docs base directory</div>
            <div className="flex items-center gap-1">
              <input
                value={baseDirInput}
                onChange={e => setBaseDirInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') applyBaseDir()
                  if (e.key === 'Escape') setShowBaseConfig(false)
                }}
                placeholder="Leave empty for session default"
                autoFocus
                className="flex-1 text-[11px] bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)] placeholder-[var(--text-muted)]"
              />
              <button onClick={applyBaseDir} className="p-0.5 text-[var(--accent-green-text)] hover:text-green-400" title="Apply">
                <Check size={12} />
              </button>
              <button onClick={() => setShowBaseConfig(false)} className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]" title="Cancel">
                <X size={12} />
              </button>
            </div>
          </div>
        )}

        {/* Create new file/dir inline */}
        {creating && (
          <div className="px-2 py-1.5 border-b border-[var(--border)] bg-[var(--bg-tertiary)]">
            <div className="text-[10px] text-[var(--text-muted)] mb-1">
              New {creating === 'file' ? 'markdown file' : 'directory'}
            </div>
            <div className="flex items-center gap-1">
              <input
                ref={createRef}
                value={createPath}
                onChange={e => setCreatePath(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreate()
                  if (e.key === 'Escape') { setCreating(null); setCreatePath('') }
                }}
                placeholder={creating === 'file' ? 'path/file.md' : 'path/dirname'}
                className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[var(--text-primary)] outline-none focus:border-[var(--accent-blue)] placeholder-[var(--text-muted)]"
              />
              <button onClick={handleCreate} className="p-0.5 text-[var(--accent-green-text)] hover:text-green-400">
                <Check size={12} />
              </button>
              <button onClick={() => { setCreating(null); setCreatePath('') }} className="p-0.5 text-[var(--text-secondary)] hover:text-[var(--accent-red)]">
                <X size={12} />
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">Loading...</div>
          ) : files.length === 0 ? (
            <div className="px-3 py-4 text-center">
              <FileText size={20} className="mx-auto text-[var(--text-muted)] mb-2" />
              <p className="text-[10px] text-[var(--text-muted)]">No markdown files found</p>
              <button
                onClick={() => { setCreating('file'); setCreatePath('') }}
                className="mt-2 text-[10px] text-[var(--accent-blue)] hover:underline"
              >
                Create one
              </button>
            </div>
          ) : (
            Object.entries(grouped).map(([dir, dirFiles]) => (
              <div key={dir}>
                {dir !== '.' && (
                  <div
                    className="flex items-center gap-1 px-3 py-1 text-[10px] text-[var(--text-muted)] group/dir cursor-default"
                    onContextMenu={e => handleContextMenu(e, 'dir', dir)}
                  >
                    <Folder size={10} />
                    <span className="flex-1 truncate">{dir}/</span>
                    <button
                      onClick={e => { e.stopPropagation(); handleContextMenu(e, 'dir', dir) }}
                      className="p-0.5 opacity-0 group-hover/dir:opacity-100 hover:text-[var(--text-primary)] transition-opacity"
                    >
                      <MoreHorizontal size={10} />
                    </button>
                  </div>
                )}
                {dirFiles.map(f => (
                  <div key={f.path} className="group/file">
                    {renamingPath === f.path ? (
                      <div className="flex items-center gap-1 px-3 py-1.5">
                        {dir !== '.' && <ChevronRight size={8} className="shrink-0 opacity-0" />}
                        <FileText size={12} className="shrink-0 text-[var(--text-secondary)]" />
                        <input
                          ref={renameRef}
                          value={renameValue}
                          onChange={e => setRenameValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleRenameSubmit()
                            if (e.key === 'Escape') setRenamingPath(null)
                          }}
                          onBlur={handleRenameSubmit}
                          className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--accent-blue)] rounded px-1 py-0 text-[var(--text-primary)] outline-none min-w-0"
                        />
                      </div>
                    ) : (
                      <button
                        onClick={() => selectFile(f.path)}
                        onContextMenu={e => handleContextMenu(e, 'file', f.path)}
                        className={`flex items-center gap-1.5 w-full px-3 py-1.5 text-xs transition-colors ${
                          selectedPath === f.path
                            ? 'bg-[var(--bg-primary)] text-[var(--accent-blue)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {dir !== '.' && <ChevronRight size={8} className="shrink-0 opacity-0" />}
                        <FileText size={12} className="shrink-0" />
                        <span className="truncate flex-1 text-left">{f.name}</span>
                        <button
                          onClick={e => { e.stopPropagation(); handleContextMenu(e, 'file', f.path) }}
                          className="p-0.5 opacity-0 group-hover/file:opacity-100 hover:text-[var(--text-primary)] transition-opacity shrink-0"
                        >
                          <MoreHorizontal size={10} />
                        </button>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        {selectedPath && (
          <div className="flex items-center justify-between px-4 h-9 border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0">
            <span className="text-[10px] text-[var(--text-muted)] font-mono truncate">{selectedPath}</span>
            <div className="flex items-center gap-1 shrink-0">
              {editing ? (
                <>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium bg-[var(--accent-blue)] hover:bg-[var(--accent-blue-hover)] text-white rounded transition-colors disabled:opacity-50"
                  >
                    <Save size={10} />
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)] rounded transition-colors"
                  >
                    <Eye size={10} />
                    Preview
                  </button>
                </>
              ) : (
                <button
                  onClick={handleStartEdit}
                  className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)] rounded transition-colors"
                >
                  <Edit3 size={10} />
                  Edit
                </button>
              )}
            </div>
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 overflow-y-auto">
          {loadingContent ? (
            <div className="p-6 text-sm text-[var(--text-muted)]">Loading...</div>
          ) : selectedPath ? (
            editing ? (
              <textarea
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                className="w-full h-full p-6 text-sm font-mono bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none resize-none leading-relaxed"
                spellCheck={false}
              />
            ) : (
              <div className="p-6 max-w-3xl mx-auto">
                <article className="text-sm text-[var(--text-primary)] leading-relaxed">
                  <MarkdownContent text={content} isComplete={true} />
                </article>
              </div>
            )
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
              Select a file to view
            </div>
          )}
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="fixed z-50 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg py-1 shadow-xl min-w-[140px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button
            onClick={() => { handleRenameStart(ctxMenu.path); }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <Pencil size={12} />
            Rename
          </button>
          <button
            onClick={() => { handleDelete(ctxMenu.path, ctxMenu.type); setCtxMenu(null) }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--accent-red)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

function groupByDir(files: FileEntry[]): Record<string, FileEntry[]> {
  const groups: Record<string, FileEntry[]> = {}
  for (const f of files) {
    const parts = f.path.split('/')
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.'
    if (!groups[dir]) groups[dir] = []
    groups[dir].push(f)
  }
  return groups
}
