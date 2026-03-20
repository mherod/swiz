/**
 * Hook execution worker - runs in isolated thread for heavy async work.
 * Uses Bun's Worker API with message passing.
 */

import { join } from "node:path"
import { spawn as bunSpawn } from "bun"

const HOOKS_DIR = join(import.meta.dir, "..", "..", "hooks")
const DEFAULT_TIMEOUT = 10 // seconds

interface RunHookMessage {
  id: string
  type: "run-hook"
  file: string
  payloadStr: string
  timeoutSec?: number
}

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

interface ErrorResult {
  id: string
  type: "hook-error"
  error: string
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

    // Set up timeout
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, baseTimeoutSec * 1000)

    // Wait for completion
    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timer)

    const endTime = Date.now()
    const exitCode = proc.exitCode
    const trimmed = output.trim()
    const stderrTrimmed = stderr.trim()

    // Parse output - classifyHookOutput logic inline
    let parsed: Record<string, unknown> | null = null
    let status = "ok"

    if (timedOut) {
      status = "timeout"
    } else if (!trimmed) {
      status = exitCode !== 0 ? "error" : "no-output"
    } else {
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        // Try to extract last JSON object
        const lastBrace = trimmed.lastIndexOf("{")
        if (lastBrace > 0) {
          try {
            const candidate = trimmed.slice(lastBrace)
            parsed = JSON.parse(candidate) as Record<string, unknown>
          } catch {
            status = "invalid-json"
          }
        } else {
          status = "invalid-json"
        }
      }
    }

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
