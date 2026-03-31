# MEMORY.md

Prescriptive workflow rules for this repository (complements `CLAUDE.md`).

## Git and session closure

- **DO**: After finishing a coding task, stage all intended paths (`git add` on modified and new files), run `bun run typecheck` and `bun run lint` (or the scoped tests you touched), then commit with Conventional Commits (`<type>(<scope>): <summary>`, summary under ~50 characters; types: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`).
- **DO**: Before treating the session as done or answering “finished”, run `git status` and ensure a clean working tree on `main` (or your intended branch)—no unstaged edits and no untracked directories left from the task.
- **DO**: Push to `origin main` after commit when work should land remotely: `git log origin/main..HEAD --oneline`, then `git push origin main` (use `swiz push-wait` / project push flow when cooldown or hooks apply).
- **DON'T**: Stop or declare the task complete while `git status` still shows modified or untracked files from that task—stop hooks and collaboration checks expect committed (and usually pushed) work.
- **DO**: When stop (or another hook) surfaces **uncommitted changes** or an **ACTION REQUIRED** to commit/push, treat that as a hard gate: run `git status`, stage every path from the task (`git add` including new files under `src/dispatch/` or elsewhere), run `bun run typecheck` and scoped or full `bun test`, commit with Conventional Commits, run `git log origin/main..HEAD --oneline`, push with `git push origin main` (or `swiz push-wait` / `/push` flow when the repo uses it), then resume—hooks encode trunk hygiene; ignoring the signal leaves the tree dirty and blocks a clean stop.

## Before stop: CI and session tasks (stop-hook checklist)

When a hook reports **tasks that need your attention** or **ACTION REQUIRED** before finishing the session, run this sequence in order—**DON'T** retry stop until each applicable step is satisfied.

1. **DO**: **Wait for CI, then check results** for the commit you care about: `SHA=$(git rev-parse HEAD)` after push, `gh run list --commit "$SHA" --limit 1 --json databaseId,status,conclusion`, then `gh run watch <databaseId> --exit-status` or `swiz ci-wait $SHA`, and on failure `gh run view <id> --json conclusion,status,jobs` / `--log-failed`. Treat “pushed” as insufficient until the run for that SHA is **success** (or the team explicitly accepts a broken trunk).
2. **DO**: If the implementation is **already done**, use native **TaskUpdate** to mark **each** current-session task **`completed`** with valid evidence (`commit:`, `test:`, `file:`, or `note:` for `swiz tasks complete`—see repo issue #300 if the hook mentions unsupported evidence keys). **DON'T** leave tasks open when the hook lists them and the work is shipped.
3. **DO**: If work is **still needed**, complete it (or add a **`pending`** / **`in_progress`** follow-up task with a single clear next step) **before** attempting stop again—**DON'T** loop stop with the same outstanding gap.

**DON'T**: Dismiss stop-hook copy that lists “wait for CI”, “mark tasks completed”, or “complete work”—either execute the checklist above or hand off with an explicit in-repo state (open task, failing CI triage, etc.).
