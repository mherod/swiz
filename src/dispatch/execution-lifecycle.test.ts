import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { join } from "node:path"
import type { RepositoryCapability } from "../repository-capability.ts"
import * as codexPlanSync from "../tasks/codex-update-plan.ts"
import { parseTranscriptSummary } from "../transcript-summary.ts"
import { useTempDir } from "../utils/test-utils.ts"
import { type DispatchLifecycleUpdate, type DispatchRequest, executeDispatch } from "./execute.ts"
import { STRATEGY_REGISTRY } from "./strategies.ts"
import { type HookStrategyContext, runStrategyPipeline } from "./strategy-base.ts"

const temp = useTempDir("swiz-dispatch-lifecycle-")
let cwd: string
let settingsHome: string

beforeEach(async () => {
  cwd = await temp.create()
  settingsHome = await temp.create()
})

function capability(isRepo = true): RepositoryCapability {
  return {
    canonicalRoot: cwd,
    repoKey: "dispatch-lifecycle-fixture",
    isRepo,
    repoSlug: null,
    hasGhCli: false,
    resolvedAt: Date.now(),
  }
}

function request(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    canonicalEvent: "sessionStart",
    hookEventName: "SessionStart",
    payloadStr: JSON.stringify({ cwd, session_id: crypto.randomUUID(), _agent: "claude" }),
    settingsHomeOverride: settingsHome,
    repositoryCapabilityProvider: async () => capability(),
    replayPendingMutations: async () => {},
    manifestProvider: async () => [
      {
        event: "sessionStart",
        hooks: [
          {
            hook: {
              name: "lifecycle-context",
              event: "sessionStart",
              run: () => ({ systemMessage: "Fixture guidance." }),
            },
          },
        ],
      },
    ],
    disableTranscriptSummaryFallback: true,
    ...overrides,
  }
}

describe("dispatch output ownership", () => {
  for (const daemonContext of [false, true]) {
    const mode = daemonContext ? "daemon" : "local"

    test(`${mode} execution returns context and diagnostics without writing stdout`, async () => {
      const write = spyOn(process.stdout, "write").mockImplementation(() => true)
      try {
        const result = await executeDispatch(request({ daemonContext }))
        expect(result.response.systemMessage).toBe("Fixture guidance.")
        expect(result.response.hookExecutions).toHaveLength(1)
        expect(result.timing.hookCount).toBe(1)
        expect(write).not.toHaveBeenCalled()
      } finally {
        write.mockRestore()
      }
    })

    test(`${mode} non-repository Stop returns its allow envelope without writing stdout`, async () => {
      const write = spyOn(process.stdout, "write").mockImplementation(() => true)
      try {
        const result = await executeDispatch(
          request({
            canonicalEvent: "stop",
            hookEventName: "Stop",
            daemonContext,
            repositoryCapabilityProvider: async () => capability(false),
          })
        )
        expect(result.response.continue).toBe(true)
        expect(result.response.reason).toBeString()
        expect(result.timing.hookCount).toBe(0)
        expect(write).not.toHaveBeenCalled()
      } finally {
        write.mockRestore()
      }
    })

    test(`${mode} filtered Stop returns its allow envelope without writing stdout`, async () => {
      const write = spyOn(process.stdout, "write").mockImplementation(() => true)
      try {
        const result = await executeDispatch(
          request({
            canonicalEvent: "stop",
            hookEventName: "Stop",
            daemonContext,
            manifestProvider: async () => [],
          })
        )
        expect(result.response.continue).toBe(true)
        expect(result.response.reason).toBeString()
        expect(result.timing.hookCount).toBe(0)
        expect(write).not.toHaveBeenCalled()
      } finally {
        write.mockRestore()
      }
    })
  }
})

