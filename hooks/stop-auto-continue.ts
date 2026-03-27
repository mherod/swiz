#!/usr/bin/env bun
// Stop hook: Block stop with an AI-generated next-step suggestion and
// extract confirmed patterns (reflections) to auto-memory.
// Uses the Gemini API (promptGemini) for transcript analysis.
// Only skips for trivial sessions (< MIN_TOOL_CALLS) or when no API key is available.

import { z } from "zod"
import { hasAiProvider, promptObject } from "../src/ai-providers.ts"
import { detectRepoOwnership } from "../src/collaboration-policy.ts"
import { resolveCwd } from "../src/cwd.ts"
import { ensureGeminiApiKey } from "../src/gemini.ts"
import { getHomeDirOrNull } from "../src/home.ts"
import { needsRefinement } from "../src/issue-refinement.ts"
import {
  type AmbitionMode,
  getEffectiveSwizSettings,
  readProjectSettings,
  readProjectState,
  readSwizSettings,
} from "../src/settings.ts"
import {
  buildTaskSection,
  buildUserMessagesSection,
  extractTranscriptData,
  formatTurnsAsContext,
  isDocsOnlySession,
  resolveTranscriptText,
  type TranscriptResolution,
} from "../src/transcript-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"
import { buildPrompt } from "./stop-auto-continue/prompt.ts"
import { writeReflections } from "./stop-auto-continue/reflections.ts"
import { checkReviewingState } from "./stop-auto-continue/reviewing-state.ts"
import {
  isUngroundedSuggestion,
  loadSuggestionLog,
  recordSuggestionAndGetCount,
  startSuggestionLogCleanup,
} from "./stop-auto-continue/suggestion-log.ts"
import { getActionableIssues } from "./stop-personal-repo-issues.ts"
import {
  git,
  hasGhCli,
  isGitHubRemote,
  isGitRepo,
  readSessionTasks,
  skillAdvice,
} from "./utils/hook-utils.ts"

const CONTEXT_TURNS = 20 // Recent turns to send as context
const DEDUP_MAX_SEEN = 2 // Allow stop after suggestion seen this many times
const ATTEMPT_TIMEOUT_MS = Number(process.env.ATTEMPT_TIMEOUT_MS) || 120_000

const WORKFLOW_FINDING =
  "Collaboration/workflow policy finding detected. Report the violation and enforce the gate; do not prescribe project-specific implementation details."

const agentResponseSchema = z.object({
  processCritique: z.string(),
  productCritique: z.string(),
  next: z.string(),
  reflections: z.array(z.string()),
})

type AgentResponse = z.infer<typeof agentResponseSchema>

/**
 * Reads in_progress and completed tasks for the session.
 * Returns a formatted block like:
 *   IN PROGRESS: Fix auth bug (#3)
 *   COMPLETED: Add tests for parser (#1), Refactor CLI entry (#2)
 * Returns "" if no tasks found.
 */
async function loadTaskContext(sessionId: string): Promise<string> {
  if (!sessionId) return ""
  const home = getHomeDirOrNull()
  if (!home) return ""
  const tasks = await readSessionTasks(sessionId, home)

  const inProgress: string[] = []
  const completed: string[] = []

  for (const task of tasks) {
    if (!task.id || task.id === "null") continue
    const label = `${task.subject} (#${task.id})`
    if (task.status === "in_progress") inProgress.push(label)
    else if (task.status === "completed") completed.push(label)
  }

  const lines: string[] = []
  if (completed.length > 0) lines.push(`COMPLETED: ${completed.join(", ")}`)
  if (inProgress.length > 0) lines.push(`IN PROGRESS: ${inProgress.join(", ")}`)
  return lines.join("\n")
}

// ─── Response sanitization ──────────────────────────────────────────────────

/**
 * Returns the first non-empty line of the agent's raw response.
 * Returns "" (triggering fallback) if the line looks like XML/tool-call markup.
 */
function sanitizeResponse(raw: string): string {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (hasMarkup(trimmed)) return ""
    return trimmed
  }
  return ""
}

