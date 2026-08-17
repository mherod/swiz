import { requiresPeerReview } from "../collaboration-policy.ts"
import { getGitClient } from "../git/client.ts"
import { resolveProjectIdentity } from "../project-identity.ts"
import {
  type EffectiveSwizSettings,
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
} from "../settings.ts"
import { swizPushCooldownSentinelPath, swizPushResultPath } from "../temp-paths.ts"
import type { Command } from "../types.ts"
import { buildConcurrentWaitGuidance } from "../utils/concurrent-work-guidance.ts"
import { getDefaultBranch, isDefaultBranch } from "../utils/git-utils.ts"
import { startCiWatchViaDaemon, summarizeCiJobs, waitForCiCompletion } from "./ci-wait.ts"

// Must match the values in hooks/pretooluse-push-cooldown.ts
export const COOLDOWN_MS = 60_000
const POLL_INTERVAL_MS = 2_000

export async function getRemainingCooldownMs(sentinelPath: string): Promise<number> {
  try {
    const file = Bun.file(sentinelPath)
    if (!(await file.exists())) return 0
    const raw = (await file.text()).trim()
    if (raw === "") return 0
    const lastPush = Number(raw)
    if (!Number.isFinite(lastPush)) return 0
    const remaining = COOLDOWN_MS - (Date.now() - lastPush)
    return remaining > 0 ? remaining : 0
  } catch {
    return 0
  }
}

interface WaitForCooldownOptions {
  sentinelPath: string
  timeoutSeconds: number
  pollIntervalMs?: number
  log?: (msg: string) => void
}

export async function waitForCooldown(opts: WaitForCooldownOptions): Promise<{ waitedMs: number }> {
  const { sentinelPath, timeoutSeconds, log = console.log } = opts
  const pollInterval = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  const startTime = Date.now()
  const timeoutMs = timeoutSeconds * 1000

  const initial = await getRemainingCooldownMs(sentinelPath)
  if (initial === 0) return { waitedMs: 0 }

  log(`⏳ Push cooldown active — ${Math.ceil(initial / 1000)}s remaining`)

  while (true) {
    await Bun.sleep(pollInterval)
    const elapsed = Date.now() - startTime
    if (elapsed > timeoutMs) {
      const remaining = await getRemainingCooldownMs(sentinelPath)
      throw new Error(
        `Cooldown did not expire within ${timeoutSeconds}s timeout` +
          (remaining > 0 ? ` (${Math.ceil(remaining / 1000)}s still remaining)` : "")
      )
    }

    const remaining = await getRemainingCooldownMs(sentinelPath)
    if (remaining === 0) {
      log(`✓ Cooldown expired after ${Math.round(elapsed / 1000)}s`)
      return { waitedMs: elapsed }
    }
    log(`⏳ Cooldown: ${Math.ceil(remaining / 1000)}s remaining...`)
  }
}

export interface PushWaitArgs {
  remote: string
  branch: string
  timeout: number
  ciTimeout: number
  wait: boolean
  extraArgs: string[]
  cwd?: string
}

interface PushWaitParseState {
  timeout: number
  ciTimeout: number
  cwd?: string
}

function parsePositiveTimeout(raw: string, label: string): number {
  const timeout = Number(raw)
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(`${label} must be a positive number`)
  }
  return timeout
}

function consumePushWaitValueOption(
  args: string[],
  index: number,
  state: PushWaitParseState
): number | null {
  const arg = args[index]
  if (!["--timeout", "-t", "--ci-timeout", "--ci-t", "--cwd"].includes(arg ?? "")) {
    return null
  }
  const next = args[index + 1]
  if (!next) throw new Error(`${arg} requires a value`)
  if (arg === "--cwd") state.cwd = next
  else if (arg === "--ci-timeout" || arg === "--ci-t") {
    state.ciTimeout = parsePositiveTimeout(next, "CI timeout")
  } else {
    state.timeout = parsePositiveTimeout(next, "Timeout")
  }
  return index + 1
}

export function parsePushWaitArgs(args: string[]): PushWaitArgs {
  let remote = "origin"
  let branch = ""
  let wait = false
  const state: PushWaitParseState = { timeout: 120, ciTimeout: 300 }
  const extraArgs: string[] = []
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === "--") {
      extraArgs.push(...args.slice(i + 1))
      break
    }

    const consumedThrough = consumePushWaitValueOption(args, i, state)
    if (consumedThrough !== null) {
      i = consumedThrough
      continue
    }
    if (arg === "--wait") {
      wait = true
      continue
    }
    if (arg.startsWith("-")) {
      extraArgs.push(arg)
      continue
    }
    positional.push(arg)
  }

  if (positional.length > 2) {
    throw new Error(`Unexpected argument: ${positional[2]}`)
  }
  remote = positional[0] || remote
  branch = positional[1] || branch

  return {
    remote,
    branch,
    timeout: state.timeout,
    ciTimeout: state.ciTimeout,
    wait,
    extraArgs,
    cwd: state.cwd,
  }
}

interface PushResult {
  success: boolean
  commitSha: string
  branch: string
  remote: string
  exitCode: number
  timestamp: number
  ciWatchStarted: boolean
  ciRunId: number | null
  ciConclusion: string | null
}

async function writePushResult(repoKey: string, result: PushResult): Promise<void> {
  try {
    await Bun.write(swizPushResultPath(repoKey), JSON.stringify(result, null, 2))
  } catch {
    // Non-fatal — the result file is a convenience, not the source of truth.
  }
}

async function assertPeerReviewAllowsDefaultPush(
  cwd: string,
  targetBranch: string,
  effective: EffectiveSwizSettings
): Promise<void> {
  if (effective.trunkMode && effective.strictNoDirectMain) {
    throw new Error(
      "Trunk mode and strict no-direct-main are both enabled; resolve that workflow conflict before pushing."
    )
  }
  const defaultBranch = await getDefaultBranch(cwd)
  if (!isDefaultBranch(targetBranch, defaultBranch)) return
  if (effective.trunkMode) return
  if (!requiresPeerReview(effective.collaborationMode)) return
  throw new Error(
    `Collaboration mode "${effective.collaborationMode}" requires peer review — ` +
      `direct pushes to ${targetBranch} are not allowed.\n\n` +
      `Push to a feature branch and open a PR instead:\n` +
      `  git checkout -b feat/<description>\n` +
      `  git push origin feat/<description>\n` +
      `  gh pr create`
  )
}

