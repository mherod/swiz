/**
 * Debug Swiz recognition of Codex update_plan transcript records.
 *
 * Run:
 *   bun scripts/debug-codex-update-plan.ts --self-test
 *   bun scripts/debug-codex-update-plan.ts <rollout.jsonl> [session-id]
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { getProviderTaskRoots } from "../src/provider-adapters.ts"
import {
  extractCodexUpdatePlanSnapshotsFromRawJsonl,
  isCodexPlanTaskId,
  syncCodexUpdatePlanSnapshot,
} from "../src/tasks/codex-update-plan.ts"
import { readTasks, type Task } from "../src/tasks/task-repository.ts"
import {
  computeSummaryFromSessionLines,
  readCurrentSessionLines,
} from "../src/transcript-summary.ts"
import { tryParseJsonLine } from "../src/utils/jsonl.ts"

interface CodexToolPayload {
  arguments?: unknown
  input?: unknown
  name?: string
  type?: string
}

interface CodexTranscriptEntry {
  payload?: CodexToolPayload
  timestamp?: string
  type?: string
}

type PlanTranscriptEntry = CodexTranscriptEntry & {
  payload: CodexToolPayload & { name: string }
}

interface PlanCallObservation {
  directUpdatePlan: boolean
  executableNestedUpdatePlan: boolean
  inputLength: number | null
  inputPreview: string | null
  lineIndex: number
  nestedUpdatePlan: boolean
  outerName: string
  parserSnapshotCount: number
  payloadType: string
  timestamp: string | null
}

interface SyntheticScenario {
  intendedPlanCall: boolean
  line: string
  name: string
}

function usage(): never {
  throw new Error(
    "Usage: bun scripts/debug-codex-update-plan.ts --self-test | <rollout.jsonl> [session-id]"
  )
}

function codexResponseItem(payload: CodexToolPayload): string {
  return JSON.stringify({
    timestamp: "2026-07-31T16:00:00.000Z",
    type: "response_item",
    payload,
  })
}

function syntheticScenarios(): SyntheticScenario[] {
  const plan = [
    { step: "Inspect plan recognition", status: "completed" },
    { step: "Probe task sync", status: "in_progress" },
    { step: "Verify results", status: "pending" },
  ]
  return [
    {
      name: "direct function_call control",
      intendedPlanCall: true,
      line: codexResponseItem({
        type: "function_call",
        name: "update_plan",
        arguments: JSON.stringify({ explanation: "Direct control", plan }),
      }),
    },
    {
      name: "wrapped Codex exec call",
      intendedPlanCall: true,
      line: codexResponseItem({
        type: "custom_tool_call",
        name: "exec",
        input: `const r = await tools.update_plan(${JSON.stringify({ explanation: "Wrapped control", plan })}); text(r);`,
      }),
    },
    {
      name: "wrapped functions.exec call",
      intendedPlanCall: true,
      line: codexResponseItem({
        type: "custom_tool_call",
        name: "functions.exec",
        input: `await tools.update_plan(${JSON.stringify({ plan })});`,
      }),
    },
    {
      name: "non-executed plan text control",
      intendedPlanCall: false,
      line: codexResponseItem({
        type: "custom_tool_call",
        name: "exec",
        input: 'const note = "await tools.update_plan({plan:[]})"; text(note);',
      }),
    },
  ]
}

function previewInput(input: unknown): string | null {
  if (typeof input !== "string") return input == null ? null : JSON.stringify(input)
  return input.length <= 320 ? input : `${input.slice(0, 317)}...`
}

function isPlanRelatedPayload(payload: CodexToolPayload): boolean {
  if (isDirectUpdatePlanPayload(payload)) return true
  const input = payload.type === "custom_tool_call" ? payload.input : payload.arguments
  return typeof input === "string" && /\btools\.update_plan\s*\(/.test(input)
}

function isDirectUpdatePlanPayload(payload: CodexToolPayload): boolean {
  return payload.name === "update_plan" || payload.name === "functions.update_plan"
}

function containsExecutableNestedUpdatePlan(input: string): boolean {
  return /(?:^|[;}\n])\s*(?:const\s+[a-zA-Z_$][\w$]*\s*=\s*)?await\s+tools\.update_plan\s*\(/.test(
    input
  )
}

function parsePlanTranscriptEntry(line: string): PlanTranscriptEntry | null {
  const entry = tryParseJsonLine(line) as CodexTranscriptEntry | undefined
  const payload = entry?.payload
  if (entry?.type !== "response_item" || !payload?.name || !isPlanRelatedPayload(payload))
    return null
  return entry as PlanTranscriptEntry
}

function toolInput(payload: CodexToolPayload): unknown {
  return payload.type === "custom_tool_call" ? payload.input : payload.arguments
}

function stringInput(input: unknown): string {
  return typeof input === "string" ? input : ""
}

function inputLength(input: unknown): number | null {
  return typeof input === "string" ? input.length : null
}

function planObservationFromLine(line: string, lineIndex: number): PlanCallObservation | null {
  const entry = parsePlanTranscriptEntry(line)
  if (!entry) return null

  const payload = entry.payload
  const input = toolInput(payload)
  const code = stringInput(input)
  return {
    directUpdatePlan: isDirectUpdatePlanPayload(payload),
    executableNestedUpdatePlan: containsExecutableNestedUpdatePlan(code),
    inputLength: inputLength(input),
    inputPreview: previewInput(input),
    lineIndex,
    nestedUpdatePlan: /\btools\.update_plan\s*\(/.test(code),
    outerName: payload.name,
    parserSnapshotCount: extractCodexUpdatePlanSnapshotsFromRawJsonl(line).length,
    payloadType: payload.type ?? "unknown",
    timestamp: entry.timestamp ?? null,
  }
}

function observePlanCalls(lines: string[]): PlanCallObservation[] {
  return lines
    .map(planObservationFromLine)
    .filter((observation): observation is PlanCallObservation => observation !== null)
}

async function syncFirstSnapshot(lines: string[]): Promise<{
  result: Awaited<ReturnType<typeof syncCodexUpdatePlanSnapshot>> | null
  tasks: Array<Pick<Task, "id" | "status" | "subject">>
}> {
  const snapshots = extractCodexUpdatePlanSnapshotsFromRawJsonl(lines.join("\n"))
  const snapshot = snapshots[0]
  if (!snapshot) return { result: null, tasks: [] }

  const tempRoot = await mkdtemp(join(tmpdir(), "swiz-debug-codex-plan-"))
  const tasksDir = join(tempRoot, "tasks")
  const sessionId = `debug-${crypto.randomUUID()}`
  try {
    const result = await syncCodexUpdatePlanSnapshot(sessionId, snapshot, {
      cwd: process.cwd(),
      tasksDir,
    })
    const tasks = await readTasks(sessionId, tasksDir)
    return {
      result,
      tasks: tasks.map(({ id, status, subject }) => ({ id, status, subject })),
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function runSelfTest(): Promise<void> {
  const results = []
  for (const scenario of syntheticScenarios()) {
    const lines = [scenario.line]
    const summary = computeSummaryFromSessionLines(lines)
    const observations = observePlanCalls(lines)
    const synced = await syncFirstSnapshot(lines)
    results.push({
      name: scenario.name,
      intendedPlanCall: scenario.intendedPlanCall,
      rawObservations: observations,
      summaryToolNames: summary.toolNames,
      parserSnapshotCount: extractCodexUpdatePlanSnapshotsFromRawJsonl(scenario.line).length,
      syncResult: synced.result,
      syncedTasks: synced.tasks,
    })
  }

  console.log("--- hypothesis ---")
  console.log(
    "Swiz should recognize direct update_plan calls; if wrapped calls produce zero snapshots and no tasks, the live Codex exec shape is the missing normalization boundary."
  )
  console.log("--- synthetic controls ---")
  console.dir(results, { depth: null })
  console.log("--- conclusion ---")
  console.dir(
    {
      directPlanRecognized: results[0]?.parserSnapshotCount === 1,
      directPlanTasksSynced: results[0]?.syncedTasks.length === 3,
      wrappedExecRecognized: results[1]?.parserSnapshotCount === 1,
      wrappedFunctionsExecRecognized: results[2]?.parserSnapshotCount === 1,
      nonExecutedTextRecognized: results[3]?.parserSnapshotCount !== 0,
      nonExecutedTextClassifiedAsExecutable:
        results[3]?.rawObservations[0]?.executableNestedUpdatePlan ?? false,
    },
    { depth: null }
  )
}

function sessionIdFromPath(transcriptPath: string): string | null {
  return (
    basename(transcriptPath, ".jsonl").match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    )?.[1] ?? null
  )
}

async function readLiveCodexTasks(sessionId: string): Promise<Task[]> {
  const tasksDir = getProviderTaskRoots("codex")?.tasksDir
  return tasksDir ? readTasks(sessionId, tasksDir) : []
}

async function runLiveTranscript(
  transcriptPath: string,
  explicitSessionId?: string
): Promise<void> {
  const sessionLines = await readCurrentSessionLines(transcriptPath)
  if (!sessionLines) throw new Error(`Could not read current session: ${transcriptPath}`)

  const sessionId = explicitSessionId ?? sessionIdFromPath(transcriptPath)
  const summary = computeSummaryFromSessionLines(sessionLines)
  const observations = observePlanCalls(sessionLines)
  const snapshots = extractCodexUpdatePlanSnapshotsFromRawJsonl(sessionLines.join("\n"))
  const tasks = sessionId ? await readLiveCodexTasks(sessionId) : []

  console.log("--- hypothesis ---")
  console.log(
    "The live Codex plan is present inside exec input; Swiz recognition requires either a parsed update_plan snapshot or mirrored codex-* task files."
  )
  console.log("--- live input ---")
  console.dir(
    {
      transcriptPath,
      sessionId,
      sessionLineCount: sessionLines.length,
      summaryToolNames: summary.toolNames,
      rawMentionCount: observations.length,
      executableCallCount: observations.filter(
        (item) => item.directUpdatePlan || item.executableNestedUpdatePlan
      ).length,
      snapshotCount: snapshots.length,
    },
    { depth: null }
  )
  console.log("--- live plan calls ---")
  console.dir(observations, { depth: null })
  console.log("--- mirrored Codex plan tasks ---")
  console.dir(
    tasks
      .filter((task) => isCodexPlanTaskId(task.id))
      .map(({ id, status, subject }) => ({ id, status, subject })),
    { depth: null }
  )
  console.log("--- conclusion ---")
  console.dir(
    {
      livePlanStructurallyPresent: observations.some(
        (item) => item.directUpdatePlan || item.executableNestedUpdatePlan
      ),
      livePlanParsed: snapshots.length > 0,
      livePlanMirroredToTasks: tasks.some((task) => isCodexPlanTaskId(task.id)),
    },
    { depth: null }
  )
}

if (process.argv[2] === "--self-test") {
  await runSelfTest()
} else {
  const transcriptPath = process.argv[2] ?? usage()
  if (!(await Bun.file(transcriptPath).exists())) {
    throw new Error(`Transcript does not exist: ${transcriptPath}`)
  }
  await runLiveTranscript(transcriptPath, process.argv[3])
}
