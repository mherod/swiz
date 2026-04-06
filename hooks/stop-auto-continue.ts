#!/usr/bin/env bun
// Stop hook: Block stop with a deterministic next-step suggestion.
// Uses hardcoded filler suggestions, changelog staleness, and issue refinement
// checks to propose actionable next work. No external AI calls.

import { z } from "zod"
import { detectRepoOwnership } from "../src/collaboration-policy.ts"
import { resolveCwd } from "../src/cwd.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import { needsRefinement } from "../src/issue-refinement.ts"
import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { type StopHookInput, stopHookInputSchema } from "../src/schemas.ts"
import {
  type AmbitionMode,
  getEffectiveSwizSettings,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
} from "../src/settings.ts"
import {
  blockStopObj,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  skillAdvice,
} from "../src/utils/hook-utils.ts"
import { checkChangelogStaleness } from "./stop-auto-continue/changelog-staleness.ts"
import { checkReviewingState } from "./stop-auto-continue/reviewing-state.ts"
import {
  recordSuggestionAndGetCount,
  startSuggestionLogCleanup,
} from "./stop-auto-continue/suggestion-log.ts"
import { getActionableIssues } from "./stop-personal-repo-issues.ts"

const DEDUP_MAX_SEEN = 2 // Allow stop after suggestion seen this many times

const WORKFLOW_FINDING =
  "Collaboration/workflow policy finding detected. Report the violation and enforce the gate; do not prescribe project-specific implementation details."

interface AgentResponse {
  processCritique: string
  productCritique: string
  next: string
  reflections: string[]
}

// ─── Workflow suggestion filter ──────────────────────────────────────────────

/**
 * Returns true if the suggestion is about git workflow, hook/skill modifications,
 * or process enforcement rather than product/code concerns.
 * These suggestions violate the ABSOLUTE PROHIBITIONS in the prompt but the AI
 * backend doesn't always comply — this is the deterministic backstop.
 */
const WORKFLOW_PATTERNS: Array<{ id: string; re: RegExp }> = [
  {
    id: "git_command",
    re: /\bgit\s+(commit|add|push|pull|fetch|rebase|merge|stash|checkout|switch)\b/i,
  },
  { id: "git_workflow", re: /\bgit\s+workflow\b/i },
  { id: "feature_branch", re: /\bfeature\s+branch\b/i },
  { id: "pull_request", re: /\bpull\s+request\b/i },
  { id: "skill_workflow", re: /\b(push|commit|pr)\s+skill\b/i },
  { id: "hook_event", re: /\b(pre-?push|pre-?commit|stop)\s+hook/i },
  { id: "hook_script", re: /\bhook\s+(script|implementation|behaviour|behavior|filtering)\b/i },
  { id: "hook_filtering", re: /\bhook-\w+\b.*\b(filtering|output|suggestion)\b/i },
  // Match only when a specific hook filename (e.g. stop-auto-continue.ts, pretooluse-foo.ts)
  // is referenced — prevents false positives on product suggestions about "the hook system/framework".
  {
    id: "specific_hook_filename",
    re: /\b(implement|modify|wire|add|fix|update)\b.*\b(?:pre-?tool-?use|post-?tool-?use|stop-|session-?start|user-?prompt)[a-z0-9-]*(?:\.ts)?\s+hook\b/i,
  },
  {
    id: "specific_hook_reference",
    re: /\b(implement|modify|wire|add|fix|update)\b.*\bhook\b.*\b(?:pre-?tool-?use|post-?tool-?use|stop-|session-?start|user-?prompt)[a-z0-9-]*/i,
  },
  { id: "collaboration_signal", re: /\bcollaboration\s+(signal|guard|detection|check)\b/i },
  { id: "branch_policy", re: /\bbranch\s+(policy|protection|enforcement)\b/i },
  { id: "push_guard", re: /\b(push|commit)\s+guard\b/i },
  { id: "push_orchestration", re: /\b(push|git)\s+orchestration\b/i },
  { id: "guard_aware", re: /\bguard-?aware\b/i },
  {
    id: "project_specific_module",
    re: /\b(implement|add|fix|build|extend|wire(?:\s+up)?|update)\b.*\bin\s+[a-z0-9]+-[a-z0-9-]+\b/i,
  },
]

