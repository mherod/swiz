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

import { getSwizSettingsPath, readSwizSettings } from "../src/settings.ts"
import {
  denyPreToolUse,
  GIT_PUSH_RE,
  isShellTool,
  readSessionLines,
  type ToolHookInput,
} from "./hook-utils.ts"

// ── Feature flag: disabled by default ────────────────────────────────────────
// Enable with: swiz settings enable push-gate
//
// Fail-closed: if settings.json is present but cannot be parsed, the gate
// remains active (returns true). Silent bypass on parse errors would defeat
// the purpose of a security guardrail.
async function isPushGateEnabled(): Promise<boolean> {
  const path = getSwizSettingsPath()
  if (!path) return false

  // File absent → gate off (pushGate defaults to false)
  const file = Bun.file(path)
  if (!(await file.exists())) return false

  // File present — use strict parsing so malformed JSON throws instead of
  // silently returning defaults (which include pushGate: false).
  try {
    const settings = await readSwizSettings({ strict: true })
    return settings.pushGate === true
  } catch {
    // Parse failure on a present file → fail-closed: keep the gate active.
    return true
  }
}

const NO_PUSH_RE = /\bdo(?:n't| not)\s+push\b/i
const PUSH_APPROVAL_PATTERNS = [
  /\bgo ahead and push\b/i,
  /\bpush now\b/i,
  /^\/push(?:\s|$)/m,
  /\bplease push\b/i,
]

interface PushCheckResult {
  blockingLine: string
  approvedAfter: boolean
}

async function scanTranscriptForPushBlock(transcriptPath: string): Promise<PushCheckResult> {
  let blockingLine = ""
  let approvedAfter = false

  try {
    for (const line of await readSessionLines(transcriptPath)) {
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
          if (role === "user" && NO_PUSH_RE.test(txt)) {
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
            approvedAfter = true
          }
        }
      } catch {}
    }
  } catch {}

  return { blockingLine, approvedAfter }
}

async function main() {
  if (!(await isPushGateEnabled())) process.exit(0)

  const input: ToolHookInput = await Bun.stdin.json()
  if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

  const command: string = (input?.tool_input?.command as string) ?? ""
  if (!GIT_PUSH_RE.test(command)) process.exit(0)

  const transcriptPath: string = input?.transcript_path ?? ""
  if (!transcriptPath) process.exit(0)

  const { blockingLine, approvedAfter } = await scanTranscriptForPushBlock(transcriptPath)
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
}

if (import.meta.main) {
  void main()
}
