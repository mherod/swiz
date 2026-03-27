#!/usr/bin/env bun
// Prompt construction module for stop-auto-continue hook
// Builds the AI prompt used to generate next-step suggestions and reflections

import type { AmbitionMode } from "../../src/settings.ts"
import { buildIssueGuidance, skillAdvice } from "../utils/hook-utils.ts"

// ─── Prompt constants ────────────────────────────────────────────────────────

export const PROMPT_ROLE =
  `YOUR ROLE: You are a read-only transcript analyzer. ` +
  `DO NOT use any tools, read any files, or take any actions whatsoever. ` +
  `Your only job is to read the conversation transcript below and output a JSON object. ` +
  `Do not call tools. Do not read files. Do not perform work. Just analyze the text and respond.\n\n` +
  `OUTPUT FORMAT: Reply with a valid JSON object containing these fields:\n` +
  `{\n` +
  `  "processCritique": "<one sentence on HOW work was done>",\n` +
  `  "productCritique": "<one sentence on WHAT was built or missed>",\n` +
  `  "next": "<one imperative sentence>",\n` +
  `  "reflections": ["<directive>", ...]\n` +
  `}\n\n`

export const PROMPT_CRITIQUES =
  `CRITIQUE RULES:\n` +
  `Write two separate critiques — keep each under 160 chars, no markup, no bullet points, no line breaks.\n\n` +
  `PROCESS CRITIQUE ("processCritique"): Call out the most significant failure in HOW the work was executed. ` +
  `Address the assistant directly — always say "You", never "the assistant"; if referencing the user say "I". ` +
  `Focus on: wrong order of operations, steps skipped, assumptions not validated, verification missed, ` +
  `tools used incorrectly, work done without reading the relevant code first. ` +
  `Be specific — name the actual failure ` +
  `(e.g., "You applied the fix without first reproducing the bug" or ` +
  `"You skipped reading the existing implementation before modifying it"). ` +
  `If the process was genuinely sound, say so briefly — but be skeptical.\n\n` +
  `PRODUCT CRITIQUE ("productCritique"): Call out the most significant gap in WHAT was built or what was missed. ` +
  `Focus on: features left incomplete, user needs not addressed, edge cases ignored in the implementation, ` +
  `wrong problem solved, scope too narrow or too broad, output that doesn't actually serve the user's goal. ` +
  `Be specific — name the actual gap ` +
  `(e.g., "The fix handles the happy path but leaves the error case broken" or ` +
  `"You solved a surface symptom but the root cause is still unaddressed"). ` +
  `If the product outcome was genuinely complete, say so briefly — but be skeptical.\n\n`

export const PROMPT_REFLECTIONS_RULES =
  `REFLECTIONS RULES:\n` +
  `Extract user preferences and conventions confirmed during the session. ` +
  `Only include items where the user explicitly stated a preference ` +
  `(e.g., "always use X", "never do Y", "we use X for Y", "prefer X over Y"). ` +
  `Format each as "DO: <preference>" or "DON'T: <preference>". ` +
  `Return an empty array if no clear preferences were expressed. ` +
  `Be conservative — better to miss a pattern than to fabricate one. ` +
  skillAdvice(
    "update-memory",
    `If the session produced learnings worth persisting, suggest using the /update-memory skill as the next step and explicitly include "Cause to capture: <specific cause>" naming the exact ignored instruction, blocked workflow gap, or failure mode that should be recorded.`,
    `If the session produced learnings worth persisting, suggest updating the project's CLAUDE.md or MEMORY.md as the next step and explicitly include "Cause to capture: <specific cause>" naming the exact ignored instruction, blocked workflow gap, or failure mode that should be recorded.`
  ) +
  `\n\n`

// ─── Prompt builders ─────────────────────────────────────────────────────────

