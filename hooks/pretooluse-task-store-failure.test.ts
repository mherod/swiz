import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../src/project-key.ts"
import type { SwizHookOutput } from "../src/SwizHook.ts"
import governance, {
  requireTasksHook,
  requireTasksRunAsMainOptions,
} from "./pretooluse-task-governance.ts"

let home: string
let cwd: string
let stores: string[]

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "swiz-task-store-failure-"))
  cwd = join(home, "project")
  await mkdir(cwd)
  await Bun.write(join(cwd, "CLAUDE.md"), "Test project")
  const key = projectKeyFromCwd(cwd)
  const root = join(home, ".claude", "tasks")
  stores = [join(root, key), join(root, ".projects", key)]
  const namespaced = stores[1]!
  await mkdir(namespaced, { recursive: true })
  await Bun.write(
    join(namespaced, "1.json"),
    JSON.stringify({ id: "1", subject: namespaced, status: "pending" })
  )
  // Coexisting valid directories now have a readable flat winner. A symlink
  // at the flat address is still refused and exercises actual read failure.
  await symlink(namespaced, stores[0]!)
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

function payload(tool_name: string, tool_input: Record<string, unknown> = {}) {
  return {
    tool_name,
    tool_input,
    session_id: `failure-isolation-${home.split("/").at(-1)}`,
    cwd,
    _taskHome: home,
    _env: { CLAUDECODE: "1" },
    _lastUserMessageAt: 0,
    _repositoryCapability: {
      canonicalRoot: cwd,
      repoKey: "fixture",
      isRepo: true,
      repoSlug: null,
      hasGhCli: false,
      resolvedAt: Date.now(),
    },
  }
}

function output(result: SwizHookOutput) {
  return result as {
    hookSpecificOutput?: {
      permissionDecision?: string
      permissionDecisionReason?: string
      additionalContext?: string
    }
  }
}

