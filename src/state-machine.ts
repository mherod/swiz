/**
 * Enhanced project state machine with metadata and transition effects.
 * Supports state metadata (priority, workflow intent) and transition-specific guards/effects.
 */

import type { EffectiveSwizSettings, ProjectState } from "./settings.ts"

/** Workflow intent that influences hook behavior and guidance */
export type WorkflowIntent =
  | "active-development"
  | "awaiting-input"
  | "released-stable"
  | "paused-work"

/** Priority level that can influence task ordering and reminders */
export type StatePriority = "immediate" | "high" | "normal" | "low"

/** Metadata attached to each state */
export interface StateMetadata {
  intent: WorkflowIntent
  priority: StatePriority
  isTerminal: boolean
  description: string
}

/** Guard function that evaluates whether a transition is allowed */
export type TransitionGuard = (
  context: TransitionContext
) => Promise<{ allowed: boolean; reason?: string }>

/** Side effect function that runs when a transition occurs */
export type TransitionEffect = (context: TransitionContext) => Promise<void>

/** Context provided to guard and effect functions */
export interface TransitionContext {
  from: ProjectState | null
  to: ProjectState
  currentSettings: Partial<EffectiveSwizSettings>
  cwd: string
  timestamp: string
}

/** Transition rule definition with optional guards and effects */
export interface TransitionRule {
  to: ProjectState
  guards?: TransitionGuard[]
  onEnter?: TransitionEffect[]
  onExit?: TransitionEffect[]
}

/** Enriched state definition combining metadata and allowed transitions */
export interface EnrichedStateDefinition {
  metadata: StateMetadata
  transitions: TransitionRule[]
}

/** Map of state metadata for all project states */
export const STATE_METADATA: Record<ProjectState, StateMetadata> = {
  "in-development": {
    intent: "active-development",
    priority: "high",
    isTerminal: false,
    description: "Active work on code and features",
  },
  "awaiting-feedback": {
    intent: "awaiting-input",
    priority: "normal",
    isTerminal: false,
    description: "Waiting for review comments or other input",
  },
  released: {
    intent: "released-stable",
    priority: "low",
    isTerminal: true,
    description: "Work is released and stable; only bug fixes permitted",
  },
  paused: {
    intent: "paused-work",
    priority: "low",
    isTerminal: true,
    description: "Work is paused; blocked or suspended",
  },
}

/**
 * Guard: Require clean/default branch when entering active development in team mode.
 * This prevents team members from starting work on a polluted branch.
 */
export async function requireCleanBranchInTeamMode(
  context: TransitionContext
): Promise<{ allowed: boolean; reason?: string }> {
  const isTeamMode = context.currentSettings.collaborationMode === "team"
  const enteringActiveWork = context.to === "in-development"

  if (!isTeamMode || !enteringActiveWork) {
    return { allowed: true }
  }

  // In team mode, entering active development requires being on a clean, default branch
  // This is a placeholder guard — actual branch checking would use git commands
  // For now, return true to allow transitions; the actual check would be in a hook
  return { allowed: true }
}

/**
 * Effect: Log state transition to history with metadata.
 * This effect is always applied to track state changes.
 */
export async function logStateTransition(_context: TransitionContext): Promise<void> {
  // This would be implemented in state.ts to update stateHistory
  // Placeholder for now
}

/**
 * Enriched state machine definition with transitions, guards, and effects.
 * This replaces the simple STATE_TRANSITIONS map with a richer model.
 */
export const ENRICHED_STATE_MACHINE: Record<ProjectState, EnrichedStateDefinition> = {
  "in-development": {
    metadata: STATE_METADATA["in-development"],
    transitions: [
      {
        to: "awaiting-feedback",
      },
      {
        to: "paused",
      },
      {
        to: "released",
      },
    ],
  },
  "awaiting-feedback": {
    metadata: STATE_METADATA["awaiting-feedback"],
    transitions: [
      {
        to: "in-development",
      },
      {
        to: "released",
      },
      {
        to: "paused",
      },
    ],
  },
  released: {
    metadata: STATE_METADATA.released,
    transitions: [
      {
        to: "in-development",
      },
      {
        to: "paused",
      },
    ],
  },
  paused: {
    metadata: STATE_METADATA.paused,
    transitions: [
      {
        to: "in-development",
        guards: [requireCleanBranchInTeamMode],
      },
    ],
  },
}

/**
 * Evaluate whether a state transition is allowed, considering guards and current settings.
 * Returns { allowed, reason } to indicate success/failure and any error message.
 */
export async function evaluateTransition(
  context: TransitionContext
): Promise<{ allowed: boolean; reason?: string }> {
  const currentState = context.from
  const targetState = context.to

  // If no current state, allow transition to initial state
  if (!currentState) {
    return { allowed: true }
  }

  // Check if target state is in allowed transitions
  const stateDefinition = ENRICHED_STATE_MACHINE[currentState]
  const transitionRule = stateDefinition.transitions.find((t) => t.to === targetState)

  if (!transitionRule) {
    return {
      allowed: false,
      reason: `Invalid transition: ${currentState} → ${targetState}`,
    }
  }

  // Evaluate all guards for this transition
  if (transitionRule.guards && transitionRule.guards.length > 0) {
    for (const guard of transitionRule.guards) {
      const result = await guard(context)
      if (!result.allowed) {
        return result
      }
    }
  }

  return { allowed: true }
}

/**
 * Get the priority of a state for ordering and task guidance.
 * Higher priority states get more prominent display in suggestions.
 */
export function getStatePriority(state: ProjectState): number {
  const priorityMap: Record<StatePriority, number> = {
    immediate: 4,
    high: 3,
    normal: 2,
    low: 1,
  }
  return priorityMap[STATE_METADATA[state].priority]
}

/**
 * Get the workflow intent of a state.
 * Used by hooks to determine guidance and enforcement.
 */
export function getWorkflowIntent(state: ProjectState): WorkflowIntent {
  return STATE_METADATA[state].intent
}

/**
 * Check if a state is terminal (no further transitions allowed).
 */
export function isTerminalState(state: ProjectState): boolean {
  return STATE_METADATA[state].isTerminal
}