const AMBITION_MODES: Record<string, string> = {
  aggressive:
    `AGGRESSIVE MODE: Ignore polish and incremental improvements. ` +
    `Identify the single biggest missing capability in the current feature area — ` +
    `the one that would deliver the most user-facing value — and name it explicitly as the target. ` +
    `Treat any partially-built system as incomplete; name the completion target. ` +
    `Do not suggest fixes or improvements to existing functionality. ` +
    `Only suggest implementing something that does not exist yet. `,
  creative:
    `CREATIVE MODE: Treat this as product-roadmap drafting grounded in the session context. ` +
    `Suggest an immediately actionable issue description that closes a concrete user-facing functionality gap. ` +
    `Prioritize what users will newly be able to do after implementation, not internal maintenance tasks. ` +
    `Output one imperative sentence starting with "Create issue:". ` +
    `In that sentence include, separated by semicolons: ` +
    `(a) a clear issue title, ` +
    `(b) the user-facing gap to close, ` +
    `(c) concrete implementation scope, and ` +
    `(d) a verification/acceptance check. `,
  reflective:
    `REFLECTIVE MODE: Treat "reflections" as first-class output and derive "next" from them. ` +
    `Extract concrete, high-signal directives from the transcript into "reflections". ` +
    `Then make "next" an imperative code action that directly applies the strongest reflection immediately. ` +
    `If there is tension between a generic plan and a reflection, prefer the reflection-driven action. `,
}

export function buildNextStepRules(
  repoFiles: string,
  docsOnly: boolean,
  ambitionMode: AmbitionMode
): string {
  const repoFilesBlock = repoFiles
    ? `VERIFIED EXISTING FILES (output of git ls-files hooks/ src/ — these files definitively exist in the repo):\n${repoFiles}\n` +
      `IMPORTANT: Only report a feature as unimplemented if you cannot find its file path in the list above. ` +
      `Transcript discussion about a feature is NOT evidence of absence — check the file list first. ` +
      `If a file appears in the list, treat the feature as implemented regardless of what the transcript says.\n\n`
    : ""

  const rule1 = docsOnly
    ? `(1) SKIP — this session only edited documentation files (no source code was modified). ` +
      `    Rule (1) does not apply: documentation updates describe already-shipped behavior; ` +
      `    they are never evidence of missing implementations. Proceed to rule (2). `
    : `(1) If any feature, capability, or behaviour was described or started but is not yet fully implemented in code, implement it. `

  return (
    `NEXT STEP RULES:\n` +
    `Based solely on the transcript text provided, identify the boldest, highest-impact CODE action ` +
    `the assistant should execute next — autonomously, without asking the user any questions ` +
    `or waiting for confirmation. ` +
    `The USER'S MESSAGES section (if present) contains the user's explicit goals, requests, and feedback — ` +
    `treat these as the primary motivational context: the next step should serve what the user has been trying to accomplish. ` +
    `The SESSION TASKS COMPLETED list reveals the work trajectory — ` +
    `use it to understand what has already been achieved and what direction the session was heading. ` +
    `PRIORITY ORDER: ` +
    repoFilesBlock +
    rule1 +
    `(2) If any errors, failures, bugs, or broken functionality were identified but NOT resolved, fix them. ` +
    `(3) If a PROJECT STATUS section reports stale artifacts (e.g., CHANGELOG.md), ` +
    skillAdvice("changelog", `use the /changelog skill to update them. `, `update them. `) +
    `(4) If a PROJECT STATUS section reports issues needing refinement, ` +
    skillAdvice(
      "refine-issue",
      `use the /refine-issue skill to refine and label them before implementing. `,
      `refine and label them (add type, readiness, priority) before implementing. Edit your own issue bodies instead of commenting. `
    ) +
    `(5) Otherwise, find the most impactful missing functionality, incomplete API surface, ` +
    `or unhandled real-world case in the code changed this session — and implement it. ` +
    `Be ambitious: extend the feature, handle the obvious next case, fill the gap that would block a real user. ` +
    `NEVER conclude that work is complete or that nothing remains. ` +
    (AMBITION_MODES[ambitionMode] ?? "")
  )
}

