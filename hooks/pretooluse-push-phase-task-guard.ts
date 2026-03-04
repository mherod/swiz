#!/usr/bin/env bun
// PreToolUse hook: Block TaskUpdate/TaskList during the push-CI verification phase.
//
// After `git push` succeeds, the agent should not touch task tools until CI is
// verified with `gh run view --json` showing conclusion. This enforces the
// "no TaskUpdate/TaskList at steps 7-10" rule from the Standard Work Sequence.

import {
  computeTranscriptSummary,
  denyPreToolUse as deny,
  getTranscriptSummary,
} from "./hook-utils.ts"

const GIT_PUSH_RE = /\bgit\s+push\b/
const GH_RUN_VIEW_CONCLUSION_RE = /\bgh\s+run\s+view\b.*\b(?:conclusion|--json)\b/

const input: Record<string, unknown> = await Bun.stdin.json()
const transcriptPath = input?.transcript_path as string | undefined

// Get transcript summary — prefer pre-parsed, fall back to computing
let summary = getTranscriptSummary(input)
if (!summary && transcriptPath) {
  summary = await computeTranscriptSummary(transcriptPath)
}
if (!summary) process.exit(0)

// Only relevant if the session has had a git push
if (!summary.hasGitPush) process.exit(0)

// Find the index of the last `git push` command and check if any
// `gh run view` with conclusion follows it
const cmds = summary.bashCommands
let lastPushIdx = -1
for (let i = cmds.length - 1; i >= 0; i--) {
  if (GIT_PUSH_RE.test(cmds[i]!)) {
    lastPushIdx = i
    break
  }
}

if (lastPushIdx === -1) process.exit(0)

// Check if any gh run view with conclusion check appears after the push
let hasPostPushCiVerification = false
for (let i = lastPushIdx + 1; i < cmds.length; i++) {
  if (GH_RUN_VIEW_CONCLUSION_RE.test(cmds[i]!)) {
    hasPostPushCiVerification = true
    break
  }
}

// If CI is already verified after the last push, allow task tools
if (hasPostPushCiVerification) process.exit(0)

// We're in push-CI phase — block TaskUpdate/TaskList
deny(
  "PUSH-CI PHASE: TaskUpdate and TaskList are blocked during steps 7-10.\n\n" +
    "A `git push` was detected but CI verification has not completed yet.\n" +
    "Complete the push-CI verification sequence first:\n\n" +
    "  1. gh run list --commit $SHA --json databaseId --jq '.[0].databaseId'\n" +
    "  2. gh run watch <run-id> --exit-status\n" +
    "  3. gh run view <run-id> --json conclusion,status,jobs\n" +
    "  4. Verify conclusion === 'success'\n\n" +
    "Only after CI verification completes should you update or list tasks.\n" +
    "This ensures task status reflects verified reality, not assumptions."
)
