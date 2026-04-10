# Plan: PR/MR Support & Worktree Sub-Projects

## Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 0: Project Tree & Worktrees | **DONE** | Tree sidebar, worktree CRUD, panel keying via `key={repoPath}` |
| Phase 1: Provider Detection & Auth | **DONE** | GitHub device flow, GitLab PKCE, provider URL parser, Settings UI |
| Phase 2: PR/MR API Service Layer | **DONE** | Rust-side: unified types, TokenStore, provider detection, 18 Tauri commands; TS types mirror; frontend token migration |
| Phase 3: PR/MR UI — List & Detail | **DONE** | 3.1: PR store, sidebar PR section, container swap. 3.1.5: Create PR from branch context menu. 3.2: real diff + conversation panels with Monaco DiffEditor |
| Phase 4: MR/PR Checkout as Sub-Project | **DONE** | 4.1: "Checkout Locally" action (context menu on PrRow + button in PrDetailView). 4.2: Independent agent sessions (works via key={repoPath}). 4.3: Cleanup (reuses existing worktree removal via ProjectContextMenu) |
| Phase 5: Full Lifecycle Actions | PENDING | |

### Infrastructure (completed alongside phases)
- **Dev HTTP server** (axum, port 3456) — exposes Tauri commands over HTTP for browser testing
- **Invoke shim** (`src/lib/invoke.ts`) — routes to Tauri or HTTP based on `__TAURI_INTERNALS__`
- **CDP enabled** (port 9122, dev builds only) — QA agent connects via Chrome DevTools Protocol
- **ErrorBanner** component — shared across AppShell, ChangesPanel, ProjectSidebar
- **CopyButton** component — shared across error dialogs

### Refactors completed
- **Per-project UI state scoping** — `selectedBranchName`, `selectedFiles`, `selectedCommitHash`, `lastClickedFile` keyed by `repoPath` in `ui.store.ts` via `useProjectUI(repoPath)` hook. All 3 panels + `git.store.ts` updated.
- **DRY: `git-runner.ts`** — shared `runGit`/`runGitOrThrow` extracted from duplicated code
- **Global error system** — `GlobalError` type, single full-width amber `ErrorBanner` in `AppShell`, detail dialog
- **Systematic error handling** — `toStoreError(label, e)` + `StoreError` type across all 23 catch blocks
- **`--all` log bug** — removed `--all` from `getLog()` fallback and `getLogWithGraph()` (dead code, deleted). Log always shows current branch or selected branch, never all branches.

### Decisions Made
- **Q1 (Worktree placement):** Global directory `~/.git-multi-project/worktrees/<projectId>/`
- **Q2 (GitHub client_id):** User-configurable in Settings UI, no hardcoded value
- **Q3 (Phase ordering):** Phase 0 first, then Phase 1
- **Q4 (GitLab self-hosted):** Settings UI shows dynamic registration link + exact redirect URI/scopes
- **Q5 (Offline):** TBD
- **Q6 (Service layer location):** Rust, not TypeScript. The web layer is purely UI — all data fetching, provider-specific mapping, and normalization lives in Rust. Frontend calls Tauri commands and receives already-normalized structs. No raw API JSON crosses the IPC bridge.
- **Q7 (Token management):** Tokens live in Rust managed state, never exposed to the frontend. OAuth flows store tokens directly into `TokenStore`. PR commands read tokens internally. Frontend only knows connection status (bool). GitLab token refresh handled transparently in Rust.

---

## Vision

Transform the flat project list into a tree where each project can have child sub-projects (worktrees, MR checkouts). Each sub-project gets its own filesystem via `git worktree`, enabling independent agent sessions running in parallel on main, a worktree, and an MR checkout simultaneously.

```
▼ my-project/
    main (working tree)
  ▼ Pull Requests
      #42 Fix login bug          ✓
      #38 Add dark mode          ●
  ▼ Worktrees
      feature-x
```

---

## Phase 0: Project Tree & Worktree Foundation -- DONE

**Goal**: Transform the flat project list into a tree. Each project can have child sub-projects (worktrees). This is the foundation everything else builds on.

### 0.1 — Data model changes

