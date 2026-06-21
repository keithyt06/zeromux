import { useState, useEffect, useCallback, useRef } from 'react'
import MarkdownContent from './markdown/MarkdownContent'
import DirectoryPicker from './DirectoryPicker'
import {
  listDir, fileRawUrl, getSessionFile,
  uploadSessionFile, createSessionDir, deleteSessionDir,
  deleteSessionFile, renameSessionFile, renameSessionDir,
} from '../lib/api'
import type { DirListEntry } from '../lib/api'
import {
  RefreshCw, Folder, FileText, Download, Upload, FolderPlus,
  MoreHorizontal, Pencil, Trash2, ChevronRight, Home, AlertCircle,
  HardDrive, X,
} from 'lucide-react'

interface Props {
  sessionId: string
}

// Per-session persisted browse root. Empty string = use the session work_dir
// (default, focuses the current project). An absolute path re-roots the browser
// to anywhere under $HOME (the backend enforces that bound).
const rootKey = (sessionId: string) => `zeromux:fb-root:${sessionId}`

type Preview =
  | { kind: 'image'; path: string }
  | { kind: 'html'; path: string; text: string }
  | { kind: 'markdown'; path: string; text: string }
  | { kind: 'text'; path: string; text: string }
  | { kind: 'unsupported'; path: string }
  | { kind: 'loading'; path: string }
  | { kind: 'error'; path: string; message: string }
  | null

type RowMenu = { x: number; y: number; entry: DirListEntry } | null

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']
const HTML_EXTS = ['html', 'htm']
const MD_EXTS = ['md', 'markdown']
// Common plaintext / config / source extensions we can show in a <pre>.
const TEXT_EXTS = [
  'txt', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'log', 'csv', 'tsv', 'xml', 'sh', 'bash', 'zsh', 'rs', 'ts', 'tsx',
  'js', 'jsx', 'py', 'go', 'java', 'c', 'h', 'cpp', 'css', 'scss',
  'sql', 'env', 'lock', 'gitignore', 'dockerfile', 'makefile',
]

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function ext(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return name.toLowerCase()
  return name.slice(dot + 1).toLowerCase()
}

function join(cwd: string, name: string): string {
  return cwd ? `${cwd}/${name}` : name
}

