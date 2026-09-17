#!/usr/bin/env bun

/** Advisory-only weighted task divergence; the reducer owns reset/weight semantics. */
import { agentHasTaskToolsForHookPayload } from "../src/agent-paths.ts"
import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import { buildTaskDivergenceMessage } from "../src/tasks/task-governance-messages.ts"
import { isAnyProviderTaskCreateTool, isAnyProviderTaskUpdateTool } from "../src/tool-matchers.ts"
import { scheduleAutoSteer } from "../src/utils/auto-steer-helpers.ts"

interface AdvisorDependencies {
  readSnapshot: (cwd: string, sessionId: string) => Promise<unknown>
  steer: typeof scheduleAutoSteer
}

/** Lazy imports avoid the manifest/settings cycle for inline hooks. */
export async function readTaskAdvisorSnapshot(cwd: string, sessionId: string): Promise<unknown> {
  const { fetchSessionDivergenceFromDaemon } = await import("../src/utils/daemon-git-state.ts")
  const live = await fetchSessionDivergenceFromDaemon(cwd, sessionId)
  if (live !== null) return live
  const { readSessionDivergenceSnapshot } = await import("../src/commands/daemon/divergence.ts")
  return await readSessionDivergenceSnapshot(cwd, sessionId)
}

async function hasUnsettledTaskOutcome(raw: Record<string, any>): Promise<boolean> {
  const toolName = raw.tool_name ?? ""
  if (!isAnyProviderTaskCreateTool(toolName) && !isAnyProviderTaskUpdateTool(toolName)) return false
  const { taskMutationOutcome } = await import("../src/commands/daemon/divergence.ts")
  const outcome = taskMutationOutcome(raw.tool_response ?? raw.toolResponse)
  // PostToolUse capture may follow this hook; never warn from a pre-movement value.
  return outcome === "changed" || outcome === "unknown"
}

function taskAdvisorContext(input: unknown) {
  const raw = typeof input === "object" && input !== null ? (input as Record<string, any>) : {}
  if (!agentHasTaskToolsForHookPayload(raw)) return null
  const parsed = toolHookInputSchema.parse(raw)
  const sessionId = parsed.session_id
  const cwd = parsed.cwd
  return sessionId && cwd ? { raw, sessionId, cwd } : null
}

export async function evaluatePosttooluseTaskAdvisor(
  input: unknown,
  dependencies: AdvisorDependencies = {
    readSnapshot: readTaskAdvisorSnapshot,
    steer: scheduleAutoSteer,
  }
): Promise<SwizHookOutput> {
  const context = taskAdvisorContext(input)
  if (!context) return {}
  const { raw, sessionId, cwd } = context
  if (await hasUnsettledTaskOutcome(raw)) return {}
  const { divergenceSnapshotSchema } = await import("../src/commands/daemon/divergence.ts")
  const result = divergenceSnapshotSchema.safeParse(
    await dependencies.readSnapshot(cwd, sessionId).catch(() => null)
  )
  if (!result.success) return {}
  const snapshot = result.data
  const message = buildTaskDivergenceMessage(snapshot)
  if (!message) return {}
  if (
    snapshot.weightedSum >= snapshot.steerThreshold &&
    raw._effectiveSettings?.autoSteer !== false
  ) {
    await dependencies.steer(sessionId, message, undefined, cwd).catch(() => false)
  }
  return buildContextHookOutput("PostToolUse", message)
}

const posttooluseTaskAdvisor: SwizHook<Record<string, any>> = {
  name: "posttooluse-task-advisor",
  event: "postToolUse",
  timeout: 5,
  run(input) {
    return evaluatePosttooluseTaskAdvisor(input)
  },
}

export default posttooluseTaskAdvisor
if (import.meta.main) await runSwizHookAsMain(posttooluseTaskAdvisor)
