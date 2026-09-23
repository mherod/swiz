import { describe, expect, it } from "vitest"
import {
  bootoutLaunchAgent,
  inspectGuiLaunchAgent,
  isLaunchAgentLoaded,
  kickstartLaunchAgent,
  killLaunchAgentProcesses,
  type LaunchAgentRuntime,
} from "./launch-agents"

describe("launch-agents robustness", () => {
  function runtime(
    result: { exitCode: number; stdout?: string; stderr?: string },
    calls: string[][] = [],
    killed: number[] = []
  ): LaunchAgentRuntime {
    return {
      run(command) {
        calls.push(command)
        return Promise.resolve({
          exitCode: result.exitCode,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        })
      },
      kill(pid) {
        killed.push(pid)
      },
      getUid() {
        return 42
      },
    }
  }

  it("isLaunchAgentLoaded maps the mocked launchctl status to a boolean", async () => {
    const calls: string[][] = []
    const result = await isLaunchAgentLoaded("com.apple.Finder", runtime({ exitCode: 0 }, calls))

    expect(result).toBe(true)
    expect(calls).toEqual([["launchctl", "list", "com.apple.Finder"]])
  })

  it("parses GUI job identity using the runtime user's domain", async () => {
    const calls: string[][] = []
    expect(
      await inspectGuiLaunchAgent(
        "com.swiz.daemon",
        runtime(
          {
            exitCode: 0,
            stdout:
              "gui/42/com.swiz.daemon = {\n\tstate = running\n\tpid = 123\n\tlast exit code = 0\n}",
          },
          calls
        )
      )
    ).toEqual({ target: "gui/42/com.swiz.daemon", loaded: true, pid: 123, lastExitCode: 0 })
    expect(calls).toEqual([["launchctl", "print", "gui/42/com.swiz.daemon"]])
  })

  it.each(["", "not-a-pid", "0", "-12"])("rejects invalid kickstart PID %j", async (stdout) => {
    await expect(
      kickstartLaunchAgent("com.swiz.daemon", runtime({ exitCode: 0, stdout }))
    ).rejects.toThrow("did not report a replacement PID")
  })

  it("bootoutLaunchAgent returns the mocked exit code and user domain", async () => {
    const calls: string[][] = []
    const result = await bootoutLaunchAgent("non-existent-label", runtime({ exitCode: 3 }, calls))

    expect(result).toBe(3)
    expect(calls).toEqual([["launchctl", "bootout", "gui/42/non-existent-label"]])
  })

  it("killLaunchAgentProcesses kills only PIDs returned by the mocked pgrep", async () => {
    const calls: string[][] = []
    const killed: number[] = []

    await killLaunchAgentProcesses(
      "swiz-daemon",
      runtime({ exitCode: 0, stdout: "123\n456\n" }, calls, killed)
    )

    expect(calls).toEqual([["pgrep", "-f", "swiz-daemon"]])
    expect(killed).toEqual([123, 456])
  })
})
