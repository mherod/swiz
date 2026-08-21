/**
 * Task-store path containment — the one place a session id becomes a directory path.
 *
 * `session_id` arrives verbatim from agent hook stdin and reaches `join(tasksDir, sessionId)`
 * unsanitized, so `..` segments escape the store: `"../../etc/passwd"` created a real
 * `~/etc/passwd/` task directory two levels above `~/.claude/tasks`. Reproduction and the
 * per-case containment table live in `scripts/debug-session-dir-traversal.ts`.
 *
 * This lives in its own leaf module rather than in `task-repository.ts` so that every caller can
 * reach it: `task-repository` imports `task-roots`, so the guard could not be shared with the
 * store-root resolver without a cycle. A guard only some call sites can import is how the
 * original fix ended up covering one file out of eleven.
 *
 * Depends on `node:path` alone — keep it that way so any module can import it.
 */

import { join, resolve, sep } from "node:path"

/**
 * Whether `sessionId` stays inside the task store when joined onto `tasksDir`.
 *
 * Containment is checked on the resolved path rather than by stripping characters, because
 * stripping silently reroutes writes: `"$(whoami)"` sanitizes to `"whoami"`, which is a
 * *different, valid* session whose tasks would then be mixed with the caller's. An id that
 * cannot be honoured exactly is refused, never rewritten. An absolute-looking id is safe —
 * `join` keeps it under the store, unlike `resolve`.
 */
export function isSafeSessionId(sessionId: string, tasksDir: string): boolean {
  if (!sessionId.trim()) return false
  const root = resolve(tasksDir)
  const dir = resolve(join(root, sessionId))
  return dir === root ? false : dir.startsWith(root + sep)
}

/**
 * Resolve a session's directory inside the task store, refusing ids that escape it.
 *
 * Hard backstop for every write and delete path; read paths that prefer an empty result over a
 * throw should test {@link isSafeSessionId} first.
 */
export function sessionDirPath(sessionId: string, tasksDir: string): string {
  if (!isSafeSessionId(sessionId, tasksDir)) {
    throw new Error(
      `Unsafe task session id ${JSON.stringify(sessionId)}: resolves outside the task store.`
    )
  }
  return join(tasksDir, sessionId)
}
