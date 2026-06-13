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
import { runSwizHookAsMain, type SwizFileEditHook, type SwizHookOutput } from "../src/SwizHook.ts"
import type { FileEditHookInput } from "../src/schemas.ts"
import {
  DEFAULT_SKILL_RECENCY_MAX_AGE_MINUTES,
  DEFAULT_SKILL_RECENCY_MAX_TURNS,
  resolveNumericSetting,
} from "../src/settings/resolution.ts"
import {
  formatCurrentSessionUsageWindow,
  formatSkillReferenceForAgent,
  getRecentlyInvokedSkillsForCurrentSession,
  skillExistsForHookPayload,
} from "../src/skill-utils.ts"
import { preToolUseAllow, preToolUseDeny } from "../src/utils/hook-utils.ts"

const SKILL_NAME = "convert-to-kotlin"

const pretooluseRequireConvertToKotlin: SwizFileEditHook = {
  name: "pretooluse-require-convert-to-kotlin",
  event: "preToolUse",
  matcher: "Edit|Write|NotebookEdit",
  timeout: 5,

  run: async (input: FileEditHookInput): Promise<SwizHookOutput> => {
    const filePath = input.tool_input?.file_path ?? ""
    const isJava = filePath.endsWith(".java")
    const isKt = filePath.endsWith(".kt")
    if (!isJava && !isKt) {
      return {}
    }

    const cwd = (input.cwd as string | undefined) ?? process.cwd()
    const frameworks = await detectFrameworks(cwd)
    if (!frameworks.has("gradle") || !frameworks.has("kotlin")) {
      return {}
    }

    if (isKt) {
      const absolutePath = resolve(cwd, filePath)
      const javaPath = absolutePath.slice(0, -3) + ".java"
      const [javaExists, ktExists] = await Promise.all([
        Bun.file(javaPath).exists(),
        Bun.file(absolutePath).exists(),
      ])
      if (!javaExists || ktExists) {
        return {}
      }
    }

    const rawInput = input as unknown as Record<string, unknown>
    if (!skillExistsForHookPayload(SKILL_NAME, rawInput)) {
      return {}
    }

    const transcriptPath = (rawInput.transcript_path as string | undefined) ?? ""
    if (!transcriptPath) {
      return {}
    }

    const [maxTurns, maxAgeMinutes] = await Promise.all([
      resolveNumericSetting(cwd, "skillRecencyMaxTurns", DEFAULT_SKILL_RECENCY_MAX_TURNS),
      resolveNumericSetting(
        cwd,
        "skillRecencyMaxAgeMinutes",
        DEFAULT_SKILL_RECENCY_MAX_AGE_MINUTES
      ),
    ])
    const recencyOptions = { maxTurns, maxAgeMs: maxAgeMinutes * 60 * 1000 }

    const invokedSkills = await getRecentlyInvokedSkillsForCurrentSession(rawInput, recencyOptions)
    const skillRef = formatSkillReferenceForAgent(SKILL_NAME)
    const window = formatCurrentSessionUsageWindow(recencyOptions)

    if (invokedSkills.includes(SKILL_NAME)) {
      return preToolUseAllow(
        isKt
          ? `${skillRef} was invoked recently — creating Kotlin file allowed.`
          : `${skillRef} was invoked recently — Java file edit allowed.`
      )
    }

    const fileName = filePath.split(/[/\\]/).pop() ?? filePath
    if (isKt) {
      return preToolUseDeny(
        `BLOCKED: creating ${fileName} matches a neighbouring Java file and requires the ${skillRef} skill.\n\n` +
          `This is because both Gradle and Kotlin have been detected in this project. ` +
          `We require Java files to be converted to Kotlin using the ${skillRef} skill to maintain codebase consistency.\n\n` +
          `Skills used recently (${window}): ${
            invokedSkills.length === 0 ? "(none)" : invokedSkills.map((s) => `/${s}`).join(", ")
          }\n\n` +
          `Invoke ${skillRef} to convert the Java file instead of creating the Kotlin file manually.`
      )
    }

    return preToolUseDeny(
      `BLOCKED: editing ${fileName} requires the ${skillRef} skill.\n\n` +
        `This is because both Gradle and Kotlin have been detected in this project. ` +
        `We require all Java files to be converted to Kotlin using the ${skillRef} skill to maintain codebase consistency.\n\n` +
        `Skills used recently (${window}): ${
          invokedSkills.length === 0 ? "(none)" : invokedSkills.map((s) => `/${s}`).join(", ")
        }\n\n` +
        `Invoke ${skillRef} before editing Java files.`
    )
  },
}

export default pretooluseRequireConvertToKotlin

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretooluseRequireConvertToKotlin)
