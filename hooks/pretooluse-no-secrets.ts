#!/usr/bin/env bun
/**
 * PreToolUse hook: Block Edit/Write/NotebookEdit operations when the proposed
 * new content contains likely secret material — API keys, tokens, private keys,
 * or generic credential assignments.
 *
 * Eager counterpart to stop-secret-scanner.ts, which only catches secrets in
 * committed diffs. This hook fires before the file mutation so that secrets
 * never land on disk at all.
 *
 * Detection logic mirrors stop-secret-scanner.ts to keep the two hooks aligned.
 * Test files are excluded (same exclusion policy as the stop hook).
 *
 * Dual-mode: exports a SwizFileEditHook for inline dispatch and remains
 * executable as a standalone script for backwards compatibility and testing.
 */

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizFileEditHook,
} from "../src/SwizHook.ts"
import { TEST_FILE_RE } from "../src/utils/git-utils.ts"
import type { FileEditHookInput } from "./schemas.ts"

// ── Secret patterns (mirrored from stop-secret-scanner.ts) ───────────────────

const PRIVATE_KEY_RE = /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/i

// Specific high-confidence token formats: AWS key IDs, GitHub tokens,
// Slack tokens, OpenAI/Stripe keys.
const TOKEN_RE =
  /AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|ghs_[a-zA-Z0-9]{36}|xox[baprs]-[0-9A-Za-z]{10,}|sk-[a-zA-Z0-9]{32,}|sk_live_[a-zA-Z0-9]{24,}|rk_live_[a-zA-Z0-9]{24,}/i

// Generic credential assignments: key/password fields with a quoted value (8+ chars).
// Requires a quoted value to avoid matching config keys without values.
const GENERIC_SECRET_RE =
  /(api_?key|api_?secret|auth_?token|access_?token|secret_?key|private_?key|password|passwd|client_?secret)\s*[:=]\s*["'][^"']{8,}["']/i

// Exclude common placeholder patterns that should not block legitimate edits.
const GENERIC_EXCLUDE_RE =
  /example|placeholder|your[_-]|<.*>|xxxx|test|fake|dummy|replace|env\.|not-needed/i

// ── Content scanning (exported for testing) ───────────────────────────────────

export interface SecretFinding {
  /** Truncated line that matched a secret pattern */
  line: string
  /** Which pattern category matched */
  kind: "private-key" | "token" | "generic-secret"
}

/**
 * Scan proposed file content for secret-like patterns.
 * Returns an array of findings (empty if clean).
 *
 * @param content - The new content or new_string being written
 * @param filePath - The target file path (used for test-file exclusion)
 */
export function scanContentForSecrets(content: string, filePath: string): SecretFinding[] {
  // Test files are excluded — they legitimately contain fake credentials in fixtures
  if (TEST_FILE_RE.test(filePath)) return []

  const findings: SecretFinding[] = []

  for (const line of content.split("\n")) {
    if (findings.length >= 10) break

    if (PRIVATE_KEY_RE.test(line)) {
      findings.push({ line: line.slice(0, 120), kind: "private-key" })
    } else if (TOKEN_RE.test(line)) {
      findings.push({ line: line.slice(0, 120), kind: "token" })
    } else if (GENERIC_SECRET_RE.test(line) && !GENERIC_EXCLUDE_RE.test(line)) {
      findings.push({ line: line.slice(0, 120), kind: "generic-secret" })
    }
  }

  return findings
}

// ── Hook implementation ─────────────────────────────────────────────────────

function evaluate(input: FileEditHookInput) {
  const filePath = input.tool_input?.file_path ?? ""
  // NFKC normalization handled by fileEditHookInputSchema.transform()
  const content = input.tool_input?.new_string ?? input.tool_input?.content ?? ""

  if (!content) return preToolUseAllow("")

  const findings = scanContentForSecrets(content, filePath)
  if (findings.length === 0) {
    return preToolUseAllow(`No secrets detected in ${filePath.split("/").pop()}`)
  }

  const lines = findings.map((f) => `  [${f.kind}] ${f.line}`).join("\n")

  return preToolUseDeny(
    [
      "Potential secret material detected in the proposed file content.",
      "",
      "Suspicious lines:",
      lines,
      "",
      "Do not write credentials, API keys, or tokens into source files.",
      "Use environment variables or a secrets manager instead:",
      "  - Reference values via process.env.MY_SECRET",
      "  - Load from .env files that are in .gitignore",
      "  - Use a vault, keychain, or CI secret store for actual values",
      "",
      "If these are legitimate test fixtures, move them to a test file (*.test.ts)",
      "or use recognisable placeholder values (e.g. 'dummy-key', 'example-token').",
    ].join("\n")
  )
}

const pretoolusNoSecrets: SwizFileEditHook = {
  name: "pretooluse-no-secrets",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  run(input) {
    return evaluate(input)
  },
}

export default pretoolusNoSecrets

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusNoSecrets)
