/**
 * Shared fixtures for skill-gate hook tests.
 *
 * Every skill gate is tested the same way: install a throwaway skill into a temp project,
 * hand the hook a synthetic transcript summary, and assert on the permission decision. The
 * helpers live here so each gate's test file does not clone them — same-name clones trip the
 * pre-commit `similar` check, and drift between copies hides real behaviour differences.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { neutralAgentEnvOverrides, runHookInProcess } from "./test-utils.ts"

export interface SkillGateSummary {
  toolNames: string[]
  toolCallCount: number
  bashCommands: string[]
  skillInvocations: string[]
  hasGitPush: boolean
  sessionLines: string[]
  sessionDurationMs: number
  successfulTestRuns: number
  lastVerificationTime: string | null
  sessionScope: string
}

/** Minimal `_transcriptSummary` payload accepted by the skill recency helpers. */
export function makeSkillGateSummary(sessionLines: string[] = []): SkillGateSummary {
  return {
    toolNames: [],
    toolCallCount: 0,
    bashCommands: [],
    skillInvocations: [],
    hasGitPush: false,
    sessionLines,
    sessionDurationMs: 0,
    successfulTestRuns: 0,
    lastVerificationTime: null,
    sessionScope: "trivial",
  }
}

/** A transcript line recording a `Skill` tool call `msAgo` milliseconds in the past. */
export function skillInvocationLine(skillName: string, msAgo = 1000): string {
  return JSON.stringify({
    timestamp: new Date(Date.now() - msAgo).toISOString(),
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Skill", input: { skill: skillName } }] },
  })
}

export interface SkillGateRunOptions {
  /** Hook script path, relative to the repo root. */
  hookScript: string
  /** Skill to install into the temp project's `.skills/` directory. */
  skillName: string
  /** Tool payload fields (`tool_name`, `tool_input`) the hook reads. */
  payload: Record<string, unknown>
  /** Transcript lines seeding skill recency. */
  sessionLines?: string[]
  /** Prefix for the temp project directory. */
  tempPrefix?: string
  /**
   * Transcript path the hook should read. Defaults to a non-existent file, which is enough for
   * gates that only consult the pre-parsed summary; supply a real path for a gate that reads the
   * transcript itself.
   */
  transcriptPath?: string
}

/**
 * Run a skill-gate hook against a temp project where `skillName` is installed.
 * Returns the hook's parsed JSON output (`{}` when it emitted nothing).
 */
export async function runSkillGateWithSkillInstalled({
  hookScript,
  skillName,
  payload,
  sessionLines = [],
  tempPrefix = "skill-gate-",
  transcriptPath = "fake.json",
}: SkillGateRunOptions): Promise<Record<string, any>> {
  const projectDir = await mkdtemp(join(tmpdir(), tempPrefix))
  try {
    const skillDir = join(projectDir, ".skills", skillName)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "SKILL.md"), `# ${skillName}\n`)

    const result = await runHookInProcess(
      hookScript,
      {
        ...payload,
        transcript_path: transcriptPath,
        cwd: projectDir,
        _transcriptSummary: makeSkillGateSummary(sessionLines),
      },
      {
        cwd: projectDir,
        env: neutralAgentEnvOverrides({ CLAUDECODE: "1" }),
      }
    )
    return result.json ?? {}
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}

/** The `permissionDecision` a skill gate emitted, if any. */
export function permissionDecisionOf(result: Record<string, any>): string | undefined {
  return (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision
}
