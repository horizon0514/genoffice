import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  RzConnectionStatus,
  RzProjectSummary,
  RzSyncOutcome,
  WorkspaceSummary,
} from '../../shared/workspace-api'

interface Props {
  initialWorkspace: WorkspaceSummary | null
  onClose: () => void
  onSynced: (workspace: WorkspaceSummary) => void
  onOpenSettings: () => void
}

type Busy = 'status' | 'projects' | 'sync' | null

const STATUS_LABEL: Record<string, string> = {
  created: '已创建',
  doing: '进行中',
  ready: '待归档',
  done: '已完成',
}

function statusLabel(status?: string): string {
  if (!status) return '未知'
  return STATUS_LABEL[status] ?? status
}

function formatDate(iso?: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

export function RzProjectsModal({ initialWorkspace, onClose, onSynced, onOpenSettings }: Props) {
  const api = window.workspaceApi
  const [status, setStatus] = useState<RzConnectionStatus | null>(null)
  const [projects, setProjects] = useState<RzProjectSummary[]>([])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<'new' | 'current'>(initialWorkspace ? 'current' : 'new')
  const [busy, setBusy] = useState<Busy>('status')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RzSyncOutcome | null>(null)

  const loadProjects = useCallback(async () => {
    if (!api) return
    setBusy('projects')
    setError(null)
    try {
      const res = await api.rzProjects()
      if (!res.ok) {
        setProjects([])
        setError(res.error ?? '读取项目列表失败')
        return
      }
      setProjects(res.projects)
      setSelectedId((current) => {
        if (current && res.projects.some((p) => p.id === current)) return current
        return res.projects[0]?.id ?? null
      })
    } finally {
      setBusy(null)
    }
  }, [api])

  useEffect(() => {
    if (!api) {
      setBusy(null)
      setError('Workspace bridge 不可用')
      return
    }
    let cancelled = false
    void (async () => {
      const next = await api.rzStatus()
      if (cancelled) return
      setStatus(next)
      setBusy(null)
      if (next.connected) {
        await loadProjects()
      } else {
        if (next.error) setError(next.error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, loadProjects])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && busy !== 'sync') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return projects
    return projects.filter((p) =>
      [p.name, p.projectCode, p.taskName, p.ownerName, p.client]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle)),
    )
  }, [projects, query])

  const selected = projects.find((p) => p.id === selectedId) ?? null

  const sync = async () => {
    if (!api || !selected) return
    setBusy('sync')
    setError(null)
    setResult(null)
    try {
      const outcome = await api.rzSync(selected.id, mode)
      setResult(outcome)
      if (!outcome.ok) {
        setError(outcome.error ?? '同步失败')
        return
      }
      if (outcome.workspace) onSynced(outcome.workspace)
    } finally {
      setBusy(null)
    }
  }

  const openTask = async () => {
    if (!api || !selected?.taskUrl) return
    await api.openUrl(selected.taskUrl)
  }

  const connected = status?.connected === true

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal rz-modal"
        role="dialog"
        aria-modal="true"
        aria-label="从 rz-system 同步项目"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="rz-modal-head">
          <div>
            <h3>从 rz-system 同步项目</h3>
            <p className="rz-subtitle">
              {connected
                ? `已连接 ${status?.name || status?.email || ''} · ${status?.baseUrl ?? ''}`
                : '选择一个项目，自动创建或更新本地工作空间'}
            </p>
          </div>
          <button
            className="btn btn-secondary rz-small"
            onClick={onClose}
            disabled={busy === 'sync'}
          >
            关闭
          </button>
        </div>

        {connected && (
          <div className="rz-toolbar">
            <input
              className="rz-search"
              type="search"
              placeholder="搜索项目名称、编码、任务或负责人"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button className="btn btn-secondary rz-small" onClick={() => void loadProjects()}>
              {busy === 'projects' ? '刷新中…' : '刷新列表'}
            </button>
          </div>
        )}

        {!connected && (
          <div className="rz-login-needed">
            {busy === 'status' ? (
              <span className="rz-login-title">正在检查 rz-system 连接…</span>
            ) : (
              <>
                <span className="rz-login-title">先连接 rz-system</span>
                <span className="rz-login-desc">
                  账号、密码和服务地址已移到设置里的「账户」页，登录后回到这里选择项目。
                </span>
                <button className="btn btn-primary" onClick={onOpenSettings}>
                  前往设置登录
                </button>
              </>
            )}
          </div>
        )}

        {error && <div className="rz-error">{error}</div>}

        {result?.ok && (
          <div className="rz-result">
            <strong>同步完成：{result.workspace?.name ?? selected?.name}</strong>
            <span>
              下载 {result.downloaded} · 跳过已存在 {result.skipped} · 失败 {result.failed}
            </span>
            {result.workspace && <code>{result.workspace.dir}</code>}
            {result.warnings.length > 0 && (
              <ul>
                {result.warnings.slice(0, 4).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {connected && (
          <div className="rz-project-list" role="listbox" aria-label="rz-system 项目">
            {busy === 'projects' && projects.length === 0 && (
              <div className="rz-empty">正在读取项目列表…</div>
            )}
            {busy !== 'projects' && filtered.length === 0 && (
              <div className="rz-empty">没有匹配的项目</div>
            )}
            {filtered.map((project) => (
              <button
                key={project.id}
                className={`rz-project-row${project.id === selectedId ? ' active' : ''}`}
                role="option"
                aria-selected={project.id === selectedId}
                onClick={() => {
                  setSelectedId(project.id)
                  setResult(null)
                }}
              >
                <span className="rz-project-main">
                  <span className="rz-project-name">{project.name}</span>
                  <span className="rz-project-meta">
                    {project.projectCode ?? `#${project.id}`}
                    {project.taskName ? ` · ${project.taskName}` : ''}
                    {project.ownerName ? ` · 负责人 ${project.ownerName}` : ''}
                  </span>
                </span>
                <span className={`rz-status rz-status-${project.status ?? 'unknown'}`}>
                  {statusLabel(project.status)}
                </span>
                <span className="rz-project-files">
                  {project.fileCount > 0 ? `${project.fileCount} 个文件` : '暂无附件'}
                </span>
                <span className="rz-project-date">{formatDate(project.updatedAt)}</span>
              </button>
            ))}
          </div>
        )}

        {connected && (
          <>
            <div className="rz-mode-row">
              <label className="rz-mode">
                <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} />
                新建项目工作空间
              </label>
              <label className="rz-mode">
                <input
                  type="radio"
                  checked={mode === 'current'}
                  onChange={() => setMode('current')}
                />
                同步到当前工作空间
                {initialWorkspace ? `（${initialWorkspace.name}）` : '（未打开）'}
              </label>
            </div>

            <div className="rz-note">
              文档会下载到本地工作空间；已存在的同名文件默认跳过，不覆盖本地编辑。审批仍在 rz-system
              内完成。
            </div>

            <div className="modal-buttons rz-actions">
              <button
                className="btn btn-secondary"
                disabled={!selected?.taskUrl}
                onClick={() => void openTask()}
              >
                在 rz-system 打开任务 / 审批
              </button>
              <button
                className="btn btn-primary"
                disabled={!selected || busy === 'sync'}
                onClick={() => void sync()}
              >
                {busy === 'sync' ? '正在同步…' : '同步所选项目'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
