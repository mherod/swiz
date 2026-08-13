#!/usr/bin/env bun

// PreToolUse hook: require /convert-to-kotlin skill before editing Java files in Gradle+Kotlin projects.
//
// Gates edits/writes to files matching *.java when both "gradle" and "kotlin" frameworks are detected.
//
// When the convert-to-kotlin skill is not installed on this machine, the gate is skipped (fail-open).
// When the skill has been invoked recently in the current session, the edit proceeds.
// Otherwise the hook blocks with an actionable message.
//
// Dual-mode: exports a SwizFileEditHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { resolve } from "node:path"
import { detectFrameworks } from "../src/detect-frameworks.ts"
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

const SKILL_NAME = GATE_REQUIRED_SKILLS.convertToKotlin.name

async function shouldGateKotlinTarget(filePath: string, cwd: string): Promise<boolean> {
  if (filePath.endsWith(".java")) return true
  if (!filePath.endsWith(".kt")) return false
  const absolutePath = resolve(cwd, filePath)
  const javaPath = `${absolutePath.slice(0, -3)}.java`
  const [javaExists, ktExists] = await Promise.all([
    Bun.file(javaPath).exists(),
    Bun.file(absolutePath).exists(),
  ])
  return javaExists && !ktExists
}

function formatRecentSkills(skills: string[]): string {
  return skills.length === 0 ? "(none)" : skills.map((skill) => `/${skill}`).join(", ")
}

async function hasGradleKotlinFrameworks(cwd: string): Promise<boolean> {
  const frameworks = await detectFrameworks(cwd)
  return frameworks.has("gradle") && frameworks.has("kotlin")
}

function buildKotlinGateDenial(
  filePath: string,
  isKt: boolean,
  skillRef: string,
  window: string,
  invokedSkills: string[]
): ReturnType<typeof preToolUseDeny> {
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath
  if (isKt) {
    return preToolUseDeny(
      `BLOCKED: creating ${fileName} matches a neighbouring Java file and requires the ${skillRef} skill.\n\n` +
        `This is because both Gradle and Kotlin have been detected in this project. ` +
        `We require Java files to be converted to Kotlin using the ${skillRef} skill to maintain codebase consistency.\n\n` +
        `Skills used recently (${window}): ${formatRecentSkills(invokedSkills)}\n\n` +
        `Invoke ${skillRef} to convert the Java file instead of creating the Kotlin file manually.`
    )
  }
  return preToolUseDeny(
    `BLOCKED: editing ${fileName} requires the ${skillRef} skill.\n\n` +
      `This is because both Gradle and Kotlin have been detected in this project. ` +
      `We require all Java files to be converted to Kotlin using the ${skillRef} skill to maintain codebase consistency.\n\n` +
      `Skills used recently (${window}): ${formatRecentSkills(invokedSkills)}\n\n` +
      `Invoke ${skillRef} before editing Java files.`
  )
}

async function evaluateConvertToKotlinGate(input: FileEditHookInput): Promise<SwizHookOutput> {
  const filePath = input.tool_input?.file_path ?? ""
  const cwd = (input.cwd as string | undefined) ?? process.cwd()
  if (!(await shouldGateKotlinTarget(filePath, cwd))) return {}

  if (!(await hasGradleKotlinFrameworks(cwd))) return {}

  const rawInput = input as unknown as Record<string, unknown>
  if (!skillExistsForHookPayload(SKILL_NAME, rawInput)) return {}
  if (!rawInput.transcript_path) return {}

  const { recencyOptions, windowText: window } = await resolveSkillRecencyOptions(cwd)
  const invokedSkills = await getRecentlyInvokedSkillsForCurrentSession(rawInput, recencyOptions)
  const skillRef = formatSkillReferenceForAgent(SKILL_NAME)
  const isKt = filePath.endsWith(".kt")
  if (invokedSkills.includes(SKILL_NAME)) {
    const action = isKt ? "creating Kotlin file" : "Java file edit"
    return preToolUseAllow(`${skillRef} was invoked recently — ${action} allowed.`)
  }
  return buildKotlinGateDenial(filePath, isKt, skillRef, window, invokedSkills)
}

const pretooluseRequireConvertToKotlin: SwizFileEditHook = {
  name: "pretooluse-require-convert-to-kotlin",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  run: evaluateConvertToKotlinGate,
}

export default pretooluseRequireConvertToKotlin

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretooluseRequireConvertToKotlin)
