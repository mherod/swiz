/**
 * Hook execution worker - runs in isolated thread for heavy async work.
 * Uses Bun's Worker API with message passing.
 */

import { join } from "node:path"
import { spawn as bunSpawn } from "bun"
import type { ErrorResult, RunHookMessage } from "./worker-types.ts"

const HOOKS_DIR = join(import.meta.dir, "..", "..", "hooks")
const DEFAULT_TIMEOUT = 10 // seconds
/** Grace period before escalating SIGTERM → SIGKILL on timed-out hooks (ms). */
const SIGKILL_GRACE_MS = 3_000

interface HookResult {
  id: string
  type: "hook-result"
  parsed: Record<string, unknown> | null
  execution: {
    file: string
    startTime: number
    endTime: number
    durationMs: number
    configuredTimeoutSec: number
    status: string
    exitCode: number | null
    stdoutSnippet: string
    stderrSnippet: string
  }
}

/** Parse hook stdout to a JSON result, handling timeout/empty/invalid cases. */
function parseWorkerOutput(
  timedOut: boolean,
  trimmed: string,
  exitCode: number
): { parsed: Record<string, unknown> | null; status: string } {
  if (timedOut) return { parsed: null, status: "timeout" }
  if (!trimmed) return { parsed: null, status: exitCode !== 0 ? "error" : "no-output" }

  try {
    return { parsed: JSON.parse(trimmed) as Record<string, unknown>, status: "ok" }
  } catch {
    // Try to extract last JSON object from polluted stdout
    const lastBrace = trimmed.lastIndexOf("{")
    if (lastBrace > 0) {
      try {
        return {
          parsed: JSON.parse(trimmed.slice(lastBrace)) as Record<string, unknown>,
          status: "ok",
        }
      } catch {
        return { parsed: null, status: "invalid-json" }
      }
    }
    return { parsed: null, status: "invalid-json" }
  }
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
    const proc = bunSpawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
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

    const { parsed, status } = parseWorkerOutput(timedOut, trimmed, exitCode ?? 0)

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

self.addEventListener("message", async (event: MessageEvent) => {
  const msg = event.data as RunHookMessage
  if (msg.type === "run-hook") {
    const result = await runHookInWorker(msg.id, msg.file, msg.payloadStr, msg.timeoutSec)
    self.postMessage(result)
  }
})
