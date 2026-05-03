#!/usr/bin/env bun

// PostToolUse hook: suggest /mid-session-checkin when drift signals fire during long sessions.
// Fires on Edit|Write after 3+ hours when no recent check-in exists and at least one drift
// signal is detected (too many uncommitted files, stale last commit + dirty, new review PRs).
// Opt-in via enforceMidSessionCheckin setting (default: false).

import { stat } from "node:fs/promises"
import { ghJson } from "../src/git-helpers.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { buildContextHookOutput, runSwizHookAsMain } from "../src/SwizHook.ts"
import { sanitizeSessionId } from "../src/session-id.ts"
import { midSessionPrBaselinePath } from "../src/temp-paths.ts"
import { getSkillsUsedForCurrentSession } from "../src/transcript-summary.ts"

const THREE_HOURS_MS = 3 * 60 * 60 * 1000
const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const UNCOMMITTED_FILES_THRESHOLD = 10

interface PrEntry {
  number: number
}

async function getSessionStartMs(transcriptPath: string, override?: number): Promise<number> {
  if (override !== undefined) return override
  try {
    const s = await stat(transcriptPath)
    return s.birthtimeMs ?? s.mtimeMs
  } catch {
    return Date.now()
  }
}

function gitStatusLines(cwd: string): string[] {
  const proc = Bun.spawnSync(["git", "-C", cwd, "status", "--porcelain"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) return []
  return new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean)
}

function getLastCommitAgeMs(cwd: string): number | null {
  const proc = Bun.spawnSync(["git", "-C", cwd, "log", "-1", "--format=%ct"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) return null
  const ts = parseInt(new TextDecoder().decode(proc.stdout).trim(), 10)
  if (Number.isNaN(ts)) return null
  return Date.now() - ts * 1000
}

async function detectPrSignal(cwd: string, safeSession: string): Promise<string | null> {
  const currentPrs = await ghJson<PrEntry[]>(
    ["pr", "list", "--search", "review-requested:@me", "--json", "number"],
    cwd
  )
  if (!currentPrs) return null

  const baselinePath = midSessionPrBaselinePath(safeSession)
  const baselineFile = Bun.file(baselinePath)
  const baselineExists = await baselineFile.exists()

  if (!baselineExists) {
    await Bun.write(baselinePath, JSON.stringify(currentPrs))
    return null
  }

  const baselinePrs = (await baselineFile.json()) as PrEntry[]
  const baselineNumbers = new Set(baselinePrs.map((p) => p.number))
  const newPrs = currentPrs.filter((p) => !baselineNumbers.has(p.number))

  if (newPrs.length === 0) return null
  return `${newPrs.length} PR${newPrs.length > 1 ? "s" : ""} now request${newPrs.length === 1 ? "s" : ""} your review`
}

async function detectDriftSignal(cwd: string, safeSession: string): Promise<string | null> {
  const statusLines = gitStatusLines(cwd)

  if (statusLines.length > UNCOMMITTED_FILES_THRESHOLD) {
    return `${statusLines.length} uncommitted files`
  }

  const lastCommitAge = getLastCommitAgeMs(cwd)
  if (lastCommitAge !== null && lastCommitAge > TWO_HOURS_MS && statusLines.length > 0) {
    const totalMins = Math.floor(lastCommitAge / 60000)
    const hours = Math.floor(totalMins / 60)
    const mins = totalMins % 60
    const ageStr = hours > 0 ? `${hours}h${mins > 0 ? `${mins}m` : ""}` : `${mins}m`
    return `last commit ${ageStr} ago with dirty tree`
  }

  return await detectPrSignal(cwd, safeSession)
}

const posttoolusMidSessionPrompt: SwizHook = {
  name: "posttooluse-mid-session-prompt",
  event: "postToolUse",
  matcher: "Edit|Write",
  timeout: 10,
  cooldownSeconds: 1800,
  cooldownMode: "always",
  requiredSettings: ["enforceMidSessionCheckin"],

  async run(input: Record<string, any>): Promise<SwizHookOutput> {
    const es = input._effectiveSettings as Record<string, any> | undefined
    if (!es?.enforceMidSessionCheckin) return {}

    const cwd = (input.cwd as string) ?? process.cwd()
    const sessionId = (input.session_id as string) ?? ""
    const transcriptPath = input.transcript_path as string | undefined
    if (!transcriptPath) return {}

    const sessionStartOverride = input._testSessionStartMs as number | undefined
    const sessionStartMs = await getSessionStartMs(transcriptPath, sessionStartOverride)
    if (Date.now() - sessionStartMs < THREE_HOURS_MS) return {}

    const skillsUsed = await getSkillsUsedForCurrentSession(input)
    if (skillsUsed.includes("mid-session-checkin")) return {}

    const safeSession = sanitizeSessionId(sessionId) ?? "unknown"
    const signal = await detectDriftSignal(cwd, safeSession)
    if (!signal) return {}

    return buildContextHookOutput(
      "PostToolUse",
      `Session has drifted: ${signal}. Consider running /mid-session-checkin to re-orient against new signals before continuing this pick.`
    )
  },
}

export default posttoolusMidSessionPrompt

if (import.meta.main) {
  await runSwizHookAsMain(posttoolusMidSessionPrompt)
}
