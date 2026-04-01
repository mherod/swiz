#!/usr/bin/env bun

// Stop hook: When uncommitted changes touch files matching user-data model patterns,
// suggest the /gdpr-analysis skill via additionalContext (non-blocking advisory).
// Conservative file-name heuristics to minimize false positives.
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { buildContextHookOutput, git, isGitRepo, skillAdvice } from "../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

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

export async function evaluateStopGdprDataModels(input: unknown): Promise<SwizHookOutput> {
  let data: StopHookInput
  try {
    data = stopHookInputSchema.parse(input)
  } catch {
    return {}
  }

  const cwd = data.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  const statusOutput = await git(["status", "--porcelain"], cwd)
  if (!statusOutput.trim()) return {}

  const changedFiles = statusOutput
    .trim()
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)

  const matchingFiles = changedFiles.filter(matchesDataModelPattern)
  if (matchingFiles.length === 0) return {}

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

  const context = `Uncommitted changes touch user-data model files:\n${fileList}${truncated}\n\n${advice}`

  return buildContextHookOutput("Stop", context)
}

const stopGdprDataModels: SwizStopHook = {
  name: "stop-gdpr-data-models",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopGdprDataModels(input)
  },
}

export default stopGdprDataModels

if (import.meta.main) {
  await runSwizHookAsMain(stopGdprDataModels)
}
