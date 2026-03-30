// Shared logic for compound task subject detection and splitting.

import { TASK_TOOLS } from "../tool-matchers.ts"
import { isPlaceholderSubject } from "../utils/inline-hook-helpers.ts"

export interface CompoundResult {
  matched: false
}

export interface CompoundMatch {
  matched: true
  intro: string
  suggestions: string[]
  /** True when the task appears to test items that likely have matching implementation tasks. */
  pairing?: boolean
}

export type DetectionResult = CompoundResult | CompoundMatch

/** Extract the leading verb from a subject, e.g. "Fix" from "Fix A and B". */
function extractVerb(s: string): string | null {
  const m = s.match(/^([A-Z][a-z]*)(?:\s|$)/)
  return m ? (m[1] ?? null) : null
}

// Primary imperative verbs that signal independent deliverable tasks.
// Excludes run/verify/check/test — those are often sub-steps, not separate tasks.
const ACTION_VERBS =
  /^(add|fix|update|remove|delete|create|refactor|migrate|implement|improve|rename|move|extract|replace|rewrite|enable|disable|configure|set up|clean up|write|deploy|build|generate|publish|merge|revert|bump|review|approve|reject|audit|profile|optimize|benchmark|document|analyse|analyze)\b/i

/** Prepend verb to each part if not already present. */
function withVerb(verb: string | null, parts: string[]): string[] {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      if (!verb) return capitalize(p)
      // Don't prepend if part already starts with the same verb or any action verb
      if (new RegExp(`^${verb}\\b`, "i").test(p)) return p
      if (ACTION_VERBS.test(p)) return capitalize(p)
      return `${verb} ${p.trim()}`
    })
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Check if subject indicates this is a test-focused task. */
function isTestTask(bare: string): boolean {
  // Match patterns like "tests for X", "test cases for X", "test coverage for X"
  return /\b(tests?|test cases?|test coverage|test fixtures?|test suites?|test scenarios?)\b/i.test(
    bare
  )
}

function detectPlaceholder(s: string): CompoundMatch | null {
  if (!isPlaceholderSubject(s)) return null
  return {
    matched: true,
    intro:
      "Auto-generated placeholder subjects have no real work content. Use a specific, actionable subject describing what you are actually doing. Examples:",
    suggestions: [
      "Verify CI for last pushed commit",
      "Continue work on open GitHub issue",
      "Run quality checks before pushing",
    ],
  }
}

/** Sorted longest-first so "TaskCreate" matches before "Task". */
const TASK_TOOL_NAMES = [...TASK_TOOLS].sort((a, b) => b.length - a.length)

function detectTaskToolName(s: string): CompoundMatch | null {
  for (const tool of TASK_TOOL_NAMES) {
    if (new RegExp(`\\b${tool}\\b`).test(s)) {
      return {
        matched: true,
        intro: `Task subjects must describe the work, not the tool call. Remove "${tool}" and describe what you are actually doing. Examples:`,
        suggestions: [
          "Fix authentication bug in login flow",
          "Add pagination to search results",
          "Refactor database connection pooling",
        ],
      }
    }
  }
  return null
}

/**
 * Matches subjects that describe task-management mechanics rather than real work.
 * e.g. "Ensure a task is in progress", "Create a pending task before running bash".
 */
const COMPLIANCE_GAMING_RE =
  /\b(ensure|maintain|keep|satisfy|create|have)\b.*\b(task|tasks)\b.*\b(in.progress|pending|exist|before|requirement|hook|gate|block)/i

function detectComplianceGaming(s: string): CompoundMatch | null {
  if (!COMPLIANCE_GAMING_RE.test(s)) return null
  return {
    matched: true,
    intro:
      "Task subjects must describe real work, not task-management mechanics. Describe what you are actually doing. Examples:",
    suggestions: [
      "Fix authentication bug in login flow",
      "Add pagination to search results",
      "Refactor database connection pooling",
    ],
  }
}

