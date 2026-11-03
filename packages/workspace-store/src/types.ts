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