describe("dispatch lifecycle settlement", () => {
  for (const provider of ["transcript", "usage"] as const) {
    test(`cancellation while ${provider} enrichment is pending prevents Codex task sync`, async () => {
      const controller = new AbortController()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const cancelled = new Error(`request cancelled during ${provider} enrichment`)
      const payload: Record<string, unknown> = {
        cwd,
        _agent: "codex",
        session_id: crypto.randomUUID(),
        transcript_path: join(cwd, "transcript.jsonl"),
      }
      const summary = parseTranscriptSummary(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call",
            name: "update_plan",
            call_id: crypto.randomUUID(),
            arguments: JSON.stringify({ plan: [{ step: "Inspect dispatch", status: "pending" }] }),
          },
        })
      )
      const sync = spyOn(
        codexPlanSync,
        "syncCodexUpdatePlanFromTranscriptSummary"
      ).mockResolvedValue(null)
      const updates: DispatchLifecycleUpdate[] = []
      const result = executeDispatch(
        request({
          daemonContext: true,
          signal: controller.signal,
          payloadStr: JSON.stringify(payload),
          preParsedPayload: payload,
          transcriptSummaryProvider: async () => {
            if (provider === "transcript") {
              entered.resolve()
              await release.promise
            }
            return summary
          },
          currentSessionToolUsageProvider: async () => {
            if (provider === "usage") {
              entered.resolve()
              await release.promise
            }
            return null
          },
          onDispatchLifecycle: (update) => updates.push(update),
        })
      ).catch((error) => error)
      try {
        await entered.promise
        controller.abort(cancelled)
        release.resolve()

        expect(await result).toBe(cancelled)
        expect(sync).not.toHaveBeenCalled()
        expect(payload._transcriptSessionLinesKey).toBeUndefined()
        expect(updates.map((update) => update.phase)).toEqual(["start", "end"])
      } finally {
        release.resolve()
        await result
        sync.mockRestore()
      }
    })
  }

  test("cancellation during enrichment prevents late hook execution and ends the lifecycle", async () => {
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const updates: DispatchLifecycleUpdate[] = []
    const run = mock(() => ({ systemMessage: "Must not run after cancellation." }))
    const cancelled = new Error("request cancelled during enrichment")
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const result = executeDispatch(
        request({
          daemonContext: true,
          signal: controller.signal,
          currentSessionToolUsageProvider: async () => {
            entered.resolve()
            await release.promise
            return null
          },
          manifestProvider: async () => [
            {
              event: "sessionStart",
              hooks: [{ hook: { name: "late-hook", event: "sessionStart", run } }],
            },
          ],
          onDispatchLifecycle: (update) => updates.push(update),
        })
      ).catch((error) => error)
      await entered.promise
      expect(updates.map((update) => update.phase)).toEqual(["start"])
      controller.abort(cancelled)
      release.resolve()

      expect(await result).toBe(cancelled)
      expect(run).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
      expect(updates.map((update) => update.phase)).toEqual(["start", "end"])
      expect(updates[1]).toEqual({ ...updates[0]!, phase: "end" })
    } finally {
      release.resolve()
      write.mockRestore()
    }
  })

  for (const provider of ["transcript", "usage"] as const) {
    test(`${provider} enrichment rejection ends the same lifecycle it started`, async () => {
      const updates: DispatchLifecycleUpdate[] = []
      const failure = new Error(`${provider} unavailable`)
      const failedProvider = async () => {
        throw failure
      }
      const req = request({
        daemonContext: true,
        payloadStr: JSON.stringify({
          cwd,
          _agent: "claude",
          session_id: crypto.randomUUID(),
          transcript_path: join(cwd, "transcript.jsonl"),
        }),
        transcriptSummaryProvider: provider === "transcript" ? failedProvider : async () => null,
        currentSessionToolUsageProvider: provider === "usage" ? failedProvider : async () => null,
        onDispatchLifecycle: (update) => updates.push(update),
      })

      await expect(executeDispatch(req)).rejects.toBe(failure)
      expect(updates.map((update) => update.phase)).toEqual(["start", "end"])
      expect(updates[1]).toEqual({ ...updates[0]!, phase: "end" })
      expect(updates[0]?.hooks).toEqual(["lifecycle-context.ts"])
    })
  }

  for (const fails of [false, true]) {
    test(`releases the caller abort listener after strategy ${fails ? "failure" : "success"}`, async () => {
      const controller = new AbortController()
      const added = spyOn(controller.signal, "addEventListener")
      const removed = spyOn(controller.signal, "removeEventListener")
      const updates: DispatchLifecycleUpdate[] = []
      const failure = new Error("strategy failed")
      const strategy = fails
        ? spyOn(STRATEGY_REGISTRY.context, "execute").mockRejectedValue(failure)
        : undefined
      try {
        const result = executeDispatch(
          request({
            daemonContext: true,
            signal: controller.signal,
            onDispatchLifecycle: (update) => updates.push(update),
          })
        )
        if (fails) await expect(result).rejects.toBe(failure)
        else expect((await result).response.systemMessage).toBe("Fixture guidance.")
        expect(added).toHaveBeenCalledTimes(1)
        expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]![1])
        expect(updates.map((update) => update.phase)).toEqual(["start", "end"])
      } finally {
        strategy?.mockRestore()
        added.mockRestore()
        removed.mockRestore()
      }
    })
  }
})

