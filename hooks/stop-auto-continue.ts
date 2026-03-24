#!/usr/bin/env bun
// Stop hook: Block stop with an AI-generated next-step suggestion and
// extract confirmed patterns (reflections) to auto-memory.
// Uses the Gemini API (promptGemini) for transcript analysis.
// Only skips for trivial sessions (< MIN_TOOL_CALLS) or when no API key is available.

import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { uniq } from "lodash-es"
import { z } from "zod"
import { hasAiProvider, promptObject } from "../src/ai-providers.ts"
import { detectRepoOwnership } from "../src/collaboration-policy.ts"
import { resolveCwd } from "../src/cwd.ts"
import { ensureGeminiApiKey } from "../src/gemini.ts"
import { getHomeDir, getHomeDirOrNull } from "../src/home.ts"
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
  projectKeyFromCwd,
  resolveTranscriptText,
  type TranscriptResolution,
} from "../src/transcript-utils.ts"
import { stopHookInputSchema } from "./schemas.ts"
import { getActionableIssues } from "./stop-personal-repo-issues.ts"
import {
  buildIssueGuidance,
  getOpenPrForBranch,
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

const HOME = getHomeDir()
const PROJECTS_DIR = join(HOME, ".claude", "projects")

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
const WORKFLOW_PATTERNS = [
  /\bgit\s+(commit|add|push|pull|fetch|rebase|merge|stash|checkout|switch)\b/i,
  /\bgit\s+workflow\b/i,
  /\bfeature\s+branch\b/i,
  /\bpull\s+request\b/i,
  /\b(push|commit|pr)\s+skill\b/i,
  /\b(pre-?push|pre-?commit|stop)\s+hook/i,
  /\bhook\s+(script|implementation|behaviour|behavior|filtering)\b/i,
  /\bhook-\w+\b.*\b(filtering|output|suggestion)\b/i,
  // Match only when a specific hook filename (e.g. stop-auto-continue.ts, pretooluse-foo.ts)
  // is referenced — prevents false positives on product suggestions about "the hook system/framework".
  /\b(implement|modify|wire|add|fix|update)\b.*\b(?:pre-?tool-?use|post-?tool-?use|stop-|session-?start|user-?prompt)[a-z0-9-]*(?:\.ts)?\s+hook\b/i,
  /\b(implement|modify|wire|add|fix|update)\b.*\bhook\b.*\b(?:pre-?tool-?use|post-?tool-?use|stop-|session-?start|user-?prompt)[a-z0-9-]*/i,
  /\bcollaboration\s+(signal|guard|detection|check)\b/i,
  /\bbranch\s+(policy|protection|enforcement)\b/i,
  /\b(push|commit)\s+guard\b/i,
  /\b(push|git)\s+orchestration\b/i,
  /\bguard-?aware\b/i,
  /\b(implement|add|fix|build|extend|wire(?:\s+up)?|update)\b.*\bin\s+[a-z0-9]+-[a-z0-9-]+\b/i,
]

export function isWorkflowSuggestion(
  text: string,
  opts: { skipPrPattern?: boolean } = {}
): boolean {
  return WORKFLOW_PATTERNS.some((re, i) => {
    // Index 3 is the /\bpull\s+request\b/i pattern — exempt it in reviewing state
    if (opts.skipPrPattern && i === 3) return false
    return re.test(text)
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

// ─── Memory file resolution ─────────────────────────────────────────────────

async function findProjectDir(cwd: string): Promise<string | null> {
  const projectKey = projectKeyFromCwd(cwd)
  const derived = join(PROJECTS_DIR, projectKey)
  try {
    await readdir(derived)
    return derived
  } catch {}

  // Fallback: scan project dirs for one that matches this CWD
  try {
    const dirs = await readdir(PROJECTS_DIR)
    for (const dir of dirs) {
      if (projectKey === dir) return join(PROJECTS_DIR, dir)
    }
  } catch {}

  return null
}

// ─── Memory writing ─────────────────────────────────────────────────────────

/**
 * Write agent-extracted reflections to the project's MEMORY.md file.
 * Deduplicates against existing content and respects a ~200-line cap.
 * Never throws — failures are silently swallowed.
 */
async function writeReflections(cwd: string, reflections: string[]): Promise<void> {
  try {
    const projectDir = await findProjectDir(cwd)
    if (!projectDir) return

    const memoryDir = join(projectDir, "memory")
    try {
      await readdir(memoryDir)
    } catch {
      return
    }

    const memoryFile = join(memoryDir, "MEMORY.md")

    let existing = ""
    if (await Bun.file(memoryFile).exists()) {
      existing = await Bun.file(memoryFile).text()
    }

    // Deduplicate against existing content — strip DO/DON'T prefix before comparing
    // so "DO: Always use bun" matches "- **DO**: Always use bun" in memory
    const existingLower = existing.toLowerCase()
    const newReflections = reflections.filter((r) => {
      const text = r.replace(/^(DO|DON'T):\s*/i, "")
      const core = text.toLowerCase().slice(0, 60)
      return !existingLower.includes(core)
    })

    if (newReflections.length === 0) return

    // Check line count won't exceed ~200
    const currentLines = existing.split("\n").length
    if (currentLines + newReflections.length + 3 > 200) return

    // Append as prescriptive directives
    let append = "\n\n## Confirmed Patterns\n\n"
    if (existing.includes("## Confirmed Patterns")) {
      append = "\n"
    }
    for (const r of newReflections) {
      const match = r.match(/^(DO|DON'T):\s*(.+)/i)
      if (match) {
        const prefix = match[1]!.toUpperCase()
        const text = match[2]!
        append += `- **${prefix}**: ${text}\n`
      } else {
        append += `- **DO**: ${r}\n`
      }
    }

    await Bun.write(memoryFile, existing + append)
  } catch {
    // Never block on memory write failure
  }
}

// ─── Changelog staleness detection ──────────────────────────────────────────

const ONE_DAY = 86400

/**
 * Check if CHANGELOG.md is stale (last updated > 1 day before the latest commit).
 * Returns a human-readable status string, or "" if not stale or not applicable.
 */
async function checkChangelogStaleness(cwd: string): Promise<string> {
  if (!(await isGitRepo(cwd))) return ""

  const repoRoot = await git(["rev-parse", "--show-toplevel"], cwd)
  if (!repoRoot) return ""

  // Find CHANGELOG.md
  let changelogPath = ""
  if (await Bun.file(`${repoRoot}/CHANGELOG.md`).exists()) {
    changelogPath = "CHANGELOG.md"
  } else {
    const lsFiles = await git(["ls-files", repoRoot], cwd)
    const match = lsFiles.split("\n").find((f) => /^CHANGELOG\.md$/i.test(f))
    if (match) changelogPath = match
  }

  if (!changelogPath) return ""

  const lastCommitTime = parseInt(await git(["log", "-1", "--format=%ct"], cwd), 10)
  if (Number.isNaN(lastCommitTime)) return ""

  const changelogTime = parseInt(
    await git(["log", "-1", "--format=%ct", "--", changelogPath], cwd),
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

// ─── Prompt construction ────────────────────────────────────────────────────

const PROMPT_ROLE =
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

const PROMPT_CRITIQUES =
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

function buildNextStepRules(
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

function buildProhibitionsBlock(cwd?: string): string {
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

const PROMPT_REFLECTIONS_RULES =
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

function buildPreviousSuggestionsBlock(seen: Record<string, number>): string {
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

function buildPrompt(opts: {
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
/** Check if any memory file (CLAUDE.md or MEMORY.md) was modified within recency window. */
async function memoryRecentlyUpdated(cwd: string, windowMs: number): Promise<boolean> {
  const home = getHomeDirOrNull()
  const candidates = [join(cwd, "CLAUDE.md"), ...(home ? [join(home, ".claude", "CLAUDE.md")] : [])]
  for (const f of candidates) {
    try {
      const s = await stat(f)
      if (Date.now() - s.mtimeMs < windowMs) return true
    } catch {}
  }
  return false
}

const MEMORY_RECENCY_WINDOW_MS = 5 * 60 * 1000

export async function buildFillerSuggestion(
  editedPaths: Set<string>,
  docsOnly: boolean,
  cwd: string
): Promise<string> {
  // Skip reflection suggestion if memory was recently updated (within 5 minutes).
  if (await memoryRecentlyUpdated(cwd, MEMORY_RECENCY_WINDOW_MS)) return ""

  const reflectAdvice = skillAdvice(
    "reflect-on-session-mistakes",
    "run /reflect-on-session-mistakes to identify patterns to avoid",
    "review the session transcript for patterns to avoid"
  )
  if (docsOnly) {
    return skillAdvice(
      "changelog",
      "Review the documentation changes for accuracy and completeness, then use /changelog to update CHANGELOG.md if it reflects user-facing behavior.",
      "Review the documentation changes for accuracy and completeness, then update CHANGELOG.md if it reflects user-facing behavior."
    )
  }
  if (editedPaths.size > 0) {
    return `Reflect on this session's work: ${reflectAdvice}, then update MEMORY.md with any confirmed directives from this session.`
  }
  return `Reflect on this session: ${reflectAdvice} and update MEMORY.md with confirmed directives.`
}

// ─── Reviewing-state checklist ───────────────────────────────────────────────

interface ReviewingPr {
  number: number
  reviews: Array<{ state: string; author: { login: string } }>
  reviewThreads: Array<{ isResolved: boolean }>
  statusCheckRollup: Array<{ state?: string; conclusion?: string; name?: string }>
}

const FAILING_STATES = new Set(["FAILURE", "ERROR"])
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"])
const PENDING_STATES = new Set(["PENDING", "EXPECTED"])

function checkPrReviewState(pr: ReviewingPr): string | null {
  const changesRequested = (pr.reviews ?? []).filter((r) => r.state === "CHANGES_REQUESTED")
  if (changesRequested.length > 0) {
    const reviewers = uniq(changesRequested.map((r) => r.author?.login).filter(Boolean))
    const who = reviewers.length > 0 ? ` from ${reviewers.join(", ")}` : ""
    return `Address CHANGES_REQUESTED review feedback${who} on PR #${pr.number} before merging.`
  }

  const unresolvedThreads = (pr.reviewThreads ?? []).filter((t) => !t.isResolved)
  if (unresolvedThreads.length > 0) {
    const count = unresolvedThreads.length
    return `Resolve ${count} unresolved review thread${count > 1 ? "s" : ""} on PR #${pr.number} before merging.`
  }

  return null
}

function checkPrCiState(pr: ReviewingPr): string | null {
  const checks = pr.statusCheckRollup ?? []
  const failingChecks = checks.filter(
    (c) => FAILING_STATES.has(c.state ?? "") || FAILING_CONCLUSIONS.has(c.conclusion ?? "")
  )
  if (failingChecks.length > 0) {
    const names = failingChecks
      .map((c) => c.name)
      .filter(Boolean)
      .slice(0, 3)
      .join(", ")
    const label = names ? ` (${names})` : ""
    return `Fix failing CI checks${label} on PR #${pr.number} before merging.`
  }

  const pendingChecks = checks.filter((c) => {
    const state = c.state ?? ""
    const conclusion = c.conclusion ?? ""
    return PENDING_STATES.has(state) || (conclusion === "" && state !== "SUCCESS")
  })
  if (pendingChecks.length > 0) {
    return `Wait for ${pendingChecks.length} pending CI check${pendingChecks.length > 1 ? "s" : ""} on PR #${pr.number} before merging.`
  }

  return null
}

/**
 * When the project is in `reviewing` or `addressing-feedback` state, run a
 * deterministic checklist before calling the AI backend. Returns a non-null
 * directive string (the next step to suggest) when a blocking issue is found,
 * or null when all checks pass (AI takes over).
 *
 * Priority order: conflicts → CHANGES_REQUESTED → unresolved threads → failing CI.
 */
async function checkMergeConflicts(cwd: string): Promise<string | null> {
  try {
    const conflictFiles = (await git(["diff", "--name-only", "--diff-filter=U"], cwd)).trim()
    if (!conflictFiles) return null
    const files = conflictFiles.split("\n").filter(Boolean).slice(0, 5)
    const fileList = files.map((f) => `\`${f}\``).join(", ")
    return skillAdvice(
      "resolve-conflicts",
      `Resolve merge conflicts in ${fileList} before continuing PR review: use the /resolve-conflicts skill.`,
      `Resolve merge conflicts in ${fileList} before continuing PR review: run \`git rebase --continue\` after fixing conflicts.`
    )
  } catch {
    return null
  }
}

async function validateReviewingStateInputs(
  state: string | null,
  cwd: string
): Promise<{ valid: boolean; directive?: string }> {
  if (state !== "reviewing" && state !== "addressing-feedback") {
    return { valid: false }
  }
  if (!(await isGitRepo(cwd))) {
    return { valid: false }
  }

  const conflictDirective = await checkMergeConflicts(cwd)
  if (conflictDirective) {
    return { valid: false, directive: conflictDirective }
  }

  if (!hasGhCli() || !(await isGitHubRemote(cwd))) {
    return { valid: false }
  }

  return { valid: true }
}

async function resolvePrForBranch(cwd: string): Promise<ReviewingPr | null> {
  try {
    const branch = (await git(["branch", "--show-current"], cwd)).trim()
    if (!branch) return null
    return await getOpenPrForBranch<ReviewingPr>(
      branch,
      cwd,
      "number,reviews,reviewThreads,statusCheckRollup"
    )
  } catch {
    return null
  }
}

export async function checkReviewingState(
  cwd: string,
  state: string | null
): Promise<string | null> {
  const validation = await validateReviewingStateInputs(state, cwd)
  if (!validation.valid) return validation.directive ?? null

  const pr = await resolvePrForBranch(cwd)
  if (!pr) return null

  const reviewDirective = checkPrReviewState(pr)
  if (reviewDirective) return reviewDirective

  const ciDirective = checkPrCiState(pr)
  if (ciDirective) return ciDirective

  // All checks pass — PR is ready to merge
  return skillAdvice(
    "pr-qa-and-merge",
    `PR #${pr.number} is ready to merge — no conflicts, no pending reviews, CI is green. Use the /pr-qa-and-merge skill to merge.`,
    `PR #${pr.number} is ready to merge — no conflicts, no pending reviews, CI is green. Run: gh pr merge ${pr.number} --squash`
  )
}

// ─── Main helpers ────────────────────────────────────────────────────────────

type StopInput = ReturnType<typeof stopHookInputSchema.parse>

function parseStopInput(hookRaw: unknown): { input: StopInput; cwd: string } {
  const parsedInput = stopHookInputSchema.safeParse(hookRaw)
  if (!parsedInput.success) {
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
  editedPaths: Set<string>
  docsOnly: boolean
  taskContext: string
  refinementStatus: string
  cwd: string
  inputCwd: string | undefined
  ambitionMode: AmbitionMode
  sessionId: string
}

async function generateAiResponse(opts: GenerateAiResponseOpts): Promise<AgentResponse> {
  const {
    turns,
    editedPaths,
    docsOnly,
    taskContext,
    refinementStatus,
    cwd,
    inputCwd,
    ambitionMode,
    sessionId,
  } = opts
  const context = formatTurnsAsContext(turns)
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
  } catch {
    const fillerNext = await buildFillerSuggestion(editedPaths, docsOnly, inputCwd ?? process.cwd())
    if (fillerNext) {
      return { processCritique: "", productCritique: "", next: fillerNext, reflections: [] }
    }
    if (!refinementStatus) {
      terminate(
        "block",
        "Auto-continue could not generate a next-step suggestion: AI backend failed during call.\nReview your recent changes and continue working if there is more to do."
      )
    }
    return { processCritique: "", productCritique: "", next: "", reflections: [] }
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
  const critiqueLines = critiquesEnabled
    ? [
        response.processCritique ? `Process: ${response.processCritique}` : "",
        response.productCritique ? `Product: ${response.productCritique}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : ""
  const critiqueLine = critiqueLines ? `${critiqueLines}\n\n` : ""
  const refinementDirective = refinementStatus ? `\n\nNote: ${refinementStatus}` : ""
  return `${critiqueLine}Stop blocked — unresolved finding: ${response.next || refinementStatus}${refinementDirective}`
}

interface SessionContext {
  transcriptData: ReturnType<typeof extractTranscriptData>
  docsOnly: boolean
  taskContext: string
  refinementStatus: string
}

async function resolveSessionContext(
  input: StopInput,
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

// ─── Suggestion grounding ─────────────────────────────────────────────────

/**
 * Regex to extract hook/file name references from a suggestion.
 * Matches patterns like: pretooluse-foo-bar, stop-something, posttooluse-xyz,
 * session-start-thing, user-prompt-handler — with optional .ts suffix.
 */
const HOOK_NAME_RE =
  /\b(pre-?tool-?use|post-?tool-?use|stop|session-?start|user-?prompt)[a-z0-9-]+(?:\.ts)?\b/gi

/**
 * Check whether a suggestion references hook/file names that don't exist in
 * the repo file list. Returns a description of the ungrounded reference if
 * found, or null if the suggestion is grounded (or has no file references).
 */
export function isUngroundedSuggestion(suggestionText: string, repoFiles: string): string | null {
  const matches = suggestionText.match(HOOK_NAME_RE)
  if (!matches || matches.length === 0) return null

  const repoFilesLower = repoFiles.toLowerCase()
  const ungrounded = uniq(
    matches
      .map((m) => m.toLowerCase().replace(/\.ts$/, ""))
      .filter((name) => !repoFilesLower.includes(name))
  )

  if (ungrounded.length === 0) return null
  return `Referenced artifacts not in repo: ${ungrounded.join(", ")}`
}

// ─── Suggestion deduplication ─────────────────────────────────────────────

/** Normalize a suggestion to a short dedup key. */
function suggestionKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120)
}

interface SuggestionLog {
  seen: Record<string, number> // key → count
}

function getSuggestionsPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
  const home = getHomeDirOrNull() ?? "/tmp"
  return join(home, ".swiz", `stop-suggestions-${safe}.json`)
}

async function loadSuggestionLog(sessionId: string): Promise<SuggestionLog> {
  try {
    const raw = await Bun.file(getSuggestionsPath(sessionId)).json()
    if (
      typeof raw === "object" &&
      raw !== null &&
      typeof (raw as SuggestionLog).seen === "object"
    ) {
      return raw as SuggestionLog
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return { seen: {} }
}

async function recordSuggestion(sessionId: string, key: string): Promise<number> {
  const log = await loadSuggestionLog(sessionId)
  log.seen[key] = (log.seen[key] ?? 0) + 1
  const path = getSuggestionsPath(sessionId)
  const { mkdirSync } = await import("node:fs")
  const { dirname } = await import("node:path")
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {}
  await Bun.write(path, JSON.stringify(log))
  return log.seen[key]!
}

/** Best-effort cleanup of dedup files older than 7 days or exceeding max count. */
const DEDUP_MAX_FILES = 50

async function pruneOldSuggestionLogs(): Promise<void> {
  const home = getHomeDirOrNull()
  if (!home) return
  const swizDir = join(home, ".swiz")
  try {
    const entries = await readdir(swizDir)
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const suggestionFiles: { path: string; mtime: number }[] = []
    for (const entry of entries) {
      if (!entry.startsWith("stop-suggestions-") || !entry.endsWith(".json")) continue
      const filePath = join(swizDir, entry)
      const file = Bun.file(filePath)
      if (!(await file.exists())) continue
      const mtime = file.lastModified
      if (mtime < cutoff) {
        await Bun.write(filePath, "") // Truncate stale files
      } else {
        suggestionFiles.push({ path: filePath, mtime })
      }
    }
    // Cap total files: truncate oldest excess
    if (suggestionFiles.length > DEDUP_MAX_FILES) {
      suggestionFiles.sort((a, b) => a.mtime - b.mtime)
      for (const file of suggestionFiles.slice(0, suggestionFiles.length - DEDUP_MAX_FILES)) {
        await Bun.write(file.path, "")
      }
    }
  } catch {
    // Best-effort — ignore errors
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function validateMainInputsAndSettings(
  hookRaw: Record<string, unknown>,
  cwd: string
): Promise<{
  input: StopInput
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
  input: StopInput,
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
      "Auto-continue could not generate a next-step suggestion: no AI backend available.\nSet GEMINI_API_KEY or install the claude or codex CLI, then continue working."
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
      editedPaths: transcriptData.editedPaths,
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
    const key = suggestionKey(response.next)
    const keyCount = await recordSuggestion(sessionId, key)
    if (keyCount >= DEDUP_MAX_SEEN) {
      terminate(
        "skip",
        "SUGGESTION_DEDUP",
        `Suggestion seen ${keyCount} times — allowing stop (dedup). Key: ${key.slice(0, 60)}`
      )
    }
  }
}

async function main(): Promise<void> {
  void pruneOldSuggestionLogs() // Fire-and-forget cleanup

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

  terminate(
    "block",
    buildFinalMessage(response, refinementStatus ?? "", effective.critiquesEnabled ?? false)
  )
}

// Guard: only run main() when this file is the entry point, not when imported for testing.
if (import.meta.main) void main()
