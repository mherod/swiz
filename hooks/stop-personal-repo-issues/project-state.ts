import type { ProjectState } from "../../src/settings.ts"
import { DEFAULT_STOP_SECTION_ORDER } from "./constants.ts"
import type { StopSection } from "./types.ts"

/** One-line hint after the opening sentence when a project state is set. */
const STATE_PRIORITY_HINT: Record<ProjectState, string> = {
  planning:
    "Project state: planning — prioritise refining and triaging the backlog before picking up ready work.",
  developing:
    "Project state: developing — prioritise merge conflicts, PR feedback, and ready issues before grooming refinement backlog.",
  reviewing:
    "Project state: reviewing — prioritise open PRs, conflicts, and review feedback before new issue work.",
  "addressing-feedback":
    "Project state: addressing-feedback — prioritise PR feedback and conflicts before new issues or backlog refinement.",
}

export function statePriorityHint(state: ProjectState): string {
  return STATE_PRIORITY_HINT[state]
}

/**
 * Full section order for reason text (and conflict mini-plan position).
 * `null` preserves the legacy order used before state-aware ordering.
 */
export function sectionOrderForProjectState(state: ProjectState | null): StopSection[] {
  if (state === null) return [...DEFAULT_STOP_SECTION_ORDER]
  switch (state) {
    case "planning":
      // Refinement + triage (blocked) before suggesting new ready work; PR hygiene before pickup
      return ["refinement", "blocked", "conflict", "feedbackPr", "readyIssues"]
    case "reviewing":
      return ["feedbackPr", "conflict", "refinement", "readyIssues", "blocked"]
    case "developing":
      // Unblock and ship; defer refinement grooming until active work is moving
      return ["conflict", "feedbackPr", "readyIssues", "refinement", "blocked"]
    case "addressing-feedback":
      return ["feedbackPr", "conflict", "readyIssues", "refinement", "blocked"]
    default:
      return [...DEFAULT_STOP_SECTION_ORDER]
  }
}

/** Top-level action plan steps — all sections contribute to the plan. */
export function planSectionOrderForProjectState(state: ProjectState | null): StopSection[] {
  return sectionOrderForProjectState(state)
}
