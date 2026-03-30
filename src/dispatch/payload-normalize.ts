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
 */
export function normalizeAgentHookPayload(payload: Record<string, unknown>): void {
  const sid = payload.session_id
  if (typeof sid !== "string" || !sid.trim()) {
    const conv = payload.conversation_id
    if (typeof conv === "string" && conv.trim()) {
      payload.session_id = conv.trim()
    }
  }

  const cwdVal = payload.cwd
  if (typeof cwdVal !== "string" || !cwdVal.trim()) {
    const roots = payload.workspace_roots
    if (Array.isArray(roots) && roots.length > 0) {
      const first = roots[0]
      if (typeof first === "string" && first.trim()) {
        payload.cwd = first.trim()
      }
    }
  }

  normalizeCursorShellCommandShape(payload)
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
