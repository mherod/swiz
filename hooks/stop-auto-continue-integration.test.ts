import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { withGitClient } from "../src/git/client.ts"
import { MockGitClient } from "../src/git/mock-client.ts"
import { runHookInProcess, useTempDir } from "../src/utils/test-utils.ts"

const tmp = useTempDir("focused-auto-continue-")

async function runFixture(
  options: { enabled?: boolean; tasks?: boolean; transcript?: string } = {}
) {
  const home = await tmp.create()
  const sessionId = "focused-session"
  if (options.tasks) {
    const taskDir = join(home, ".claude", "tasks", sessionId)
    await mkdir(taskDir, { recursive: true })
    await Bun.write(
      join(taskDir, "1.json"),
      JSON.stringify({ id: "1", status: "pending", subject: "Later work", description: "Later" })
    )
    await Bun.write(
      join(taskDir, "2.json"),
      JSON.stringify({
        id: "2",
        status: "in_progress",
        subject: "Finish the active fix",
        description: "Current",
      })
    )
  }
  const transcriptPath = join(home, "transcript.jsonl")
  if (options.transcript !== undefined) await Bun.write(transcriptPath, options.transcript)
  const git = new MockGitClient()
  const result = await withGitClient(git, () =>
    runHookInProcess(
      "hooks/stop-auto-continue.ts",
      {
        cwd: home,
        session_id: sessionId,
        transcript_path: transcriptPath,
        _effectiveSettings: { autoContinue: options.enabled ?? true },
      },
      { cwd: home, env: { HOME: home, SWIZ_NO_DAEMON: "1", AI_TEST_NO_BACKEND: "1" } }
    )
  )
  return { result, git }
}

describe("auto-continue with isolated external dependencies", () => {
  test("stays quiet when there is no concrete next action", async () => {
    const { result } = await runFixture()
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBeUndefined()
    expect(result.stdout).toBe("")
  })

  test("does not turn an old transcript into invented unfinished work", async () => {
    const { result } = await runFixture({
      transcript: JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Everything is complete." }] },
      }),
    })
    expect(result.decision).toBeUndefined()
  })

  test("resumes only the active task, ahead of pending work", async () => {
    const { result } = await runFixture({ tasks: true })
    expect(result.decision).toBe("block")
    expect(result.reason).toContain("Resume task #2: Finish the active fix")
    expect(result.reason).not.toContain("Later work")
    expect(result.reason).not.toContain("could not identify")
    expect(result.reason).not.toContain("Collaboration/workflow policy finding")
  })

  test("requires explicit continuation opt-in even when tasks remain", async () => {
    const { result, git } = await runFixture({ enabled: false, tasks: true })
    expect(result.decision).toBeUndefined()
    expect(git.calls).toHaveLength(0)
  })
})