function remoteBranchName(refspec: string): string {
  const destination = refspec.includes(":") ? refspec.slice(refspec.lastIndexOf(":") + 1) : refspec
  return destination.replace(/^refs\/heads\//, "")
}

async function verifyRemoteHead(
  cwd: string,
  remote: string,
  targetBranch: string,
  expectedSha: string
): Promise<void> {
  const branch = remoteBranchName(targetBranch)
  const result = await getGitClient().run(
    ["ls-remote", "--heads", remote, `refs/heads/${branch}`],
    {
      cwd,
    }
  )
  if (result.exitCode !== 0) {
    throw new Error(`Push succeeded, but remote verification failed: ${result.stderr.trim()}`)
  }
  const remoteSha = result.stdout.trim().split(/\s+/)[0]
  if (remoteSha !== expectedSha) {
    throw new Error(
      `Push returned success, but ${remote}/${branch} is ${remoteSha || "missing"}; ` +
        `expected ${expectedSha}`
    )
  }
  console.log(`✓ Remote ${remote}/${branch} verified at ${expectedSha.slice(0, 8)}`)
}

export interface ExecutePushFlowOptions {
  remote: string
  branch: string
  cooldownTimeout: number
  ciTimeout: number
  waitForCi: boolean
  extraArgs?: string[]
  cwd: string
}

export interface ExecutePushFlowResult {
  commitSha: string
  targetBranch: string
  remote: string
  ciRunId: number | null
  ciConclusion: string | null
}

interface PushExecutionContext {
  commitSha: string
  targetBranch: string
  remote: string
  cwd: string
  repoKey: string
  effective: EffectiveSwizSettings
}

interface PushResultOutcome {
  success: boolean
  exitCode: number
  ciWatchStarted?: boolean
  ciRunId?: number | null
  ciConclusion?: string | null
}

function flowResult(
  context: PushExecutionContext,
  ciRunId: number | null = null,
  ciConclusion: string | null = null
): ExecutePushFlowResult {
  return {
    commitSha: context.commitSha,
    targetBranch: context.targetBranch,
    remote: context.remote,
    ciRunId,
    ciConclusion,
  }
}

async function persistPushOutcome(
  context: PushExecutionContext,
  outcome: PushResultOutcome
): Promise<void> {
  await writePushResult(context.repoKey, {
    success: outcome.success,
    commitSha: context.commitSha,
    branch: context.targetBranch,
    remote: context.remote,
    exitCode: outcome.exitCode,
    timestamp: Date.now(),
    ciWatchStarted: outcome.ciWatchStarted ?? false,
    ciRunId: outcome.ciRunId ?? null,
    ciConclusion: outcome.ciConclusion ?? null,
  })
}

async function preparePushFlow(options: ExecutePushFlowOptions): Promise<PushExecutionContext> {
  const [globalSettings, projectSettings] = await Promise.all([
    readSwizSettings(),
    readProjectSettings(options.cwd),
  ])
  const effective = getEffectiveSwizSettings(globalSettings, undefined, projectSettings)
  let targetBranch = options.branch
  if (!targetBranch) {
    const branchResult = getGitClient().runSync(["branch", "--show-current"], {
      cwd: options.cwd,
    })
    targetBranch = branchResult.stdout.trim()
    if (!targetBranch) throw new Error("Could not determine current branch (detached HEAD?)")
  }

  const headResult = getGitClient().runSync(["rev-parse", "HEAD"], { cwd: options.cwd })
  const commitSha = headResult.stdout.trim()
  if (!commitSha) throw new Error("Could not determine HEAD SHA")

  await assertPeerReviewAllowsDefaultPush(options.cwd, targetBranch, effective)
  const { repoKey } = await resolveProjectIdentity(options.cwd)
  await waitForCooldown({
    sentinelPath: swizPushCooldownSentinelPath(repoKey),
    timeoutSeconds: options.cooldownTimeout,
  })
  return {
    commitSha,
    targetBranch,
    remote: options.remote,
    cwd: options.cwd,
    repoKey,
    effective,
  }
}

async function pushAndVerifyRemote(
  context: PushExecutionContext,
  extraArgs: string[]
): Promise<{ dryRun: boolean }> {
  const pushArgs = ["push", ...extraArgs, context.remote, context.targetBranch]
  console.log(`→ git ${pushArgs.join(" ")}`)
  const pushResult = await getGitClient().run(pushArgs, {
    cwd: context.cwd,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (pushResult.exitCode !== 0) {
    await persistPushOutcome(context, { success: false, exitCode: pushResult.exitCode })
    throw new Error(`git push failed with exit code ${pushResult.exitCode}`)
  }

  console.log("✓ Push succeeded")
  const dryRun = extraArgs.includes("--dry-run") || extraArgs.includes("-n")
  if (dryRun) {
    console.log("ℹ Dry-run push completed — skipping remote and CI verification.")
    return { dryRun: true }
  }

  try {
    await verifyRemoteHead(context.cwd, context.remote, context.targetBranch, context.commitSha)
  } catch (error) {
    await persistPushOutcome(context, { success: false, exitCode: 1 })
    throw error
  }
  return { dryRun: false }
}

async function waitForCiAfterPush(
  context: PushExecutionContext,
  ciTimeout: number
): Promise<ExecutePushFlowResult> {
  if (context.effective.ignoreCi) {
    console.log("ℹ ignore-ci enabled — skipping CI verification.")
    await persistPushOutcome(context, { success: true, exitCode: 0 })
    return flowResult(context)
  }

  console.log(`⏳ Waiting for CI run for commit ${context.commitSha.slice(0, 8)}...`)
  const ci = await waitForCiCompletion(context.commitSha, ciTimeout, { cwd: context.cwd })
  const success = ci.conclusion === "success"
  await persistPushOutcome(context, {
    success,
    exitCode: success ? 0 : 1,
    ciRunId: ci.runId,
    ciConclusion: ci.conclusion,
  })
  console.log(`CI jobs: ${summarizeCiJobs(ci.jobs) || "none reported"}`)
  console.log(`CI completed in ${Math.round(ci.elapsed / 1000)}s: ${ci.conclusion}`)
  if (!success) throw new Error(`CI run ${ci.runId} completed with conclusion: ${ci.conclusion}`)
  console.log(`evidence: ci_green:${ci.runId} -- commit:${context.commitSha}`)
  return flowResult(context, ci.runId, ci.conclusion)
}

async function startBackgroundCiWatch(
  context: PushExecutionContext
): Promise<ExecutePushFlowResult> {
  let ciWatchStarted = false
  if (context.effective.ignoreCi) {
    console.log("ℹ ignore-ci enabled — skipping background CI watch.")
  } else {
    const watchResult = await startCiWatchViaDaemon(context.commitSha, context.cwd)
    if (watchResult?.ignored) {
      console.log("ℹ ignore-ci enabled — skipping background CI watch.")
    } else if (watchResult?.watch) {
      ciWatchStarted = true
      const mode = watchResult.deduped ? "already active" : "started"
      console.log(`✓ CI background watch ${mode} for ${context.commitSha.slice(0, 8)}`)
    } else {
      console.log(
        "⚠ Could not reach daemon for CI watch; run 'swiz daemon' to enable background CI notifications."
      )
    }
  }
  await persistPushOutcome(context, { success: true, exitCode: 0, ciWatchStarted })
  return flowResult(context)
}

/** Canonical push path shared by `push-wait` and `push-ci`. */
export async function executePushFlow(
  options: ExecutePushFlowOptions
): Promise<ExecutePushFlowResult> {
  console.log(
    buildConcurrentWaitGuidance("Running the push, remote verification, and CI flow safely.")
  )
  const context = await preparePushFlow(options)
  const extraArgs = options.extraArgs ?? []
  const { dryRun } = await pushAndVerifyRemote(context, extraArgs)
  if (dryRun) return flowResult(context)
  if (options.waitForCi) return await waitForCiAfterPush(context, options.ciTimeout)
  return await startBackgroundCiWatch(context)
}

export const pushWaitCommand: Command = {
  name: "push-wait",
  description: "Push safely from a shared directory, verify the remote, and optionally verify CI",
  usage:
    "swiz push-wait [remote] [branch] [--wait] [--cwd <dir>] [--timeout <s>] [--ci-timeout <s>]",
  options: [
    { flags: "--wait", description: "Wait for authoritative CI and job conclusions" },
    { flags: "--cwd <dir>", description: "Working directory for the git push (default: cwd)" },
    { flags: "--timeout, -t <seconds>", description: "Max cooldown wait (default: 120)" },
    { flags: "--ci-timeout <seconds>", description: "Max CI wait (default: 300)" },
  ],
  async run(args) {
    const parsed = parsePushWaitArgs(args)
    await executePushFlow({
      remote: parsed.remote,
      branch: parsed.branch,
      cooldownTimeout: parsed.timeout,
      ciTimeout: parsed.ciTimeout,
      waitForCi: parsed.wait,
      extraArgs: parsed.extraArgs,
      cwd: parsed.cwd ?? process.cwd(),
    })
  },
}