describe("task-store failure isolation", () => {
  test.each([
    "Read",
    "SendMessage",
    "Bash",
    "Edit",
    "Write",
    "TaskList",
    "mcp__swiz__TaskList",
  ])("keeps %s available without modifying either store", async (tool) => {
    const before = await Promise.all(stores.map((dir) => Bun.file(join(dir, "1.json")).text()))
    const result = output(
      await governance.run(
        payload(tool, { command: "git status --short", file_path: "src/example.ts" })
      )
    )
    expect(result.hookSpecificOutput?.permissionDecision).toBe("allow")
    expect(result.hookSpecificOutput?.additionalContext).toContain("Task state unavailable")
    expect(result.hookSpecificOutput?.additionalContext).toContain("Task store is not a directory")
    expect(await Promise.all(stores.map((dir) => Bun.file(join(dir, "1.json")).text()))).toEqual(
      before
    )
    for (const dir of stores) expect(await readdir(dir)).toEqual(["1.json"])
  })

  test.each([
    "TaskCreate",
    "TaskUpdate",
    "TodoWrite",
    "mcp__swiz__TaskCreate",
    "mcp__swiz__TaskUpdate",
  ])("denies %s when task state cannot be validated", async (tool) => {
    const result = output(
      await governance.run(payload(tool, { taskId: "1", subject: "Inspect fixture" }))
    )
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("Task state unavailable")
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain(
      "pretooluse-task-governance"
    )
  })

  test("governance permits the advertised diagnostic command repeatedly", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = output(
        await governance.run(
          payload("Bash", { command: "cat hooks/pretooluse-task-governance.ts" })
        )
      )
      expect(result.hookSpecificOutput?.permissionDecision).toBe("allow")
      expect(result.hookSpecificOutput?.additionalContext).toContain(governance.name)
      expect(result.hookSpecificOutput?.additionalContext).toContain(
        "cat hooks/pretooluse-task-governance.ts"
      )
    }
  })

  // #957: read-only inspection skips the require-tasks gate before any task-store read, so the
  // diagnostic command gets no opinion rather than an allow that would skip the permission prompt.
  test("require-tasks has no opinion on the advertised diagnostic command", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await requireTasksHook.run(
        payload("Bash", { command: "cat hooks/pretooluse-task-governance.ts" })
      )
      expect(result).toEqual({})
    }
  })

  test("trace-only errors use the same policy during the user-message grace window", async () => {
    for (const tool of ["Read", "TaskUpdate"]) {
      const input = { ...payload(tool), _lastUserMessageAt: Date.now() }
      const result = output(await governance.run(input))
      expect(result.hookSpecificOutput?.permissionDecision).toBe(tool === "Read" ? "allow" : "deny")
      expect(result.hookSpecificOutput?.permissionDecisionReason).toContain(
        "Task state unavailable"
      )
      expect(result.hookSpecificOutput?.permissionDecisionReason).toContain(governance.name)
    }
  })

  test.each([
    governance,
    requireTasksHook,
  ])("%s retains direct task-file protection", async (hook) => {
    for (const [tool, input] of [
      ["Edit", { file_path: join(stores[0]!, "1.json") }],
      ["Bash", { command: `cat ${stores[0]}/1.json` }],
    ] as const) {
      const result = output(await hook.run(payload(tool, input)))
      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny")
      expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("managed automatically")
    }
  })

  test("malformed payloads and stdin still fail closed with the correct hook name", async () => {
    const invalid = { ...payload("Read"), tool_input: 123 }
    const result = output(
      await governance.run(invalid as unknown as Parameters<typeof governance.run>[0])
    )
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain(governance.name)
    expect(result.hookSpecificOutput?.permissionDecisionReason).not.toContain(
      "Task state unavailable"
    )
    const stdinResult = output(
      requireTasksRunAsMainOptions.onStdinJsonError!(new SyntaxError("invalid JSON"))
    )
    expect(stdinResult.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(stdinResult.hookSpecificOutput?.permissionDecisionReason).toContain(
      requireTasksHook.name
    )
  })

  test("a different task-read failure also leaves ordinary work available", async () => {
    const brokenHome = join(home, "invalid-namespace")
    const root = join(brokenHome, ".claude", "tasks")
    await mkdir(root, { recursive: true })
    const invalidStore = join(root, projectKeyFromCwd(cwd))
    await Bun.write(invalidStore, "not a directory")
    const result = output(await governance.run({ ...payload("Read"), _taskHome: brokenHome }))
    expect(result.hookSpecificOutput?.permissionDecision).toBe("allow")
    expect(result.hookSpecificOutput?.additionalContext).toContain("Task store is not a directory")
    expect(await Bun.file(invalidStore).text()).toBe("not a directory")
  })

  test("coexisting valid stores keep task tooling available without a read failure", async () => {
    const validHome = join(home, "valid-coexistence")
    const root = join(validHome, ".claude", "tasks")
    const key = projectKeyFromCwd(cwd)
    for (const dir of [join(root, key), join(root, ".projects", key)]) {
      await Bun.write(
        join(dir, "1.json"),
        JSON.stringify({
          id: "1",
          subject: dir,
          status: "pending",
        })
      )
    }
    for (const tool of ["TaskList", "TaskUpdate"]) {
      const result = output(
        await governance.run({
          ...payload(tool, { taskId: "1", subject: "Inspect fixture" }),
          _taskHome: validHome,
        })
      )
      // Available means not denied; the governance trace states no decision (#963).
      expect(result.hookSpecificOutput?.permissionDecision).toBeUndefined()
      expect(result.hookSpecificOutput?.additionalContext).toContain("Tasks:")
      expect(JSON.stringify(result)).not.toContain("Task state unavailable")
    }
    expect(await readdir(join(root, ".projects", key))).toEqual(["1.json"])
  })

  test("an unrelated exception with conflict-like text is not treated as a read failure", async () => {
    const input = {
      ...payload("Read"),
      get tool_input(): never {
        throw new Error("Conflicting task stores: unrelated input failure")
      },
    }
    const result = output(await governance.run(input))
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(result.hookSpecificOutput?.permissionDecisionReason).toContain("unexpected error")
    expect(result.hookSpecificOutput?.permissionDecisionReason).not.toContain(
      "Task state unavailable"
    )
  })

  test("an available empty store still enforces the normal task gate", async () => {
    const result = output(
      await requireTasksHook.run({
        ...payload("Bash", { command: "bun run build" }),
        _taskHome: join(home, "empty-store"),
      })
    )
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(result.hookSpecificOutput?.permissionDecisionReason).not.toContain(
      "Task state unavailable"
    )
  })
})