**`ProjectEntry` becomes hierarchical:**

```typescript
export interface ProjectEntry {
  id: string
  path: string          // filesystem path (worktree path for children)
  name: string
  alias?: string
  parentId?: string     // undefined = root project, string = child of parent
  kind: 'project' | 'worktree' | 'mr-checkout'
  meta?: {
    branch?: string     // the branch this worktree/MR is on
    mrId?: number       // MR/PR identifier (for mr-checkout kind)
    provider?: 'github' | 'gitlab'
  }
}
```

- Root projects: `parentId` is `undefined`, `kind` is `'project'`
- Worktrees: `parentId` points to root project, `kind` is `'worktree'`
- MR checkouts (Phase 4): `parentId` points to root, `kind` is `'mr-checkout'`
- Storage stays flat array — tree structure derived from `parentId` relationships

**Files affected:**
- `src/services/project-manager.ts` — update `ProjectEntry`, add helpers: `getChildren(parentId)`, `getRootProjects()`
- `src/stores/project.store.ts` — add derived selectors for tree structure
- `src/types/index.ts` — shared type exports

### 0.2 — Git worktree service layer

**New file: `src/services/worktree.service.ts`**

Thin wrapper around `git worktree` commands via existing `run_git`:
- `listWorktrees(repoPath)` → parses `git worktree list --porcelain`
- `addWorktree(repoPath, path, branch)` → `git worktree add <path> <branch>`
- `removeWorktree(repoPath, path)` → `git worktree remove <path>`

No new Rust code needed — reuses existing `run_git` command.

### 0.3 — ProjectSidebar tree rendering

**Transform flat `<ul>` into indented tree:**
- Root projects render as today (folder icon, name, delete)
- Children render indented underneath with a different icon per `kind`:
  - `worktree` → `GitBranch` icon
  - `mr-checkout` → `GitPullRequest` icon (Phase 4)
- Collapse/expand toggle on root projects that have children
- Context menu on root: "Add worktree..." option
- Context menu on worktree child: "Remove worktree" (runs `git worktree remove`)

**Files affected:**
- `src/components/projects/ProjectSidebar.tsx` — tree rendering
- `src/components/context-menus/ProjectContextMenu.tsx` — new menu items

### 0.4 — Sub-project selection & panel keying

Selecting a sub-project works exactly like selecting a root project:
- Sets `selectedProjectId` to the sub-project's `id`
- Sets `repoPath` to the sub-project's `path` (the worktree directory)
- All panels (`ChangesPanel`, `CommitGraphPanel`, `DiffViewerPanel`) already re-key on `repoPath` — they just work
- Agent terminal sessions key on `projectId` — each sub-project gets independent sessions

**No panel code changes needed** — the `key={repoPath}` pattern already handles this.

---

## Phase 1: Provider Detection & OAuth Authentication -- DONE

**Goal**: Detect whether a project is GitHub or GitLab from its remote URL, authenticate with OAuth, store tokens.

### 1.1 — Provider detection

**New file: `src/services/provider.ts`**

Parse remote URL to detect provider:
```
git@github.com:user/repo.git       → { provider: 'github', owner: 'user', repo: 'repo' }
https://github.com/user/repo.git   → { provider: 'github', owner: 'user', repo: 'repo' }
git@gitlab.com:group/project.git   → { provider: 'gitlab', host: 'gitlab.com', projectPath: 'group/project' }
https://gitlab.mycorp.com/...      → { provider: 'gitlab', host: 'gitlab.mycorp.com', ... }
```

Called lazily when a project is selected — runs `git remote get-url origin` via existing `run_git`, caches result in store.

### 1.2 — GitHub OAuth (Device Flow)

**New Rust file: `src-tauri/src/github.rs`**

Device flow — no callback server needed:
1. `POST https://github.com/login/device/code` with `client_id` + `scope=repo,workflow`
2. Returns `device_code`, `user_code`, `verification_uri`
3. App shows user the code and opens browser to `verification_uri`
4. App polls `POST https://github.com/login/oauth/access_token` with `device_code` + `grant_type=urn:ietf:params:oauth:grant-type:device_code`
5. On success, returns `access_token`

