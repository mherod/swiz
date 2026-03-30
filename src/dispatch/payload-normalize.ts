/**
 * Map agent-specific dispatch JSON onto canonical Swiz hook fields before backfills.
 *
 * **Cursor** (`hooks.json`) sends `conversation_id` instead of `session_id`, and
 * `workspace_roots: string[]` instead of a single `cwd`. Other fields (`generation_id`,
 * `model`, `status`, `loop_count`, `cursor_version`, `user_email`, `transcript_path`,
 * `hook_event_name`) are left on the payload for hooks that read them.
 *
 * **Cursor shell hooks** (`beforeShellExecution` / `afterShellExecution`, mapped to
 * `preToolUse` / `postToolUse`) send a top-level **`command`** string without **`tool_name`**
 * or **`tool_input`**. Those are synthesized as Claude-style **`Bash`** + **`tool_input.command`**
 * so manifest matchers and hooks match.
 *
 * **cwd:** Cursor sometimes sends `cwd` as the global user-data directory (`…/.cursor`) while
 * also sending `workspace_roots`. We set `cwd` to the first workspace root when the payload
 * `cwd` is missing, empty, or not under any listed root. When `workspace_roots` is absent but
 * `cwd` is that global `…/.cursor` path (not `…/.cursor/projects/…`), we clear `cwd` so
 * `swiz dispatch` can inject `process.cwd()` from the launcher (the real project directory).
 */
export function normalizeAgentHookPayload(payload: Record<string, unknown>): void {
  const sid = payload.session_id
  if (typeof sid !== "string" || !sid.trim()) {
    const conv = payload.conversation_id
    if (typeof conv === "string" && conv.trim()) {
      payload.session_id = conv.trim()
    }
  }

  const rootsRaw = payload.workspace_roots
  const roots: string[] = Array.isArray(rootsRaw)
    ? rootsRaw
        .filter((r): r is string => typeof r === "string" && r.trim() !== "")
        .map((r) => r.trim().replace(/\/+$/, ""))
    : []

  const cwdStr = typeof payload.cwd === "string" ? payload.cwd.trim().replace(/\/+$/, "") : ""

  if (roots.length > 0) {
    const underSomeRoot =
      cwdStr !== "" && roots.some((r) => cwdStr === r || cwdStr.startsWith(`${r}/`))
    if (cwdStr === "" || !underSomeRoot) {
      payload.cwd = roots[0]
    }
  } else if (cwdStr !== "" && isCursorGlobalUserDataCwd(cwdStr)) {
    delete payload.cwd
  }

  normalizeCursorShellCommandShape(payload)
}

/** True for Cursor's top-level config dir (`…/.cursor`), not workspace metadata under `projects/`. */
function isCursorGlobalUserDataCwd(cwd: string): boolean {
  const t = cwd.replace(/\/+$/, "") || cwd
  return /\/\.cursor$/.test(t) && !t.includes("/.cursor/projects/")
}

/**
 * Cursor IDE shell events use `{ command: "..." }` at the top level. Swiz hooks expect
 * `tool_name` + `tool_input.command` like Claude Code PreToolUse.
 */
function normalizeCursorShellCommandShape(payload: Record<string, unknown>): void {
  const cmd = payload.command
  if (typeof cmd !== "string" || !cmd.trim()) return

  const hasToolName =
    (typeof payload.tool_name === "string" && payload.tool_name.trim()) ||
    (typeof payload.toolName === "string" && payload.toolName.trim())
  if (hasToolName) return

  const ti = payload.tool_input ?? payload.toolInput
  if (ti && typeof ti === "object" && !Array.isArray(ti)) {
    const t = ti as Record<string, unknown>
    if (typeof t.command === "string" && t.command.trim()) return
    if (Object.keys(t).length > 0) return
  }

  const toolInput: Record<string, unknown> = { command: cmd.trim() }
  if (payload.sandbox === true) {
    toolInput.sandbox = true
  }
  payload.tool_name = "Bash"
  payload.tool_input = toolInput
}