export function isWorkflowSuggestion(
  text: string,
  opts: { skipPrPattern?: boolean } = {}
): boolean {
  return WORKFLOW_PATTERNS.some((pattern) => {
    if (opts.skipPrPattern && pattern.id === "pull_request") return false
    return pattern.re.test(text)
  })
}

function normalizeCreativeIssueDescription(next: string): string {
  const compact = next.replace(/\s+/g, " ").trim()
  const body = compact.replace(/^Create issue:\s*/i, "").trim()
  const seed = body || "Deliver a roadmap-level user-facing capability gap closure"
  const parts = [`Create issue: ${seed}`]

  if (!/user-facing gap:/i.test(seed)) {
    parts.push("user-facing gap: state the concrete capability users cannot currently access")
  }
  if (!/\bscope:/i.test(seed)) {
    parts.push("scope: list concrete code changes across affected modules")
  }
  if (!/\bacceptance:/i.test(seed) && !/\bverification:/i.test(seed)) {
    parts.push("acceptance: define observable pass/fail behavior checks")
  }

  return parts.join("; ")
}

function normalizeReflectiveNextStep(reflections: string[]): string {
  const top = reflections[0]?.trim()
  if (!top) return ""

  const doMatch = top.match(/^DO:\s*(.+)$/i)
  if (doMatch?.[1]) {
    return `Apply this confirmed reflection immediately in code: ${doMatch[1].trim()}`
  }

  const dontMatch = top.match(/^DON['’]T:\s*(.+)$/i)
  if (dontMatch?.[1]) {
    return `Avoid this confirmed anti-pattern in the next code change: ${dontMatch[1].trim()}`
  }

  return `Apply this confirmed reflection immediately in code: ${top}`
}

// ─── Issue refinement detection ──────────────────────────────────────────────

/**
 * Check for open issues that need refinement (missing readiness labels or
 * explicitly labelled needs-refinement). Returns a formatted status string
 * for injection into the auto-continue prompt, or "" if none found.
 */
async function checkRefinementNeeds(cwd: string): Promise<string> {
  if (!(await isGitRepo(cwd))) return ""
  if (!hasGhCli()) return ""
  if (!(await isGitHubRemote(cwd))) return ""

  const ownership = await detectRepoOwnership(cwd)
  if (!ownership.repoOwner) return ""
  const currentUser = ownership.currentUser
  if (!currentUser) return ""

  const allIssues = await getActionableIssues(
    cwd,
    ownership.isPersonalRepo ? undefined : currentUser
  )
  const refinementIssues = allIssues.filter((i) => needsRefinement(i))

  if (refinementIssues.length === 0) return ""

  const issueRefs = refinementIssues
    .slice(0, 5)
    .map((i) => `#${i.number}`)
    .join(", ")
  const extra = refinementIssues.length > 5 ? ` (and ${refinementIssues.length - 5} more)` : ""

  return (
    `${refinementIssues.length} open issue(s) need refinement before implementation: ${issueRefs}${extra}. ` +
    skillAdvice(
      "refine-issue",
      "Use /refine-issue to refine and label them before working on implementation.",
      "Refine issues by adding type, readiness, and priority labels before implementing. If you created the issue, edit the body to add proposals instead of commenting."
    )
  )
}

// ─── Termination helper ─────────────────────────────────────────────────────

/**
 * Thrown to unwind the auto-continue pipeline; {@link evaluateStopAutoContinue}
 * converts this into a {@link SwizHookOutput} for inline dispatch. Subprocess
 * path uses {@link runSwizHookAsMain}, which applies the same output via
 * `exitWithHookObject`.
 */
export class AutoContinueExit extends Error {
  readonly output: SwizHookOutput

  constructor(output: SwizHookOutput) {
    super("AutoContinueExit")
    this.name = "AutoContinueExit"
    this.output = output
  }
}

/**
 * Single termination point for all exits in this hook.
 *
 * "skip"  → log one structured reason code to stderr, then throw {@link AutoContinueExit} with `{}`.
 * "block" → throw {@link AutoContinueExit} with `blockStopObj(reason)` (subprocess: exit via runSwizHookAsMain).
 */
/**
 * Pure normalization step — exported for unit testing.
 * Maps raw (possibly invalid) inputs into guaranteed well-formed output args.
 * `terminate()` calls this before emitting anything.
 */
export function normalizeTerminateArgs(
  action: string,
  args: string[]
): { safeAction: "skip" | "block"; normalizedArgs: [string] | [string, string] } {
  const safeAction = action === "skip" || action === "block" ? action : "block"
  if (safeAction === "skip") {
    const code = args[0]?.trim() || "UNKNOWN"
    const message = args[1]?.trim() || "unspecified exit reason"
    return { safeAction, normalizedArgs: [code, message] }
  }
  const reason =
    args[0]?.trim() || "Stop blocked — unexpected termination (malformed reason payload)"
  return { safeAction, normalizedArgs: [reason] }
}

function terminate(action: "skip", code: string, message: string): never
function terminate(action: "block", reason: string): never
function terminate(action: "skip" | "block", ...args: string[]): never {
  const { safeAction, normalizedArgs } = normalizeTerminateArgs(action, args)
  if (safeAction === "skip") {
    console.error(`[stop-auto-continue:${normalizedArgs[0]}] ${normalizedArgs[1]}`)
    throw new AutoContinueExit({})
  }
  const reason = normalizedArgs[0]!
  throw new AutoContinueExit(blockStopObj(reason))
}

// ─── Main helpers ────────────────────────────────────────────────────────────

function parseStopInput(hookRaw: unknown): { input: StopHookInput; cwd: string } {
  try {
    const input = stopHookInputSchema.parse(hookRaw)
    return { input, cwd: resolveCwd(input.cwd) }
  } catch (err) {
    const issues = err instanceof z.ZodError ? err.issues : []
    console.error("[stop-auto-continue] stopHookInputSchema parse failed:", JSON.stringify(issues))
    terminate("block", "Auto-continue received malformed stop-hook input.")
  }
}

function postProcessResponse(
  response: AgentResponse,
  ambitionMode: AmbitionMode,
  projectState: string | null
): AgentResponse {
  const result = { ...response }

  if (ambitionMode === "reflective") {
    const reflectiveNext = normalizeReflectiveNextStep(result.reflections)
    if (reflectiveNext) result.next = reflectiveNext
  }

  const isReviewing = projectState === "reviewing" || projectState === "addressing-feedback"
  if (result.next && isWorkflowSuggestion(result.next, { skipPrPattern: isReviewing })) {
    const truncated = result.next.slice(0, 120).replace(/\s+/g, " ").trim()
    const ellipsis = result.next.length > 120 ? "…" : ""
    result.next = `${WORKFLOW_FINDING} [Filtered suggestion: "${truncated}${ellipsis}"]`
  }

  if (ambitionMode === "creative" && result.next) {
    result.next = normalizeCreativeIssueDescription(result.next)
  }

  return result
}

function buildFinalMessage(
  response: AgentResponse,
  refinementStatus: string,
  critiquesEnabled: boolean
): string {
  const parts: string[] = []

  // Lead with the actionable next step — most important info first
  const nextStep = response.next || refinementStatus
  parts.push(`New task: ${nextStep}`)

  // Critiques as supporting context
  if (critiquesEnabled) {
    const critiques: string[] = []
    if (response.processCritique) {
      critiques.push(response.processCritique)
    }
    if (response.productCritique) {
      critiques.push(response.productCritique)
    }
    if (critiques.length > 0) {
      parts.push("")
      parts.push("── Session review ──")
      parts.push(...critiques)
    }
  }

  // Refinement note (only if it wasn't already used as the next step)
  if (refinementStatus && response.next) {
    parts.push("")
    parts.push(`Note: ${refinementStatus}`)
  }

  return parts.join("\n")
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function validateMainInputsAndSettings(
  hookRaw: Record<string, any>,
  cwd: string
): Promise<{
  input: StopHookInput
  effective: ReturnType<typeof getEffectiveSwizSettings>
}> {
  const { input } = parseStopInput(hookRaw)

  const settings = await readSwizSettings()
  const projectSettings = await readProjectSettings(cwd)
  const effective = getEffectiveSwizSettings(settings, input.session_id, projectSettings)
  if (!effective.autoContinue) {
    terminate("skip", "AUTO_CONTINUE_DISABLED", "auto-continue is disabled — skipping block")
  }

  return { input, effective }
}

async function generateDeterministicResponse(
  cwd: string,
  input: StopHookInput,
  effective: ReturnType<typeof getEffectiveSwizSettings>,
  projectState: string | null
): Promise<{
  response: AgentResponse
  refinementStatus: string | null
}> {
  const reviewingDirective = await checkReviewingState(cwd, projectState)
  if (reviewingDirective) terminate("block", reviewingDirective)

  // Parallel: deterministic filler suggestion + refinement/changelog checks
  const { buildFillerSuggestion } = await import("./stop-auto-continue/filler-suggestions.ts")
  const [filler, refinementStatus, changelogStatus] = await Promise.all([
    buildFillerSuggestion({ cwd, sessionId: input.session_id ?? undefined }).catch(() => ""),
    checkRefinementNeeds(cwd),
    checkChangelogStaleness(cwd),
  ])

  const next = filler || changelogStatus || refinementStatus || ""
  const response = postProcessResponse(
    { processCritique: "", productCritique: "", next, reflections: [] },
    effective.ambitionMode,
    projectState
  )

  return { response, refinementStatus }
}

async function validateResponseAndChecks(
  response: AgentResponse,
  refinementStatus: string | null,
  sessionId: string
): Promise<void> {
  if (!response.next && !refinementStatus) {
    terminate(
      "block",
      "Auto-continue could not identify a specific next step. Review your recent changes and ensure all tasks are complete before stopping."
    )
  }

  // Dedup: allow stop if the same suggestion repeats.
  if (sessionId && response.next) {
    const keyCount = await recordSuggestionAndGetCount(sessionId, response.next)
    if (keyCount >= DEDUP_MAX_SEEN) {
      const key = response.next
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120)
      terminate(
        "skip",
        "SUGGESTION_DEDUP",
        `Suggestion seen ${keyCount} times — allowing stop (dedup). Key: ${key.slice(0, 60)}`
      )
    }
  }
}

async function runStopAutoContinueMain(hookRaw: Record<string, any>): Promise<void> {
  startSuggestionLogCleanup() // Fire-and-forget cleanup

  if (!getHomeDirOrNull()) {
    terminate(
      "skip",
      "NO_HOME",
      "HOME unset — skipping auto-continue (cannot resolve session paths under ~/.claude)."
    )
  }

  const { input, cwd } = parseStopInput(hookRaw)
  const { effective } = await validateMainInputsAndSettings(hookRaw, cwd)

  const projectState = await readProjectState(cwd)
  const { response, refinementStatus } = await generateDeterministicResponse(
    cwd,
    input,
    effective,
    projectState
  )

  await validateResponseAndChecks(response, refinementStatus, input.session_id ?? "")

  const finalMessage = buildFinalMessage(
    response,
    refinementStatus ?? "",
    effective.critiquesEnabled ?? false
  )

  terminate("block", finalMessage)
}

export async function evaluateStopAutoContinue(input: StopHookInput): Promise<SwizHookOutput> {
  try {
    await runStopAutoContinueMain(input as unknown as Record<string, any>)
    return {}
  } catch (err) {
    if (err instanceof AutoContinueExit) return err.output
    throw err
  }
}

const stopAutoContinue: SwizStopHook = {
  name: "stop-auto-continue",
  event: "stop",
  timeout: 15,

  run(input) {
    return evaluateStopAutoContinue(input)
  },
}

export default stopAutoContinue

if (import.meta.main) {
  await runSwizHookAsMain(stopAutoContinue, {
    onStdinJsonError: () => blockStopObj("Auto-continue could not parse stop-hook input JSON."),
  })
}
