import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "../utils/test-utils.ts"
import { normalizeDaemonArgs, validateDaemonArgs } from "./daemon.ts"

// PROCESS_CONTRACT_TEST: a daemon started on an occupied port exits non-zero with a startup diagnostic.
const temp = useTempDir("swiz-daemon-startup-")
const indexPath = join(process.cwd(), "index.ts")

describe("validateDaemonArgs", () => {
  it("accepts every documented flag", () => {
    expect(() => validateDaemonArgs([])).not.toThrow()
    expect(() => validateDaemonArgs(["--port", "7943", "--restart"])).not.toThrow()
    expect(() => validateDaemonArgs(["status"])).not.toThrow()
    expect(() => validateDaemonArgs(["--install"])).not.toThrow()
    expect(() => validateDaemonArgs(["--uninstall"])).not.toThrow()
  })

  it("accepts subcommands as bare words or flags", () => {
    expect(normalizeDaemonArgs(["restart", "--port", "7943"])).toEqual([
      "--restart",
      "--port",
      "7943",
    ])
    expect(normalizeDaemonArgs(["install"])).toEqual(["--install"])
    expect(normalizeDaemonArgs(["uninstall"])).toEqual(["--uninstall"])
    expect(normalizeDaemonArgs(["--status"])).toEqual(["status"])
    for (const word of ["restart", "install", "uninstall", "--status"]) {
      expect(() => validateDaemonArgs(normalizeDaemonArgs([word]))).not.toThrow()
    }
  })

  it("still rejects a misspelled subcommand after normalising", () => {
    expect(() => validateDaemonArgs(normalizeDaemonArgs(["restrat"]))).toThrow(
      'unknown argument "restrat".'
    )
  })

  it("rejects unknown arguments and a missing port", () => {
    expect(() => validateDaemonArgs(["--bogus"])).toThrow('unknown argument "--bogus".')
    expect(() => validateDaemonArgs(["--port"])).toThrow("--port requires a numeric port")
  })
})

describe("daemon startup failure", () => {
  // PROCESS_CONTRACT_TEST: startup must exit non-zero without lingering when its port is occupied.
  it("exits non-zero instead of idling when the port is taken", async () => {
    const cwd = await temp.create()
    const blocker = Bun.serve({ port: 0, fetch: () => new Response("x") })
    try {
      const proc = Bun.spawn(["bun", indexPath, "daemon", "--port", String(blocker.port)], {
        cwd,
        env: { ...process.env, HOME: cwd, SWIZ_DIRECT: "1", AI_TEST_NO_BACKEND: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const timer = setTimeout(() => proc.kill(), 30_000)
      const [, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      clearTimeout(timer)
      expect(proc.signalCode).toBeNull()
      expect(proc.exitCode).toBe(1)
      expect(stderr).toContain("swiz daemon:")
    } finally {
      await blocker.stop(true)
    }
  }, 40_000)
})
