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
}

export interface WorkspaceManifest {
  /** Display name of this workspace */
  name: string
  createdAt: string
  updatedAt: string
  /** Optional rz-system import source details */
  rzSystem?: {
    baseUrl?: string
    projectIds?: string[]
    importedAt?: string
  }
  /** People participating in the workspace (stub, not enforced) */
  members: WorkspaceMember[]
  /** Project links with their associated files (relative) */
  projects: WorkspaceProjectLink[]
}

export interface RzProject {
  id: string
  name: string
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
