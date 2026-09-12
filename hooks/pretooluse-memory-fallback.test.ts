import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { withGitClient } from "../src/git/client.ts"
import { MockGitClient } from "../src/git/mock-client.ts"
import {
  createEnforcementProjectDir,
  runHookInProcess,
  useTempDir,
} from "../src/utils/test-utils.ts"

const { create } = useTempDir("swiz-memory-fallback-")
const reminder = {
  type: "user",
  message: {
    content:
      "Stop hook feedback: record a DO or DON'T rule that proactively builds the required steps into your standard development workflow.",
  },
}

function completed(name: string, input: Record<string, unknown>, failed = false, extra = {}) {
  const id = crypto.randomUUID()
  return [
    {
      type: "assistant",
      timestamp: new Date().toISOString(),
      ...extra,
      message: { content: [{ type: "tool_use", id, name, input }] },
    },
    {
      type: "user",
      ...extra,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: failed,
            content: failed ? "Advisory setup failed: runtime or analyzer unavailable" : "Success",
          },
        ],
      },
    },
  ]
}

async function fixture() {
  const git = new MockGitClient((args) => (args[0] === "rev-parse" ? ".git\n" : ""))
  const cwd = await withGitClient(git, () => createEnforcementProjectDir(create))
  // Canonical project identity uses filesystem discovery, independent of the Git mock.
  await mkdir(join(cwd, ".git"))
  const home = await create()
  const skillPath = join(cwd, ".skills/update-memory/SKILL.md")
  await Bun.write(skillPath, "---\nname: update-memory\n---\nRecord a project rule.\n")
  const payload = {
    cwd,
    session_id: crypto.randomUUID(),
    _agent: "claude",
    transcript_path: join(cwd, "transcript.jsonl"),
  }
  async function run(gate: string, lines: unknown[], filePath = "src/app.ts", toolName = "Edit") {
    await Bun.write(payload.transcript_path, lines.map((line) => JSON.stringify(line)).join("\n"))
    const result = await withGitClient(git, () =>
      runHookInProcess(
        `hooks/${gate}.ts`,
        {
          ...payload,
          tool_name: toolName,
          tool_input: { file_path: join(cwd, filePath), new_string: "rule" },
        },
        { env: { HOME: home, CODEX_HOME: join(home, ".codex") } }
      )
    )
    expect(result.exitCode).toBe(0)
    return result.json?.hookSpecificOutput as Record<string, string> | undefined
  }
  return { cwd, skillPath, run }
}

const fileGate = "pretooluse-claude-md-update-memory-gate"
const captureGate = "pretooluse-update-memory-enforcement"

describe("memory fallback across both gates", () => {
  test("successful direct read after failed setup permits memory edit and requires completed write", async () => {
    const { cwd, skillPath, run } = await fixture()
    const failed = [reminder, ...completed("Skill", { skill: "update-memory" }, true)]
    expect((await run(fileGate, failed, "CLAUDE.md"))?.permissionDecision).toBe("deny")
    const denial = await run(captureGate, failed)
    expect(denial?.permissionDecision).toBe("deny")
    expect(denial?.permissionDecisionReason).toContain(skillPath)
    const read = [...failed, ...completed("Read", { file_path: skillPath })]
    expect((await run(fileGate, read, "CLAUDE.md"))?.permissionDecision).toBe("allow")
    expect((await run(captureGate, read, "CLAUDE.md"))?.permissionDecision).not.toBe("deny")
    expect((await run(captureGate, read))?.permissionDecision).toBe("deny")
    const write = { file_path: join(cwd, "CLAUDE.md"), content: "DO: follow the skill." }
    expect(
      (await run(captureGate, [...read, ...completed("Write", write, true)]))?.permissionDecision
    ).toBe("deny")
    expect(
      (await run(captureGate, [...read, ...completed("Write", write)]))?.permissionDecision
    ).not.toBe("deny")
  })

  test("successful native invocation also satisfies both skill prerequisites", async () => {
    const { cwd, run } = await fixture()
    const lines = [
      reminder,
      ...completed("Skill", { skill: "update-memory" }),
      ...completed("Write", { file_path: join(cwd, "CLAUDE.md") }),
    ]
    expect((await run(fileGate, lines, "CLAUDE.md"))?.permissionDecision).toBe("allow")
    expect((await run(captureGate, lines))?.permissionDecision).not.toBe("deny")
  })

  test.each([
    "failed",
    "missing-result",
    "stale",
    "other-session",
    "other-cwd",
    "wrong-path",
  ])("rejects %s fallback evidence", async (kind) => {
    const { cwd, skillPath, run } = await fixture()
    let read = completed(
      "Read",
      { file_path: kind === "wrong-path" ? join(cwd, "other/update-memory/SKILL.md") : skillPath },
      kind === "failed",
      kind === "stale"
        ? { timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString() }
        : kind === "other-session"
          ? { sessionId: "another-session" }
          : kind === "other-cwd"
            ? { cwd: join(cwd, "other") }
            : {}
    )
    if (kind === "missing-result") read = read.slice(0, 1)
    const lines = [reminder, ...read, ...completed("Write", { file_path: join(cwd, "CLAUDE.md") })]
    expect((await run(fileGate, lines, "CLAUDE.md"))?.permissionDecision).toBe("deny")
    expect((await run(captureGate, lines))?.permissionDecision).toBe("deny")
  })
})
