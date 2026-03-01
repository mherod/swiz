#!/usr/bin/env bun
// PreToolUse hook: Block `git push` when the current transcript contains an
// explicit "do not push" instruction (e.g. from a skill or user message).
//
// Skills such as /commit include "DO NOT push to remote without approval" in
// their content. This hook detects those instructions and hard-blocks the push
// so the agent cannot accidentally override them.

import { denyPreToolUse, GIT_PUSH_RE, isShellTool, type ToolHookInput } from "./hook-utils.ts"

const input: ToolHookInput = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = (input?.tool_input?.command as string) ?? ""
if (!GIT_PUSH_RE.test(command)) process.exit(0)

const transcriptPath: string = input?.transcript_path ?? ""
if (!transcriptPath) process.exit(0)

// ── Scan all text blocks in the transcript ────────────────────────────────────
// "Do not push" instructions come from skills (loaded as user text blocks) or
// from the user directly. We scan both user and assistant text content.

// Matches "do not push", "don't push", "DO NOT push" etc.
const NO_PUSH_RE = /\bdo(?:n't| not)\s+push\b/i

let matchedLine = ""

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
        if (NO_PUSH_RE.test(txt)) {
          // Capture the first matching line for the block message
          const hit =
            txt
              .split("\n")
              .find((l) => NO_PUSH_RE.test(l))
              ?.trim() ?? ""
          matchedLine = hit
          break
        }
      }
      if (matchedLine) break
    } catch {}
  }
} catch {}

if (!matchedLine) process.exit(0)

denyPreToolUse(
  `BLOCKED: git push is prohibited by an explicit instruction in this session.\n\n` +
    `Instruction found in transcript:\n` +
    `  "${matchedLine}"\n\n` +
    `The /commit skill and other workflows include "DO NOT push" directives that must\n` +
    `be respected. Pushing without explicit approval after seeing that instruction is\n` +
    `a procedural violation.\n\n` +
    `To push, you must receive explicit user approval first (e.g. the user invokes\n` +
    `/push or says "go ahead and push"). Do not attempt to rationalise around this.`
)