// Read a File as base64 (strip the data: prefix) for uploadSessionFile.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function FileBrowser({ sessionId }: Props) {
  const [cwd, setCwd] = useState('')
  // Browse root (absolute path) or '' = work_dir. Lazy-init from localStorage.
  const [root, setRoot] = useState<string>(() => {
    try { return localStorage.getItem(rootKey(sessionId)) || '' } catch { return '' }
  })
  const [pickingRoot, setPickingRoot] = useState(false)
  const [entries, setEntries] = useState<DirListEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview>(null)
  const [menu, setMenu] = useState<RowMenu>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)

  // When re-rooted (root set), the browser is READ-ONLY: the write endpoints
  // (upload/mkdir/rename/delete) ignore base_dir and would silently target the
  // work_dir, not the chosen root. So writes are only offered at the default root.
  const effectiveBase = root || undefined
  const readOnly = root !== ''

  const uploadRef = useRef<HTMLInputElement>(null)

  // Bumped to force a re-list after a write op without restructuring deps.
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey(k => k + 1), [])

  // Fetch the listing in the effect with an ignore-flag so a stale response
  // (cwd changed mid-flight, or unmount) never lands. setState only happens
  // inside the async closure, never synchronously in the effect body.
  useEffect(() => {
    let ignore = false
    listDir(sessionId, cwd, effectiveBase)
      .then(data => {
        if (ignore) return
        setEntries(data.entries)
        setTruncated(data.truncated)
        setError(null)
        setLoading(false)
      })
      .catch(e => {
        if (ignore) return
        setError(errMsg(e) || 'Failed to list directory')
        setEntries([])
        setLoading(false)
      })
    return () => { ignore = true }
  }, [sessionId, cwd, effectiveBase, reloadKey])

  // Switch browse root to an absolute path under $HOME; reset into its top level.
  const chooseRoot = (abs: string) => {
    setPickingRoot(false)
    setPreview(null)
    setCwd('')
    setRoot(abs)
    try { localStorage.setItem(rootKey(sessionId), abs) } catch { /* ignore */ }
  }

  // Back to the session work_dir (default root).
  const resetRoot = () => {
    setPreview(null)
    setCwd('')
    setRoot('')
    try { localStorage.removeItem(rootKey(sessionId)) } catch { /* ignore */ }
  }

  // Close row menu on outside click.
  useEffect(() => {
    if (!menu) return
    const handler = () => setMenu(null)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [menu])

  const openDir = (name: string) => {
    setPreview(null)
    setCwd(join(cwd, name))
  }

  const goCrumb = (idx: number) => {
    setPreview(null)
    if (idx < 0) { setCwd(''); return }
    setCwd(cwd.split('/').slice(0, idx + 1).join('/'))
  }

  const openFile = async (entry: DirListEntry) => {
    const path = join(cwd, entry.name)
    const e = ext(entry.name)
    if (IMAGE_EXTS.includes(e)) {
      setPreview({ kind: 'image', path })
      return
    }
    if (HTML_EXTS.includes(e) || MD_EXTS.includes(e) || TEXT_EXTS.includes(e)) {
      setPreview({ kind: 'loading', path })
      try {
        const text = await getSessionFile(sessionId, path, effectiveBase)
        if (HTML_EXTS.includes(e)) setPreview({ kind: 'html', path, text })
        else if (MD_EXTS.includes(e)) setPreview({ kind: 'markdown', path, text })
        else setPreview({ kind: 'text', path, text })
      } catch (err) {
        setPreview({ kind: 'error', path, message: errMsg(err) || 'Failed to read file' })
      }
      return
    }
    setPreview({ kind: 'unsupported', path })
  }

  // ── Upload (drag-drop + picker), targeting the current cwd ──
  const uploadFiles = async (files: FileList | File[]) => {
    if (readOnly) return // re-rooted browser is read-only (writes hit work_dir)
    for (const file of Array.from(files)) {
      const path = join(cwd, file.name)
      // Pre-check existence in the current listing for an overwrite confirm.
      if (entries.some(en => en.name === file.name && en.type === 'file')) {
        if (!confirm(`「${file.name}」已存在，覆盖？`)) continue
      }
      try {
        setUploadMsg(`上传 ${file.name}…`)
        const base64 = await fileToBase64(file)
        await uploadSessionFile(sessionId, path, base64)
      } catch (e) {
        const msg = errMsg(e)
        // 409 = conflict (race: created after our listing). Offer overwrite.
        if (msg.includes('409') || /exist/i.test(msg)) {
          if (confirm(`「${file.name}」已存在，覆盖？`)) {
            try {
              const base64 = await fileToBase64(file)
              await uploadSessionFile(sessionId, path, base64)
            } catch (e2) {
              setUploadMsg(`上传失败: ${errMsg(e2)}`)
            }
          }
        } else {
          setUploadMsg(`上传失败: ${msg}`)
        }
      }
    }
    setUploadMsg(null)
    reload()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (readOnly) return
    if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files)
  }

  const handlePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) uploadFiles(e.target.files)
    if (uploadRef.current) uploadRef.current.value = ''
  }

  // ── Write ops (mkdir / rename / delete) ──
  const handleMkdir = async () => {
    const name = prompt('新建文件夹名称')?.trim()
    if (!name) return
    try {
      // cwd already exists (it is the browsed dir); creating a child dir under it
      // is the single mkdir the backend needs — no parent auto-create.
      await createSessionDir(sessionId, join(cwd, name))
      reload()
    } catch (e) {
      alert(`创建失败: ${errMsg(e)}`)
    }
  }

  const handleRename = async (entry: DirListEntry) => {
    setMenu(null)
    const next = prompt('重命名为', entry.name)?.trim()
    if (!next || next === entry.name) return
    const from = join(cwd, entry.name)
    const to = join(cwd, next)
    try {
      if (entry.type === 'dir') await renameSessionDir(sessionId, from, to)
      else await renameSessionFile(sessionId, from, to)
      if (preview && preview.path === from) setPreview(null)
      reload()
    } catch (e) {
      alert(`重命名失败: ${errMsg(e)}`)
    }
  }

  const handleDelete = async (entry: DirListEntry) => {
    setMenu(null)
    const label = entry.type === 'dir' ? '文件夹' : '文件'
    if (!confirm(`删除${label}「${entry.name}」？`)) return
    const path = join(cwd, entry.name)
    try {
      if (entry.type === 'dir') await deleteSessionDir(sessionId, path)
      else await deleteSessionFile(sessionId, path)
      if (preview && preview.path === path) setPreview(null)
      reload()
    } catch (e) {
      alert(`删除失败: ${errMsg(e)}`)
    }
  }

  const crumbs = cwd ? cwd.split('/') : []

  return (
    <div
      className="flex h-full min-w-0"
      onDragOver={e => { if (readOnly) return; e.preventDefault(); setDragOver(true) }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false) }}
      onDrop={handleDrop}
    >
      {/* List column */}
      <div className="w-72 max-w-[40%] border-r border-[var(--border)] flex flex-col bg-[var(--bg-secondary)] shrink-0">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-3 h-9 border-b border-[var(--border)]">
          <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Files
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setPickingRoot(true)}
              className="p-1 text-[var(--text-secondary)] hover:text-[var(--accent-blue)] rounded transition-colors"
              title="选择根目录"
            >
              <HardDrive size={12} />
            </button>
            {!readOnly && (
              <>
                <button
                  onClick={handleMkdir}
                  className="p-1 text-[var(--text-secondary)] hover:text-[var(--accent-green-text)] rounded transition-colors"
                  title="新建文件夹"
                >
                  <FolderPlus size={12} />
                </button>
                <button
                  onClick={() => uploadRef.current?.click()}
                  className="p-1 text-[var(--text-secondary)] hover:text-[var(--accent-blue)] rounded transition-colors"
                  title="上传到当前目录"
                >
                  <Upload size={12} />
                </button>
                <input ref={uploadRef} type="file" multiple className="hidden" onChange={handlePick} />
              </>
            )}
            <button
              onClick={reload}
              className="p-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors"
              title="刷新"
            >
              <RefreshCw size={12} />
            </button>
          </div>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 border-b border-[var(--border)] text-[11px]">
          <button
            onClick={() => goCrumb(-1)}
            className="flex items-center gap-1 px-1 py-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors truncate max-w-[10rem]"
            title={readOnly ? root : '会话工作目录'}
          >
            <Home size={11} className="shrink-0" />
            {readOnly ? (root.split('/').filter(Boolean).pop() || root) : '根目录'}
          </button>
          {readOnly && (
            <button
              onClick={resetRoot}
              className="flex items-center px-1 py-0.5 rounded text-[var(--text-muted)] hover:text-[var(--accent-red)] hover:bg-[var(--bg-tertiary)] transition-colors"
              title="回到会话工作目录"
            >
              <X size={11} />
            </button>
          )}
          {crumbs.map((seg, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <ChevronRight size={10} className="text-[var(--text-muted)]" />
              <button
                onClick={() => goCrumb(i)}
                className="px-1 py-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors truncate max-w-[8rem]"
              >
                {seg}
              </button>
            </span>
          ))}
        </div>

        {/* Entries */}
        <div className="flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">Loading...</div>
          ) : error ? (
            <div className="px-3 py-4 text-center text-[10px] text-[var(--accent-red)]">{error}</div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-4 text-center text-[10px] text-[var(--text-muted)]">空目录</div>
          ) : (
            entries.map(en => (
              <div key={en.name} className="group/row flex items-center">
                <button
                  onClick={() => (en.type === 'dir' ? openDir(en.name) : openFile(en))}
                  className={`flex items-center gap-1.5 flex-1 min-w-0 px-3 py-1.5 text-xs transition-colors ${
                    preview && preview.path === join(cwd, en.name)
                      ? 'bg-[var(--bg-primary)] text-[var(--accent-blue)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {en.type === 'dir'
                    ? <Folder size={12} className="shrink-0 text-[var(--accent-blue)]" />
                    : <FileText size={12} className="shrink-0" />}
                  <span className="truncate flex-1 text-left">{en.name}</span>
                </button>
                {en.type === 'file' && (
                  <a
                    href={fileRawUrl(sessionId, join(cwd, en.name), effectiveBase)}
                    download={en.name}
                    onClick={e => e.stopPropagation()}
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--accent-blue)] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0"
                    title="下载"
                  >
                    <Download size={11} />
                  </a>
                )}
                {!readOnly && (
                  <button
                    onClick={e => {
                      e.stopPropagation()
                      setMenu({ x: e.clientX, y: e.clientY, entry: en })
                    }}
                    className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] opacity-0 group-hover/row:opacity-100 transition-opacity shrink-0"
                    title="更多"
                  >
                    <MoreHorizontal size={11} />
                  </button>
                )}
              </div>
            ))
          )}
          {truncated && (
            <div className="px-3 py-2 text-[10px] text-[var(--text-muted)]">已截断（目录过大）</div>
          )}
        </div>
      </div>

      {/* Preview pane */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {preview && (
          <div className="flex items-center px-4 h-9 border-b border-[var(--border)] bg-[var(--bg-secondary)] shrink-0">
            <span className="text-[10px] text-[var(--text-muted)] font-mono truncate flex-1">{preview.path}</span>
            <a
              href={fileRawUrl(sessionId, preview.path, effectiveBase)}
              download
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)] rounded transition-colors"
            >
              <Download size={10} />
              下载
            </a>
          </div>
        )}
        <div className="flex-1 overflow-auto">
          {!preview ? (
            <div className="flex items-center justify-center h-full text-sm text-[var(--text-muted)]">
              选择文件以预览
            </div>
          ) : preview.kind === 'loading' ? (
            <div className="p-6 text-sm text-[var(--text-muted)]">Loading...</div>
          ) : preview.kind === 'error' ? (
            <div className="p-6 text-sm text-[var(--accent-red)]">{preview.message}</div>
          ) : preview.kind === 'image' ? (
            <div className="flex items-center justify-center h-full p-6">
              <img src={fileRawUrl(sessionId, preview.path, effectiveBase)} alt={preview.path} className="max-w-full max-h-full object-contain" />
            </div>
          ) : preview.kind === 'html' ? (
            // srcDoc (NOT src=data:/blob:) — CSP frame-src 'self' blocks those.
            // Empty sandbox: no scripts, no same-origin — agent HTML can't execute.
            <iframe sandbox="" srcDoc={preview.text} title={preview.path} className="w-full h-full border-0 bg-white" />
          ) : preview.kind === 'markdown' ? (
            <div className="p-6 max-w-3xl mx-auto">
              <article className="text-sm text-[var(--text-primary)] leading-relaxed">
                <MarkdownContent text={preview.text} isComplete={true} />
              </article>
            </div>
          ) : preview.kind === 'text' ? (
            <pre className="p-6 text-xs font-mono text-[var(--text-primary)] whitespace-pre-wrap break-words leading-relaxed">{preview.text}</pre>
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--text-muted)]">
              <AlertCircle size={24} />
              <span className="text-sm">不支持预览</span>
              <a
                href={fileRawUrl(sessionId, preview.path, effectiveBase)}
                download
                className="flex items-center gap-1 px-3 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border)] rounded transition-colors"
              >
                <Download size={12} />
                下载
              </a>
            </div>
          )}
        </div>

        {/* Drag-drop overlay */}
        {dragOver && (
          <div className="absolute inset-0 z-40 flex items-center justify-center bg-[var(--bg-primary)]/80 border-2 border-dashed border-[var(--accent-blue)] pointer-events-none">
            <span className="text-sm text-[var(--accent-blue)]">拖放以上传到 {cwd ? `/${cwd}` : '当前目录'}</span>
          </div>
        )}
        {uploadMsg && (
          <div className="absolute bottom-3 right-3 z-50 px-3 py-1.5 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded shadow-lg text-[var(--text-primary)]">
            {uploadMsg}
          </div>
        )}
      </div>

      {/* Row menu */}
      {menu && (
        <div
          className="fixed z-50 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg py-1 shadow-xl min-w-[140px]"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            onClick={() => handleRename(menu.entry)}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <Pencil size={12} />
            重命名
          </button>
          <button
            onClick={() => handleDelete(menu.entry)}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--accent-red)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <Trash2 size={12} />
            删除
          </button>
        </div>
      )}

      {/* Root picker: re-root the browser anywhere under $HOME (read-only) */}
      {pickingRoot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl overflow-hidden">
            <DirectoryPicker
              initialPath={root || undefined}
              onSelect={chooseRoot}
              onCancel={() => setPickingRoot(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default FileBrowser
