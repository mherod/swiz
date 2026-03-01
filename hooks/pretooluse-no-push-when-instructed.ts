#!/usr/bin/env bun
// PreToolUse hook: Block `git push` when the current transcript contains an
// explicit "do not push" instruction (e.g. from a skill or user message)
// without a subsequent explicit push-approval signal.
//
// Skills such as /commit include "DO NOT push to remote without approval" in
// their content. This hook detects those instructions and hard-blocks the push
// unless approval appears AFTER the blocking instruction in the transcript.
//
// Approval signals (must appear AFTER the "do not push" instruction):
//   - An explicit USER message ("go ahead and push", "/push", "push now", etc.)
//
// Both blocking and approval are restricted to user-role entries. This prevents
// the agent's own reasoning from self-approving a push it was told not to do.
//
// NOT accepted as approval (all machine-generated):
//   - Stop-hook action plans ("Push N commit(s) to") — system messages
//   - Skill content (e.g. /push skill header) — auto-loaded by the agent
//   - Assistant reasoning ("I'll go ahead and push") — agent-generated text

import { denyPreToolUse, GIT_PUSH_RE, isShellTool, type ToolHookInput } from "./hook-utils.ts"

const input: ToolHookInput = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = (input?.tool_input?.command as string) ?? ""
if (!GIT_PUSH_RE.test(command)) process.exit(0)

const transcriptPath: string = input?.transcript_path ?? ""
if (!transcriptPath) process.exit(0)

// ── Pattern definitions ───────────────────────────────────────────────────────

// Instruction to block on
const NO_PUSH_RE = /\bdo(?:n't| not)\s+push\b/i

// Approval signals — any of these appearing AFTER the blocking instruction
// count as explicit authorisation to push.
//
// IMPORTANT: Skill content (e.g. the /push skill header "Get committed changes
// pushed to remote") must NOT appear here. Skill content loads into the
// transcript whenever the agent invokes a skill — that is not the same as the
// user explicitly authorising a push. Only phrases that require deliberate
// human typing or a system stop-hook action plan are accepted.
const PUSH_APPROVAL_PATTERNS = [
  // Explicit user approval phrases that cannot be produced by skill loading
  // or system-generated stop-hook action plans.
  /\bgo ahead and push\b/i,
  /\bpush now\b/i,
  // /push on its own line (user typed the skill invocation directly) —
  // require whitespace or end-of-line so "/push-something" paths don't match.
  /^\/push(?:\s|$)/m,
  /\bplease push\b/i,
]

// ── Single ordered pass through transcript ────────────────────────────────────
// Track the last "do not push" instruction and whether approval follows it.

let blockingLine = "" // text of the most-recent blocking instruction
let approvedAfter = false // true if an approval signal appears after the block

try {
  const text = await Bun.file(transcriptPath).text()
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      const role: string = entry?.type ?? ""
      if (role !== "user" && role !== "assistant") continue
      const content = entry?.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block?.type !== "text") continue
        const txt: string = block?.text ?? ""

        // Only treat user-role text as a potential "do not push" directive.
        // Assistant text (the agent's own reasoning) must never trigger a block.
        if (role === "user" && NO_PUSH_RE.test(txt)) {
          // Found a blocking instruction — record it and reset approval flag
          blockingLine =
            txt
              .split("\n")
              .find((l) => NO_PUSH_RE.test(l))
              ?.trim() ?? txt.slice(0, 120)
          approvedAfter = false
        } else if (
          role === "user" &&
          blockingLine &&
          PUSH_APPROVAL_PATTERNS.some((re) => re.test(txt))
        ) {
          // Approval appeared after the blocking instruction — user role only.
          // Assistant text (agent reasoning) must never self-approve a push.
          approvedAfter = true
        }
      }
    } catch {}
  }
} catch {}

// No blocking instruction found, or it was superseded by explicit approval
if (!blockingLine || approvedAfter) process.exit(0)

denyPreToolUse(
  `BLOCKED: git push is prohibited by an explicit instruction in this session.\n\n` +
    `Instruction found in transcript:\n` +
    `  "${blockingLine}"\n\n` +
    `The /commit skill and other workflows include "DO NOT push" directives that must\n` +
    `be respected. Pushing without explicit approval after seeing that instruction is\n` +
    `a procedural violation.\n\n` +
    `To push, you must receive explicit user approval first (e.g. the user invokes\n` +
    `/push or says "go ahead and push"). Do not attempt to rationalise around this.`
)
