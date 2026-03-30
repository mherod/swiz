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
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import type { ToolHookInput } from "./schemas.ts"

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

const CONVERSATION_ROLES = new Set(["user", "assistant"])

function isTextBlock(block: unknown): string | null {
  const b = block as Record<string, unknown>
  return b?.type === "text" && typeof b?.text === "string" ? String(b.text) : null
}

function extractTextBlocks(entry: Record<string, unknown>): Array<{ role: string; text: string }> {
  const role: string = (entry?.type as string) ?? ""
  if (!CONVERSATION_ROLES.has(role)) return []
  const content = (entry as { message?: { content?: unknown[] } })?.message?.content
  if (!Array.isArray(content)) return []
  const results: Array<{ role: string; text: string }> = []
  for (const block of content) {
    const text = isTextBlock(block)
    if (text) {
      results.push({ role, text })
    }
  }
  return results
}

function extractBlockingSnippet(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => NO_PUSH_RE.test(l))
      ?.trim() ?? text.slice(0, 120)
  )
}

function processTranscriptEntry(entry: Record<string, unknown>, state: PushCheckResult): void {
  for (const { role, text } of extractTextBlocks(entry)) {
    if (role !== "user") continue
    if (NO_PUSH_RE.test(text)) {
      state.blockingLine = extractBlockingSnippet(text)
      state.approvedAfter = false
    } else if (state.blockingLine && PUSH_APPROVAL_PATTERNS.some((re) => re.test(text))) {
      state.approvedAfter = true
    }
  }
}

const pretoolusNoPushWhenInstructed: SwizHook<ToolHookInput> = {
  name: "pretooluse-no-push-when-instructed",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 5,

  async run(input: ToolHookInput): Promise<SwizHookOutput> {
    // ── Feature flag check ────────────────────────────────────────────────────
    // Prefer dispatcher-injected settings (fast path). Fall back to disk read
    // with fail-closed behaviour: malformed settings.json keeps the gate active.
    const injected = (input as Record<string, unknown>)._effectiveSettings as
      | Record<string, unknown>
      | undefined
    let pushGateEnabled: boolean
    if (injected && typeof injected.pushGate !== "undefined") {
      pushGateEnabled = injected.pushGate === true
    } else {
      const { getSwizSettingsPath, readSwizSettings } = await import("../src/settings.ts")
      const path = getSwizSettingsPath()
      if (!path) return preToolUseAllow("")
      const file = Bun.file(path)
      if (!(await file.exists())) return preToolUseAllow("")
      try {
        const settings = await readSwizSettings({ strict: true })
        pushGateEnabled = settings.pushGate === true
      } catch {
        // Parse failure on a present file → fail-closed: keep the gate active.
        pushGateEnabled = true
      }
    }
    if (!pushGateEnabled) return preToolUseAllow("")

    // ── Push command check ────────────────────────────────────────────────────
    const { isShellTool, GIT_PUSH_RE, readSessionLines } = await import(
      "../src/utils/hook-utils.ts"
    )
    if (!isShellTool(input?.tool_name ?? "")) return preToolUseAllow("")
    const command: string = (input?.tool_input?.command as string) ?? ""
    if (!GIT_PUSH_RE.test(command)) return preToolUseAllow("")

    // ── Transcript scan ───────────────────────────────────────────────────────
    const transcriptPath: string = input?.transcript_path ?? ""
    if (!transcriptPath) return preToolUseAllow("")

    const state: PushCheckResult = { blockingLine: "", approvedAfter: false }
    try {
      for (const line of await readSessionLines(transcriptPath)) {
        if (!line.trim()) continue
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        processTranscriptEntry(entry, state)
      }
    } catch {}

    if (!state.blockingLine) return preToolUseAllow("No 'do not push' instruction found")
    if (state.approvedAfter) return preToolUseAllow("Push approved by user after instruction")

    return preToolUseDeny(
      `BLOCKED: git push is prohibited by an explicit instruction in this session.\n\n` +
        `Instruction found in transcript:\n` +
        `  "${state.blockingLine}"\n\n` +
        `The /commit skill and other workflows include "DO NOT push" directives that must\n` +
        `be respected. Pushing without explicit approval after seeing that instruction is\n` +
        `a procedural violation.\n\n` +
        `To push, you must receive explicit user approval first (e.g. the user invokes\n` +
        `/push or says "go ahead and push"). Do not attempt to rationalise around this.`
    )
  },
}

export default pretoolusNoPushWhenInstructed

if (import.meta.main) {
  await runSwizHookAsMain(pretoolusNoPushWhenInstructed)
}
