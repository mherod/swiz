import {
  PROJECT_STATES,
  type ProjectState,
  readProjectState,
  STATE_TRANSITIONS,
  TERMINAL_STATES,
  writeProjectState,
} from "../settings.ts"
import type { Command } from "../types.ts"

function printStateList(): void {
  console.log("\n  swiz state — project state machine\n")
  for (const state of PROJECT_STATES) {
    const transitions = STATE_TRANSITIONS[state]
    const isTerminal = TERMINAL_STATES.includes(state)
    const arrow = transitions.length > 0 ? `→ ${transitions.join(", ")}` : "(terminal)"
    const marker = isTerminal ? " [terminal]" : ""
    console.log(`  ${state}${marker}  ${arrow}`)
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
        console.log("\n  project state: not set (default: in-development)\n")
      } else {
        const transitions = STATE_TRANSITIONS[current]
        const isTerminal = TERMINAL_STATES.includes(current)
        console.log(`\n  project state: ${current}${isTerminal ? " [terminal]" : ""}`)
        if (transitions.length > 0) {
          console.log(`  allowed transitions: ${transitions.join(", ")}`)
        } else {
          console.log("  allowed transitions: none (terminal state)")
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
        const allowed = STATE_TRANSITIONS[current]
        if (!allowed.includes(targetState)) {
          throw new Error(
            `Invalid transition: ${current} → ${targetState}\nAllowed from ${current}: ${allowed.length > 0 ? allowed.join(", ") : "none (terminal state)"}`
          )
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
