#!/usr/bin/env bun

// Stop hook: Block stop if secrets/credentials detected in recent commits
//
// Dual-mode: SwizStopHook for inline dispatch + subprocess via runSwizHookAsMain.

import type { SwizHookOutput, SwizStopHook } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"
import { blockStopObj, git, isGitRepo, TEST_FILE_RE } from "../src/utils/hook-utils.ts"
import { type StopHookInput, stopHookInputSchema } from "./schemas.ts"

const PRIVATE_KEY_RE = /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/i
const TOKEN_RE =
  /AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|ghs_[a-zA-Z0-9]{36}|xox[baprs]-[0-9A-Za-z]{10,}|sk-[a-zA-Z0-9]{32,}|sk_live_[a-zA-Z0-9]{24,}|rk_live_[a-zA-Z0-9]{24,}/i
const GENERIC_SECRET_RE =
  /(api_?key|api_?secret|auth_?token|access_?token|secret_?key|private_?key|password|passwd|client_?secret)\s*[:=]\s*["'][^"']{8,}["']/i
const GENERIC_EXCLUDE_RE =
  /example|placeholder|your[_-]|<.*>|xxxx|test|fake|dummy|not-needed|replace|env\./i

function isSecretLine(line: string): boolean {
  if (PRIVATE_KEY_RE.test(line)) return true
  if (TOKEN_RE.test(line)) return true
  if (GENERIC_SECRET_RE.test(line) && !GENERIC_EXCLUDE_RE.test(line)) return true
  return false
}

function scanDiffForSecrets(diff: string, limit = 10): string[] {
  const findings: string[] = []
  let currentFile = ""
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6)
      continue
    }
    if (TEST_FILE_RE.test(currentFile)) continue
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    if (isSecretLine(line)) findings.push(line.slice(0, 120))
    if (findings.length >= limit) break
  }
  return findings
}

async function findSecretFindings(cwd: string): Promise<string[]> {
  const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
  const base = (await git(["rev-parse", "--verify", "HEAD~10"], cwd)) || GIT_EMPTY_TREE
  const diff = await git(["diff", `${base}..HEAD`], cwd)
  if (!diff) return []
  return scanDiffForSecrets(diff)
}

function formatSecretReason(findings: string[]): string {
  let reason = "Potential secrets detected in recent commits.\n\n"
  reason += "Suspicious lines:\n"
  for (const f of findings) reason += `  ${f}\n`
  reason +=
    "\nReview and remove secrets before stopping. If these are false positives, use a recognised placeholder value instead of a hardcoded string:\n"
  reason += '  • Not applicable:  api_key = "not-needed"\n'
  reason += '  • Placeholder:     api_key = "your_api_key_here"\n'
  reason += '  • Template token:  api_key = "<YOUR_API_KEY>"\n'
  reason += "  • Env variable:    api_key = process.env.API_KEY"
  return reason
}

export async function evaluateStopSecretScanner(input: StopHookInput): Promise<SwizHookOutput> {
  const parsed = stopHookInputSchema.parse(input)
  const cwd = parsed.cwd ?? process.cwd()

  if (!(await isGitRepo(cwd))) return {}

  const findings = await findSecretFindings(cwd)
  if (findings.length === 0) return {}

  return blockStopObj(formatSecretReason(findings))
}

const stopSecretScanner: SwizStopHook = {
  name: "stop-secret-scanner",
  event: "stop",
  timeout: 10,

  run(input) {
    return evaluateStopSecretScanner(input)
  },
}

export default stopSecretScanner

if (import.meta.main) {
  await runSwizHookAsMain(stopSecretScanner)
}