/** True if text contains XML/tool-call markup after NFKC normalization. */
function hasMarkup(text: string): boolean {
  // NFKC folds fullwidth ＜→<; strip zero-width format chars to prevent ZWJ injection
  const normalized = text.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
  // Homoglyphs that don't NFKC-normalize to <:
  // 〈U+3008 ‹U+2039 ⟨U+27E8 ˂U+02C2 ᐸU+1438 ❮U+276E ❰U+2770 ⟪U+27EA ⦑U+2991 ⧼U+29FC
  return /[<〈‹⟨˂ᐸ❮❰⟪⦑⧼]\w/.test(normalized)
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

/**
 * Apply markup and length filtering to a structured AgentResponse returned by the
 * AI SDK. sanitizeResponse() strips XML/tool-call injection from string fields;
 * reflections are also length-capped and de-duplication-ready.
 */
function filterAgentResponse(parsed: AgentResponse): AgentResponse {
  return {
    processCritique: sanitizeResponse(parsed.processCritique),
    productCritique: sanitizeResponse(parsed.productCritique),
    next: sanitizeResponse(parsed.next),
    reflections: parsed.reflections
      .filter((r) => r.length >= 10 && r.length <= 300 && !hasMarkup(r))
      .slice(0, 10),
  }
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

// ─── Changelog staleness detection ──────────────────────────────────────────

const ONE_DAY = 86400

/**
 * Check if CHANGELOG.md is stale (last updated > 1 day before the latest commit).
 * Returns a human-readable status string, or "" if not stale or not applicable.
 */
export async function checkChangelogStaleness(cwd: string): Promise<string> {
  if (!(await isGitRepo(cwd))) return ""

  const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
  if (!repoRoot) return ""

  // Find CHANGELOG.md
  let changelogPath = ""
  if (await Bun.file(`${repoRoot}/CHANGELOG.md`).exists()) {
    changelogPath = "CHANGELOG.md"
  } else {
    const lsFiles = await git(["ls-files"], repoRoot)
    const match = lsFiles.split("\n").find((f) => /^CHANGELOG\.md$/i.test(f))
    if (match) changelogPath = match
  }

  if (!changelogPath) return ""

  const lastCommitTime = parseInt(await git(["log", "-1", "--format=%ct"], repoRoot), 10)
  if (Number.isNaN(lastCommitTime)) return ""

  const changelogTime = parseInt(
    await git(["log", "-1", "--format=%ct", "--", changelogPath], repoRoot),
    10
  )
  if (Number.isNaN(changelogTime)) return ""

  const gap = lastCommitTime - changelogTime
  if (gap <= ONE_DAY) return ""

  const days = Math.floor(gap / ONE_DAY)
  const hours = Math.floor((gap % ONE_DAY) / 3600)

  return `CHANGELOG.md is stale — last updated ${days}d ${hours}h before the most recent commit. It should be updated.`
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
 * Single termination point for all exits in this hook.
 *
 * "skip"  → log one structured reason code to stderr, exit 0 (allow stop).
 * "block" → emit one JSON decision object to stdout, exit 0 (block stop).
 *
 * Returning `never` is a compiler-enforced guarantee: no code after any
 * terminate() call can execute, making dual-emission structurally impossible.
 *
 * The runtime implementation is defensively hardened: unknown actions default
 * to "block" (safe — prevents accidental stop), and empty/missing payloads
 * are normalised to stable fallback values so output is always well-formed.
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
  } else {
    console.log(JSON.stringify({ decision: "block", reason: normalizedArgs[0] }))
  }
  process.exit(0)
}

// ─── Filler suggestion ───────────────────────────────────────────────────────

/**
 * Build a deterministic filler next-step suggestion when all AI backends fail.
 * Uses the session's edited file paths to produce a context-aware suggestion.
 * Returns "" if no useful suggestion can be derived.
 */

// ─── Main helpers ────────────────────────────────────────────────────────────

function parseStopInput(hookRaw: unknown): { input: StopHookInput; cwd: string } {
  const parsedInput = stopHookInputSchema.safeParse(hookRaw)
  if (!parsedInput.success) {
    console.error(
      "[stop-auto-continue] stopHookInputSchema parse failed:",
      JSON.stringify(parsedInput.error.issues)
    )
    terminate("block", "Auto-continue received malformed stop-hook input.")
  }
  const input = parsedInput.data
  return { input, cwd: resolveCwd(input.cwd) }
}

async function handleNoTranscript(
  transcriptResolution: TranscriptResolution,
  sessionId: string,
  cwd: string,
  inputCwd: string | undefined,
  ambitionMode: AmbitionMode
): Promise<void> {
  // Parallelize all independent I/O operations
  const [taskContext, refinementStatus, changelogStatus, repoFiles] = await Promise.all([
    loadTaskContext(sessionId),
    checkRefinementNeeds(cwd),
    checkChangelogStaleness(cwd),
    git(["ls-files", "hooks/", "src/"], cwd).catch(() => ""),
  ])
  const statusParts = [changelogStatus, refinementStatus].filter(Boolean)
  const fallbackPrompt = buildPrompt({
    taskSection: buildTaskSection(taskContext),
    userMessagesSection: "",
    projectStatus: statusParts.join("\n"),
    context: `Transcript unavailable. Failure reason: ${transcriptResolution.failureReason ?? "unknown transcript read failure"}`,
    ambitionMode,
    cwd: inputCwd,
    docsOnly: false,
    repoFiles,
  })
  terminate(
    "block",
    "Auto-continue could not analyze this session from transcript data. " +
      "Continue directly using the internal-agent prompt below:\n\n" +
      fallbackPrompt
  )
}

interface GenerateAiResponseOpts {
  turns: ReturnType<typeof extractTranscriptData>["turns"]
  docsOnly: boolean
  taskContext: string
  refinementStatus: string
  cwd: string
  inputCwd: string | undefined
  ambitionMode: AmbitionMode
  sessionId: string
}

async function generateAiResponse(opts: GenerateAiResponseOpts): Promise<AgentResponse> {
  const { turns, docsOnly, taskContext, refinementStatus, cwd, inputCwd, ambitionMode, sessionId } =
    opts
  // Cap context to ~30K chars (~8K tokens) to stay within model limits.
  // Prioritize recent turns — trim from the front if over budget.
  const MAX_CONTEXT_CHARS = 30_000
  let context = formatTurnsAsContext(turns)
  if (context.length > MAX_CONTEXT_CHARS) {
    context = `[...earlier turns truncated for length...]\n\n${context.slice(-MAX_CONTEXT_CHARS)}`
  }
  const taskSection = buildTaskSection(taskContext)
  const userMessagesSection = buildUserMessagesSection(turns)
  // Parallelize I/O-bound pre-AI data gathering
  const [changelogStatus, repoFiles, suggestionLog] = await Promise.all([
    checkChangelogStaleness(cwd),
    docsOnly ? Promise.resolve("") : git(["ls-files", "hooks/", "src/"], cwd).catch(() => ""),
    sessionId ? loadSuggestionLog(sessionId) : Promise.resolve({ seen: {} }),
  ])
  const statusParts = [changelogStatus, refinementStatus].filter(Boolean)
  const prompt = buildPrompt({
    taskSection,
    userMessagesSection,
    projectStatus: statusParts.join("\n"),
    context,
    ambitionMode,
    cwd: inputCwd,
    docsOnly,
    repoFiles,
    previousSuggestions: suggestionLog.seen,
  })

  try {
    const parsed = await promptObject(prompt, agentResponseSchema, {
      timeout: ATTEMPT_TIMEOUT_MS,
    })
    return filterAgentResponse(parsed)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[stop-auto-continue] AI generation failed: ${errMsg}`)
    if (errMsg.includes("Requested entity was not found")) {
      console.error(
        "[stop-auto-continue] Hint: check GEMINI_MODEL env var, API key project, and GEMINI_API_VERSION"
      )
    }
    // Allow stop gracefully — other stop hooks (memory reminder, etc.) handle fallback suggestions.
    terminate("skip", "AI_BACKEND_FAILED", `AI generation failed: ${errMsg}`)
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
  parts.push(`▶ Next step: ${nextStep}`)

  // Critiques as supporting context
  if (critiquesEnabled) {
    const critiques: string[] = []
    if (response.processCritique) critiques.push(`  Process: ${response.processCritique}`)
    if (response.productCritique) critiques.push(`  Product: ${response.productCritique}`)
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

interface SessionContext {
  transcriptData: ReturnType<typeof extractTranscriptData>
  docsOnly: boolean
  taskContext: string
  refinementStatus: string
}

async function resolveSessionContext(
  input: StopHookInput,
  cwd: string,
  ambitionMode: AmbitionMode
): Promise<SessionContext> {
  const transcriptResolution = await resolveTranscriptText(input.transcript_path, cwd)

  if (!transcriptResolution.raw) {
    await handleNoTranscript(
      transcriptResolution,
      input.session_id ?? "",
      cwd,
      input.cwd,
      ambitionMode
    )
  }

  const transcriptData = extractTranscriptData(
    transcriptResolution.raw!,
    transcriptResolution.formatHint
  )
  const turns = transcriptData.turns.slice(-CONTEXT_TURNS)
  if (turns.length === 0) {
    terminate(
      "block",
      "Auto-continue could not analyze this session: transcript has no parseable conversation turns."
    )
  }

  // Parallelize independent I/O operations
  const [taskContext, refinementStatus] = await Promise.all([
    loadTaskContext(input.session_id ?? ""),
    checkRefinementNeeds(cwd),
  ])
  return {
    transcriptData,
    docsOnly: isDocsOnlySession(transcriptData.editedPaths),
    taskContext,
    refinementStatus,
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function validateMainInputsAndSettings(
  hookRaw: Record<string, unknown>,
  cwd: string
): Promise<{
  input: StopHookInput
  effective: ReturnType<typeof getEffectiveSwizSettings>
}> {
  const { input } = parseStopInput(hookRaw)

  await ensureGeminiApiKey()

  const settings = await readSwizSettings()
  const projectSettings = await readProjectSettings(cwd)
  const effective = getEffectiveSwizSettings(settings, input.session_id, projectSettings)
  if (!effective.autoContinue) {
    terminate("skip", "AUTO_CONTINUE_DISABLED", "auto-continue is disabled — skipping block")
  }

  return { input, effective }
}

async function validatePrerequisitesAndGenerateResponse(
  cwd: string,
  input: StopHookInput,
  effective: ReturnType<typeof getEffectiveSwizSettings>,
  projectState: string | null
): Promise<{
  response: ReturnType<typeof postProcessResponse>
  repoFiles: string
  refinementStatus: string | null
}> {
  const reviewingDirective = await checkReviewingState(cwd, projectState)
  if (reviewingDirective) terminate("block", reviewingDirective)

  if (!hasAiProvider()) {
    terminate(
      "block",
      "Auto-continue could not generate a next-step suggestion: no AI backend available.\nSet GEMINI_API_KEY, OPENROUTER_API_KEY, or install the claude CLI, then continue working."
    )
  }

  const { transcriptData, docsOnly, taskContext, refinementStatus } = await resolveSessionContext(
    input,
    cwd,
    effective.ambitionMode
  )

  const turns = transcriptData.turns.slice(-CONTEXT_TURNS)
  const [rawResponse, repoFiles] = await Promise.all([
    generateAiResponse({
      turns,
      docsOnly,
      taskContext,
      refinementStatus,
      cwd,
      inputCwd: input.cwd,
      ambitionMode: effective.ambitionMode,
      sessionId: input.session_id ?? "",
    }),
    docsOnly ? Promise.resolve("") : git(["ls-files", "hooks/", "src/"], cwd).catch(() => ""),
  ])
  const response = postProcessResponse(rawResponse, effective.ambitionMode, projectState)

  return { response, repoFiles, refinementStatus }
}

async function validateResponseAndChecks(
  response: ReturnType<typeof postProcessResponse>,
  refinementStatus: string | null,
  repoFiles: string,
  sessionId: string,
  cwd: string
): Promise<void> {
  if (response.reflections.length > 0) {
    await writeReflections(cwd, response.reflections)
  }

  if (!response.next && !refinementStatus) {
    terminate(
      "block",
      "Auto-continue could not identify a specific next step. Review your recent changes and ensure all tasks are complete before stopping."
    )
  }

  // Grounding check: if suggestion references hook/file names absent from repo, skip instead of block.
  if (response.next && repoFiles) {
    const ungrounded = isUngroundedSuggestion(response.next, repoFiles)
    if (ungrounded) {
      terminate(
        "skip",
        "UNGROUNDED_SUGGESTION",
        `Suggestion references non-existent artifacts — allowing stop. Detail: ${ungrounded}`
      )
    }
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

async function main(): Promise<void> {
  startSuggestionLogCleanup() // Fire-and-forget cleanup

  let hookRaw: Record<string, unknown>
  try {
    hookRaw = (await Bun.stdin.json()) as Record<string, unknown>
  } catch {
    terminate("block", "Auto-continue could not parse stop-hook input JSON.")
  }

  const { input, cwd } = parseStopInput(hookRaw)
  const { effective } = await validateMainInputsAndSettings(hookRaw, cwd)

  const projectState = await readProjectState(cwd)
  const { response, repoFiles, refinementStatus } = await validatePrerequisitesAndGenerateResponse(
    cwd,
    input,
    effective,
    projectState
  )

  await validateResponseAndChecks(
    response,
    refinementStatus,
    repoFiles,
    input.session_id ?? "",
    cwd
  )

  const finalMessage = buildFinalMessage(
    response,
    refinementStatus ?? "",
    effective.critiquesEnabled ?? false
  )

  // Auto-steer intercept is handled at the dispatch level (BlockingStrategy).
  // This hook just blocks as usual; the dispatcher converts it to a terminal
  // steering prompt when autoSteer is enabled.
  terminate("block", finalMessage)
}

// Guard: only run main() when this file is the entry point, not when imported for testing.
if (import.meta.main) void main()
