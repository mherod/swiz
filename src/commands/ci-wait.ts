import { stderrLog } from "../debug.ts"
import { acquireGhSlot } from "../gh-rate-limit.ts"
import { git } from "../git-helpers.ts"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../settings.ts"
import type { Command } from "../types.ts"
import { getDaemonPort } from "./daemon/daemon-admin.ts"

const DAEMON_PORT = getDaemonPort()
const DAEMON_ORIGIN = process.env.SWIZ_DAEMON_ORIGIN ?? `http://127.0.0.1:${DAEMON_PORT}`
const DEFAULT_POLL_INTERVAL_MS = 5_000
const PASSING_JOB_CONCLUSIONS = new Set(["success", "skipped", "neutral"])

export interface CiWatchStartResponse {
  /** Set when global `ignore-ci` is enabled — daemon did not register a watch. */
  ignored?: boolean
  deduped?: boolean
  watch?: {
    sha: string
    cwd: string
    startedAt: number
    lastCheckedAt: number | null
    runId: number | null
    runUrl: string | null
  }
}

export interface GhRunSummary {
  databaseId: number
  workflowName: string
  status: string
  conclusion: string | null
  event: string
  headSha: string
  url: string
}

export interface GhRunJob {
  name: string
  conclusion: string | null
  status: string
}

export interface GhRunViewResult {
  conclusion: string | null
  status: string
  jobs: GhRunJob[]
}

export interface CiCompletionResult {
  conclusion: string
  elapsed: number
  runId: number
  jobs: GhRunJob[]
}

export interface CiWaitOptions {
  cwd?: string
  discoveryPollMs?: number
  statusPollMs?: number
  log?: (message: string) => void
  findFn?: (sha: string, cwd: string) => Promise<number | null>
  watchFn?: (runId: number, cwd: string, timeoutMs: number) => Promise<number>
  viewFn?: (runId: number, cwd: string) => Promise<GhRunViewResult | null>
  sleepFn?: (ms: number) => Promise<void>
}

interface CiWaitRuntime {
  cwd: string
  discoveryPollMs: number
  statusPollMs: number
  log: (message: string) => void
  findFn: (sha: string, cwd: string) => Promise<number | null>
  watchFn: (runId: number, cwd: string, timeoutMs: number) => Promise<number>
  viewFn: (runId: number, cwd: string) => Promise<GhRunViewResult | null>
  sleepFn: (ms: number) => Promise<void>
}

