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

P1 — Non‑realtime cloud sync (dufs HTTP)
---------------------------------------

- Transport: `dufs` static server (`PUT`/`GET`), no WebDAV required. Targets [`sigoden/dufs`](https://github.com/sigoden/dufs).
- Publish (Push):
  - Builds a signed/versioned snapshot: manifest + per‑file SHA‑256 hashes.
  - Uploads `index.json` and content‑addressed blobs to the configured dufs base URL.
  - Writes a stable pointer `genoffice/<workspace-id>/latest.json` for discovery.
- Pull (Review):
  - Fetches the remote `latest.json` and its `index.json`.
  - Creates a read‑only mirror under `<workspace>/.genoffice/mirror/<workspace-id>/<version>/`.
  - Computes a diff vs local. Apply requires explicit selection; nothing is overwritten automatically.
- Conflict policy: local‑first; no deletes on apply.
- Env:
  - `GENOFFICE_SYNC_BASE_URL` — dufs base URL (e.g. `http://host:port` or `https://host/subdir`)
  - `GENOFFICE_SYNC_USER` / `GENOFFICE_SYNC_PASSWORD` — optional Basic Auth for dufs
- Notes:
  - Older dufs builds may not enable WebDAV. This implementation only relies on plain HTTP `PUT`/`GET`.
  - If your server auto‑creates parent directories on `PUT`, nested paths under `genoffice/` will be made on demand. Otherwise, pre‑create the target folder on the server and/or point `GENOFFICE_SYNC_BASE_URL` at an existing subfolder.
- UI:
  - Home → Quick cards add “Publish snapshot” and “Pull snapshot for review”.
  - Pull shows a count of changed/new files and prompts for a JSON list of paths to apply.

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
