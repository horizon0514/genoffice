import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  HandoffDiffEntry,
  HandoffDownloadResult,
  HandoffPublishResult,
  HandoffSummary,
  WorkspaceSummary,
} from '../../shared/workspace-api'

type WorkspaceProject = WorkspaceSummary['projects'][number]

interface Props {
  workspace: WorkspaceSummary
  project: WorkspaceProject
  currentUserName?: string
  onClose: () => void
  onApplied: () => void
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const KIND_LABEL: Record<HandoffDiffEntry['kind'], string> = {
  new: '新增',
  changed: '修改',
  unchanged: '未变',
}

export function HandoffModal({ workspace, project, currentUserName, onClose, onApplied }: Props) {
  const api = window.workspaceApi
  const [handoffs, setHandoffs] = useState<HandoffSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState<HandoffPublishResult | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [download, setDownload] = useState<HandoffDownloadResult | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [appliedCount, setAppliedCount] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!api) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.handoffList(project.id)
      if (!res.ok) {
        setHandoffs([])
        setError(res.error ?? '读取交接记录失败')
        return
      }
      setHandoffs(res.handoffs)
    } finally {
      setLoading(false)
    }
  }, [api, project.id])

  useEffect(() => {
    void load()
  }, [load])

  const active = useMemo(
    () => handoffs.find((handoff) => handoff.id === activeId) ?? null,
    [handoffs, activeId],
  )

  const publish = async () => {
    if (!api) return
    setPublishing(true)
    setError(null)
    setPublished(null)
    try {
      const res = await api.handoffPublish(workspace.dir, note.trim() || undefined)
      if (!res.ok) {
        setError(res.error ?? '提交交接失败')
        return
      }
      setPublished(res)
      setNote('')
      await load()
    } finally {
      setPublishing(false)
    }
  }

  const openHandoff = async (handoff: HandoffSummary) => {
    if (!api) return
    setActiveId(handoff.id)
    setDownload(null)
    setSelectedPaths(new Set())
    setAppliedCount(null)
    setError(null)
    setDownloading(true)
    try {
      const res = await api.handoffDownload(workspace.dir, project.id, handoff.id)
      if (!res.ok) {
        setError(res.error ?? '下载交接失败')
        return
      }
      setDownload(res)
      setSelectedPaths(
        new Set((res.diff ?? []).filter((entry) => entry.kind !== 'unchanged').map((e) => e.path)),
      )
    } finally {
      setDownloading(false)
    }
  }

  const apply = async () => {
    if (!api || !download?.handoffId) return
    setApplying(true)
    setError(null)
    try {
      const res = await api.handoffApply(workspace.dir, download.handoffId, [...selectedPaths])
      if (!res.ok) {
        setError(res.error ?? '应用失败')
        return
      }
      setAppliedCount(res.applied)
      onApplied()
    } finally {
      setApplying(false)
    }
  }

  const copyLink = (url: string) => {
    void navigator.clipboard.writeText(url).catch(() => undefined)
  }

  const togglePath = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal rz-modal handoff-modal"
        role="dialog"
        aria-modal="true"
        aria-label="项目交接"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="rz-modal-head">
          <div>
            <h3>项目交接</h3>
            <p className="rz-subtitle">
              {project.projectCode ?? `#${project.id}`} · {project.name}
            </p>
          </div>
          <div className="handoff-head-actions">
            <button
              className="btn btn-secondary rz-small"
              disabled={!project.url}
              onClick={() => project.url && void api?.openUrl(project.url)}
            >
              在 rz-system 打开任务
            </button>
            <button className="btn btn-secondary rz-small" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>

        <div className="handoff-publish">
          <textarea
            className="handoff-note"
            rows={2}
            maxLength={500}
            placeholder="本次交接说明（可选），例如：初稿完成，请重点复核第三章。"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="handoff-publish-row">
            <span className="handoff-hint">提交后生成独立交接目录，不会覆盖其他人的提交。</span>
            <button
              className="btn btn-primary rz-small"
              disabled={publishing}
              onClick={() => void publish()}
            >
              {publishing ? '正在提交…' : '提交当前工作空间'}
            </button>
          </div>
          {published?.ok && (
            <div className="rz-result handoff-result">
              <strong>
                已提交 {published.fileCount ?? 0} 个文件 · {formatBytes(published.totalBytes ?? 0)}
              </strong>
              <span>交接 ID：{published.handoffId}</span>
              <button
                className="handoff-link-btn"
                onClick={() => published.url && copyLink(published.url)}
              >
                复制交接链接
              </button>
            </div>
          )}
        </div>

        <div className="handoff-list-head">
          <strong>交接记录</strong>
          <button className="handoff-link-btn" onClick={() => void load()} disabled={loading}>
            {loading ? '读取中…' : '刷新'}
          </button>
        </div>

        {error && <div className="rz-error">{error}</div>}

        <div className="handoff-body">
          <div className="handoff-list" role="listbox" aria-label="交接记录">
            {!loading && handoffs.length === 0 && (
              <div className="rz-empty">还没有交接记录，提交后其他人就能在这里看到。</div>
            )}
            {handoffs.map((handoff) => {
              const mine = !!currentUserName && handoff.authorName.trim() === currentUserName.trim()
              return (
                <button
                  key={handoff.id}
                  className={`handoff-row${handoff.id === activeId ? ' active' : ''}`}
                  role="option"
                  aria-selected={handoff.id === activeId}
                  onClick={() => void openHandoff(handoff)}
                >
                  <span className="handoff-row-top">
                    <span className="handoff-author">
                      {handoff.authorName}
                      {mine && <span className="handoff-badge">我</span>}
                    </span>
                    <span className="handoff-time">{formatTime(handoff.createdAt)}</span>
                  </span>
                  <span className="handoff-note-text">{handoff.note || '未填写交接说明'}</span>
                  <span className="handoff-row-meta">
                    {handoff.fileCount} 个文件 · {formatBytes(handoff.totalBytes)}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="handoff-detail">
            {!active && <div className="rz-empty">选择一条交接记录，下载并查看对方改了什么。</div>}
            {active && downloading && <div className="rz-empty">正在下载并比较文件…</div>}
            {active && !downloading && download?.ok && (
              <>
                <div className="handoff-detail-head">
                  <span>
                    {active.authorName} · {formatTime(active.createdAt)}
                  </span>
                  <span className="handoff-detail-actions">
                    <button className="handoff-link-btn" onClick={() => copyLink(active.url)}>
                      复制链接
                    </button>
                    <button
                      className="handoff-link-btn"
                      onClick={() => void api?.openUrl(active.url)}
                    >
                      浏览器打开
                    </button>
                  </span>
                </div>
                <div className="handoff-diff">
                  {(download.diff ?? []).map((entry) => (
                    <label key={entry.path} className="handoff-diff-row">
                      <input
                        type="checkbox"
                        checked={selectedPaths.has(entry.path)}
                        onChange={() => togglePath(entry.path)}
                      />
                      <span className={`handoff-kind handoff-kind-${entry.kind}`}>
                        {KIND_LABEL[entry.kind]}
                      </span>
                      <span className="handoff-path" title={entry.path}>
                        {entry.path}
                      </span>
                    </label>
                  ))}
                  {(download.diff ?? []).length === 0 && (
                    <div className="rz-empty">这个交接包里没有文件。</div>
                  )}
                </div>
                <div className="handoff-detail-foot">
                  <span className="handoff-hint">
                    {appliedCount === null
                      ? '应用会覆盖同名文件，不会删除本地其他文件。'
                      : `已应用 ${appliedCount} 个文件。`}
                  </span>
                  <button
                    className="btn btn-primary rz-small"
                    disabled={applying || selectedPaths.size === 0}
                    onClick={() => void apply()}
                  >
                    {applying ? '正在应用…' : `应用所选（${selectedPaths.size}）`}
                  </button>
                </div>
              </>
            )}
            {active && !downloading && download && !download.ok && (
              <div className="rz-empty">{download.error ?? '下载失败'}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
