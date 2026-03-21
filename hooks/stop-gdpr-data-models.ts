#!/usr/bin/env bun

// Stop hook: When uncommitted changes touch files matching user-data model patterns,
// suggest the /gdpr-analysis skill via additionalContext (non-blocking advisory).
// Conservative file-name heuristics to minimize false positives.

import { stopHookInputSchema } from "./schemas.ts"
import { emitContext, git, isGitRepo, skillAdvice } from "./utils/hook-utils.ts"

// File-path patterns that suggest user/personal data model changes.
// Intentionally narrow to avoid false positives — matches model/schema files
// with PII-related names, not general application files.
const DATA_MODEL_PATTERNS = [
  /\b(?:models?|schemas?|entities|types)\/.*(?:user|account|profile|person|customer|member)\b/i,
  /\b(?:user|account|profile|person|customer|member)[-.]?(?:model|schema|entity|type)\b/i,
  /\bpii\b/i,
  /\bgdpr\b/i,
  /\bpersonal[-_]?data\b/i,
  /\bdata[-_]?subject\b/i,
  /\bconsent[-_]?(?:model|schema|record)\b/i,
  /\bdata[-_]?retention\b/i,
  /\berasure\b/i,
  /\b(?:models?|schemas?|migrations?)\/.*(?:email|phone|address|dob|birth|ssn|national[-_]?id)\b/i,
]

function matchesDataModelPattern(filePath: string): boolean {
  return DATA_MODEL_PATTERNS.some((re) => re.test(filePath))
}

async function main(): Promise<void> {
  const raw = await Bun.stdin.json().catch(() => null)
  if (!raw) return

  const input = stopHookInputSchema.safeParse(raw)
  if (!input.success) return

  const cwd = input.data.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return

  // Check uncommitted changes (staged + unstaged)
  const statusOutput = await git(["status", "--porcelain"], cwd)
  if (!statusOutput.trim()) return

  const changedFiles = statusOutput
    .trim()
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)

  const matchingFiles = changedFiles.filter(matchesDataModelPattern)
  if (matchingFiles.length === 0) return

  const fileList = matchingFiles
    .slice(0, 10)
    .map((f) => `  - ${f}`)
    .join("\n")
  const truncated = matchingFiles.length > 10 ? `\n  ... and ${matchingFiles.length - 10} more` : ""

  const advice = skillAdvice(
    "gdpr-analysis",
    `Use the /gdpr-analysis skill to audit these changes for GDPR compliance (PII mapping, DSAR readiness, right-to-erasure, consent management).`,
    `Consider reviewing these changes for data privacy implications:\n  - PII exposure and storage patterns\n  - Data subject access request (DSAR) readiness\n  - Right-to-erasure completeness\n  - Consent management`
  )

  // Non-blocking: emit as additionalContext via emitContext helper
  const context = `Uncommitted changes touch user-data model files:\n${fileList}${truncated}\n\n${advice}`

  await emitContext("Stop", context, cwd)
}

if (import.meta.main) void main()
