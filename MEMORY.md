# Session Directives

## DO

- Confirm whether the requested issue is already implemented before making edits; prefer evidence-first closure when acceptance criteria are already on `main`.
- When full-suite tests fail, isolate the failing test first (`bun test <file> --concurrent`) before modifying unrelated files.
- Keep changes scoped to the active issue; if a file outside scope changes during debugging, revert it immediately and continue with scoped validation.
- Use `git status` (full output, not only short form) before and after reset/unstage operations to distinguish staged vs unstaged state clearly.
- Report certainty levels accurately: "verified existing implementation" vs "implemented now."
- Match requested frontend source type before scaffolding; when user asks for TSX, create `.tsx` files from the start.
- Validate browser navigation success with snapshot/title/URL before confirming the page is open.
- Seed new "active project" UI APIs with at least the current working directory so first-load views are not empty.
- Run `bun run lint` after CSS/design passes and before declaring completion.

## DON'T

- Do not "stabilize" unrelated flaky tests as part of an issue that does not require those changes.
- Do not leave incidental test-timeout or formatting edits in unrelated files when no feature code change is needed.
- Do not claim implementation work happened in-session when resolution was actually verification-only.
- Do not rely on a navigation call alone as proof of page load.
- Do not postpone lint/style cleanup until stop-hook enforcement catches it.