export async function startCiWatchViaDaemon(
  sha: string,
  cwd: string
): Promise<CiWatchStartResponse | null> {
  try {
    const resp = await fetch(`${DAEMON_ORIGIN}/ci-watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha, cwd }),
      signal: AbortSignal.timeout(1500),
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as CiWatchStartResponse
    if (data.ignored) return { ignored: true }
    if (!data.watch) return null
    return { deduped: data.deduped ?? false, watch: data.watch }
  } catch {
    return null
  }
}

/** Expand a short SHA in the repository that owns the requested CI run. */
export async function expandSha(sha: string, cwd: string = process.cwd()): Promise<string> {
  if (sha.length === 40) return sha
  try {
    const full = await git(["rev-parse", sha], cwd)
    return full.length === 40 ? full : sha
  } catch {
    return sha
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function runGhJson(args: string[], cwd: string): Promise<unknown | null> {
  try {
    await acquireGhSlot()
    const proc = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    if (proc.exitCode !== 0) return null
    return JSON.parse(stdout) as unknown
  } catch {
    return null
  }
}

function isRunSummary(value: unknown): value is GhRunSummary {
  if (!value || typeof value !== "object") return false
  const run = value as Partial<GhRunSummary>
  return (
    typeof run.databaseId === "number" &&
    typeof run.workflowName === "string" &&
    typeof run.status === "string" &&
    (typeof run.conclusion === "string" || run.conclusion === null) &&
    typeof run.event === "string" &&
    typeof run.headSha === "string" &&
    typeof run.url === "string"
  )
}

function isRunViewResult(value: unknown): value is GhRunViewResult {
  if (!value || typeof value !== "object") return false
  const run = value as Partial<GhRunViewResult>
  if (
    typeof run.status !== "string" ||
    (typeof run.conclusion !== "string" && run.conclusion !== null) ||
    !Array.isArray(run.jobs)
  ) {
    return false
  }
  return run.jobs.every(
    (job) =>
      job &&
      typeof job === "object" &&
      typeof job.name === "string" &&
      typeof job.status === "string" &&
      (typeof job.conclusion === "string" || job.conclusion === null)
  )
}

/**
 * Prefer the repository's CI workflow and avoid choosing a Dependabot run merely
 * because GitHub returned it first for the same commit.
 */
export function selectCiRun(runs: GhRunSummary[], fullSha: string): GhRunSummary | null {
  const matching = runs.filter((run) => run.headSha === fullSha)
  if (matching.length === 0) return null

  const nonDependabot = matching.filter(
    (run) => !/dependabot/i.test(`${run.workflowName} ${run.event}`)
  )
  const candidates = nonDependabot.length > 0 ? nonDependabot : matching
  return candidates.find((run) => /^ci$/i.test(run.workflowName.trim())) ?? candidates[0] ?? null
}

export async function findRunId(
  fullSha: string,
  cwd: string = process.cwd()
): Promise<number | null> {
  const data = await runGhJson(
    [
      "run",
      "list",
      "--commit",
      fullSha,
      "--limit",
      "15",
      "--json",
      "databaseId,workflowName,status,conclusion,event,headSha,url",
    ],
    cwd
  )
  if (!Array.isArray(data)) return null
  const selected = selectCiRun(data.filter(isRunSummary), fullSha)
  return selected?.databaseId ?? null
}

async function readCiRun(runId: number, cwd: string): Promise<GhRunViewResult | null> {
  const data = await runGhJson(
    ["run", "view", String(runId), "--json", "conclusion,status,jobs"],
    cwd
  )
  return isRunViewResult(data) ? data : null
}

async function streamCiRun(runId: number, cwd: string, timeoutMs: number): Promise<number> {
  const proc = Bun.spawn(["gh", "run", "watch", String(runId), "--exit-status"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  const killTimer = setTimeout(() => proc.kill(), Math.max(timeoutMs, 0))
  await proc.exited
  clearTimeout(killTimer)
  return proc.exitCode ?? 1
}

function resolveCiWaitRuntime(options: CiWaitOptions): CiWaitRuntime {
  return {
    cwd: options.cwd ?? process.cwd(),
    discoveryPollMs: options.discoveryPollMs ?? DEFAULT_POLL_INTERVAL_MS,
    statusPollMs: options.statusPollMs ?? DEFAULT_POLL_INTERVAL_MS,
    log: options.log ?? console.log,
    findFn: options.findFn ?? findRunId,
    watchFn: options.watchFn ?? streamCiRun,
    viewFn: options.viewFn ?? readCiRun,
    sleepFn: options.sleepFn ?? sleep,
  }
}

export interface DiscoverRunIdOptions {
  /** Maximum number of attempts before returning null (default: 3). */
  maxAttempts?: number
  /** Milliseconds to wait between failed attempts (default: 5 000). */
  intervalMs?: number
  /** Repository in which to query GitHub Actions (default: process.cwd()). */
  cwd?: string
  /** Override the run-finder for testing (default: findRunId). */
  findFn?: (sha: string, cwd: string) => Promise<number | null>
  /** Called before each sleep when no run is found yet. */
  onWaiting?: (attempt: number, maxAttempts: number) => void
}

export async function discoverRunId(
  fullSha: string,
  {
    maxAttempts = 3,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    cwd = process.cwd(),
    findFn = findRunId,
    onWaiting,
  }: DiscoverRunIdOptions = {}
): Promise<number | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = await findFn(fullSha, cwd)
    if (id !== null) return id
    if (attempt < maxAttempts - 1) {
      onWaiting?.(attempt + 1, maxAttempts)
      await sleep(intervalMs)
    }
  }
  return null
}

export function evaluateCiRun(
  data: GhRunViewResult
): { state: "pending"; completedJobs: number } | { state: "completed"; conclusion: string } {
  const completedJobs = data.jobs.filter((job) => job.status === "completed").length
  if (data.status !== "completed") return { state: "pending", completedJobs }

  const blockingJobs = data.jobs.filter(
    (job) => !job.conclusion || !PASSING_JOB_CONCLUSIONS.has(job.conclusion)
  )
  if (data.conclusion === "success" && blockingJobs.length > 0) {
    return { state: "completed", conclusion: "failure" }
  }
  return { state: "completed", conclusion: data.conclusion ?? "unknown" }
}

interface CiDiscoveryContext {
  commitSha: string
  fullSha: string
  cwd: string
  startTime: number
  timeoutMs: number
  timeoutSeconds: number
  pollMs: number
  log: (message: string) => void
  findFn: (sha: string, cwd: string) => Promise<number | null>
  sleepFn: (ms: number) => Promise<void>
}

async function discoverCiRunUntilTimeout(context: CiDiscoveryContext): Promise<number> {
  while (true) {
    const elapsed = Date.now() - context.startTime
    if (elapsed >= context.timeoutMs) {
      throw new Error(
        `No CI run found for commit ${context.commitSha} within ${context.timeoutSeconds}s timeout`
      )
    }
    const runId = await context.findFn(context.fullSha, context.cwd)
    if (runId !== null) return runId
    context.log(`⏳ Waiting for CI run to appear... (${Math.round(elapsed / 1000)}s)`)
    await context.sleepFn(Math.min(context.pollMs, context.timeoutMs - elapsed))
  }
}

interface CiStatusContext {
  runId: number
  cwd: string
  startTime: number
  timeoutMs: number
  timeoutSeconds: number
  pollMs: number
  log: (message: string) => void
  viewFn: (runId: number, cwd: string) => Promise<GhRunViewResult | null>
  sleepFn: (ms: number) => Promise<void>
}

async function pollCiRunUntilComplete(context: CiStatusContext): Promise<CiCompletionResult> {
  let reportedReadFailure = false
  while (true) {
    const elapsed = Date.now() - context.startTime
    if (elapsed >= context.timeoutMs) {
      throw new Error(
        `CI run ${context.runId} still running after ${context.timeoutSeconds}s timeout`
      )
    }

    const data = await context.viewFn(context.runId, context.cwd)
    if (!data) {
      if (!reportedReadFailure) {
        context.log("⚠ Could not read CI status from GitHub; retrying...")
        reportedReadFailure = true
      }
      await context.sleepFn(Math.min(context.pollMs, context.timeoutMs - elapsed))
      continue
    }

    reportedReadFailure = false
    const evaluation = evaluateCiRun(data)
    if (evaluation.state === "completed") {
      return {
        conclusion: evaluation.conclusion,
        elapsed: Date.now() - context.startTime,
        runId: context.runId,
        jobs: data.jobs,
      }
    }

    context.log(
      `⏳ CI: ${data.status} — ${evaluation.completedJobs}/${data.jobs.length} job(s) done ` +
        `(${Math.round(elapsed / 1000)}s)`
    )
    await context.sleepFn(Math.min(context.pollMs, context.timeoutMs - elapsed))
  }
}

/**
 * Discover a run, stream it when possible, then verify its authoritative final
 * state with `gh run view`. A transient `gh run watch` failure never becomes a
 * false CI failure; status polling continues until GitHub reports completion.
 */
export async function waitForCiCompletion(
  commitSha: string,
  timeoutSeconds: number = 300,
  options: CiWaitOptions = {}
): Promise<CiCompletionResult> {
  const startTime = Date.now()
  const timeoutMs = timeoutSeconds * 1000
  const { cwd, discoveryPollMs, statusPollMs, log, findFn, watchFn, viewFn, sleepFn } =
    resolveCiWaitRuntime(options)
  const fullSha = await expandSha(commitSha, cwd)
  const runId = await discoverCiRunUntilTimeout({
    commitSha,
    fullSha,
    cwd,
    startTime,
    timeoutMs,
    timeoutSeconds,
    pollMs: discoveryPollMs,
    log,
    findFn,
    sleepFn,
  })

  log(`Found CI run ${runId} — streaming output:\n`)
  const remainingMs = Math.max(timeoutMs - (Date.now() - startTime), 0)
  const watchExitCode = await watchFn(runId, cwd, remainingMs)
  if (watchExitCode !== 0) {
    log("⚠ Live CI stream ended early; checking authoritative run status...")
  }

  return await pollCiRunUntilComplete({
    runId,
    cwd,
    startTime,
    timeoutMs,
    timeoutSeconds,
    pollMs: statusPollMs,
    log,
    viewFn,
    sleepFn,
  })
}

export interface CiWaitArgs {
  commitSha: string
  timeout: number
  cwd?: string
}

interface CiWaitParseState {
  timeout: number
  cwd?: string
}

function parsePositiveInteger(raw: string, label: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`)
  }
  return value
}

