#!/usr/bin/env bun

import { resolve } from "node:path"
import type { IssueStore } from "../src/issue-store.ts"
import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { type PostToolHookInput, toolHookInputSchema } from "../src/schemas.ts"
import {
  captureEditSnapshot,
  type EditObservationIdentity,
  editContinuationInput,
  editContinuationOutput,
  editObservationIdentity,
  explicitEditTargets,
  failedEditResponse,
  isObservedEditTool,
} from "../src/session-edit-snapshot.ts"
import { extractFileEditTargetPaths, isFileEditTool } from "../src/tool-matchers.ts"

export function resolveEditTargets(input: ReturnType<typeof toolHookInputSchema.parse>): string[] {
  if (!isFileEditTool(input.tool_name ?? "")) return []
  return extractFileEditTargetPaths(input.tool_input ?? {})
}

function uncertainOwnership(): SwizHookOutput {
  return buildContextHookOutput(
    "PostToolUse",
    "File edit ownership is uncertain for this call (overlapping sessions or unavailable observation). Inspect the diff before claiming files.",
    { rephrase: false }
  )
}

/** Missing shell observations are not evidence that the call edited files. */
function unavailableOwnership(input: PostToolHookInput): SwizHookOutput {
  return isFileEditTool(input.tool_name ?? "") ? uncertainOwnership() : {}
}

async function recordExplicitEdits(input: PostToolHookInput): Promise<SwizHookOutput> {
  if (failedEditResponse(input)) return {}
  const parsed = toolHookInputSchema.parse(
    typeof input.tool_input === "string"
      ? { ...input, tool_input: { command: input.tool_input } }
      : input
  )
  const files = resolveEditTargets(parsed)
  if (files.length === 0) return {}
  const cwd = parsed.cwd ?? process.cwd()
  const sessionId = parsed.session_id
  if (!sessionId) return uncertainOwnership()
  const [{ getIssueStore }, { canonicalClaimPath, fileClaimProjectKey }] = await Promise.all([
    import("../src/issue-store.ts"),
    import("../src/session-file-claims.ts"),
  ])
  const store = getIssueStore()
  if (store.isNoOp) return uncertainOwnership()
  const projectKey = fileClaimProjectKey(cwd)
  for (const file of files)
    store.recordSessionEdit(projectKey, sessionId, canonicalClaimPath(resolve(cwd, file)))
  return {}
}

async function finishObservation(
  store: IssueStore,
  identity: EditObservationIdentity,
  input: PostToolHookInput
): Promise<SwizHookOutput | null> {
  const { cwd, project, session, tool } = identity
  const continuation = editContinuationInput(input)
  const observation =
    (continuation && store.editObservations.pending(project, session, continuation)) ||
    store.editObservations.get(project, session, tool)
  if (!observation) return null
  if (observation.finished_at !== null) return {}
  const pending = editContinuationOutput(input.tool_response)
  if (pending) {
    store.editObservations.pause(project, session, observation.tool_id, pending)
    return {}
  }
  const previousPaths = Object.keys(JSON.parse(observation.snapshot ?? "{}"))
  const after = await captureEditSnapshot(cwd, [
    ...previousPaths,
    ...explicitEditTargets(input),
  ]).catch((error) => {
    store.editObservations.abandon(project, session, observation.tool_id)
    throw error
  })
  const changed = store.editObservations.finish(project, session, observation.tool_id, after)
  if (changed !== null) return {}
  return observation.snapshot ? uncertainOwnership() : unavailableOwnership(input)
}

async function recordObservedEdits(input: PostToolHookInput): Promise<SwizHookOutput | null> {
  try {
    const identity = editObservationIdentity(input)
    if (!identity) return null
    const { getIssueStore } = await import("../src/issue-store.ts")
    const store = getIssueStore()
    if (store.isNoOp) return unavailableOwnership(input)
    return await finishObservation(store, identity, input)
  } catch {
    return unavailableOwnership(input)
  }
}

export async function evaluatePosttooluseSessionEdits(
  input: PostToolHookInput
): Promise<SwizHookOutput> {
  if (!isObservedEditTool(input.tool_name ?? "")) return {}
  const observed = await recordObservedEdits(input)
  if (observed) return observed
  if (isFileEditTool(input.tool_name ?? "")) return await recordExplicitEdits(input)
  return {}
}

const hook: SwizHook<PostToolHookInput> = {
  name: "posttooluse-session-edits",
  event: "postToolUse",
  timeout: 10,
  // Finishes the edit observation its PreToolUse half began.
  sideEffect: true,
  run: evaluatePosttooluseSessionEdits,
}

export default hook
if (import.meta.main) await runSwizHookAsMain(hook)
