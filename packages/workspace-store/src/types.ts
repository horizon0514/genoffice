export interface WorkspaceMember {
  id: string
  name: string
  role?: string
}

export interface WorkspaceProjectLink {
  id: string
  name: string
  /** Relative file paths under the workspace directory */
  files: string[]
  /** rz-system project code (e.g. PERF-DEMO-12) */
  projectCode?: string
  /** rz-system project lifecycle status: created | doing | ready | done */
  status?: string
  /** Owning task in rz-system */
  taskId?: string
  taskName?: string
  /** Deep link to the rz-system task detail page */
  url?: string
  ownerName?: string
  memberNames?: string[]
  /** Last successful sync from rz-system */
  syncedAt?: string
}

export interface WorkspaceManifest {
  /** Display name of this workspace */
  name: string
  createdAt: string
  updatedAt: string
  /** Optional rz-system import source details */
  rzSystem?: {
    baseUrl?: string
    /** Browser URL of rz-system (may differ from the API base) */
    webUrl?: string
    /** dufs base URL used for rz-system attachments */
    filesUrl?: string
    projectIds?: string[]
    importedAt?: string
    lastSyncAt?: string
  }
  /** People participating in the workspace (stub, not enforced) */
  members: WorkspaceMember[]
  /** Project links with their associated files (relative) */
  projects: WorkspaceProjectLink[]
}

export interface RzFileRef {
  fileName: string
  fileUrl: string
}

export interface RzProjectStage {
  key: string
  name?: string
  files: RzFileRef[]
  adminFiles: RzFileRef[]
}

export interface RzProjectResult {
  key: string
  type?: string
  files: RzFileRef[]
}

export interface RzProject {
  id: string
  name: string
  projectCode?: string
  status?: string
  client?: string
  ownerId?: string
  ownerName?: string
  assistantNames?: string[]
  taskId?: string
  taskName?: string
  taskStatus?: number
  taskOwnerName?: string
  memberNames?: string[]
  updatedAt?: string
  stages: RzProjectStage[]
  finalResults: RzProjectResult[]
  coreResults: RzProjectResult[]
  /** Browser URL of the project's task in rz-system */
  taskUrl?: string
}

export interface RzTask {
  id: string
  projectId: string
  title: string
  status?: string
  assignee?: string
}

export interface RzSystemClient {
  listProjects(): Promise<RzProject[]>
  listTasks(projectId: string): Promise<RzTask[]>
}

export interface ImportResult {
  projects: number
  tasks: number
}

export interface RzSyncResult {
  workspaceDir: string
  workspaceName: string
  projects: number
  downloaded: number
  skipped: number
  failed: number
  files: string[]
  warnings: string[]
}

// ── P1 snapshot/sync types ────────────────────────────────────────────────────

export interface SnapshotFileEntry {
  /** POSIX-style path relative to the workspace root */
  path: string
  /** File byte size */
  size: number
  /** Last modified time in milliseconds since epoch (rounded) */
  mtimeMs: number
  /** Hex-encoded SHA-256 of the file contents */
  sha256: string
}

export interface SnapshotIndex {
  /** Format marker for forwards-compat */
  schema: 'genoffice-workspace-snapshot@1'
  workspace: {
    /** Human title from manifest or directory name */
    name: string
    /** Stable slug+hash identifier (safe for URLs) */
    id: string
  }
  /** ISO timestamp of when this snapshot was created */
  createdAt: string
  /** Short content-derived version tag (e.g. 8-char digest prefix) */
  version: string
  /** Relative path where blobs are stored under the dufs base (no leading slash) */
  blobsBasePath: string
  /** Files included in the snapshot (sorted by path) */
  files: SnapshotFileEntry[]
  /** The manifest file hash and size (also present as a regular file entry) */
  manifest: {
    path: string
    size: number
    sha256: string
  }
  /** Overall hash of the index payload (defense against truncation/mutation) */
  indexSha256: string
}

export type DiffKind = 'new' | 'changed' | 'unchanged' | 'deleted'

export interface FileDiff {
  kind: DiffKind
  path: string
  local?: { size: number; sha256: string } | null
  remote?: { size: number; sha256: string } | null
}

export interface PullResult {
  ok: boolean
  /** Snapshot version string when ok */
  version?: string
  /** Computed file-level diff */
  diff?: FileDiff[]
  /** Mirror directory where the fetched snapshot was stored (absolute path) */
  mirrorDir?: string
  error?: string
}

export interface PublishResult {
  ok: boolean
  version?: string
  indexPath?: string
  error?: string
}

// ── Handoff: project-scoped immutable exchange packages ───────────────────────

export interface HandoffFileEntry {
  /** POSIX-style path relative to the workspace root */
  path: string
  size: number
  sha256: string
}

export interface HandoffManifest {
  schema: 'genoffice-handoff@1'
  handoffId: string
  projectId: string
  projectName: string
  projectCode?: string
  taskId?: string
  taskUrl?: string
  author: {
    name: string
    email?: string
  }
  note?: string
  createdAt: string
  files: HandoffFileEntry[]
}

export interface HandoffSummary {
  id: string
  /** Browser URL of the handoff folder on the file server */
  url: string
  projectId: string
  authorName: string
  authorEmail?: string
  note?: string
  createdAt: string
  fileCount: number
  totalBytes: number
}

export interface HandoffPublishResult {
  ok: boolean
  handoffId?: string
  url?: string
  fileCount?: number
  totalBytes?: number
  error?: string
}

export interface HandoffDiffEntry {
  path: string
  kind: 'new' | 'changed' | 'unchanged'
}

export interface HandoffDownloadResult {
  ok: boolean
  handoffId?: string
  /** Local directory holding the downloaded handoff */
  dir?: string
  diff?: HandoffDiffEntry[]
  error?: string
}

export interface HandoffApplyResult {
  ok: boolean
  applied: number
  error?: string
}