function consumeCiWaitOption(
  args: string[],
  index: number,
  state: CiWaitParseState
): number | null {
  const arg = args[index]
  if (arg !== "--timeout" && arg !== "-t" && arg !== "--cwd") return null
  const next = args[index + 1]
  if (!next) throw new Error(`${arg} requires a value`)
  if (arg === "--cwd") state.cwd = next
  else state.timeout = parsePositiveInteger(next, "Timeout")
  return index + 1
}

export function parseCiWaitArgs(args: string[]): CiWaitArgs {
  let commitSha = ""
  const state: CiWaitParseState = { timeout: 300 }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const consumedThrough = consumeCiWaitOption(args, i, state)
    if (consumedThrough !== null) {
      i = consumedThrough
      continue
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`)
    if (commitSha) throw new Error(`Unexpected argument: ${arg}`)
    commitSha = arg
  }

  if (!commitSha) throw new Error("Commit SHA is required")
  return { commitSha, timeout: state.timeout, cwd: state.cwd }
}

export function summarizeCiJobs(jobs: GhRunJob[]): string {
  const counts = new Map<string, number>()
  for (const job of jobs) {
    const conclusion = job.conclusion ?? job.status
    counts.set(conclusion, (counts.get(conclusion) ?? 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => `${count} ${name}`).join(", ")
}

export const ciWaitCommand: Command = {
  name: "ci-wait",
  description: "Wait for GitHub Actions CI and verify every job's final state",
  usage: "swiz ci-wait <commit-sha> [--cwd <dir>] [--timeout <seconds>]",
  options: [
    { flags: "--cwd <dir>", description: "Repository containing the commit (default: cwd)" },
    { flags: "--timeout, -t <seconds>", description: "Timeout in seconds (default: 300)" },
  ],
  async run(args) {
    const { commitSha, timeout, cwd: cwdArg } = parseCiWaitArgs(args)
    const cwd = cwdArg ?? process.cwd()
    const [globalSettings, projectSettings] = await Promise.all([
      readSwizSettings(),
      readProjectSettings(cwd),
    ])
    const effective = getEffectiveSwizSettings(globalSettings, undefined, projectSettings)
    if (effective.ignoreCi) {
      stderrLog("ignore-ci", "ignore-ci is enabled — skipping CI wait.")
      return
    }

    try {
      console.log(`⏳ Waiting for CI run for commit ${commitSha.slice(0, 8)}...`)
      const { conclusion, elapsed, runId, jobs } = await waitForCiCompletion(commitSha, timeout, {
        cwd,
      })
      const elapsedSeconds = Math.round(elapsed / 1000)
      console.log(`\nCI jobs: ${summarizeCiJobs(jobs) || "none reported"}`)
      if (conclusion === "success") {
        console.log(`✓ CI completed in ${elapsedSeconds}s: ${conclusion}`)
        console.log(`evidence: ci_green:${runId} -- commit:${commitSha}`)
        process.exitCode = 0
      } else {
        stderrLog(
          "CI failure status reporting with exit codes",
          `✗ CI completed in ${elapsedSeconds}s: ${conclusion}`
        )
        process.exitCode = 1
      }
    } catch (err) {
      const errMsg = String(err)
      stderrLog("CI failure status reporting with exit codes", `✗ Error: ${errMsg}`)
      process.exitCode = errMsg.includes("timeout") ? 1 : 2
    }
  },
}
