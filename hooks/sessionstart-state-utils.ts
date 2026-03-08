import { readProjectState, STATE_TRANSITIONS } from "../src/settings.ts"
import { getStatePriority, getWorkflowIntent, STATE_METADATA } from "../src/state-machine.ts"

export interface SessionStartStateInfo {
  state: string
  transitions: string[]
  intent: string
  priority: number
  description: string
}

/**
 * Resolve derived state-machine context for SessionStart hooks.
 * Returns null when no project state is currently set.
 */
export async function readSessionStartStateInfo(
  cwd: string
): Promise<SessionStartStateInfo | null> {
  const state = await readProjectState(cwd)
  if (!state) return null

  const transitions = STATE_TRANSITIONS[state]
  const metadata = STATE_METADATA[state]

  return {
    state,
    transitions,
    intent: getWorkflowIntent(state),
    priority: getStatePriority(state),
    description: metadata.description,
  }
}
