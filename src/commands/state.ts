import { DIM, RESET } from "../ansi.ts"
import {
  CLAUDE_MODEL_FOR_PLANNING_AND_REVIEW,
  setClaudeSettingsModel,
} from "../claude-model-settings.ts"
import { stderrLog } from "../debug.ts"
import { formatDuration } from "../format-duration.ts"
import {
  PROJECT_STATES,
  type ProjectState,
  readProjectState,
  readStateData,
  STATE_TRANSITIONS,
  type StateHistoryEntry,
  writeProjectState,
} from "../settings.ts"
import { evaluateTransition, STATE_METADATA } from "../state-machine.ts"
import type { Command } from "../types.ts"
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"

function computeStateTotals(history: StateHistoryEntry[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (let i = 0; i < history.length; i++) {
    const entry = history[i]!
    const next = history[i + 1]
    const start = new Date(entry.timestamp).getTime()
    const end = next ? new Date(next.timestamp).getTime() : Date.now()
    const elapsed = Math.max(0, end - start)
    totals.set(entry.to, (totals.get(entry.to) ?? 0) + elapsed)
  }
  return totals
}

function printStateList(): void {
  console.log("\n  swiz state — project state machine\n")
  for (const state of PROJECT_STATES) {
    const transitions = STATE_TRANSITIONS[state]
    const metadata = STATE_METADATA[state]
    const arrow = `→ ${transitions.join(", ")}`
    const intentMarker = ` [${metadata.intent}]`
    console.log(`  ${state}${intentMarker}  ${arrow}`)
  }
  console.log()
}

async function handleShowState(cwd: string): Promise<void> {
  const current = await readProjectState(cwd)
  if (!current) {
    console.log("\n  project state: not set (use: swiz state set planning)\n")
    return
  }
  const transitions = STATE_TRANSITIONS[current]
  const metadata = STATE_METADATA[current]
  console.log(`\n  project state: ${current}`)
  console.log(`  workflow intent: ${metadata.intent}`)
  console.log(`  priority: ${metadata.priority}`)

  const stateData = await readStateData(cwd)
  const history = stateData?.stateHistory ?? []
  if (history.length > 0) {
    const lastEntry = history[history.length - 1]!
    const age = Date.now() - new Date(lastEntry.timestamp).getTime()
    console.log(`  current state age: ${formatDuration(age)}`)
  }
  console.log(`  allowed transitions: ${transitions.join(", ")}`)

  if (history.length > 1) {
    const totals = computeStateTotals(history)
    console.log(`\n  ${DIM}time per state:${RESET}`)
    for (const [state, ms] of totals) {
      const marker = state === current ? " ←" : ""
      console.log(`    ${DIM}${state}: ${formatDuration(ms)}${marker}${RESET}`)
    }
  }
  console.log()
}

async function handleSetState(cwd: string, target: string | undefined): Promise<void> {
  if (!target) {
    throw new Error(`Usage: swiz state set <state>\nValid states: ${PROJECT_STATES.join(", ")}`)
  }
  if (!(target in STATE_TRANSITIONS)) {
    throw new Error(`Unknown state: "${target}"\nValid states: ${PROJECT_STATES.join(", ")}`)
  }

  const targetState = target as ProjectState
  const current = await readProjectState(cwd)

  if (current && current !== targetState) {
    const result = await evaluateTransition({
      from: current,
      to: targetState,
      currentSettings: { collaborationMode: "solo" },
      cwd,
      timestamp: new Date().toISOString(),
    })
    if (!result.allowed) {
      throw new Error(result.reason || `Invalid transition: ${current} → ${targetState}`)
    }
  }

  await writeProjectState(cwd, targetState)
  const from = current ? `${current} → ` : ""
  console.log(`  project state: ${from}${targetState}`)

  await tryApplyStateModel(targetState, cwd)
}

async function tryApplyStateModel(state: ProjectState, cwd: string): Promise<void> {
  if (state !== "planning" && state !== "reviewing") return
  try {
    const { path } = await setClaudeSettingsModel({
      model: CLAUDE_MODEL_FOR_PLANNING_AND_REVIEW,
      scope: "local",
      cwd,
    })
    console.log(`  claude model: ${CLAUDE_MODEL_FOR_PLANNING_AND_REVIEW} (${path})`)
  } catch (err) {
    stderrLog("state set — claude model", messageFromUnknownError(err))
  }
}

export const stateCommand: Command = {
  name: "state",
  description:
    "Show or set the persistent project state (planning/reviewing → Claude model opus in .claude/settings.local.json)",
  usage: "swiz state [show|list|set <state>]",

  async run(args: string[]): Promise<void> {
    const cwd = process.cwd()
    const sub = args[0] ?? "show"

    if (sub === "list") {
      printStateList()
      return
    }
    if (sub === "show") {
      await handleShowState(cwd)
      return
    }
    if (sub === "set") {
      await handleSetState(cwd, args[1])
      return
    }

    throw new Error(`Unknown subcommand: "${sub}"\nUsage: swiz state [show|list|set <state>]`)
  },
}
