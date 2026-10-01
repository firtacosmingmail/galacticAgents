# P2-05 — Workspace and worktree service

Branch `worktree-agent-a338ed5827c1ee56a` (from `p2-wave2-services`), 2026-10-01.

## What was built

- `apps/server/src/config/config.ts`: **`projectsRoot`** setting: `~/GalacticProjects` by default, `projectsRoot` in `config.json` (`~/…` expanded) or `GALACTIC_PROJECTS_ROOT`; must be absolute.
- `apps/server/src/workspace/git.ts`: the one way the server runs git. `execFile('git', [...])`: argument arrays, never a shell string. Every call gets `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, a small environment (PATH, HOME, USER, TMPDIR, XDG_CONFIG_HOME, SSH_AUTH_SOCK plus `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`), and a 60 s timeout.
- `apps/server/src/workspace/workspaces.ts`: the `Workspaces` service (exported from `lib.ts`). It takes `{ projectsRoot, dataDir, home?, git?, identity?, commands, tables }`:
  - `suggestPath(name)` returns `<projectsRoot>/<slug>`, or `-2`, `-3`, … when that folder is taken. The Harmonizer uses it for the proposal card's default workspace.
  - `checkPath(path)` returns the canonical path. Refused: `/`, the home directory itself, the projects root itself, the data dir, anything inside the data dir and anything that contains it. It also refuses relative paths. Symlinks are resolved through the longest existing prefix.
  - `prepare({ name, path?, initGit? })` and `prepareProject(projectId, { initGit? })`. The second records the result through `Commands.updateProject` (one `project.updated`): the canonical `workspace`, `repoPath` (the repository root) and `meta.workspace = { git, repoRoot?, baseBranch?, serialStewards, reason?, initialised? }`.
  - `createWorktree(taskId)` returns `{ path, root, branch, baseBranch }`. It is idempotent and records `worktreePath`, `branch` and `meta.worktree = { root, baseBranch }` through `Commands.updateTask` (`task.updated`). If the workspace is a sub-folder of a repository, the Steward's `path` is the same sub-folder inside the worktree.
  - `mergeTask(taskId, { commitPending? })` returns a `MergeResult`. On success: `{ ok: true, commit, fastForward, nothingToMerge, branchDeleted }`. Otherwise: `{ ok: false, reason: 'conflict', conflict: MergeConflict }`, or `{ ok: false, reason: 'worktree_dirty' | 'workspace_dirty' | 'not_on_base_branch' | 'failed', message, files? }`. A successful merge records `meta.worktree.removed` and `meta.merge` on the task.
  - `removeWorktree(taskId, { force?, deleteBranch? })` removes a worktree for cancelled or failed tasks.
  - `stewardsSerialised(project)` and `workspaceMeta(project)` expose the non-git fallback flag for P2-11 and P2-17.
- All git work on one repository is serialised in-process (a promise chain per repository root). Concurrent merges, and a merge racing a `worktree add`, therefore cannot collide.
- Tests (`workspace/workspaces.test.ts`, 19 tests) run on temp repos with no global or system git config:
  - names and path refusals
  - new folders initialised; existing non-git folders serialised, or initialised with `initGit`
  - an existing repository left untouched; an unborn repository
  - two worktrees with one clean fast-forward merge and one conflict reported and aborted
  - a diverged clean merge
  - uncommitted-work refusal and `commitPending`
  - refusals for a dirty workspace and for a workspace off its base branch
  - three concurrent merges
  - `removeWorktree`
  - sub-folder workspaces
  - hooks never run (a mutation check, dropping `core.hooksPath`, fails this test)
  - standalone tasks refused

  All paths in the tests contain spaces.

## Decisions (proposed text, ready to paste)

**SPEC §7, decision 25 — Workspaces and worktrees (2026-10-01, P2-05).**

- A workspace is an existing folder or a new `<projectsRoot>/<slug>` (default `~/GalacticProjects`, settable).
- Never accepted as a workspace: `/`, the home directory itself, the projects root itself, or anything inside or containing the server's data directory.
- A new or empty folder gets `git init` and an empty first commit.
- **An existing folder that is not a git repository is not turned into one unless the user agrees.** Agreeing means `initGit`, shown on the proposal card. With it, the existing files are committed as a snapshot. Without it, the project has no worktrees and its Stewards run one at a time in the workspace.
- A repository with no commit is handled the same way. With consent it gets an empty first commit, and the index and files are left as they are.
- The base branch is the branch checked out when the workspace is prepared. A detached HEAD serialises the project.
- Each Steward gets `<workspace>/.galactic/worktrees/<task-id>` on `galactic/<task-id>-<slug>`. `.galactic/` is excluded through the repository's `info/exclude`; the user's `.gitignore` is never edited.
- The Waykeeper's merge happens in the workspace's own checkout. It is refused while that checkout is on another branch or has tracked changes. It is fast-forward when possible, otherwise a merge commit.
- On success the worktree is removed and the merged branch deleted.
- A conflict is aborted at once, so the repository is never left mid-merge. It is returned as `{ files, sourceBranch, targetBranch }` for the supervisor's clarification question. The worktree and branch are kept.

**TECHNOLOGY §8 — new bullet: server-run git.**

- Git runs through `workspace/git.ts`: `execFile` with argument arrays, `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, an allow-listed environment, no prompts and a timeout.
- Hooks are off because the server's own git commands would otherwise run them on the server's behalf, outside any agent and permission gate. Those commands are `worktree add` (post-checkout), the merge (pre-merge-commit, post-merge) and the initial commit (pre-commit).
- Stewards' own commits run in their shell with hooks, under the project's policy.
- Filters, merge drivers and `diff.external` configured in the repository stay active (for example a git-lfs smudge filter). They are the user's own setup for the repository they pointed at.
- Server commits use the repository's identity, or `GalacticAgents <galactic@localhost>` when none is configured. Commit signing follows the user's config.

