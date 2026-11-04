GenOffice Workspace (fork extension)
====================================

This fork introduces a local-first Workspace concept to GenOffice:

- A Workspace is just a folder on disk plus a manifest at `<workspace>/.genoffice/workspace.json`.
- Documents remain real Office files on disk; the editor kernel is untouched.
- The shell can read the real project list from rz-system and pull a selected project's
  metadata plus attachments into a new or existing workspace.
- Reviews and approvals still happen in rz-system. GenOffice links back to the mounted
  task instead of pretending to submit an approval through an API that does not exist.

P0 — What’s implemented
-----------------------

- Workspace manifest:
  - `name`, `createdAt`, `updatedAt`
  - `members` stub (array, not enforced)
  - `projects`: array of `{ id, name, files[] }`, where `files` are relative paths under the workspace folder
  - rz metadata on each project: `projectCode`, `status`, `taskId`, `taskName`,
    `ownerName`, `memberNames`, `syncedAt`, and a task deep link
  - Optional `rzSystem` block recording source URLs, project ids, and the last sync time
- Shell UI:
  - Home → Quick cards now include:
    - “Open/Create Workspace” — pick a folder; creates the manifest if missing; the folder is added to the sidebar.
    - “从 rz-system 创建 / 同步 rz-system 项目” — opens the real rz-system project picker.
  - The Home panel aggregates every rz-system workspace found under the default save
    directory or the sidebar roots. It shows workspace count, project count, file count,
    and the most recent sync time instead of only reading `lastWorkspaceDir`.
  - The project rail previews five projects and starts with a “查看全部” entry when more
    are available, so the full picker stays reachable even when the rail overflows.
  - The project picker supports search, refresh, new-workspace mode, and
    sync-to-current-workspace mode; connection settings live under Settings → Account.
- Importer:
  - Real rz-system v2 HTTP client in `@genoffice/workspace-store`.
  - Logs in with `POST /api/v2/auth/login` (`email` + `password`) and reuses the
    HttpOnly `rz-system-session` cookie.
  - Reads projects with `POST /api/v2/project/getProjects` and tasks with
    `POST /api/v2/task/getTasks`.
  - Downloads attachments from the configured dufs base URL.
  - Downloads project process files (`files/`, `admin/`), final results (`final/`),
    and core results (`core/`).
  - Never overwrites an existing file. A same-named local file is counted as skipped,
    so local edits survive a re-sync.
  - Fixture data remains only as a test utility; the desktop integration never falls
    back to fixtures when the real service is unavailable.

How to run
----------

1. Start rz-system and the attachment service (dufs in the local demo):

```bash
# example only; use the actual deployment URLs outside local development
# rz-system API:  http://192.168.2.99:3000
# attachment svc: http://192.168.1.99:5100
```

2. Install and start the dev shell as usual:

```bash
npm install
npm run dev
```

3. Open Settings → Account and sign in to rz-system:

- Enter the rz-system URL, the dufs attachment URL, the account, and the password.
- Click “连接 rz-system”. The session cookie is stored locally; the password is not.

4. In the Home window:

- Click “从 rz-system 创建” (or “同步 rz-system 项目” when a workspace is already open).
- Select a project and choose:
  - “新建项目工作空间” — creates `<projectCode>-<project name>` under the configured
    default save directory.
  - “同步到当前工作空间” — updates the currently open workspace.
- Click “同步所选项目”. The result reports downloaded / skipped / failed counts.
- Use “在 rz-system 打开任务 / 审批” to open the mounted task detail page in the system
  browser.
- Each project can live in its own workspace folder. The Home panel discovers all of
  them, so “新建项目工作空间” does not hide earlier projects.

The manifest can be inspected/edited by hand; linked files are stored as relative paths.

Local layout
------------

For a project with code `PERF-DEMO-12`:

```text
<workspace>/
  .genoffice/workspace.json
  PERF-DEMO-12/
    files/<stage>/...
    admin/<stage>/...
    final/<result-key>/...
    core/<result-key>/...
```

The project workspace folder itself is named `<projectCode>-<project name>`. Unsafe
filesystem characters are sanitized, and path traversal is rejected before writing.

Adapter contract (rz-system)
---------------------------

`@genoffice/workspace-store` defines:

- `RzSystemClient`: `listProjects()` and `listTasks(projectId)`.
- `HttpRzClient`: real `/api/v2/*` POST RPC client with cookie-session login.
- `syncRzProjectsToWorkspace({ workspaceDir, client, projects, filesBaseUrl })`:
  - Initializes the workspace when missing
  - Downloads referenced attachments without overwriting existing files
  - Adds/updates project metadata, members, task link, and sync timestamps
  - Records `rzSystem.projectIds[]` and `lastSyncAt`

