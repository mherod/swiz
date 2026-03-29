#!/usr/bin/env bun

// PreToolUse hook: require developing, reviewing, or addressing-feedback state
// before editing .ts / .tsx files. Planning is for triage and design — not TS edits.

import type { ProjectState } from "../src/settings"
import { readProjectState } from "../src/settings.ts"
import { denyPreToolUse, isCodeChangeTool } from "../src/utils/hook-utils.ts"
import { type FileEditHookInput, fileEditHookInputSchema } from "./schemas.ts"

const ALLOWED_STATES = new Set<ProjectState>(["developing", "reviewing", "addressing-feedback"])

function isTsOrTsxPath(raw: string): boolean {
  const p = raw.normalize("NFKC").replace(/\\/g, "/")
  return /\.(tsx|ts)$/i.test(p)
}

function resolveTsEditPath(input: FileEditHookInput): string | null {
  if (!isCodeChangeTool(input.tool_name ?? "")) return null
  const toolInput = input.tool_input as Record<string, unknown> | undefined
  const filePath = String(toolInput?.file_path ?? toolInput?.path ?? "")
  return filePath && isTsOrTsxPath(filePath) ? filePath : null
}

async function main(): Promise<void> {
  const input = fileEditHookInputSchema.parse(await Bun.stdin.json())
  if (!resolveTsEditPath(input)) return

  const state = await readProjectState(input.cwd ?? process.cwd())
  if (!state || ALLOWED_STATES.has(state)) return

  denyPreToolUse(
    `Editing TypeScript sources requires project state \`developing\`, \`reviewing\`, or \`addressing-feedback\`.\n\n` +
      `Current state: "${state}".\n\n` +
      `Transition with \`swiz state set developing\` (or another allowed state) before editing \`.ts\` / \`.tsx\` files.`
  )
}

if (import.meta.main) await main()
