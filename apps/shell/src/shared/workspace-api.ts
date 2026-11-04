export interface WorkspaceSummary {
  /** absolute directory path */
  dir: string
  name: string
  /** projects mirrored from rz-system */
  projects: Array<{
    id: string
    name: string
    fileCount: number
    projectCode?: string
    status?: string
    taskId?: string
    taskName?: string
    ownerName?: string
    url?: string
    memberNames?: string[]
    syncedAt?: string
  }>
  rzSystem?: {
    baseUrl?: string
    webUrl?: string
    filesUrl?: string
    projectIds?: string[]
    importedAt?: string
    lastSyncAt?: string
  }
  /** ISO time strings */
  createdAt: string
  updatedAt: string
}

export interface ImportOutcome {
  ok: boolean
  projects: number
  tasks: number
  error?: string
}

export interface RzProjectSummary {
  id: string
  name: string
  projectCode?: string
  status?: string
  taskId?: string
  taskName?: string
  taskOwnerName?: string
  ownerName?: string
  memberNames?: string[]
  client?: string
  updatedAt?: string
  taskUrl?: string
  fileCount: number
}

export interface RzConnectionStatus {
  configured: boolean
  connected: boolean
  baseUrl?: string
  webUrl?: string
  filesUrl?: string
  email?: string
  name?: string
  error?: string
}

export interface RzConfigureInput {
  baseUrl: string
  webUrl?: string
  filesUrl?: string
  email: string
  password: string
}

export interface RzSyncOutcome {
  ok: boolean
  mode: 'new' | 'current'
  workspace?: WorkspaceSummary
  downloaded: number
  skipped: number
  failed: number
  warnings: string[]
  error?: string
}

export interface HandoffSummary {
  id: string
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
  dir?: string
  diff?: HandoffDiffEntry[]
  error?: string
}

export interface HandoffApplyResult {
  ok: boolean
  applied: number
  error?: string
}

export const WORKSPACE_CHANNELS = {
  get: 'workspace:get',
  pick: 'workspace:pick',
  importRz: 'workspace:import-rz',
  rzStatus: 'workspace:rz-status',
  rzConfigure: 'workspace:rz-configure',
  rzLogout: 'workspace:rz-logout',
  rzProjects: 'workspace:rz-projects',
  rzWorkspaces: 'workspace:rz-workspaces',
  rzSync: 'workspace:rz-sync',
  openUrl: 'workspace:open-url',
  publish: 'workspace:publish',
  pull: 'workspace:pull',
  apply: 'workspace:apply',
  handoffList: 'workspace:handoff-list',
  handoffPublish: 'workspace:handoff-publish',
  handoffDownload: 'workspace:handoff-download',
  handoffApply: 'workspace:handoff-apply',
} as const

export interface WorkspaceApi {
  /** get the last workspace (if any) */
  get(): Promise<WorkspaceSummary | null>
  /** pick a folder; initializes a workspace manifest when missing; returns the summary */
  pick(): Promise<WorkspaceSummary | null>
  /** import rz-system projects into the current or picked workspace */
  importRz(): Promise<ImportOutcome>
  /** current rz-system connection/config state */
  rzStatus(): Promise<RzConnectionStatus>
  /** sign in to rz-system and persist the resulting session cookie */
  rzConfigure(input: RzConfigureInput): Promise<RzConnectionStatus>
  /** clear the persisted rz-system session cookie */
  rzLogout(): Promise<RzConnectionStatus>
  /** live project list from rz-system */
  rzProjects(): Promise<{ ok: boolean; projects: RzProjectSummary[]; error?: string }>
  /** synced rz-system workspaces discovered under the configured folder roots */
  rzWorkspaces(): Promise<WorkspaceSummary[]>
  /** download a project (metadata + attachments) into a new or the current workspace */
  rzSync(projectId: string, mode: 'new' | 'current'): Promise<RzSyncOutcome>
  /** open an http(s) URL in the system browser */
  openUrl(url: string): Promise<boolean>
  /** publish a snapshot to the configured dufs base URL */
  publish(): Promise<{ ok: boolean; version?: string; error?: string }>
  /** pull latest snapshot into a read-only mirror; returns diff */
  pull(): Promise<{
    ok: boolean
    version?: string
    mirrorDir?: string
    diff?: Array<{ kind: 'new' | 'changed' | 'unchanged' | 'deleted'; path: string }>
    error?: string
  }>
  /** apply selected files (relative paths) from the last mirror to the workspace */
  apply(paths: string[]): Promise<{ ok: boolean; applied: number; error?: string }>
  /** list immutable handoff packages published for one project */
  handoffList(
    projectId: string,
  ): Promise<{ ok: boolean; handoffs: HandoffSummary[]; error?: string }>
  /** publish the current workspace as a handoff package */
  handoffPublish(workspaceDir: string, note?: string): Promise<HandoffPublishResult>
  /** download a handoff into the local workspace mirror and diff it */
  handoffDownload(
    workspaceDir: string,
    projectId: string,
    handoffId: string,
  ): Promise<HandoffDownloadResult>
  /** copy selected files from a downloaded handoff into the workspace */
  handoffApply(
    workspaceDir: string,
    handoffId: string,
    paths: string[],
  ): Promise<HandoffApplyResult>
}