Env vars
--------

Environment variables take precedence over values saved from the UI:

- `RZ_SYSTEM_BASE_URL` or `RZ_API_BASE_URL` — rz-system API base, e.g.
  `https://rz.example.com`
- `RZ_SYSTEM_WEB_URL` — browser base used for task deep links when it differs from the API
- `RZ_SYSTEM_FILES_URL` or `RZ_UPLOAD_BASE_URL` — dufs attachment base URL
- `RZ_SYSTEM_EMAIL` or `RZ_API_USER` — login email (rz-system calls this field `email`)
- `RZ_SYSTEM_PASSWORD` or `RZ_API_PASSWORD` — login password; never persisted
- `RZ_SYSTEM_SESSION_COOKIE` — an existing `rz-system-session` cookie, useful for
  non-interactive runs

The UI stores the base URLs, login email, and session cookie in app settings after a
successful login. The password is intentionally not stored.

Collaboration flow (handoff packages)
-------------------------------------

GenOffice owns three things: open the project, edit real Office files, and hand the
result to the next person. Membership, task assignment, review, and approval stay in
rz-system; GenOffice does not duplicate those states.

### Handoff layout

Every submission creates an immutable directory on the rz-system attachment server
(dufs):

```
genoffice/projects/<rzProjectId>/handoffs/<YYYYMMDD-HHmmss>-<author>-<random>/
  manifest.json
  files/...
```

`manifest.json` records the project id, project code, task id, author, note, timestamp,
and a file list with relative paths and SHA-256 hashes.

- The collaboration key is the rz-system `projectId`, not the local directory name or
  machine path.
- Every submission gets a new directory. There is no `latest` pointer, so nobody can
  overwrite another person's submission.
- Files are uploaded first and `manifest.json` last, so an interrupted upload never
  shows up in the list.
- A handoff contains the whole workspace directory. Keep one workspace per rz-system
  project (the default sync mode) rather than syncing several projects into one folder.

### Roles

- **Author**: edits in GenOffice, fills in a short note, and submits the workspace.
- **Receiver**: opens the project card, downloads the handoff, reviews the
  new/changed/unchanged file list, and applies selected files.
- **Reviewer / approver**: completes the real workflow in rz-system. GenOffice only
  deep-links to `/task/detail?taskId=...`.

The local manifest `members` array is cached metadata, not an ACL.

### Day-to-day flow

1. Click a project in the Home panel to open **项目交接**.
2. Submit the current workspace with an optional note.
3. A teammate opens the same project, sees the handoff, downloads it, and selects the
   files to apply.
4. Approval continues in rz-system via **在 rz-system 打开任务**.

### Explicit non-goals

- No real-time co-editing of the same file. Split work by file or section, or use Word's
  track-changes/compare and submit the result.
- No rz-system membership, permission, or approval writes from GenOffice.
- Handoff packages are append-only. Applying a handoff only overwrites the files you
  select and never deletes local files.

### Storage and permissions

- Handoffs use the attachment URL configured under Settings → Account (dufs).
- The current deployment allows anonymous read/write on the intranet, so access control
  depends on network isolation.
- For stricter deployments, put Basic Auth in front of dufs and pass
  `GENOFFICE_SYNC_USER` / `GENOFFICE_SYNC_PASSWORD`.

Legacy snapshot sync (kept, no longer exposed on Home)
-----------------------------------------------------

`packages/workspace-store/src/sync.ts` still contains the earlier workspace-id-based
snapshot publish/pull implementation (`GENOFFICE_SYNC_BASE_URL`). It is not used by the
handoff UI: its workspace id includes a hash of the local absolute path, so two machines
cannot see each other's snapshots. Prefer handoff packages for anything user-facing.

Deferred (design notes)
-----------------------

P2 — AI provider for internal gateway rz‑vllm (implemented)
----------------------------------------------------------

- Provider: `RZ vLLM` under Settings → AI Model.
- Protocol: OpenAI-compatible; works with vLLM and compatible gateways.
- Settings:
  - Base URL: your gateway root including `/v1` (e.g. `http://host:8000/v1`).
  - Model id: the served model name (listed by your `/v1/models`).
  - API key: optional. Leave empty if your gateway is on a trusted network; otherwise paste the bearer token.
- Behavior:
  - The model picker auto-loads from your server’s `/v1/models` when a Base URL is set.
  - Existing third‑party BYO‑key providers remain unchanged and selectable side‑by‑side.

Scope and merge safety
----------------------

- Changes are scoped to the shell and a new workspace-store package; editor kernels (Docs/Sheets/Slides) are untouched.
- The new UI is additive and gated behind simple quick cards; no upstream behavior is changed.
