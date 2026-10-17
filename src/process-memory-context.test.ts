import { describe, expect, test } from "bun:test"
import posttooluseProcessMemory from "../hooks/posttooluse-process-memory.ts"
import pretooluseProcessMemory from "../hooks/pretooluse-process-memory.ts"
import { buildManifestForAgent, hookIdentifier } from "./manifest.ts"
import {
  evaluateProcessMemoryContext,
  formatProcessMemoryContext,
  PROCESS_MEMORY_THRESHOLD_KIB,
  parseExcessiveProcessMemory,
} from "./process-memory-context.ts"
import { hookOutputSchema } from "./schemas.ts"
import type { SpawnWithTimeoutResult, spawnWithTimeout } from "./utils/process-utils.ts"

const gib = 1024 * 1024
const successfulProbe = (stdout: string): SpawnWithTimeoutResult => ({
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
})

describe("process memory context", () => {
  test("warns only above 24 GiB per process, not at the boundary or for aggregate RAM", () => {
    const threshold = PROCESS_MEMORY_THRESHOLD_KIB
    expect(
      parseExcessiveProcessMemory(
        `1 ${threshold - 1} small\n2 ${threshold} boundary\n3 ${threshold + 1} excess`
      )
    ).toEqual([{ pid: 3, rssKiB: threshold + 1, command: "excess" }])
    expect(parseExcessiveProcessMemory(`1 ${20 * gib} first\n2 ${20 * gib} second`)).toEqual([])
  })

  test("parses macOS paths with spaces and Linux names, largest first", () => {
    expect(
      parseExcessiveProcessMemory(
        `  20  ${25 * gib} /Applications/Example App.app/Contents/MacOS/Example App\n` +
          `10 ${32 * gib} bun\n11 1024 small`
      )
    ).toEqual([
      { pid: 10, rssKiB: 32 * gib, command: "bun" },
      {
        pid: 20,
        rssKiB: 25 * gib,
        command: "/Applications/Example App.app/Contents/MacOS/Example App",
      },
    ])
  })

  test("ignores missing, malformed, negative, and unsafe numeric fields", () => {
    expect(
      parseExcessiveProcessMemory(
        `PID RSS COMMAND\n\n0 ${32 * gib} invalid\n-1 ${32 * gib} invalid\n` +
          `1 -100 invalid\n1 NaN invalid\n1 999999999999999999999 invalid\n` +
          `999999999999999999999 ${32 * gib} invalid\n1 3.5 invalid\n1 ${32 * gib}`
      )
    ).toEqual([])
  })

  test("formats bounded context with names, PIDs, and resident GiB", () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `${i + 1} ${(40 - i) * gib} /private/apps/Example App`
    ).join("\n")
    const message = formatProcessMemoryContext(parseExcessiveProcessMemory(rows))
    expect(message).toContain('PID 1: "Example App" — 40.00 GiB RSS')
    expect(message).not.toContain("/private/apps")
    expect(message.match(/PID /g)).toHaveLength(10)
    expect(message).toContain("2 additional processes exceed 24 GiB")
    expect(formatProcessMemoryContext([])).toBe("")
  })

  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    test(`${event} emits valid advisory context without granting or denying permission`, async () => {
      const controller = new AbortController()
      const run: typeof spawnWithTimeout = async (command, options) => {
        expect(command).toEqual(["ps", "-axo", "pid=,rss=,comm="])
        expect(options?.signal).toBe(controller.signal)
        expect(options?.timeoutMs).toBe(500)
        return successfulProbe(`123 ${26 * gib} bun`)
      }
      const output = await evaluateProcessMemoryContext(
        event,
        { signal: controller.signal, timeoutMs: 500 },
        run,
        "darwin"
      )
      expect(hookOutputSchema.safeParse(output).success).toBe(true)
      const parsed = hookOutputSchema.parse(output)
      expect(parsed.hookSpecificOutput?.hookEventName).toBe(event)
      expect(parsed.hookSpecificOutput?.additionalContext).toContain("PID 123")
      expect(parsed.hookSpecificOutput?.permissionDecision).toBeUndefined()
      expect(parsed.decision).toBeUndefined()
    })
  }

  test("stays silent for low usage and failed, timed out, or cancelled probes", async () => {
    for (const result of [
      successfulProbe(`1 ${24 * gib} boundary`),
      { ...successfulProbe(`1 ${32 * gib} partial`), exitCode: 1 },
      { ...successfulProbe(`1 ${32 * gib} partial`), timedOut: true },
      { ...successfulProbe(`1 ${32 * gib} partial`), aborted: true },
    ]) {
      expect(
        await evaluateProcessMemoryContext("PreToolUse", undefined, async () => result, "linux")
      ).toEqual({})
    }
    expect(
      await evaluateProcessMemoryContext(
        "PostToolUse",
        undefined,
        async () => {
          throw new Error("ps unavailable")
        },
        "linux"
      )
    ).toEqual({})
  })

  test("does not spawn on unsupported platforms or after cancellation", async () => {
    let calls = 0
    const run: typeof spawnWithTimeout = async () => {
      calls++
      return successfulProbe("")
    }
    expect(await evaluateProcessMemoryContext("PreToolUse", undefined, run, "win32")).toEqual({})
    expect(
      await evaluateProcessMemoryContext(
        "PostToolUse",
        { signal: AbortSignal.abort() },
        run,
        "darwin"
      )
    ).toEqual({})
    expect(calls).toBe(0)
  })

  test("registers both hooks for every tool with separate session cooldowns", () => {
    for (const tasksEnabled of [true, false]) {
      const manifest = buildManifestForAgent({ tasksEnabled })
      for (const hook of [pretooluseProcessMemory, posttooluseProcessMemory]) {
        const group = manifest.find((entry) => entry.event === hook.event && !entry.matcher)
        expect(group?.hooks.some((entry) => hookIdentifier(entry) === `${hook.name}.ts`)).toBe(true)
        expect(hook.cooldownSeconds).toBe(60)
        expect(hook.cooldownMode).toBe("always")
        expect(hook.cooldownScope).toBe("session")
      }
    }
  })
})
