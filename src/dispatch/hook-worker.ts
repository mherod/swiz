/**
 * Hook execution worker - runs in isolated thread for heavy async work.
 * Uses Bun's Worker API with message passing.
 */

import { join } from "node:path"
import { spawn as bunSpawn } from "bun"
import { merge } from "lodash-es"
import type { HookExecution } from "./engine.ts"
import {
  classifyHookOutput,
  DEFAULT_TIMEOUT,
  type ErrorResult,
  extractCallerEnv,
  extractPayloadCwd,
  HOOKS_DIR,
  type RunHookMessage,
  SIGKILL_GRACE_MS,
} from "./worker-types.ts"

interface HookResult {
  id: string
  type: "hook-result"
  parsed: Record<string, any> | null
  execution: HookExecution
}

/**
 * Run a single hook - extracted from engine.ts for worker execution.
 */
async function runHookInWorker(
  id: string,
  file: string,
  payloadStr: string,
  timeoutSec?: number
): Promise<HookResult | ErrorResult> {
  const cmd = file.endsWith(".ts") ? ["bun", join(HOOKS_DIR, file)] : [join(HOOKS_DIR, file)]
  const startTime = Date.now()
  const baseTimeoutSec = timeoutSec ?? DEFAULT_TIMEOUT

  try {
    // Merge caller's environment from the enriched payload so daemon-spawned
    // hooks inherit the full shell env (LaunchAgent only gets minimal env vars).
    const callerEnv = extractCallerEnv(payloadStr)
    const env = callerEnv ? merge({}, process.env, callerEnv) : undefined
    const spawnCwd = extractPayloadCwd(payloadStr)

    const proc = bunSpawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: spawnCwd,
      env,
    })

    // Write payload and close stdin
    await proc.stdin.write(payloadStr)
    await proc.stdin.end()

    // Set up timeout with SIGKILL escalation
    let timedOut = false
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill("SIGTERM")
      // Escalate to SIGKILL if the process doesn't exit after grace period.
      sigkillTimer = setTimeout(() => {
        proc.kill("SIGKILL")
      }, SIGKILL_GRACE_MS)
    }, baseTimeoutSec * 1000)

    // Wait for completion
    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timer)
    if (sigkillTimer) clearTimeout(sigkillTimer)

    const endTime = Date.now()
    const exitCode = proc.exitCode
    const trimmed = output.trim()
    const stderrTrimmed = stderr.trim()

    const { parsed, status } = classifyHookOutput({ timedOut, trimmed, exitCode })

    return {
      id,
      type: "hook-result",
      parsed,
      execution: {
        file,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        configuredTimeoutSec: baseTimeoutSec,
        status,
        exitCode: exitCode ?? null,
        stdoutSnippet: trimmed.slice(0, 500),
        stderrSnippet: stderrTrimmed.slice(0, 500),
      },
    }
  } catch (err) {
    return {
      id,
      type: "hook-error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// Worker message handler using Bun's Worker API
// Use Bun.isMainThread to detect worker context
if (Bun.isMainThread) {
  throw new Error("This script must be run as a Worker")
}

declare const self: {
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void
  postMessage: (data: HookResult | ErrorResult) => void
}

self.addEventListener("message", (event: MessageEvent) => {
  void (async () => {
    const msg = event.data as RunHookMessage
    if (msg.type === "run-hook") {
      const result = await runHookInWorker(msg.id, msg.file, msg.payloadStr, msg.timeoutSec)
      self.postMessage(result)
    }
  })()
})