**Tauri commands:**
- `github_device_code_request(client_id, scope)` → `{ device_code, user_code, verification_uri, interval }`
- `github_device_code_poll(client_id, device_code)` → `{ access_token, ... }` or polling status
- `github_api(token, method, path, body?)` → generic GitHub REST API proxy

**Scopes needed:** `repo` (full PR lifecycle) + `workflow` (CI/Actions status)

### 1.3 — GitLab OAuth (PKCE Flow)

**New Rust file: `src-tauri/src/gitlab.rs`**

Reuses the PKCE + localhost callback pattern already built for OpenRouter (`openrouter.rs`):
1. Generate PKCE verifier + challenge
2. Open browser to `https://<host>/oauth/authorize?...&code_challenge=...&scope=api`
3. Catch callback on localhost port, extract `code`
4. Exchange code for `access_token` + `refresh_token` at `https://<host>/oauth/token`
5. Token auto-refresh via `refresh_token` when expired

**Tauri commands:**
- `gitlab_start_oauth(host, client_id)` → `{ access_token, refresh_token, expires_at }`
- `gitlab_refresh_token(host, client_id, refresh_token)` → new tokens
- `gitlab_api(host, token, method, path, body?)` → generic GitLab REST API proxy

**Scopes needed:** `api` (full MR lifecycle + CI pipelines)

**Self-hosted support:** Same flow works for any GitLab instance — just swap the host URL. User registers an OAuth app on their instance.

### 1.4 — Token storage & settings UI

**Extend settings store (`src/stores/settings.store.ts`):**
```typescript
providers: {
  github?: { accessToken: string }
  gitlab?: Array<{
    host: string
    accessToken: string
    refreshToken: string
    expiresAt: number
  }>
}
```

- GitHub: single token (github.com)
- GitLab: array of `{ host, token }` pairs for self-hosted support
- Settings modal gets a "Providers" tab: connect/disconnect GitHub, add GitLab instances

**Files affected:**
- `src/stores/settings.store.ts` — extend `AppSettings`
- `src/components/settings/SettingsModal.tsx` — new provider tab
- `src/services/project-manager.ts` — persist tokens in store

---

## Phase 2: PR/MR API Service Layer (Rust)

**Goal**: Abstract GitHub PR and GitLab MR APIs behind unified Rust types and Tauri commands. All data fetching, normalization, and provider-specific mapping lives in Rust. The frontend is purely UI — it calls Tauri commands and receives already-normalized structs.

**Design principle**: The web layer is just UI. Rust owns all data and logic.

### 2.1 — Unified Rust types

