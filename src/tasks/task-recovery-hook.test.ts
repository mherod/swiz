import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import {
  evaluatePretooluseEnforceTaskupdate,
  evaluatePretooluseRequireTasks,
  evaluatePretooluseTaskGovernance,
} from "../../hooks/pretooluse-task-governance.ts"
import { hookOutputSchema } from "../schemas.ts"
import { taskListSyncSentinelPath } from "../temp-paths.ts"
import * as autoSteerHelpers from "../utils/auto-steer-helpers.ts"
import { buildEffectiveTestSettings, useTempDir } from "../utils/test-utils.ts"

const temp = useTempDir("swiz-task-recovery-hook-")
const sessionIds: string[] = []
let autoSteer: ReturnType<typeof spyOn<typeof autoSteerHelpers, "scheduleAutoSteer">>

beforeAll(() => {
  autoSteer = spyOn(autoSteerHelpers, "scheduleAutoSteer").mockResolvedValue(false)
})

afterAll(async () => {
  autoSteer.mockRestore()
  for (const sessionId of sessionIds) {
    const sentinel = Bun.file(taskListSyncSentinelPath(sessionId))
    if (await sentinel.exists()) await sentinel.delete()
  }
})

async function fixture(taskCount = 0, taskStatus = "in_progress") {
  const taskHome = await temp.create()
  const cwd = join(taskHome, "project")
  const sessionId = crypto.randomUUID()
  sessionIds.push(sessionId)
  const timestamp = new Date().toISOString()
  const transcriptPath = join(taskHome, "transcript.jsonl")
  await Bun.write(join(cwd, "CLAUDE.md"), "Track implementation with native tasks.\n")
  await Bun.write(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp,
      message: { content: [{ type: "tool_use", id: "task-list", name: "TaskList", input: {} }] },
    })}\n`
  )
  for (let index = 1; index <= taskCount; index++) {
    await Bun.write(
      join(taskHome, ".claude", "tasks", sessionId, `${index}.json`),
      JSON.stringify({
        id: String(index),
        subject: `Inspect recovery case ${index}`,
        description: "Native session task fixture",
        status: taskStatus,
        statusChangedAt: timestamp,
        blocks: [],
        blockedBy: [],
      })
    )
  }
  return {
    session_id: sessionId,
    cwd,
    transcript_path: transcriptPath,
    tool_name: "Bash",
    tool_input: { command: "swiz tasks recover --all-sessions" },
    _agent: "claude",
    _env: { CLAUDECODE: "1" },
    _taskHome: taskHome,
    _lastUserMessageAt: 0,
    _effectiveSettings: buildEffectiveTestSettings({
      auditStrictness: "strict",
      autoContinue: true,
      autoSteer: false,
    }),
    _repositoryCapability: {
      canonicalRoot: cwd,
      repoKey: sessionId,
      isRepo: true,
      repoSlug: null,
      hasGhCli: false,
      resolvedAt: Date.now(),
    },
    _currentSessionToolUsage: {
      toolNames: ["TaskList"],
      skillInvocations: [],
      events: [{ kind: "tool", value: "TaskList", turnIndex: 1, timestamp }],
    },
  }
}

function decision(result: unknown) {
  return hookOutputSchema.parse(result).hookSpecificOutput?.permissionDecision
}

describe("task recovery reaches the CLI", () => {
  test.each([
    "swiz",
    "/usr/local/bin/swiz",
    "bun run index.ts",
  ])("%s permits recovery while routine task commands remain denied", async (launcher) => {
    const input = await fixture()
    const evaluate = (command: string) =>
      evaluatePretooluseEnforceTaskupdate({ ...input, tool_input: { command } })

    expect(decision(await evaluate(`${launcher} tasks list`))).toBe("deny")
    expect(decision(await evaluate(`${launcher} tasks recover --all-sessions`))).toBe("allow")
    expect(
      decision(
        await evaluate(`${launcher} tasks recover status 1 cancelled --session ${input.session_id}`)
      )
    ).toBe("allow")
  })
})

describe("task recovery remains reachable below task minimums", () => {
  const evaluators = [
    { name: "standalone task requirement", evaluate: evaluatePretooluseRequireTasks },
    {
      name: "merged task governance",
      evaluate: evaluatePretooluseTaskGovernance,
    },
  ]

  for (const { name, evaluate } of evaluators) {
    test.each([0, 1])(`${name} permits recovery with %i native tasks`, async (taskCount) => {
      const input = await fixture(taskCount)
      const control = { ...input, tool_input: { command: "bun run build" } }
      expect(decision(await evaluate(control))).toBe("deny")
      expect(decision(await evaluate(input))).not.toBe("deny")
    })

    test(`${name} permits recovery without recent TaskList synchronization`, async () => {
      const input = await fixture()
      input._currentSessionToolUsage = { toolNames: [], skillInvocations: [], events: [] }
      await Bun.write(input.transcript_path, "")
      const control = { ...input, tool_input: { command: "bun run build" } }
      expect(decision(await evaluate(control))).toBe("deny")
      expect(decision(await evaluate(input))).not.toBe("deny")
    })

    test(`${name} permits recovery while the pending queue overflows`, async () => {
      const input = await fixture(21, "pending")
      const control = { ...input, tool_input: { command: "bun run build" } }
      expect(decision(await evaluate(control))).toBe("deny")
      expect(decision(await evaluate(input))).not.toBe("deny")
    })

    test.each([
      "swiz tasks recover --all-sessions && bun run build",
      "bun run build; swiz tasks recover --all-sessions",
    ])(`${name} keeps mixed command chains gated: %s`, async (command) => {
      const input = await fixture()
      expect(decision(await evaluate({ ...input, tool_input: { command } }))).toBe("deny")
    })
  }
})

describe("task recovery preserves native task-file protection", () => {
  test("denies direct shell access even when chained after recovery", async () => {
    const input = await fixture()
    for (const evaluate of [
      evaluatePretooluseEnforceTaskupdate,
      evaluatePretooluseRequireTasks,
      evaluatePretooluseTaskGovernance,
    ]) {
      const result = await evaluate({
        ...input,
        tool_input: {
          command: `swiz tasks recover --all-sessions && cat ~/.claude/tasks/${input.session_id}/1.json`,
        },
      })
      expect(decision(result)).toBe("deny")
      expect(hookOutputSchema.parse(result).hookSpecificOutput?.permissionDecisionReason).toContain(
        ".claude/tasks"
      )
    }
  })
})
