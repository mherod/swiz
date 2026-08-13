#!/usr/bin/env bun
/**
 * PostToolUse hook: push-autosteer-issue — schedules an auto-steer message
 * directing the agent to pick up a new issue from the issue store when:
 * 1. A git push command has successfully run (local HEAD matches remote tracking branch).
 * 2. There are no incomplete/pending tasks in the current session.
 * 3. There is a ready issue available in the issue store.
 *
 * Dual-mode: SwizHook + runSwizHookAsMain.
 */

import { getRepoSlug, git } from "../src/git-helpers.ts"
import { needsRefinement } from "../src/issue-refinement.ts"
import { getIssueStore } from "../src/issue-store.ts"
import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { PostToolHookInput } from "../src/schemas.ts"
import { postToolUseHookInputSchema } from "../src/schemas.ts"
import { readSessionTasks } from "../src/tasks/task-recovery.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import { scheduleAutoSteer } from "../src/utils/auto-steer-helpers.ts"
import { GIT_PUSH_RE } from "../src/utils/shell-patterns.ts"

export function isPushCommand(toolName: string, command: string): boolean {
  return isShellTool(toolName) && GIT_PUSH_RE.test(command)
}

export async function verifyPushLanded(cwd: string): Promise<boolean> {
  const localHead = await git(["rev-parse", "HEAD"], cwd)
  if (!localHead) return false

  const remoteHead = await git(["rev-parse", "@{upstream}"], cwd)
  if (!remoteHead) return false

  return localHead === remoteHead
}

export async function hasActiveTasks(sessionId: string): Promise<boolean> {
  const tasks = await readSessionTasks(sessionId)
  return tasks.some((t) => t.status === "in_progress" || t.status === "pending")
}

export async function getReadyIssue(
  cwd: string
): Promise<{ number: number; title: string } | null> {
  const repoSlug = await getRepoSlug(cwd)
  if (!repoSlug) return null

  const store = getIssueStore()
  const issues = store.listIssues<{
    number: number
    title: string
    labels?: Array<{ name: string }>
    state?: string
  }>(repoSlug, Number.MAX_SAFE_INTEGER)

  const openIssues = issues.filter((i) => (i.state ?? "open").toLowerCase() === "open")
  if (openIssues.length === 0) return null

  const readyIssues = openIssues.filter((i) => !needsRefinement({ ...i, labels: i.labels ?? [] }))
  return readyIssues[0] ?? null
}

interface PushAutosteerContext {
  cwd: string
  sessionId: string
}

function parsePushAutosteerContext(input: unknown): PushAutosteerContext | null {
  if (!input || typeof input !== "object") return null
  const parsed = postToolUseHookInputSchema.parse(input)
  const toolName = typeof parsed.tool_name === "string" ? parsed.tool_name : ""
  const toolInput = parsed.tool_input as { command?: string } | undefined
  const command = String(toolInput?.command ?? "")
  if (!isPushCommand(toolName, command)) return null

  const sessionId = parsed.session_id ?? ""
  if (!sessionId) return null
  return { cwd: parsed.cwd ?? process.cwd(), sessionId }
}

export async function evaluatePushAutosteerIssue(input: unknown): Promise<SwizHookOutput> {
  const context = parsePushAutosteerContext(input)
  if (!context) return {}

  // Verify the push actually landed
  if (!(await verifyPushLanded(context.cwd))) return {}
  if (await hasActiveTasks(context.sessionId)) return {}

  // Read open and ready issues from the local IssueStore
  const pick = await getReadyIssue(context.cwd)
  if (!pick) return {}

  const message = `Please look into the issue store for a new issue to work on. Ready issue available: #${pick.number} "${pick.title}".`

  // Enqueue steering message as asap so it's delivered immediately to the terminal
  await scheduleAutoSteer(context.sessionId, message, "asap", context.cwd)

  return {}
}

const posttoolusePushAutosteerIssue: SwizHook<PostToolHookInput> = {
  name: "posttooluse-push-autosteer-issue",
  event: "postToolUse",
  matcher: "Bash",
  timeout: 10,
  async: true,
  requiredSettings: ["autoSteer"],

  run(input) {
    return evaluatePushAutosteerIssue(input)
  },
}

export default posttoolusePushAutosteerIssue

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusePushAutosteerIssue as SwizHook<Record<string, any>>)
}
