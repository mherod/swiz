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

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  if (hours < 24) return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainHours = hours % 24
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`
}

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

export const stateCommand: Command = {
  name: "state",
  description: "Show or set the persistent project state",
  usage: "swiz state [show|list|set <state>]",

  async run(args: string[]): Promise<void> {
    const cwd = process.cwd()
    const sub = args[0] ?? "show"

    if (sub === "list") {
      printStateList()
      return
    }

    if (sub === "show") {
      const current = await readProjectState(cwd)
      if (!current) {
        console.log("\n  project state: not set (use: swiz state set planning)\n")
      } else {
        const transitions = STATE_TRANSITIONS[current]
        const metadata = STATE_METADATA[current]
        console.log(`\n  project state: ${current}`)
        console.log(`  workflow intent: ${metadata.intent}`)
        console.log(`  priority: ${metadata.priority}`)

        // Show current state age from history
        const stateData = await readStateData(cwd)
        const history = stateData?.stateHistory ?? []
        if (history.length > 0) {
          const lastEntry = history[history.length - 1]!
          const age = Date.now() - new Date(lastEntry.timestamp).getTime()
          console.log(`  current state age: ${formatDuration(age)}`)
        }

        console.log(`  allowed transitions: ${transitions.join(", ")}`)

        // Show cumulative time per state
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
      return
    }

    if (sub === "set") {
      const target = args[1]
      if (!target) {
        throw new Error(`Usage: swiz state set <state>\nValid states: ${PROJECT_STATES.join(", ")}`)
      }
      if (!(target in STATE_TRANSITIONS)) {
        throw new Error(`Unknown state: "${target}"\nValid states: ${PROJECT_STATES.join(", ")}`)
      }

      const targetState = target as ProjectState
      const current = await readProjectState(cwd)

      if (current && current !== targetState) {
        const timestamp = new Date().toISOString()
        const result = await evaluateTransition({
          from: current,
          to: targetState,
          currentSettings: {
            collaborationMode: "solo",
          },
          cwd,
          timestamp,
        })
        if (!result.allowed) {
          throw new Error(result.reason || `Invalid transition: ${current} → ${targetState}`)
        }
      }

      await writeProjectState(cwd, targetState)
      const from = current ? `${current} → ` : ""
      console.log(`  project state: ${from}${targetState}`)
      return
    }

    throw new Error(`Unknown subcommand: "${sub}"\nUsage: swiz state [show|list|set <state>]`)
  },
}
