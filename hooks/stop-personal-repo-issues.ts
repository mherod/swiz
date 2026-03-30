#!/usr/bin/env bun

/**
 * Stop hook: Check for open issues and PRs needing attention
 * Blocks stop if a personal GitHub repo has open issues, or if
 * the current user has self-authored or self-assigned issues in an org repo.
 */

import { missingRefinementCategories, needsRefinement } from "../src/issue-refinement.ts"
import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import type { SwizStopHook } from "../src/SwizHook.ts"
import { evaluateStopPersonalRepoIssues } from "./stop-personal-repo-issues/evaluate.ts"
import { getActionableIssues } from "./stop-personal-repo-issues/issues.ts"
import {
  planSectionOrderForProjectState,
  sectionOrderForProjectState,
} from "./stop-personal-repo-issues/project-state.ts"
import {
  orderRebaseSuggestionPRs,
  selectRebaseSuggestionPRs,
} from "./stop-personal-repo-issues/pull-requests.ts"
import type { Issue, PR, StopSection } from "./stop-personal-repo-issues/types.ts"

export { missingRefinementCategories, needsRefinement }
export type { StopSection, Issue, PR }
export {
  sectionOrderForProjectState,
  planSectionOrderForProjectState,
  orderRebaseSuggestionPRs,
  selectRebaseSuggestionPRs,
  getActionableIssues,
}
export { evaluateStopPersonalRepoIssues }

const stopPersonalRepoIssues: SwizStopHook = {
  name: "stop-personal-repo-issues",
  event: "stop",
  timeout: 10,
  cooldownSeconds: 30,
  requiredSettings: ["personalRepoIssuesGate"],

  run(input) {
    return evaluateStopPersonalRepoIssues(input)
  },
}

export default stopPersonalRepoIssues

if (import.meta.main) {
  await runSwizHookAsMain(stopPersonalRepoIssues)
}