describe("strategy pipeline failure cleanup", () => {
  for (const outcome of ["failure", "deny"] as const) {
    test(`async work ${outcome === "failure" ? "is cancelled on callback failure" : "completes after an ordinary deny"}`, async () => {
      const started = Promise.withResolvers<void>()
      const callback = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const completed = Promise.withResolvers<void>()
      const failure = new Error("result callback failed")
      const asyncAborted = mock(() => release.resolve())
      let asyncSignal: AbortSignal | undefined
      let completedWork = false
      const deny = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Blocked by fixture.",
        },
      }
      const ctx: HookStrategyContext = {
        canonicalEvent: "preToolUse",
        hookEventName: "PreToolUse",
        agentId: "claude",
        cwd,
        daemonContext: true,
        enrichedPayloadStr: JSON.stringify({ cwd }),
        filteredGroups: [
          {
            event: "preToolUse",
            hooks: [
              {
                hook: {
                  name: "sync-deny",
                  event: "preToolUse",
                  run: async () => {
                    await started.promise
                    return deny
                  },
                },
              },
              {
                hook: {
                  name: "async-observation",
                  event: "preToolUse",
                  async: true,
                  run: async (_input, context) => {
                    asyncSignal = context?.signal
                    asyncSignal?.addEventListener("abort", asyncAborted, { once: true })
                    started.resolve()
                    try {
                      await release.promise
                      completedWork = true
                      return {}
                    } finally {
                      asyncSignal?.removeEventListener("abort", asyncAborted)
                      completed.resolve()
                    }
                  },
                },
              },
            ],
          },
        ],
      }
      const pending = runStrategyPipeline(ctx, {
        onResult: (_result, abort) => {
          callback.resolve()
          if (outcome === "failure") throw failure
          abort()
        },
        processResults: () => deny,
      }).catch((error) => error)
      try {
        await callback.promise
        if (outcome === "failure") {
          expect(await pending).toBe(failure)
          expect(asyncSignal?.aborted).toBe(true)
          expect(asyncAborted).toHaveBeenCalledTimes(1)
        } else {
          expect(asyncSignal?.aborted).toBe(false)
          expect(asyncAborted).not.toHaveBeenCalled()
          expect(completedWork).toBe(false)
          release.resolve()
          expect(await pending).toEqual(deny)
        }
        await completed.promise
        expect(completedWork).toBe(true)
      } finally {
        release.resolve()
        await pending
      }
    })
  }

  for (const phase of ["hook-result", "aggregation"] as const) {
    test(`${phase} rejection cancels work and releases its timer and caller listener`, async () => {
      const caller = new AbortController()
      const added = spyOn(caller.signal, "addEventListener")
      const removed = spyOn(caller.signal, "removeEventListener")
      const timers = spyOn(globalThis, "setTimeout")
      const cleared = spyOn(globalThis, "clearTimeout")
      const failure = new Error(`${phase} failed`)
      let hookSignal: AbortSignal | undefined
      const hookAborted = mock(() => {})
      const ctx: HookStrategyContext = {
        canonicalEvent: "sessionStart",
        hookEventName: "SessionStart",
        agentId: "claude",
        cwd,
        daemonContext: true,
        signal: caller.signal,
        enrichedPayloadStr: JSON.stringify({ cwd }),
        filteredGroups: [
          {
            event: "sessionStart",
            hooks: [
              {
                hook: {
                  name: "cleanup-fixture",
                  event: "sessionStart",
                  run: (_input, context) => {
                    hookSignal = context?.signal
                    hookSignal?.addEventListener("abort", hookAborted, { once: true })
                    return {}
                  },
                },
              },
            ],
          },
        ],
      }
      try {
        await expect(
          runStrategyPipeline(ctx, {
            collectionTimeoutMs: 60_000,
            onResult: () => {
              if (phase === "hook-result") throw failure
            },
            processResults: () => {
              throw failure
            },
          })
        ).rejects.toBe(failure)

        expect(hookSignal?.aborted).toBe(true)
        expect(hookAborted).toHaveBeenCalledTimes(1)
        expect(added).toHaveBeenCalledTimes(1)
        expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0]![1])
        expect(timers).toHaveBeenCalledTimes(1)
        expect(cleared).toHaveBeenCalledWith(timers.mock.results[0]!.value)
      } finally {
        for (const timer of timers.mock.results) {
          if (timer.type === "return") clearTimeout(timer.value)
        }
        timers.mockRestore()
        cleared.mockRestore()
        added.mockRestore()
        removed.mockRestore()
      }
    })
  }
})