**New file: `src-tauri/src/pull_request.rs`** — shared types + provider dispatch

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub id: u64,
    pub number: u64,                // PR #42 / MR !42
    pub title: String,
    pub description: String,
    pub state: PrState,             // "open" | "merged" | "closed"
    pub author: PrUser,
    pub source_branch: String,
    pub target_branch: String,
    pub is_draft: bool,
    pub has_conflicts: bool,
    pub created_at: String,
    pub updated_at: String,
    pub labels: Vec<String>,
    pub reviewers: Vec<PrReviewer>,
    pub ci_status: Option<CiStatusKind>,  // null when no CI
    pub web_url: String,
    pub provider: ProviderKind,     // "github" | "gitlab"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub id: u64,
    pub author: PrUser,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub path: Option<String>,       // file path for inline comments
    pub line: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReview {
    pub id: u64,
    pub author: PrUser,
    pub state: ReviewState,         // "approved" | "changes_requested" | "commented" | "pending"
    pub body: String,
    pub submitted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiCheck {
    pub id: u64,
    pub name: String,
    pub status: CiStatusKind,       // "success" | "failure" | "pending" | "running" | "skipped"
    pub url: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

// Enums: PrState, ReviewState, CiStatusKind, ProviderKind
// Helper structs: PrUser { login, avatar_url? }, PrReviewer { login, state }
```

### 2.2 — Provider detection in Rust

**New function in `src-tauri/src/pull_request.rs`:**

Detect provider from remote URL (mirrors the existing TS `provider.ts` logic but in Rust):
- `detect_provider(repo_path) → ProviderInfo { kind, owner, repo, host?, project_path? }`
- Runs `git remote get-url origin` via existing `run_git` infra
- Parses SSH (`git@github.com:user/repo.git`) and HTTPS (`https://github.com/user/repo.git`) formats
- Used internally by all PR commands to route to the correct adapter

### 2.3 — GitHub PR adapter

**Extend `src-tauri/src/github.rs`** with typed adapter functions:

The existing `github_api` command becomes an internal helper. New Tauri-facing commands call it internally and map raw JSON to unified `PullRequest` structs.

Mapping: GitHub REST API → unified types
- `GET /repos/{owner}/{repo}/pulls` → `Vec<PullRequest>`
- `GET /repos/{owner}/{repo}/pulls/{n}` → `PullRequest`
- `POST /repos/{owner}/{repo}/pulls` → `PullRequest`
- `PATCH /repos/{owner}/{repo}/pulls/{n}` → `PullRequest`
- `PUT /repos/{owner}/{repo}/pulls/{n}/merge` → merge
- `GET /repos/{owner}/{repo}/pulls/{n}/comments` → `Vec<PrComment>`
- `GET /repos/{owner}/{repo}/pulls/{n}/reviews` → `Vec<PrReview>`
- `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` → `Vec<CiCheck>`

Field mappings: `head.ref` → `source_branch`, `base.ref` → `target_branch`, `mergeable_state` → `has_conflicts`, `draft` → `is_draft`, `html_url` → `web_url`, etc.

### 2.4 — GitLab MR adapter

**Extend `src-tauri/src/gitlab.rs`** with typed adapter functions:

Same pattern — existing `gitlab_api` becomes internal, new typed functions on top.

Mapping: GitLab REST API → unified types
- `GET /projects/{id}/merge_requests` → `Vec<PullRequest>`
- `GET /projects/{id}/merge_requests/{iid}` → `PullRequest`
- `POST /projects/{id}/merge_requests` → `PullRequest`
- `PUT /projects/{id}/merge_requests/{iid}` → `PullRequest`
- `PUT /projects/{id}/merge_requests/{iid}/merge` → merge
- `GET /projects/{id}/merge_requests/{iid}/notes` → `Vec<PrComment>`
- `GET /projects/{id}/merge_requests/{iid}/approvals` → `Vec<PrReview>`
- `GET /projects/{id}/merge_requests/{iid}/pipelines` → `Vec<CiCheck>`

Field mappings: `source_branch` → `source_branch` (direct), `target_branch` → `target_branch`, `has_conflicts` → `has_conflicts`, `work_in_progress`/`draft` → `is_draft`, `web_url` → `web_url`, etc.

### 2.5 — Unified Tauri commands

**New commands exposed to frontend (in `src-tauri/src/pull_request.rs`):**

```rust
#[tauri::command]
async fn list_pull_requests(repo_path: String, state: Option<String>) -> Result<Vec<PullRequest>, String>

#[tauri::command]
async fn get_pull_request(repo_path: String, number: u64) -> Result<PullRequest, String>

#[tauri::command]
async fn create_pull_request(repo_path: String, params: CreatePrParams) -> Result<PullRequest, String>

#[tauri::command]
async fn update_pull_request(repo_path: String, number: u64, params: UpdatePrParams) -> Result<PullRequest, String>

#[tauri::command]
async fn merge_pull_request(repo_path: String, number: u64, strategy: Option<String>) -> Result<(), String>

#[tauri::command]
async fn close_pull_request(repo_path: String, number: u64) -> Result<(), String>

#[tauri::command]
async fn get_pr_comments(repo_path: String, number: u64) -> Result<Vec<PrComment>, String>

#[tauri::command]
async fn add_pr_comment(repo_path: String, number: u64, body: String, path: Option<String>, line: Option<u64>) -> Result<PrComment, String>

#[tauri::command]
async fn get_pr_reviews(repo_path: String, number: u64) -> Result<Vec<PrReview>, String>

#[tauri::command]
async fn approve_pull_request(repo_path: String, number: u64) -> Result<(), String>

#[tauri::command]
async fn request_pr_changes(repo_path: String, number: u64, body: String) -> Result<(), String>

#[tauri::command]
async fn get_pr_checks(repo_path: String, number: u64) -> Result<Vec<CiCheck>, String>
```

Each command:
1. Calls `detect_provider(repo_path)` to determine GitHub vs GitLab
2. Reads the appropriate token from the frontend-supplied settings (or from command args)
3. Delegates to the provider-specific adapter function
4. Returns unified types — frontend never sees raw API JSON

### 2.6 — TypeScript type mirrors

**New file: `src/types/pull-request.ts`** — thin type definitions mirroring the Rust structs for TypeScript consumption. No logic, just types:

```typescript
// These mirror the Rust structs from src-tauri/src/pull_request.rs
// serde(rename_all = "camelCase") means field names arrive as camelCase

export interface PullRequest {
  id: number
  number: number
  title: string
  description: string
  state: 'open' | 'merged' | 'closed'
  author: { login: string; avatarUrl?: string }
  sourceBranch: string
  targetBranch: string
  isDraft: boolean
  hasConflicts: boolean
  createdAt: string
  updatedAt: string
  labels: string[]
  reviewers: { login: string; state: 'approved' | 'changesRequested' | 'pending' }[]
  ciStatus: 'success' | 'failure' | 'pending' | 'running' | null
  webUrl: string
  provider: 'github' | 'gitlab'
}

// ... PrComment, PrReview, CiCheck mirrors
```

No TS service layer. Frontend calls `invoke('list_pull_requests', { repoPath, state })` directly.

### 2.7 — Token management in Rust

Tokens live in Rust managed state — the frontend never sees or passes them.

**Rust-side token store (`Mutex<TokenStore>` in Tauri managed state):**
```rust
pub struct TokenStore {
    pub github: Option<String>,                    // access_token
    pub gitlab: HashMap<String, GitLabTokens>,     // host → { access_token, refresh_token, expires_at }
}
```

**Flow:**
1. OAuth flows (`github.rs`, `gitlab.rs`) already obtain tokens in Rust
2. Instead of returning tokens to the frontend, they store them directly in `TokenStore`
3. PR commands read tokens from `TokenStore` — no token args needed
4. Tokens are persisted to disk (encrypted or plain file in app data dir) so they survive app restarts
5. Frontend only knows *whether* a provider is connected (bool), never the token value
6. Settings UI shows connect/disconnect buttons; "disconnect" clears the token from `TokenStore`

**Tauri commands for auth status (replacing token-returning commands):**
```rust
#[tauri::command]
async fn is_github_connected(state: State<'_, Mutex<TokenStore>>) -> Result<bool, String>

#[tauri::command]
async fn is_gitlab_connected(state: State<'_, Mutex<TokenStore>>, host: String) -> Result<bool, String>

#[tauri::command]
async fn disconnect_github(state: State<'_, Mutex<TokenStore>>) -> Result<(), String>

#[tauri::command]
async fn disconnect_gitlab(state: State<'_, Mutex<TokenStore>>, host: String) -> Result<(), String>

#[tauri::command]
async fn list_gitlab_connections(state: State<'_, Mutex<TokenStore>>) -> Result<Vec<String>, String>  // returns connected hosts
```

**GitLab token refresh:** Handled transparently in Rust. When a GitLab API call gets a 401, the adapter auto-refreshes using the stored `refresh_token` before retrying. Frontend is unaware.

**Migration:** Existing settings store `providers` section on the frontend will be removed. Any tokens currently stored there are migrated to `TokenStore` on first launch, then cleared from the frontend store.

### 2.8 — Dev server updates

Extend `dispatch_cmd!` macro in `src-tauri/src/dev_server.rs` to include all new PR commands, so they're accessible via `POST /invoke/{cmd}` for browser-based testing.

---

## Phase 3: PR/MR UI — List & Detail View

**Goal**: View PRs/MRs in the app, see details, diffs, comments, CI status.

### 3.1 — PR/MR list in project tree — DONE

Under each root project that has a detected provider, show an expandable section in the ProjectSidebar tree:

```
▼ my-project/
    main (working tree)
  ▼ Pull Requests (3)
      #42 Fix login bug          ✓
      #38 Add dark mode          ●
      #35 Refactor auth          ✗
  ▼ Worktrees
      feature-x
```

**Implemented:**
- `pr.store.ts` — zustand store with provider detection cache (`providers`), PR list cache (`cache` keyed by repoPath), selection state (`selectedPr`)
- Provider detection runs eagerly on sidebar mount for all root projects via `detectAllProviders()`
- "Pull Requests" section appears below worktree children when provider is detected
- Fetched lazily when section is expanded (fires `fetchPrs` on first expand)
- Badge count on the section header after first fetch
- Manual refresh button (appears on hover when section is expanded)
- Loading spinner, error state (with Settings link for auth errors), empty state
- `PrRow` component shows PR icon (color-coded by state: green=open, purple=merged, red=closed), `#number`, title, draft badge, CI status icon
- **Container swap in AppShell**: `selectedPr !== null` swaps the entire 3-column git area to `<PrDetailView>`, keyed by `repoPath-pr-number` for full remount
- Clicking a project/worktree row calls `clearSelectedPr()` to swap back to git panels
- `PrDetailView` (placeholder): column 1 shows full PR metadata (title, state badge, branches, author, description, labels, reviewers, conflict warning, web link, timestamps); columns 2+3 show "Coming in Phase 3.2" placeholders for Diff and Conversation

### 3.2 — PR/MR detail panel — DONE

When a PR/MR is selected from the tree:
- **Column 1** → PR metadata (title, state badge, branches, author, description, labels, reviewers, conflict warning, web link, timestamps)
- **Column 2** → PR diff: `get_pr_files` Rust command (GitHub `/pulls/{n}/files`, GitLab `/merge_requests/{iid}/changes`) → unified patch parsed into `FileDiff[]` → rendered via existing `FileDiffList` with Monaco DiffEditor per file
- **Column 3** → Conversation timeline: `get_pr_comments` + `get_pr_reviews` merged chronologically, review state badges (approved/changes requested/commented), inline comment file references, "Add a comment" form via `add_pr_comment`

**New files:**
- `src/components/pull-requests/PrDiffPanel.tsx` — fetches PR files, parses patches, renders via FileDiffList
- `src/components/pull-requests/PrConversationPanel.tsx` — chronological timeline of comments + reviews, add comment form
- `src-tauri/src/pull_request.rs` — added `PrFile` struct + `get_pr_files` command (GitHub + GitLab adapters)
- `src/types/pull-request.ts` — added `PrFile` TS type

### 3.1.5 — Create PR/MR from branch — PENDING

**Trigger:** Right-click a branch in the Changes panel → "Create Pull Request" context menu item.

**Flow:**
1. Right-click a non-default, pushed branch → context menu shows "Create Pull Request" (only if provider detected + connected)
2. Opens a dialog:
   - **Target branch** selector (defaults to `main` or `master`, whichever exists)
   - **Title** (pre-filled: humanized branch name or last commit subject)
   - **Description** (markdown textarea)
   - **Draft** toggle
3. Submit → calls `invoke('create_pull_request', { repoPath, params })`
4. On success: PR appears in sidebar PR list, optionally auto-opens detail view
5. **Fallback**: if provider not connected, show "Open on GitHub/GitLab" link instead (opens browser to the "new PR" page with branch pre-filled)

**Prerequisites for showing the menu item:**
- Branch is not the default branch (not `main`/`master`)
- Branch has been pushed (has remote tracking or remote counterpart exists)
- Provider detected for this repo

### 3.3 — (Merged into 3.1.5 above)

---

## Phase 4: MR/PR Checkout as Sub-Project — DONE

**Goal**: Check out a PR/MR locally as a worktree sub-project with full filesystem isolation.

### 4.1 — "Checkout Locally" action — DONE

**Implemented:**
- Right-click context menu on any open PR in the sidebar PrRow → "Checkout Locally"
- "Checkout Locally" button in the PrDetailView metadata column
- Both trigger `checkoutPr()` action in `pr.store.ts` which orchestrates:
  1. `git fetch origin` — ensures latest remote refs
  2. `git worktree add <path> origin/<sourceBranch>` — creates isolated checkout
  3. Registers `ProjectEntry` with `kind: 'mr-checkout'`, `meta: { mrId, branch, provider }`
- Worktree path convention: `~/.git-multi-project/worktrees/<projectId>/pr-<number>-<branch>/`
- Already-checked-out PRs show "Already Checked Out" (disabled) in both context menu and button
- Spinner shown during checkout operation
- Errors surface via global error banner
- Fork-based PRs deferred (same-repo branches only for now)

### 4.2 — Independent agent sessions — DONE (works out of the box)

Since each sub-project has its own `projectId` and `projectPath`:
- Terminal sessions key on `sessionKey(projectId, column)` — already isolated
- User can switch between main project, worktree, and MR checkout
- Each gets its own opencode + shell terminal session
- Per-project UI state scoped via `useProjectUI(repoPath)` — no cross-contamination

### 4.3 — Cleanup — DONE (reuses existing worktree removal)

Existing `ProjectContextMenu` already handles `mr-checkout` kind:
- Context menu shows "Remove Checkout" for `mr-checkout` entries
- `handleRemoveWorktree()` in ProjectSidebar: force-removes worktree, prunes, deletes orphaned branch, removes ProjectEntry
- Works identically for worktrees and MR checkouts

---

## Phase 5: Full Lifecycle Actions

**Goal**: Complete PR/MR workflow from within the app.

### 5.1 — Review actions
- Approve, request changes, add comments (inline on diff lines and general)
- View existing reviews and comment threads
- Resolve/unresolve discussion threads (GitLab)
- Re-request review

### 5.2 — Merge
- Merge button with strategy picker (merge commit / squash / rebase)
- Pre-flight checks: CI status, approval count, conflict state
- On conflict: prompt user to resolve locally (they're already on a worktree checkout)

### 5.3 — Conflict resolution flow
1. PR/MR shows "has conflicts"
2. User clicks "Checkout Locally" (if not already) — creates worktree sub-project
3. User switches to the MR checkout sub-project
4. App runs `git fetch origin && git merge origin/<target-branch>`
5. Conflicts appear in ChangesPanel as `updated-but-unmerged`
6. User resolves in diff viewer, stages, commits, pushes
7. PR/MR auto-updates — conflicts resolved, CI re-runs, ready to merge

### 5.4 — CI/CD status
- Show pipeline/check status as icons on PR/MR list items
- Detail view shows individual checks with pass/fail/running status
- Click to open full CI logs in browser

---

## Dependency Graph

```
Phase 0 (tree + worktrees)  ←──────────────────────────┐
    │                                                    │
    ├── Phase 1 (auth + provider detection)              │
    │       │                                            │
    │       └── Phase 2 (API service layer)              │
    │               │                                    │
    │               ├── Phase 3 (UI: list + detail)      │
    │               │                                    │
    │               └── Phase 4 (checkout as sub-project)┘
    │                       │
    │                       └── Phase 5 (full lifecycle)
```

- Phase 0 and Phase 1 can be developed **in parallel**
- Phase 4 depends on **both** Phase 0 (worktrees) and Phase 2 (API layer)
- Phase 3 and Phase 4 can be developed **in parallel** after Phase 2

---

## Open Questions

### Q5: Offline / API-unavailable behavior
When GitHub/GitLab APIs are unreachable:
- PR/MR sections show cached data with a "last fetched" timestamp?
- Or hide entirely until connectivity is restored?

---

## Files Created / Modified

### New files
| File | Purpose |
|------|---------|
| `src/services/worktree.service.ts` | Git worktree operations (list/add/remove), base dir resolver |
| `src/services/provider.ts` | Remote URL parser, provider detection (GitHub/GitLab/unknown) |
| `src/lib/invoke.ts` | Unified invoke shim (Tauri vs HTTP dev server) |
| `src/components/ui/error-banner.tsx` | Shared error/warning banner component |
| `src/components/ui/copy-button.tsx` | Shared copy-to-clipboard button |
| `src-tauri/src/github.rs` | GitHub device flow OAuth + REST API proxy |
| `src-tauri/src/gitlab.rs` | GitLab PKCE OAuth + token refresh + REST API proxy |
| `src-tauri/src/dev_server.rs` | Axum HTTP server exposing Tauri commands for browser testing |

#### Phase 2
| File | Purpose |
|------|---------|
| `src-tauri/src/pull_request.rs` | Unified PR types, provider detection (Rust), dispatch to GitHub/GitLab adapters, all PR Tauri commands |
| `src/types/pull-request.ts` | Thin TS type mirrors of Rust structs (no logic) |

#### Phase 3.1
| File | Purpose |
|------|---------|
| `src/stores/pr.store.ts` | Zustand store: provider detection cache, PR list cache (keyed by repoPath), selectedPr, fetch/select/clear actions |
| `src/components/pull-requests/PrRow.tsx` | Sidebar PR row: state-colored icon, number, title, draft badge, CI status indicator |
| `src/components/pull-requests/PrDetailView.tsx` | 3-column PR detail container: metadata column + placeholder diff/conversation columns |

### Modified files
| File | Changes |
|------|---------|
| `src/services/project-manager.ts` | `ProjectEntry` extended with `kind`, `parentId`, `meta`; tree helpers; cascade delete |
| `src/stores/project.store.ts` | `addChildProject`, `getRootProjects`, `getChildren`, `getRootFor` |
| `src/stores/settings.store.ts` | `providers` section (GitHub token + GitLab instances) |
| `src/components/projects/ProjectSidebar.tsx` | Tree rendering, worktree add/remove, expand/collapse; Phase 3.1: PR section per root, provider detection on mount, lazy PR fetch, PrRow integration |
| `src/components/context-menus/ProjectContextMenu.tsx` | Worktree-aware menu items |
| `src/components/settings/SettingsModal.tsx` | Providers tab (GitHub device flow UI, GitLab multi-instance UI) |
| `src/components/layout/AppShell.tsx` | Panel keying by `repoPath`, shared `ErrorBanner`/`CopyButton`; Phase 3.1: container swap (`selectedPr` → PrDetailView vs git panels) |
| `src/components/changes/ChangesPanel.tsx` | Error banner, commit error dialog, project-scoped state via key |
| `src-tauri/src/lib.rs` | Registered new modules/commands, CDP enabled in dev, dev server spawn |
| `src-tauri/src/openrouter.rs` | Improved error parsing (extract human message from JSON) |
| `src-tauri/Cargo.toml` | Added axum, tower-http |
| `src-tauri/permissions/allow-run-git.toml` | Whitelisted 6 new commands |

#### Phase 2 modifications (planned)
| File | Changes |
|------|---------|
| `src-tauri/src/github.rs` | Add typed PR adapter functions (list/get/create/update/merge/comments/reviews/checks) on top of existing generic API helper; OAuth flow stores tokens into `TokenStore` instead of returning them; add `is_github_connected`/`disconnect_github` commands |
| `src-tauri/src/gitlab.rs` | Add typed MR adapter functions on top of existing generic API helper; OAuth flow stores tokens into `TokenStore`; transparent 401 → refresh retry; add `is_gitlab_connected`/`disconnect_gitlab`/`list_gitlab_connections` commands |
| `src-tauri/src/lib.rs` | Register `pull_request` module + all new PR/auth-status Tauri commands; initialize `TokenStore` managed state; load persisted tokens on startup |
| `src-tauri/src/dev_server.rs` | Extend `dispatch_cmd!` macro with new PR + auth-status commands |
| `src-tauri/permissions/allow-run-git.toml` | Whitelist new PR + auth-status commands |
| `src/stores/settings.store.ts` | Remove `providers` section (tokens migrated to Rust `TokenStore`); replace with connection-status queries via Tauri commands |
| `src/components/settings/SettingsModal.tsx` | Providers tab calls `is_github_connected`/`is_gitlab_connected` instead of reading tokens from store; connect/disconnect buttons invoke Rust commands |
