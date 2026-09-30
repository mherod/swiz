import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DISPATCH_TIMEOUTS } from "../dispatch/timeouts.ts"
import { daemonClientTimeoutMs } from "./dispatch-bootstrap.ts"

// PROCESS_CONTRACT_TEST: verifies the dispatch client's timeout fallback (exit code, stdout envelope, stderr notice) at the CLI boundary.
const indexPath = join(process.cwd(), "index.ts")
const tempDirs: string[] = []

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("daemonClientTimeoutMs", () => {
  test("leaves headroom under the agent hook timeout for every event", () => {
    for (const [event, seconds] of Object.entries(DISPATCH_TIMEOUTS)) {
      expect(daemonClientTimeoutMs(event)).toBeLessThan(seconds * 1000)
    }
  })

  test("userPromptSubmit gives up 3s before the 15s agent budget", () => {
    expect(daemonClientTimeoutMs("userPromptSubmit")).toBe(12_000)
  })
})

describe("runThinDispatch daemon timeout", () => {
  test("allows without a local re-run when the daemon hangs", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "swiz-bootstrap-"))
    tempDirs.push(tempDir)
    let requests = 0
    // Accepts the dispatch and never answers, like a daemon stuck on slow hooks.
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        requests++
        return new Promise<Response>(() => {})
      },
    })
    try {
      const started = Date.now()
      const proc = Bun.spawn(["bun", indexPath, "dispatch", "postCompact", "PostCompact"], {
        cwd: tempDir,
        stdin: new Blob([JSON.stringify({ session_id: "s-timeout", cwd: tempDir })]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          HOME: tempDir,
          SWIZ_DIRECT: "1",
          // CI sets SWIZ_NO_DAEMON=1, which would skip the daemon path under test.
          SWIZ_NO_DAEMON: "",
          SWIZ_DAEMON_PORT: String(server.port),
          AI_TEST_NO_BACKEND: "1",
        },
      })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      const elapsed = Date.now() - started

      expect(proc.exitCode).toBe(0)
      expect(requests).toBe(1)
      expect(JSON.parse(stdout.trim())).toEqual({})
      expect(stderr).toContain("allowing without local re-run")
      // Must finish inside the 10s agent budget for postCompact.
      expect(elapsed).toBeLessThan(DISPATCH_TIMEOUTS.postCompact! * 1000)
    } finally {
      await server.stop(true)
    }
  }, 20_000)
})