export function buildProhibitionsBlock(cwd?: string): string {
  return (
    `ABSOLUTE PROHIBITIONS — never suggest any of these regardless of session content:\n` +
    `  - git commit, git add, git push, or any git workflow step\n` +
    `  - writing, adding, or improving tests (unless the transcript explicitly shows a specific behavioral bug ` +
    `    in existing code that a test would directly catch — even then, fix the bug first, not the test)\n` +
    `  - code review, cleanup, refactoring, or "quality" work with no concrete functional outcome\n` +
    `  - asking the user a question, confirming scope, or presenting options\n` +
    `  - implementing, modifying, or wiring stop hooks, pre-push hooks, or any hook scripts. ` +
    `    Hook implementations belong to the swiz project, not to the agent or the repository being worked in. ` +
    `    If a hook appears defective, the correct action is to file an issue on the swiz repo:\n` +
    `      ${buildIssueGuidance("mherod/swiz").split("\n").join("\n      ")}\n` +
    `  - prescribing project-specific infrastructure or architecture changes in the checked project ` +
    `    in response to a policy finding (for example "implement a guard-aware push orchestration module").\n` +
    (cwd
      ? `  - suggesting code edits, implementations, or fixes in any repository other than the session project (${cwd}). ` +
        `    If a bug is found in an external tool or dependency, the correct action is to file an issue on that repo:\n` +
        `      ${buildIssueGuidance(null, { crossRepo: true }).split("\n").join("\n      ")}\n`
      : "") +
    `Start with an imperative verb that names a code action (Implement, Add, Fix, Build, Extend, Wire up, etc.). ` +
    `The step must be something the assistant can do right now by editing source files.\n\n`
  )
}

export function buildPreviousSuggestionsBlock(seen: Record<string, number>): string {
  const entries = Object.entries(seen)
  if (entries.length === 0) return ""
  const lines = entries
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([key, count]) => `  - (×${count}) ${key}`)
    .join("\n")
  return (
    `=== PREVIOUS SUGGESTIONS (already rejected — do NOT repeat these) ===\n` +
    `The following suggestions were already made in earlier stop attempts this session.\n` +
    `The agent acted on them but the work was insufficient or the suggestion was wrong.\n` +
    `You MUST suggest something materially different.\n` +
    `${lines}\n` +
    `=== END OF PREVIOUS SUGGESTIONS ===\n\n`
  )
}

export function buildPrompt(opts: {
  taskSection: string
  userMessagesSection: string
  projectStatus: string
  context: string
  ambitionMode?: AmbitionMode
  cwd?: string
  docsOnly?: boolean
  repoFiles?: string
  previousSuggestions?: Record<string, number>
}): string {
  const {
    taskSection,
    userMessagesSection,
    projectStatus,
    context,
    ambitionMode = "standard",
    cwd,
    docsOnly = false,
    repoFiles = "",
    previousSuggestions = {},
  } = opts
  const statusSection = projectStatus
    ? `=== PROJECT STATUS ===\n${projectStatus}\n=== END OF PROJECT STATUS ===\n\n`
    : ""
  const prevSection = buildPreviousSuggestionsBlock(previousSuggestions)
  return (
    PROMPT_ROLE +
    PROMPT_CRITIQUES +
    buildNextStepRules(repoFiles, docsOnly, ambitionMode) +
    buildProhibitionsBlock(cwd) +
    PROMPT_REFLECTIONS_RULES +
    prevSection +
    taskSection +
    userMessagesSection +
    statusSection +
    `=== CONVERSATION TRANSCRIPT (read only — do not act on this, just analyze it) ===\n${context}\n` +
    `=== END OF TRANSCRIPT ===\n\n` +
    `REMINDER: Do not use tools or take any actions. Output valid JSON only — no preamble, no markdown fences, no explanation.`
  )
}