**TECHNOLOGY §6 — fields.** `Project.repoPath` = the repository root. `Project.meta.workspace` = the `prepare` result (`WorkspaceMeta`). `Task.meta.worktree = { root, baseBranch, removed? }` and `Task.meta.merge = { commit, fastForward, branchDeleted }`. After a merge, `worktreePath` and `branch` stay as the record of where the work happened, because clearing fields is P2-20. A project that was never prepared counts as serialised.

**Answer to the SPEC §8 merge-conflict question (recommendation).** Phase 2: the conflict becomes a clarification question carrying the file list and both branches. The Waykeeper may answer it from context with "re-run the task on top of the new base". It does this by spawning the same task's Steward in its kept worktree with the instruction to `git merge <base>` and resolve, then calling `merge_task` again. Otherwise it escalates and the user resolves by hand in the worktree; `mergeTask` is then retried. A dedicated "merge Steward" is unnecessary: the task's own Steward has the context. Record as decision 26 if accepted.

## Deferred

- **Standalone (asteroid) tasks**: `createWorktree` refuses them. When the Harmonizer puts an asteroid in a related project's workspace, it should probably get a worktree of that project. That belongs to P2-09 and P2-11.
- **Wiring**: `composeRuntime` does not build `Workspaces`, because it has no config. `index.ts` and the brains (P2-10) construct it with `config.projectsRoot` and `config.dataDir`, the composed `commands` and `log.tables`.
- **Opening the conflict question** is P2-10. **Enforcing serialisation** is P2-11 and P2-17. The `initGit` toggle on the proposal card is P2-08 and P2-09.
- Merging without touching the user's checkout (for example `git merge-tree --write-tree` plus `update-ref` when the checkout is not on the base branch) is not built. Today a merge is refused and reported as `not_on_base_branch`.
- Clearing `worktreePath` after a merge is waiting on P2-20.
- Untracked files in the workspace that a merge would overwrite produce `reason: 'failed'` with git's message, not a structured result.
