/**
 * Recovery-oriented payload inference for dispatch hook inputs.
 *
 * Fills required canonical fields (`cwd`, `session_id`) when the inbound agent
 * payload omits them. Runs **after** {@link normalizeAgentHookPayload}
 * (agent-specific key mapping) and **before** {@link assertNormalizedDispatchPayload}
 * (the Zod gate), so downstream consumers always see a canonical shape.
 *
 * Every synthesized field is recorded on `payload._inferredFields: string[]` for
 * diagnostics — `logPayloadDiagnostics` surfaces the list so a corrupt upstream
 * agent leaves a visible trail instead of silently producing `unknown-session`.
 *
 * ### Scope
 *
 * Inference only targets general, non-tool events (Stop, SessionStart,
 * UserPromptSubmit, PreCompact, SubagentStop, SessionEnd, etc.). We do **not**
 * synthesize `tool_name` or `tool_input` — a PreToolUse/PostToolUse payload
 * with a missing tool identifier is genuinely corrupt, and inventing one would
 * route the dispatch to the wrong hook group. Missing `hook_event_name` is
 * likewise left alone: per-agent upstream schemas pin it to a literal
 * (`"Stop"`, `"PreToolUse"`), and filling it with the canonical dispatch event
 * ("stop", "preToolUse") would fail the literal check.
 *
 * ### Daemon safety
 *
 * The daemon serves multiple projects simultaneously; its own `process.cwd()`
 * is the swiz install directory, not the caller's project. The CLI layer
 * (`src/commands/dispatch.ts`) injects `process.cwd()` into the payload before
 * forwarding to the daemon so the daemon sees the correct project cwd. This
 * module records where `cwd` came from (`CwdSource`) and refuses to run disk
 * scans keyed off cwd when it fell through to `process.cwd()` — otherwise a
 * broken upstream payload could make the daemon infer a session from the wrong
 * project tree.
 */

import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { getHomeDirOrNull } from "../home.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import { log } from "./engine.ts"

/** Source of the resolved `cwd` value — used to gate disk-based inference. */
type CwdSource = "payload" | "env" | "process"

/**
 * Mutate `payload` to fill missing required fields.
 *
 * Idempotent — safe to call multiple times. Records each filled field in
 * `payload._inferredFields: string[]`.
 */
export async function backfillPayloadDefaults(payload: Record<string, any>): Promise<void> {
  const cwdSource = backfillCwd(payload)
  await backfillSessionId(payload, cwdSource)
}

/** Append `field` to `payload._inferredFields` without duplicates. */
function trackInferred(payload: Record<string, any>, field: string): void {
  const list = Array.isArray(payload._inferredFields) ? (payload._inferredFields as string[]) : []
  if (!list.includes(field)) list.push(field)
  payload._inferredFields = list
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/**
 * Resolve `payload.cwd` through the agent → env var → process fallback chain
 * and return the source tier. Later inference steps consult the source to
 * decide whether cwd-scoped disk lookups are trustworthy.
 */
function backfillCwd(payload: Record<string, any>): CwdSource {
  if (isNonEmptyString(payload.cwd)) return "payload"

  const envCwd =
    process.env.GEMINI_CWD || process.env.GEMINI_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR
  if (isNonEmptyString(envCwd)) {
    payload.cwd = envCwd
    trackInferred(payload, "cwd")
    return "env"
  }

  const processCwd = process.cwd()
  payload.cwd = processCwd
  trackInferred(payload, "cwd")

  if (payload._cwdCleared) {
    log(
      `[warn] Dispatch: cwd was cleared during payload normalization ` +
        `(Cursor global dir detected) and fell back to ${processCwd}. ` +
        `Hooks will operate on that directory, not the user's project. ` +
        `Ensure Cursor sends workspace_roots or the CLI layer injects cwd.`
    )
  }
  return "process"
}

/**
 * Session-id fallback chain:
 *   payload.session_id (from agent / conversation_id mapping)
 *   → `$GEMINI_SESSION_ID`
 *   → latest Claude transcript file for this project's cwd (disk scan)
 *   → `"unknown-session"` (final floor).
 *
 * The disk scan is skipped when `cwdSource === "process"` because that means
 * cwd came from the process's own working directory — which is trustworthy
 * CLI-side but **not** daemon-side (the daemon serves multiple projects from
 * its own install dir). Scanning that tree risks returning a session id from
 * an unrelated project. The scan is also scoped by `projectKeyFromCwd` so it
 * can never leak a session id from a different project when we do run it.
 */
async function backfillSessionId(
  payload: Record<string, any>,
  cwdSource: CwdSource
): Promise<void> {
  if (isNonEmptyString(payload.session_id)) return

  const fromEnv = process.env.GEMINI_SESSION_ID
  if (isNonEmptyString(fromEnv)) {
    payload.session_id = fromEnv
    trackInferred(payload, "session_id")
    return
  }

  if (cwdSource !== "process" && isNonEmptyString(payload.cwd)) {
    const fromDisk = await findLatestClaudeSessionIdForCwd(payload.cwd)
    if (fromDisk) {
      payload.session_id = fromDisk
      trackInferred(payload, "session_id")
      log(
        `[warn] Dispatch: session_id missing from payload; inferred latest ` +
          `Claude session "${fromDisk}" from ~/.claude/projects. Upstream ` +
          `agent should send session_id.`
      )
      return
    }
  }

  payload.session_id = "unknown-session"
  trackInferred(payload, "session_id")
}

/**
 * Scan `~/.claude/projects/<projectKey>/` for the most recently modified
 * `.jsonl` transcript file and return its session id (filename without
 * extension). Returns null when HOME is unset, the directory is missing, or
 * no transcript files exist.
 */
async function findLatestClaudeSessionIdForCwd(cwd: string): Promise<string | null> {
  const home = getHomeDirOrNull()
  if (!home) return null

  const dir = join(home, ".claude", "projects", projectKeyFromCwd(cwd))
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }

  const transcripts = entries.filter((name) => name.endsWith(".jsonl"))
  if (transcripts.length === 0) return null

  const stats = await Promise.all(
    transcripts.map(async (name) => {
      try {
        const s = await stat(join(dir, name))
        return { name, mtimeMs: s.mtimeMs }
      } catch {
        return { name, mtimeMs: 0 }
      }
    })
  )

  stats.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const latest = stats[0]
  if (!latest || latest.mtimeMs === 0) return null

  return latest.name.slice(0, -".jsonl".length)
}
