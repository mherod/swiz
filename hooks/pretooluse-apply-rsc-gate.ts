#!/usr/bin/env bun

// PreToolUse hook: require /apply-rsc skill before editing Next.js RSC page/layout files.
//
// Gates edits to files matching:
//   **/app/**/page.tsx          — Next.js App Router page components
//   **/layout.tsx               — any layout component
//   **/app/**/error.tsx         — App Router error boundaries (Client Components)
//   **/app/**/loading.tsx       — App Router loading/Suspense boundaries
//   **/app/**/*-client.tsx      — colocated Client Component files under app/
//
// When the apply-rsc skill is not installed on this machine, the gate is skipped
// (fail-open). When the skill has been invoked recently in the current session,
// the edit proceeds. Otherwise the hook blocks with an actionable message.
//
// Dual-mode: exports a SwizFileEditHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { GATE_REQUIRED_SKILLS } from "../src/gate-required-skills.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizFileEditHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import type { FileEditHookInput } from "../src/schemas.ts"
import {
  formatSkillReferenceForAgent,
  getRecentlyInvokedSkillsForCurrentSession,
  resolveSkillRecencyOptions,
  skillExistsForHookPayload,
} from "../src/skill-utils.ts"

const SKILL_NAME = GATE_REQUIRED_SKILLS.applyRsc.name

// Matches **/app/**/page.tsx (Next.js App Router pages), **/layout.tsx (any
// layout file), **/app/**/error.tsx and **/app/**/loading.tsx (App Router error
// and loading boundaries, at root or nested), and **/app/**/*-client.tsx
// (colocated Client Component files).
const RSC_PAGE_RE = /(?:^|[/\\])app[/\\].+[/\\]page\.tsx$/
const LAYOUT_RE = /(?:^|[/\\])layout\.tsx$/
const APP_ERROR_RE = /(?:^|[/\\])app[/\\](?:.+[/\\])?error\.tsx$/
const APP_LOADING_RE = /(?:^|[/\\])app[/\\](?:.+[/\\])?loading\.tsx$/
const APP_CLIENT_RE = /(?:^|[/\\])app[/\\].+-client\.tsx$/

export function isRscGatedFile(filePath: string): boolean {
  return (
    RSC_PAGE_RE.test(filePath) ||
    LAYOUT_RE.test(filePath) ||
    APP_ERROR_RE.test(filePath) ||
    APP_LOADING_RE.test(filePath) ||
    APP_CLIENT_RE.test(filePath)
  )
}

function formatInvokedSkills(skills: string[]): string {
  return skills.length === 0 ? "(none)" : skills.map((skill) => `/${skill}`).join(", ")
}

async function evaluateApplyRscGate(input: FileEditHookInput): Promise<SwizHookOutput> {
  const filePath = input.tool_input?.file_path ?? ""
  if (!isRscGatedFile(filePath)) return {}

  const rawInput = input as unknown as Record<string, unknown>
  if (!skillExistsForHookPayload(SKILL_NAME, rawInput)) return {}

  const transcriptPath = (rawInput.transcript_path as string | undefined) ?? ""
  if (!transcriptPath) return {}

  const cwd = (input.cwd as string | undefined) ?? process.cwd()
  const { recencyOptions, windowText: window } = await resolveSkillRecencyOptions(cwd)
  const invokedSkills = await getRecentlyInvokedSkillsForCurrentSession(rawInput, recencyOptions)
  const skillRef = formatSkillReferenceForAgent(SKILL_NAME)

  if (invokedSkills.includes(SKILL_NAME)) {
    return preToolUseAllow(`${skillRef} was invoked recently — RSC file edit allowed.`)
  }

  const fileName = filePath.split(/[/\\]/).pop() ?? filePath
  return preToolUseDeny(
    `BLOCKED: editing ${fileName} requires the ${skillRef} skill.\n\n` +
      `Skills used recently (${window}): ${formatInvokedSkills(invokedSkills)}\n\n` +
      `Invoke ${skillRef} before editing RSC page, layout, error, loading, or client component files. ` +
      `The skill enforces correct Server/Client Component boundaries and import conventions.`
  )
}

const pretooluseApplyRscGate: SwizFileEditHook = {
  name: "pretooluse-apply-rsc-gate",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  run: evaluateApplyRscGate,
}

export default pretooluseApplyRscGate

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretooluseApplyRscGate)
