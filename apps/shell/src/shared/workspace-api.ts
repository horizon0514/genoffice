export interface WorkspaceSummary {
  /** absolute directory path */
  dir: string
  name: string
  /** projects mirrored from rz-system (ids and names only) */
  projects: Array<{ id: string; name: string; fileCount: number }>
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

export const WORKSPACE_CHANNELS = {
  get: 'workspace:get',
  pick: 'workspace:pick',
  importRz: 'workspace:import-rz',
} as const

export interface WorkspaceApi {
  /** get the last workspace (if any) */
  get(): Promise<WorkspaceSummary | null>
  /** pick a folder; initializes a workspace manifest when missing; returns the summary */
  pick(): Promise<WorkspaceSummary | null>
  /** import rz-system projects into the current or picked workspace */
  importRz(): Promise<ImportOutcome>
}
