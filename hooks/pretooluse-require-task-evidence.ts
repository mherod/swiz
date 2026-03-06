#!/usr/bin/env bun
// PreToolUse hook: Require structured evidence when completing a task via TaskUpdate.
// Plain `TaskUpdate { status: "completed" }` leaves no machine-readable verification
// record, causing stop hooks to fire repeatedly.  This hook requires >=1 distinct
// evidence field in the description before allowing completion.

import { denyPreToolUse } from "./hook-utils.ts"

// Evidence patterns — each entry is a named family with a regex.
// Any 1+ distinct families must match for the call to proceed.
const EVIDENCE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "note", re: /note:\s*\S.{4,}/i },
  { name: "conclusion", re: /conclusion:\s*\S+/i },
  { name: "run", re: /\brun\s+\d{3,}/i },
  { name: "commit", re: /\b[0-9a-f]{7,40}\b/ },
  { name: "ci_green", re: /\bci\s+green\b/i },
  { name: "pr", re: /\bpr[:#]\s*\d+/i },
  { name: "no_ci", re: /no\s+ci.*(workflow|run|configured)/i },
]

const REQUIRED = 1

const input = await Bun.stdin.json()
const toolInput: Record<string, unknown> = input?.tool_input ?? {}

// Only enforce on completion updates.
if (toolInput.status !== "completed") process.exit(0)

const description: string = typeof toolInput.description === "string" ? toolInput.description : ""

const matched = EVIDENCE_PATTERNS.filter(({ re }) => re.test(description)).map(({ name }) => name)

if (matched.length >= REQUIRED) process.exit(0)

const foundList = matched.length > 0 ? matched.join(", ") : "none"
const reason =
  `TaskUpdate status=completed requires at least ${REQUIRED} structured evidence field in \`description\`, ` +
  `but found ${matched.length} (${foundList}).\n\n` +
  `Evidence fields (any ${REQUIRED}+ required):\n` +
  EVIDENCE_PATTERNS.map(({ name }) => `  • ${name}`).join("\n") +
  `\n\nUse \`swiz tasks complete <id> --evidence "note:CI green"\` ` +
  `instead of a plain TaskUpdate.`

denyPreToolUse(reason, { includeReassessmentAdvice: false })
