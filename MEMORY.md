# MEMORY.md

Prescriptive workflow rules for this repository (complements `CLAUDE.md`).

## Git and session closure

- **DO**: After finishing a coding task, stage all intended paths (`git add` on modified and new files), run `bun run typecheck` and `bun run lint` (or the scoped tests you touched), then commit with Conventional Commits (`<type>(<scope>): <summary>`, summary under ~50 characters; types: `feat`, `fix`, `refactor`, `docs`, `style`, `test`, `chore`).
- **DO**: Before treating the session as done or answering “finished”, run `git status` and ensure a clean working tree on `main` (or your intended branch)—no unstaged edits and no untracked directories left from the task.
- **DO**: Push to `origin main` after commit when work should land remotely: `git log origin/main..HEAD --oneline`, then `git push origin main` (use `swiz push-wait` / project push flow when cooldown or hooks apply).
- **DON'T**: Stop or declare the task complete while `git status` still shows modified or untracked files from that task—stop hooks and collaboration checks expect committed (and usually pushed) work.
- **DO**: When stop (or another hook) surfaces **uncommitted changes** or an **ACTION REQUIRED** to commit/push, treat that as a hard gate: run `git status`, stage every path from the task (`git add` including new files under `src/dispatch/` or elsewhere), run `bun run typecheck` and scoped or full `bun test`, commit with Conventional Commits, run `git log origin/main..HEAD --oneline`, push with `git push origin main` (or `swiz push-wait` / `/push` flow when the repo uses it), then resume—hooks encode trunk hygiene; ignoring the signal leaves the tree dirty and blocks a clean stop.
