import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { TASK_STATUSES, type Task } from "../tasks/task-repository.ts"
import {
  appendReplyToSink,
  buildMcpCapabilities,
  buildMcpInstructions,
  evaluatePermissionPolicy,
  loadPermissionPolicy,
  readProjectTasksWithPrune,
  summarizeTasks,
} from "./mcp.ts"

describe("TaskList summary", () => {
  const task = (id: string, status: Task["status"]): Task => ({
    id,
    subject: `Task ${id}`,
    description: "",
    status,
    blocks: [],
    blockedBy: [],
  })

  it("buckets every status so the parts sum to the total", () => {
    // The observed failure: 48 tasks reported as pending 2 / inProgress 0 / completed 45, with
    // the one cancelled task counted in `total` but in no bucket. A consumer computing
    // `total - completed - pending - inProgress` then saw a phantom open task.
    const tasks = [
      task("1", "pending"),
      task("2", "in_progress"),
      task("3", "completed"),
      task("4", "completed"),
      task("5", "cancelled"),
    ]
    const summary = summarizeTasks(tasks)

    expect(summary).toEqual({ total: 5, pending: 1, inProgress: 1, completed: 2, cancelled: 1 })
    expect(summary.pending + summary.inProgress + summary.completed + summary.cancelled).toBe(
      summary.total
    )
  })

  it("keeps a bucket for every status in TASK_STATUSES", () => {
    // Guards the next status added to the enum: one task per status must still sum to the total,
    // so a new status cannot silently land outside the buckets the way `cancelled` did.
    const tasks = TASK_STATUSES.map((status, i) => task(String(i), status))
    const summary = summarizeTasks(tasks)
    const bucketed = summary.pending + summary.inProgress + summary.completed + summary.cancelled

    expect(summary.total).toBe(TASK_STATUSES.length)
    expect(bucketed).toBe(summary.total)
  })

  it("returns zeroed buckets for an empty task list", () => {
    expect(summarizeTasks([])).toEqual({
      total: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      cancelled: 0,
    })
  })
})

describe("readProjectTasksWithPrune", () => {
  const STALE_MS = 16 * 60_000 // past the 15-minute COMPLETED_TASK_PRUNE_AGE_MS retention

  async function writeProjectTask(
    tasksDir: string,
    projectKey: string,
    task: Partial<Task> & { id: string; status: Task["status"] }
  ): Promise<string> {
    const dir = join(tasksDir, projectKey)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `${task.id}.json`)
    await writeFile(
      filePath,
      JSON.stringify({
        subject: `Task ${task.id}`,
        description: "",
        blocks: [],
        blockedBy: [],
        ...task,
      })
    )
    return filePath
  }

  it("prunes stale completed tasks from the project store on read", async () => {
    const tasksDir = await mkdtemp(join(tmpdir(), "swiz-mcp-prune-"))
    const projectKey = "proj-key"
    const stalePath = await writeProjectTask(tasksDir, projectKey, {
      id: "1",
      status: "completed",
      completedAt: Date.now() - STALE_MS,
    })
    const freshPath = await writeProjectTask(tasksDir, projectKey, {
      id: "2",
      status: "completed",
      completedAt: Date.now(),
    })
    const openPath = await writeProjectTask(tasksDir, projectKey, { id: "3", status: "pending" })

    const tasks = await readProjectTasksWithPrune(projectKey, tasksDir)

    expect(tasks.map((t) => t.id)).toEqual(["2", "3"])
    expect(await Bun.file(stalePath).exists()).toBe(false)
    expect(await Bun.file(freshPath).exists()).toBe(true)
    expect(await Bun.file(openPath).exists()).toBe(true)
  })

  it("returns without pruning when the project key escapes the store", async () => {
    const tasksDir = await mkdtemp(join(tmpdir(), "swiz-mcp-prune-escape-"))
    const tasks = await readProjectTasksWithPrune("../outside", tasksDir)
    expect(tasks).toEqual([])
  })
})

describe("MCP channel setting helpers", () => {
  it("omits channel capabilities when MCP channels are disabled", () => {
    expect(buildMcpCapabilities(false)).toEqual({ tools: {} })
    expect(buildMcpInstructions(false)).not.toContain("<channel")
    expect(buildMcpInstructions(false)).toContain("reply")
  })

  it("includes channel capabilities when MCP channels are enabled", () => {
    expect(buildMcpCapabilities(true).experimental).toEqual({
      "claude/channel": {},
      "claude/channel/permission": {},
    })
    expect(buildMcpInstructions(true)).toContain("<channel")
  })
})

async function writeRawPolicy(cwd: string, content: string): Promise<string> {
  const policyPath = join(cwd, ".swiz", "permission-policy.json")
  await mkdir(dirname(policyPath), { recursive: true })
  await writeFile(policyPath, content)
  return policyPath
}

async function writePolicy(cwd: string, rules: unknown[]): Promise<string> {
  return writeRawPolicy(cwd, JSON.stringify({ rules }))
}

