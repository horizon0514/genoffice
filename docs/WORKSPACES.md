GenOffice Workspace (fork extension)
====================================

This fork introduces a local-first Workspace concept to GenOffice:

- A Workspace is just a folder on disk plus a manifest at `<workspace>/.genoffice/workspace.json`.
- Documents remain real Office files on disk; the editor kernel is untouched.
- A read-only importer mirrors projects from rz-system into the manifest.

P0 — What’s implemented
-----------------------

- Workspace manifest:
  - `name`, `createdAt`, `updatedAt`
  - `members` stub (array, not enforced)
  - `projects`: array of `{ id, name, files[] }`, where `files` are relative paths under the workspace folder
  - Optional `rzSystem` block recording source info and the last import time
- Shell UI:
  - Home → Quick cards now include:
    - “Open/Create Workspace” — pick a folder; creates the manifest if missing; the folder is added to the sidebar.
    - “Import from rz-system” — runs the importer into the last picked workspace.
- Importer:
  - Adapter interface (`@genoffice/workspace-store`)
  - HTTP client stub (OpenAI-style bearer auth) driven by env:
    - `RZ_API_BASE_URL`
    - `RZ_API_TOKEN`
  - Fixture client with sample JSON under `packages/workspace-store/fixtures/rz/`
  - Tests covering the fixture importer and manifest behaviors

How to run
----------

1) Install and start the dev shell as usual:

```bash
npm install
npm run dev -w @genoffice/shell
```

2) In the Home window:

- Click “Open/Create Workspace”, pick or create a folder. This writes `<folder>/.genoffice/workspace.json` and adds the folder to the sidebar.
- Click “Import from rz-system” to mirror rz projects into the manifest:
  - With real API:
    - Export `RZ_API_BASE_URL=https://your-rz-base` and `RZ_API_TOKEN=...` before launch.
  - Without API details:
    - The importer falls back to bundled fixtures (see `packages/workspace-store/fixtures/rz/`).

The manifest can be inspected/edited by hand; linked files are stored as relative paths.

Adapter contract (rz-system)
---------------------------

`@genoffice/workspace-store` defines:

- `RzSystemClient`: `listProjects()` and `listTasks(projectId)`.
- `importRzSystemIntoWorkspace({ workspaceDir, client, options })`:
  - Creates the workspace if missing
  - Adds/updates `{ id, name }` under `projects`
  - Does not write or modify any document file
  - Records `rzSystem.projectIds[]` and `importedAt`

Env vars
--------

- `RZ_API_BASE_URL` — base URL of rz-system (optional; when missing, fixtures are used)
- `RZ_API_TOKEN` — bearer token (optional; used only with `RZ_API_BASE_URL`)

Deferred (design notes)
-----------------------

- P1: Non-realtime cloud sync
  - Push: publish a signed workspace snapshot (manifest + file hashes + optional redacted previews)
  - Pull for review: fetch snapshot into a read-only mirror, diff against local; user opts into file-by-file updates
  - Transport: static object store (S3-compatible), snapshot index JSON, content-addressed blobs
  - Conflict policy: local-first; snapshot import never overwrites files without explicit user action
- P2: AI provider for internal gateway `rz-vllm`
  - Adapter under `@genoffice/ai-provider` with an OpenAI-compatible shape
  - Settings:
    - `rz-vllm` endpoint field (base URL)
    - Model id textbox
    - API key (optional if gateway is on a trusted network)
  - Keep third-party BYO keys side-by-side; no change to existing providers

Scope and merge safety
----------------------

- Changes are scoped to the shell and a new workspace-store package; editor kernels (Docs/Sheets/Slides) are untouched.
- The new UI is additive and gated behind simple quick cards; no upstream behavior is changed.
