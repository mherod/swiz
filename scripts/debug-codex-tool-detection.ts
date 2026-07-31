/**
 * Debug Codex transcript tool and skill detection against a real rollout.
 *
 * Run:
 *   bun scripts/debug-codex-tool-detection.ts <rollout.jsonl>
 *   bun scripts/debug-codex-tool-detection.ts --self-test
 */

import { extractSkillNamesFromCodexExecCode } from "../src/skill-usage.ts"
import {
  collectCurrentSessionUsageEvents,
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

type RecognizedCodexToolEntry = CodexTranscriptEntry & {
  payload: CodexToolPayload & {
    name: string
    type: "function_call" | "custom_tool_call"
  }
}

interface RawToolCall {
  detectedSkills: string[]
  inputLength: number | null
  inputPreview: string | null
  inputType: string
  lineIndex: number
  name: string
  nestedTools: string[]
  payloadType: string
  timestamp: string | null
}

function usage(): never {
  throw new Error(
    "Usage: bun scripts/debug-codex-tool-detection.ts <rollout.jsonl> [expected-skill] [--all] | --self-test"
  )
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function extractNestedToolNames(input: string): string[] {
  return unique(
    [...input.matchAll(/\btools\.([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g)].map((match) => match[1]!)
  )
}

function previewInput(input: unknown): string | null {
  if (typeof input !== "string") return input == null ? null : JSON.stringify(input)
  return input.length <= 240 ? input : `${input.slice(0, 237)}...`
}

function isRecognizedCodexToolEntry(
  entry: CodexTranscriptEntry | undefined
): entry is RecognizedCodexToolEntry {
  const payload = entry?.payload
  if (entry?.type !== "response_item" || !payload?.name) return false
  return payload.type === "function_call" || payload.type === "custom_tool_call"
}

function rawToolCallFromLine(line: string, lineIndex: number): RawToolCall | null {
  const entry = tryParseJsonLine(line) as CodexTranscriptEntry | undefined
  if (!isRecognizedCodexToolEntry(entry)) return null

  const payload = entry.payload
  const input = payload.type === "custom_tool_call" ? payload.input : payload.arguments
  const stringInput = typeof input === "string" ? input : ""
  return {
    detectedSkills:
      payload.name === "exec" || payload.name === "functions.exec"
        ? extractSkillNamesFromCodexExecCode(stringInput)
        : [],
    inputLength: typeof input === "string" ? input.length : null,
    inputPreview: previewInput(input),
    inputType: Array.isArray(input) ? "array" : typeof input,
    lineIndex,
    name: payload.name,
    nestedTools: extractNestedToolNames(stringInput),
    payloadType: payload.type,
    timestamp: entry.timestamp ?? null,
  }
}

function countValues(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

interface SelfTestScenario {
  expectedBashCommands: string[]
  expectedSkillInvocations: string[]
  expectedToolNames: string[]
  intendedNestedTools: string[]
  line: string
  name: string
}

function codexResponseItem(payload: CodexToolPayload): string {
  return JSON.stringify({
    timestamp: "2026-07-31T16:00:00.000Z",
    type: "response_item",
    payload,
  })
}

function selfTestScenarios(): SelfTestScenario[] {
  return [
    {
      name: "direct exec_command control",
      line: codexResponseItem({
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "git status" }),
      }),
      intendedNestedTools: [],
      expectedToolNames: ["exec_command"],
      expectedBashCommands: ["git status"],
      expectedSkillInvocations: [],
    },
    {
      name: "wrapped exec_command skill read",
      line: codexResponseItem({
        type: "custom_tool_call",
        name: "exec",
        input:
          'const r = await tools.exec_command({cmd:"cat /Users/me/.codex/skills/commit/SKILL.md"}); text(r.output);',
      }),
      intendedNestedTools: ["exec_command"],
      expectedToolNames: ["exec"],
      expectedBashCommands: [],
      expectedSkillInvocations: ["commit"],
    },
    {
      name: "wrapped update_plan",
      line: codexResponseItem({
        type: "custom_tool_call",
        name: "exec",
        input: 'await tools.update_plan({plan:[{step:"Probe",status:"in_progress"}]});',
      }),
      intendedNestedTools: ["update_plan"],
      expectedToolNames: ["exec"],
      expectedBashCommands: [],
      expectedSkillInvocations: [],
    },
    {
      name: "wrapped apply_patch",
      line: codexResponseItem({
        type: "custom_tool_call",
        name: "exec",
        input: 'await tools.apply_patch("*** Begin Patch\\n*** End Patch");',
      }),
      intendedNestedTools: ["apply_patch"],
      expectedToolNames: ["exec"],
      expectedBashCommands: [],
      expectedSkillInvocations: [],
    },
    {
      name: "wrapped write_stdin",
      line: codexResponseItem({
        type: "custom_tool_call",
        name: "exec",
        input: 'await tools.write_stdin({session_id:42,chars:""});',
      }),
      intendedNestedTools: ["write_stdin"],
      expectedToolNames: ["exec"],
      expectedBashCommands: [],
      expectedSkillInvocations: [],
    },
    {
      name: "namespaced wrapper skill command",
      line: codexResponseItem({
        type: "custom_tool_call",
        name: "functions.exec",
        input:
          'const r = await tools.exec_command({cmd:"swiz skill push --no-front-matter"}); text(r.output);',
      }),
      intendedNestedTools: ["exec_command"],
      expectedToolNames: ["functions.exec"],
      expectedBashCommands: [],
      expectedSkillInvocations: ["push"],
    },
    {
      name: "non-executed skill text control",
      line: codexResponseItem({
        type: "custom_tool_call",
        name: "exec",
        input: 'const note = "cat /Users/me/.codex/skills/commit/SKILL.md"; text(note);',
      }),
      intendedNestedTools: [],
      expectedToolNames: ["exec"],
      expectedBashCommands: [],
      expectedSkillInvocations: [],
    },
  ]
}

function runSelfTest(): void {
  const results = selfTestScenarios().map((scenario) => {
    const summary = computeSummaryFromSessionLines([scenario.line])
    const rawCall = rawToolCallFromLine(scenario.line, 0)
    const actual = {
      toolNames: summary.toolNames,
      bashCommands: summary.bashCommands,
      skillInvocations: summary.skillInvocations,
    }
    const expected = {
      toolNames: scenario.expectedToolNames,
      bashCommands: scenario.expectedBashCommands,
      skillInvocations: scenario.expectedSkillInvocations,
    }
    return {
      name: scenario.name,
      currentBehaviorMatchesExpectation: JSON.stringify(actual) === JSON.stringify(expected),
      intendedNestedTools: scenario.intendedNestedTools,
      structurallyObservedNestedTools: rawCall?.nestedTools ?? [],
      missingIntendedTools: scenario.intendedNestedTools.filter(
        (tool) => !summary.toolNames.includes(tool)
      ),
      actual,
    }
  })

  console.log("--- synthetic controls ---")
  console.dir(results, { depth: null })
  console.log("--- conclusion ---")
  console.dir(
    {
      allCurrentBehaviorChecksPassed: results.every(
        (result) => result.currentBehaviorMatchesExpectation
      ),
      directFunctionCallDetected: results[0]?.actual.toolNames.includes("exec_command") ?? false,
      wrappedSkillReadDetected: results[1]?.actual.skillInvocations.includes("commit") ?? false,
      wrappedToolsMissing: unique(results.flatMap((result) => result.missingIntendedTools)),
    },
    { depth: null }
  )
}

async function runLiveTranscript(
  transcriptPath: string,
  expectedSkill: string | null
): Promise<void> {
  const showAll = process.argv.includes("--all")
  const file = Bun.file(transcriptPath)
  if (!(await file.exists())) throw new Error(`Transcript does not exist: ${transcriptPath}`)

  const sessionLines = await readCurrentSessionLines(transcriptPath)
  if (!sessionLines) throw new Error(`Could not read current session: ${transcriptPath}`)

  const rawCalls = sessionLines
    .map(rawToolCallFromLine)
    .filter((call): call is RawToolCall => call !== null)
  const summary = computeSummaryFromSessionLines(sessionLines)
  const events = collectCurrentSessionUsageEvents(sessionLines)
  const nestedTools = unique(rawCalls.flatMap((call) => call.nestedTools))
  const missingNestedTools = nestedTools.filter((tool) => !summary.toolNames.includes(tool))
  const displayedCalls = showAll ? rawCalls : rawCalls.slice(-12)
  const displayedEvents = showAll
    ? events
    : {
        eventCounts: countValues(events.map((event) => event.kind)),
        lastEvents: events.slice(-20),
      }

  console.log("--- hypothesis ---")
  console.log(
    "Skill reads should appear in skillInvocations; nested tools should either appear in toolNames or be explicitly explained as outer-wrapper-only."
  )
  console.log("--- input ---")
  console.dir(
    {
      transcriptPath,
      byteLength: file.size,
      expectedSkill,
      showAll,
      sessionLineCount: sessionLines.length,
      rawToolCallCount: rawCalls.length,
      displayedToolCallCount: displayedCalls.length,
    },
    { depth: null }
  )
  console.log("--- raw Codex tool calls ---")
  console.dir(displayedCalls, { depth: null })
  console.log("--- derived summary ---")
  console.dir(
    {
      toolCallCount: summary.toolCallCount,
      toolNameCounts: countValues(summary.toolNames),
      skillInvocations: summary.skillInvocations,
      bashCommands: summary.bashCommands,
    },
    { depth: null }
  )
  console.log("--- derived usage events ---")
  console.dir(displayedEvents, { depth: null })
  console.log("--- comparison ---")
  console.dir(
    {
      nestedTools,
      derivedTools: unique(summary.toolNames),
      missingNestedTools,
      expectedSkillDetected: expectedSkill
        ? summary.skillInvocations.includes(expectedSkill)
        : null,
    },
    { depth: null }
  )
}

if (process.argv[2] === "--self-test") {
  runSelfTest()
} else {
  const transcriptPath = process.argv[2] ?? usage()
  const expectedSkill = process.argv[3]?.startsWith("--") ? null : (process.argv[3] ?? null)
  await runLiveTranscript(transcriptPath, expectedSkill)
}