function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  const originalWrite = process.stderr.write
  let stderr = ""
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
    const callback = args.find(
      (arg): arg is (error?: Error | null) => void => typeof arg === "function"
    )
    callback?.()
    return true
  }) as typeof process.stderr.write
  try {
    return { result: fn(), stderr }
  } finally {
    process.stderr.write = originalWrite
  }
}

describe("loadPermissionPolicy", () => {
  it("treats a missing policy file as an empty policy without noise", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toEqual([])
    expect(stderr).toBe("")
    expect(stderr).not.toContain("permission-policy.json unavailable")
  })

  it("loads and compiles safe patterns once per rule", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    await writePolicy(cwd, [
      {
        tool: "*",
        pattern: "allow-test",
        behavior: "allow",
      },
      {
        tool: "write_file",
        behavior: "deny",
      },
    ])

    const rules = loadPermissionPolicy(cwd)

    expect(rules).toHaveLength(2)
    expect(rules[0]?.patternRegex).toBeInstanceOf(RegExp)
    expect(rules[0]?.pattern).toBe("allow-test")
    expect(evaluatePermissionPolicy(rules, "anything", "this is an allow-test message")).toBe(
      "allow"
    )
    expect(evaluatePermissionPolicy(rules, "write_file", "any input")).toBe("deny")
  })

  it("skips unsafe regex patterns and keeps the rest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    const policyPath = await writePolicy(cwd, [
      {
        tool: "*",
        pattern: "(a+)+",
        behavior: "deny",
      },
      {
        tool: "read_file",
        pattern: "safe-read",
        behavior: "allow",
      },
    ])

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toHaveLength(1)
    expect(rules[0]?.tool).toBe("read_file")
    expect(rules[0]?.pattern).toBe("safe-read")
    expect(evaluatePermissionPolicy(rules, "read_file", "safe-read")).toBe("allow")
    expect(stderr).toContain(
      `swiz mcp: permission-policy.json at ${policyPath} skipped unsafe pattern "(a+)+"`
    )
    expect(stderr).toContain("unsupported constructs were rejected")
  })

  it("keeps file valid when one rule has invalid regex syntax", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    const policyPath = await writePolicy(cwd, [
      {
        tool: "edit",
        pattern: "(unclosed",
        behavior: "deny",
      },
      {
        tool: "grep",
        pattern: "safe",
        behavior: "allow",
      },
    ])

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toHaveLength(1)
    expect(rules[0]?.tool).toBe("grep")
    expect(rules[0]?.pattern).toBe("safe")
    expect(stderr).toContain(
      `swiz mcp: permission-policy.json at ${policyPath} skipped unsafe pattern "(unclosed"`
    )
    expect(stderr).toContain("Invalid regular expression")
  })

  it("reports malformed JSON with the policy path and parse reason", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    const policyPath = await writeRawPolicy(cwd, "")

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toEqual([])
    expect(stderr).toContain(`failed to parse permission-policy.json at ${policyPath}`)
    expect(stderr).toContain("Unexpected")
  })

  it("reports schema-invalid rules with the policy path and validation reason", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    const policyPath = await writeRawPolicy(
      cwd,
      JSON.stringify({ rules: [{ tool: "read_file", behavior: "maybe" }] })
    )

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toEqual([])
    expect(stderr).toContain(`permission-policy.json schema invalid at ${policyPath}`)
    expect(stderr).toContain("behavior")
  })

  it("reports policy I/O failures with the policy path and failure reason", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-test-"))
    const policyPath = join(cwd, ".swiz", "permission-policy.json")
    await mkdir(policyPath, { recursive: true })

    const { result: rules, stderr } = captureStderr(() => loadPermissionPolicy(cwd))

    expect(rules).toEqual([])
    expect(stderr).toContain(`permission-policy.json unavailable at ${policyPath}`)
    expect(stderr).toMatch(/EISDIR|is a directory|illegal operation/i)
  })
})

describe("appendReplyToSink", () => {
  it("writes a JSONL line to the replies log", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-mcp-reply-test-"))
    await appendReplyToSink("/some/project", { content: "hello", kind: "note" }, home)
    const logPath = join(home, ".swiz", "mcp-replies.jsonl")
    const raw = await readFile(logPath, "utf8")
    const line = JSON.parse(raw.trim())
    expect(line.content).toBe("hello")
    expect(line.kind).toBe("note")
    expect(line.cwd).toBe("/some/project")
    expect(typeof line.ts).toBe("number")
  })

  it("appends multiple writes in order", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-mcp-reply-order-"))
    await appendReplyToSink("/proj", { content: "first", kind: "note" }, home)
    await appendReplyToSink("/proj", { content: "second", kind: "note" }, home)
    const logPath = join(home, ".swiz", "mcp-replies.jsonl")
    const lines = (await readFile(logPath, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).content).toBe("first")
    expect(JSON.parse(lines[1]!).content).toBe("second")
  })

  it("rejects when the log path is an existing directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "swiz-mcp-reply-fail-"))
    // Occupy the log path with a directory so appendFile fails.
    await mkdir(join(home, ".swiz", "mcp-replies.jsonl"), { recursive: true })
    let threw = false
    try {
      await appendReplyToSink("/proj", { content: "x", kind: "note" }, home)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
