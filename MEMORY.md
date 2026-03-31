# MEMORY.md

Prescriptive workflow rules for this repository (complements `CLAUDE.md`).

## Git and session closure

- **DO**: After finishing a coding task, stage all intended paths (`git add` on modified and new files), run `bun run typecheck` and `bun run lint` (or the scoped tests you touched), then commit with Conventional Commits (`<type>(<scope>): <summary>`, summary under ~50 characters; types: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`).
- **DO**: Before treating the session as done or answering “finished”, run `git status` and ensure a clean working tree on `main` (or your intended branch)—no unstaged edits and no untracked directories left from the task.
- **DO**: Push to `origin main` after commit when work should land remotely: `git log origin/main..HEAD --oneline`, then `git push origin main` (use `swiz push-wait` / project push flow when cooldown or hooks apply).
- **DON'T**: Stop or declare the task complete while `git status` still shows modified or untracked files from that task—stop hooks and collaboration checks expect committed (and usually pushed) work.
- **DO**: When stop (or another hook) surfaces **uncommitted changes** or an **ACTION REQUIRED** to commit/push, treat that as a hard gate: run `git status`, stage every path from the task (`git add` including new files under `src/dispatch/` or elsewhere), run `bun run typecheck` and scoped or full `bun test`, commit with Conventional Commits, run `git log origin/main..HEAD --oneline`, push with `git push origin main` (or `swiz push-wait` / `/push` flow when the repo uses it), then resume—hooks encode trunk hygiene; ignoring the signal leaves the tree dirty and blocks a clean stop.
- **DO**: After every push to `main`, tie the branch to CI before ending the session: `SHA=$(git rev-parse HEAD)` (or `origin/main` after fetch), `gh run list --commit "$SHA" --limit 1 --json databaseId,status,conclusion`, then `gh run watch <databaseId> --exit-status` or `gh run view <id> --log-failed` if it failed; do not treat the session as finished while the latest run for that commit is missing, `in_progress`, or not `success` unless the team explicitly accepts a broken trunk.
- **DO**: When a hook lists **session tasks** (e.g. “wait for CI”, “mark tasks completed”), finish or explicitly hand off each item: if work is done, use native **TaskUpdate** with `status: completed` and evidence (`test:`, `note:ci_green`, `commit:`, etc. per `swiz tasks complete` / hook rules); if not done, keep a **`pending` or `in_progress`** follow-up task—**DON'T** ignore that block and attempt stop again unchanged.

## CI and native tasks before stop

- **DO**: After `git push origin main`, set `SHA=$(git rev-parse HEAD)`, run `gh run list --commit $SHA --json databaseId` (or `swiz ci-wait $SHA`) and confirm the latest run reaches **success** with `gh run view <id> --json conclusion,status,jobs` before treating the session as finished—do not stop on “pushed” alone.
- **DO**: When using native **Task** tools in-session, mark work **completed** with `TaskUpdate` (evidence: `commit:`, `test:`, or `file:`) as soon as the change is committed; if the scope was already shipped earlier, update tasks to **completed** instead of leaving them open when the stop hook lists outstanding tasks.
- **DON'T**: Ignore stop-hook text that lists **tasks needing attention** or **wait for CI**—either run the CI check for your SHA, close/update tasks, or finish the remaining implementation before attempting stop again.
