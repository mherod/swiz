import { describe, expect, mock, test } from "bun:test"
import {
  type CodexProcess,
  createCodexProcessRuntime,
  parseCodexProcesses,
  prepareCodexCleanup,
} from "./cleanup-codex-processes.ts"
import { parseCleanupArgs } from "./cleanup-path.ts"

const processes = [{ pid: 12345, executable: "/usr/local/bin/codex" }]

describe("Codex process inspection", () => {
  test("force is opt-in and rejects misleading boolean assignments", () => {
    expect(parseCleanupArgs([]).force).toBe(false)
    expect(parseCleanupArgs(["--force"]).force).toBe(true)
    expect(() => parseCleanupArgs(["--force=false"])).toThrow("does not accept a value")
  })

  test("a Codex init process still prevents cleanup even though it cannot be killed", () => {
    expect(parseCodexProcesses("1 codex").map((p) => p.pid)).toEqual([1])
  })

  test("detects CLI, app, helpers and embedded Codex hosts from executable paths", () => {
    const found = parseCodexProcesses(
      [
        "10 /usr/local/bin/codex",
        "11 codex",
        "12 /Applications/Codex.app/Contents/MacOS/Codex",
        "13 /Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper",
        "14 /Applications/ChatGPT (Nightly).app/Contents/Resources/codex-code-mode-host",
        "15 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler",
        "16 /tmp/.codex/tools/bun",
        "17 /usr/bin/osascript",
        "18 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "19 /usr/bin/ps",
      ].join("\n")
    )
    expect(found.map((p) => p.pid)).toEqual([10, 11, 12, 13, 14, 15])
    expect(found[0]!.appPath).toBeUndefined()
    expect(found[3]!.appPath).toBe("/Applications/Codex.app")
    expect(found[4]!.appPath).toBe("/Applications/ChatGPT (Nightly).app")
  })

  test.each(["", "unrecognized output"])("rejects invalid process data: %s", (output) => {
    expect(() => parseCodexProcesses(output)).toThrow()
  })

  test("does not mistake a failed ps command for an idle Codex", async () => {
    const run = mock(async (_args: string[]) => {
      throw new Error("ps denied")
    })
    const decision = await prepareCodexCleanup({ dryRun: false }, createCodexProcessRuntime(run))
    expect(decision.allowed).toBe(false)
    expect(decision.message).toContain("ps denied")
    expect(run.mock.calls).toEqual([[["ps", "-axo", "pid=,comm="]]])
  })
})

describe("Codex process shutdown", () => {
  test("macOS uses escaped app paths and numeric PID signals through osascript", async () => {
    const run = mock(async (_args: string[]) => "")
    const runtime = createCodexProcessRuntime(run, "darwin")
    const appPath = '/Applications/Codex "Nightly".app'
    await runtime.quitApps([
      { ...processes[0]!, appPath },
      { pid: 23456, executable: "Codex Helper", appPath },
    ])
    await runtime.terminate(processes, "TERM")
    await runtime.terminate(processes, "KILL")
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      [
        "osascript",
        "-e",
        'if application "/Applications/Codex \\"Nightly\\".app" is running then tell application "/Applications/Codex \\"Nightly\\".app" to quit',
      ],
      ["osascript", "-e", 'do shell script "/bin/kill -TERM 12345"'],
      ["osascript", "-e", 'do shell script "/bin/kill -KILL 12345"'],
    ])
  })

  test("non-macOS cleanup signals only inspected PIDs without AppleScript", async () => {
    const run = mock(async (_args: string[]) => "")
    const runtime = createCodexProcessRuntime(run, "linux")
    await runtime.quitApps(processes)
    await runtime.terminate(processes, "TERM")
    expect(run.mock.calls).toEqual([[["/bin/kill", "-TERM", "12345"]]])
  })

  test.each([0, -1, 1.5, process.pid])("rejects unsafe kill target %s", async (pid) => {
    const run = mock(async (_args: string[]) => "")
    const runtime = createCodexProcessRuntime(run, "darwin")
    await expect(runtime.terminate([{ pid, executable: "codex" }], "KILL")).rejects.toThrow(
      "unsafe"
    )
    expect(run).not.toHaveBeenCalled()
  })

  test("force escalates after a refused quit and verifies exit after KILL", async () => {
    let running = true
    const terminate = mock(async (_processes: CodexProcess[], signal: "TERM" | "KILL") => {
      if (signal === "KILL") running = false
    })
    const decision = await prepareCodexCleanup(
      { force: true, dryRun: false },
      {
        inspect: async () => (running ? processes : []),
        quitApps: async () => {
          throw new Error("quit refused")
        },
        terminate,
        wait: async () => {},
      }
    )
    expect(decision).toMatchObject({ allowed: true, stopped: true })
    expect(terminate.mock.calls).toEqual([
      [processes, "TERM"],
      [processes, "KILL"],
    ])
  })

  test("losing process visibility during shutdown keeps cleanup blocked", async () => {
    let checks = 0
    const decision = await prepareCodexCleanup(
      { force: true, dryRun: false },
      {
        inspect: async () => {
          if (++checks === 1) return processes
          throw new Error("inspection lost")
        },
        quitApps: async () => {},
        terminate: async () => {},
        wait: async () => {},
      }
    )
    expect(decision.allowed).toBe(false)
    expect(decision.message).toContain("inspection lost")
  })
})