function detectMultipleIssues(s: string, verb: string | null): CompoundMatch | null {
  const hashes = s.match(/#\d+/g) ?? []
  if (hashes.length < 2) return null
  const suggestions = hashes.map((h: string) => (verb ? `${verb} ${h}` : h))
  return {
    matched: true,
    intro: "Tasks relating to different issues should be tracked separately. Suggested split:",
    suggestions,
  }
}

function countSuffixTokens(firstTokens: string[], maxSuffixLen: number): number {
  let count = 0
  for (let i = firstTokens.length - 1; i >= 0; i--) {
    const candidate = firstTokens.slice(i).join(" ")
    if (candidate.length <= maxSuffixLen) {
      count = firstTokens.length - i
    } else {
      break
    }
  }
  return count
}

function detectSuffixExpansion(
  parts: string[],
  bare: string,
  verb: string | null
): CompoundMatch | null {
  const trailingAreSuffixes = parts
    .slice(1)
    .every((p) => p.trim().length <= 20 && !ACTION_VERBS.test(p.trim()))
  if (!trailingAreSuffixes || parts.length < 2) return null

  const firstPart = (parts[0] ?? "").trim()
  const firstTokens = firstPart.split(/\s+/)
  const maxSuffixLen = Math.max(...parts.slice(1).map((p) => p.trim().length))

  const suffixTokens = countSuffixTokens(firstTokens, maxSuffixLen)
  if (suffixTokens === 0) return null

  const stemTokens = firstTokens.slice(0, firstTokens.length - suffixTokens)
  const stemBare = stemTokens.join(" ").trim()
  if (!stemBare) return null

  const prefix = verb ? `${verb} ` : ""
  const suggestions = parts.map((p, i) =>
    i === 0
      ? capitalize(`${prefix}${firstPart}`.trim())
      : capitalize(`${prefix}${stemBare} ${p.trim()}`.trim())
  )

  const pairing = isTestTask(bare)
  const intro = pairing
    ? "This test task covers multiple items. If implementation tasks already exist for each item, update them to include tests rather than creating separate test tasks. Suggested test task names:"
    : "This is a compound task. Suggested split:"

  return { matched: true, intro, suggestions, ...(pairing ? { pairing: true } : {}) }
}

function detectSharedObject(parts: string[]): CompoundMatch | null {
  const lastPart = (parts[parts.length - 1] ?? "").trim()
  const lastVerbMatch = lastPart.match(ACTION_VERBS)
  if (!lastVerbMatch) return null

  const lastVerb = lastVerbMatch[0]
  const sharedObject = lastPart.slice(lastVerb.length).trim()
  if (!sharedObject) return null

  const leadingAreBareVerbs = parts
    .slice(0, -1)
    .every((p) => ACTION_VERBS.test(p.trim()) && p.trim().split(/\s+/).length <= 2)
  if (!leadingAreBareVerbs) return null

  const suggestions = parts.map((p) => {
    const t = p.trim()
    const v = t.match(ACTION_VERBS)?.[0] ?? t
    const own = t.slice(v.length).trim()
    return capitalize(`${v} ${own || sharedObject}`.trim())
  })
  return { matched: true, intro: "This is a compound task. Suggested split:", suggestions }
}

function detectCommaList(s: string, bare: string, verb: string | null): CompoundMatch | null {
  if ((s.match(/,/g) ?? []).length < 2) return null

  const normalized = bare.replace(/,?\s+and\s+/i, ", ").replace(/,\s*$/, "")
  const parts = normalized.split(/,\s*/)

  const suffixResult = detectSuffixExpansion(parts, bare, verb)
  if (suffixResult) return suffixResult

  const sharedResult = detectSharedObject(parts)
  if (sharedResult) return sharedResult

  return {
    matched: true,
    intro: "This is a compound task. Suggested split:",
    suggestions: withVerb(verb, parts),
  }
}

function detectAndConjunction(bare: string, verb: string | null): CompoundMatch | null {
  if (!/ and /i.test(bare)) return null
  const parts = bare.split(/ and /i)
  const trailingPartsAreActions = parts.slice(1).every((p) => ACTION_VERBS.test(p.trim()))
  if (!trailingPartsAreActions) return null
  return {
    matched: true,
    intro: "This is a compound task. Suggested split:",
    suggestions: withVerb(verb, parts),
  }
}

export function detect(s: string): DetectionResult {
  const placeholder = detectPlaceholder(s)
  if (placeholder) return placeholder

  const verb = extractVerb(s)
  const bare = verb ? s.slice(verb.length).trim() : s

  const taskTool = detectTaskToolName(s)
  if (taskTool) return taskTool

  const gaming = detectComplianceGaming(s)
  if (gaming) return gaming

  const issues = detectMultipleIssues(s, verb)
  if (issues) return issues

  const commaResult = detectCommaList(s, bare, verb)
  if (commaResult) return commaResult

  const andResult = detectAndConjunction(bare, verb)
  if (andResult) return andResult

  return { matched: false }
}

export function formatMessage(result: CompoundMatch, postfix?: string): string {
  const lines = [result.intro, ...result.suggestions.map((s) => `  • ${s}`)]
  if (postfix) lines.push(postfix)
  return lines.join("\n")
}
