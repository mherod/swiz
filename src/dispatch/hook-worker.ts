/**
 * Hook execution worker - runs in isolated thread for heavy async work.
 * Uses Bun's Worker API with message passing.
 */

import { join } from "node:path"
import { merge } from "lodash-es"
import { messageFromUnknownError } from "../utils/hook-json-helpers.ts"
import { spawnWithTimeout } from "../utils/process-utils.ts"
import type { HookExecution } from "./engine.ts"
import {
  classifyHookOutput,
  type ErrorResult,
  extractCallerEnv,
  extractPayloadCwd,
  HOOKS_DIR,
  type HookStartedMessage,
  type RunHookMessage,
  resolveHookTimeoutSec,
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
  const baseTimeoutSec = resolveHookTimeoutSec(timeoutSec)

  try {
    // Merge caller's environment from the enriched payload so daemon-spawned
    // hooks inherit the full shell env (LaunchAgent only gets minimal env vars).
    const callerEnv = extractCallerEnv(payloadStr)
    const env = callerEnv ? merge({}, process.env, callerEnv) : undefined
    const spawnCwd = extractPayloadCwd(payloadStr)

    // Not detached: with a process-group child, worker-pool.test.ts dies with
    // SIGTERM (exit 143) in this Worker-thread path, cause not yet isolated.
    // Until it is, only the hook process itself is signalled here; the main
    // thread path (engine.runHook) does kill the whole group.
    // The pid is reported so the pool can kill the hook if this worker dies.
    const result = await spawnWithTimeout(cmd, {
      cwd: spawnCwd,
      env,
      stdin: payloadStr,
      timeoutMs: baseTimeoutSec * 1000,
      sigkillGraceMs: SIGKILL_GRACE_MS,
      onSpawn: (pid) => self.postMessage({ id, type: "hook-started", pid }),
    })

    const endTime = Date.now()
    const exitCode = result.exitCode
    const trimmed = result.stdout.trim()
    const stderrTrimmed = result.stderr.trim()

    const { parsed, status } = classifyHookOutput({
      timedOut: result.timedOut,
      trimmed,
      exitCode,
    })

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
      error: messageFromUnknownError(err),
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
  postMessage: (data: HookResult | ErrorResult | HookStartedMessage) => void
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
