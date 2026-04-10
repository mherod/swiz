#!/usr/bin/env bun

// PreToolUse hook: require developing, reviewing, or addressing-feedback state
// before editing .ts / .tsx files. Planning is for triage and design — not TS edits.
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { runSwizHookAsMain, type SwizHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { FileEditHookInput } from "../src/schemas.ts"
import type { ProjectState } from "../src/settings"
import { isCodeChangeTool } from "../src/tool-matchers.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"

const ALLOWED_STATES = new Set<ProjectState>(["developing", "reviewing", "addressing-feedback"])

function isTsOrTsxPath(raw: string): boolean {
  const p = raw.normalize("NFKC").replace(/\\/g, "/")
  return /\.(tsx|ts)$/i.test(p)
}

function resolveTsEditPath(input: FileEditHookInput): string | null {
  if (!isCodeChangeTool(input.tool_name ?? "")) return null
  const toolInput = input.tool_input as Record<string, any> | undefined
  const filePath = String(toolInput?.file_path ?? toolInput?.path ?? "")
  return filePath && isTsOrTsxPath(filePath) ? filePath : null
}

function checkState(
  input: FileEditHookInput & { _projectState?: ProjectState | null }
): SwizHookOutput | null {
  if (!resolveTsEditPath(input)) return null

  const state = input._projectState ?? null
  if (!state || ALLOWED_STATES.has(state)) return null

  return preToolUseDeny(
    `Editing TypeScript sources requires project state \`developing\`, \`reviewing\`, or \`addressing-feedback\`.\n\n` +
      `Current state: "${state}".\n\n` +
      `Transition with \`swiz state set developing\` (or another allowed state) before editing \`.ts\` / \`.tsx\` files.`
  )
}

const pretooluseTsEditStateGate: SwizHook<FileEditHookInput> = {
  name: "pretooluse-ts-edit-state-gate",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  run(rawInput) {
    const input = rawInput as FileEditHookInput & { _projectState?: ProjectState | null }
    return checkState(input) ?? preToolUseAllow("")
  },
}

export default pretooluseTsEditStateGate

// ─── Standalone execution ────────────────────────────────────────────────────
if (import.meta.main) {
  // In standalone mode, read project state from disk via settings.ts.
  const { readProjectState } = await import("../src/settings.ts")
  const standaloneHook: SwizHook<FileEditHookInput> = {
    ...pretooluseTsEditStateGate,
    async run(rawInput) {
      const input = rawInput as FileEditHookInput
      if (!resolveTsEditPath(input)) return preToolUseAllow("")
      const state = await readProjectState(input.cwd ?? process.cwd())
      const augmented = { ...input, _projectState: state }
      return checkState(augmented) ?? preToolUseAllow("")
    },
  }
  await runSwizHookAsMain(standaloneHook)
}
