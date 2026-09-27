#!/usr/bin/env bun

import type { IssueStore } from "../src/issue-store.ts"
import {
  buildContextHookOutput,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
  type SwizHookRunContext,
} from "../src/SwizHook.ts"
import type { ToolHookInput } from "../src/schemas.ts"
import {
  captureEditSnapshot,
  type EditObservationIdentity,
  editContinuationInput,
  editObservationIdentity,
  explicitEditTargets,
  isObservedEditTool,
  SESSION_EDIT_OBSERVATION_MATCHER,
} from "../src/session-edit-snapshot.ts"

async function beginObservation(
  store: IssueStore,
  identity: EditObservationIdentity,
  input: ToolHookInput,
  context?: SwizHookRunContext
): Promise<void> {
  const { cwd, project, session, tool } = identity
  const continuation = editContinuationInput(input)
  if (continuation && store.editObservations.pending(project, session, continuation)) return
  if (context?.signal?.aborted) return
  if (!store.editObservations.begin(project, session, tool)) return
  const cancel = () => store.editObservations.cancel(project, session, tool)
  context?.signal?.addEventListener("abort", cancel, { once: true })
  try {
    const snapshot = await captureEditSnapshot(cwd, explicitEditTargets(input))
    store.editObservations.save(project, session, tool, snapshot)
  } catch (error) {
    cancel()
    throw error
  }
}

export async function evaluatePretooluseSessionEdits(
  input: ToolHookInput,
  context?: SwizHookRunContext
): Promise<SwizHookOutput> {
  if (!isObservedEditTool(input.tool_name ?? "")) return {}
  try {
    const identity = editObservationIdentity(input)
    if (!identity) return {}
    const { getIssueStore } = await import("../src/issue-store.ts")
    const store = getIssueStore()
    if (store.isNoOp) throw new Error("Edit history database unavailable")
    await beginObservation(store, identity, input, context)
    return {}
  } catch {
    return buildContextHookOutput(
      "PreToolUse",
      "File edit observation is unavailable for this call; automatic ownership coverage may be incomplete.",
      { rephrase: false }
    )
  }
}

const hook: SwizHook = {
  name: "pretooluse-session-edits",
  event: "preToolUse",
  matcher: SESSION_EDIT_OBSERVATION_MATCHER,
  timeout: 10,
  run: evaluatePretooluseSessionEdits,
}

export default hook
if (import.meta.main) await runSwizHookAsMain(hook)
