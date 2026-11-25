import { describe, expect, test } from "bun:test"
import {
  type GitClient,
  type GitCommandResult,
  type GitRunOptions,
  withGitClient,
} from "./git/client.ts"
import { git, gitAttempt, MAX_CONCURRENT_GIT_QUERIES } from "./git-helpers.ts"

/** Records how git was invoked and lets a test hold queries open. */
class RecordingGitClient implements GitClient {
  syncCalls = 0
  active = 0
  peakActive = 0
  private readonly gates: Array<() => void> = []

  constructor(private readonly hold = false) {}

  async run(args: string[], _options?: GitRunOptions): Promise<GitCommandResult> {
    this.active += 1
    this.peakActive = Math.max(this.peakActive, this.active)
    if (this.hold) await new Promise<void>((resolve) => this.gates.push(resolve))
    this.active -= 1
    return { stdout: `${args.join(" ")}\n`, stderr: "", exitCode: 0 }
  }

  runSync(_args: string[], _options?: GitRunOptions): GitCommandResult {
    this.syncCalls += 1
    return { stdout: "sync\n", stderr: "", exitCode: 0 }
  }

  releaseAll(): void {
    for (const release of this.gates.splice(0)) release()
  }
}

describe("git query helpers do not block the event loop", () => {
  test("git() and gitAttempt() use the asynchronous client path, never the sync spawn", async () => {
    const client = new RecordingGitClient()
    await withGitClient(client, async () => {
      expect(await git(["rev-parse", "HEAD"], "/repo")).toBe("rev-parse HEAD")
      const attempt = await gitAttempt(["config", "--get", "user.name"], "/repo")
      expect(attempt).toMatchObject({ ran: true, exitCode: 0, stdout: "config --get user.name" })
    })
    expect(client.syncCalls).toBe(0)
  })

  test("the event loop keeps running while a git query is in flight", async () => {
    const client = new RecordingGitClient(true)
    await withGitClient(client, async () => {
      const pending = git(["status", "--porcelain"], "/repo")
      // A timer can only fire while the query is outstanding if nothing blocks the thread.
      let timerFired = false
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          timerFired = true
          resolve()
        }, 5)
      )
      expect(timerFired).toBe(true)
      expect(client.active).toBe(1)
      client.releaseAll()
      expect(await pending).toBe("status --porcelain")
    })
  })

  test("concurrent queries are capped and the queued ones still complete", async () => {
    const client = new RecordingGitClient(true)
    await withGitClient(client, async () => {
      const total = MAX_CONCURRENT_GIT_QUERIES * 2 + 3
      const pending = Array.from({ length: total }, (_, index) => git([`q${index}`], "/repo"))
      await Bun.sleep(5)
      expect(client.peakActive).toBe(MAX_CONCURRENT_GIT_QUERIES)
      // Drain in waves: each release frees slots for the queued queries.
      for (let wave = 0; wave < 4; wave++) {
        client.releaseAll()
        await Bun.sleep(5)
      }
      const results = await Promise.all(pending)
      expect(results).toHaveLength(total)
      expect(results[total - 1]).toBe(`q${total - 1}`)
      expect(client.peakActive).toBe(MAX_CONCURRENT_GIT_QUERIES)
      expect(client.active).toBe(0)
    })
  })
})
