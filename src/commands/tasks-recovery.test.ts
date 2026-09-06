import { describe, expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import type { Task } from "../tasks/task-repository.ts"
import { projectKeyFromCwd } from "../transcript-utils.ts"
import { neutralAgentEnvOverrides, runCommandInProcess, useTempDir } from "../utils/test-utils.ts"
import { tasksCommand } from "./tasks.ts"

const { create } = useTempDir("swiz-tasks-recovery-")
const nativeSession = "6132aaaa-1111-2222-3333-444444444444"
const otherSession = "abcd1111-5555-6666-7777-888888888888"

function task(id: string, subject: string): Task {
  return { id, subject, description: "Fixture task", status: "pending", blocks: [], blockedBy: [] }
}

async function writeSession(tasksDir: string, sessionId: string, tasks: Task[]) {
  const directory = join(tasksDir, sessionId)
  await mkdir(directory, { recursive: true })
  for (const value of tasks)
    await Bun.write(join(directory, `${value.id}.json`), JSON.stringify(value))
}

async function fixture() {
  const root = await realpath(await create())
  const home = join(root, "home")
  const cwd = join(root, "workspace")
  const tasksDir = join(home, ".claude", "tasks")
  await mkdir(cwd, { recursive: true })
  const projectSession = projectKeyFromCwd(cwd)
  await writeSession(tasksDir, nativeSession, [
    task("1", "Native phantom skill task"),
    task("6132-2", "Native scoped task"),
  ])
  await writeSession(tasksDir, otherSession, [
    task("1", "Other session task"),
    task("99", "Task only in another session"),
  ])
  await writeSession(tasksDir, projectSession, [task("3", "Project MCP queue task")])
  const projectsDir = join(home, ".claude", "projects", projectSession)
  await mkdir(projectsDir, { recursive: true })
  await Bun.write(
    join(projectsDir, `${projectSession}.jsonl`),
    `${JSON.stringify({ type: "user", cwd })}\n`
  )
  return {
    home,
    cwd,
    tasksDir,
    projectSession,
    env: neutralAgentEnvOverrides({
      HOME: home,
      CODEX_HOME: undefined,
      CLAUDECODE: "1",
      AI_TEST_NO_BACKEND: "1",
      SWIZ_TASKS_SYSTEM_MESSAGE: "0",
    }),
  }
}

async function taskFile(context: Awaited<ReturnType<typeof fixture>>, session: string, id: string) {
  return Bun.file(join(context.tasksDir, session, `${id}.json`)).json()
}

describe("scoped native task recovery", () => {
  test("lists native-session tasks absent from the project MCP queue", async () => {
    const context = await fixture()
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "--session", "6132aaaa"],
      context
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Native phantom skill task")
    expect(result.stdout).not.toContain("Project MCP queue task")
    expect(result.stdout).not.toContain("Other session task")
  })

  test("keeps ordinary task CLI access denied while explicit recovery works", async () => {
    const context = await fixture()
    const denied = await runCommandInProcess(tasksCommand, ["--session", nativeSession], context)
    expect(denied.exitCode).toBe(1)
    expect(denied.stderr).toContain("not available inside Claude Code")
    const recovered = await runCommandInProcess(
      tasksCommand,
      ["recover", "list", "--session", nativeSession],
      context
    )
    expect(recovered.exitCode).toBe(0)
    expect(recovered.stdout).toContain("Native phantom skill task")
  })

  test.each([
    "--all-sessions",
    "--recovered",
  ])("lists recovery with explicit %s scope", async (scope) => {
    const context = await fixture()
    const result = await runCommandInProcess(tasksCommand, ["recover", scope], context)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Native phantom skill task")
    if (scope === "--recovered") expect(result.stdout).not.toContain("Project MCP queue task")
  })

  test("cancels the selected task without changing another session with the same ID", async () => {
    const context = await fixture()
    const otherBefore = await taskFile(context, otherSession, "1")
    const evidence = "note:cancelled a phantom skill step after checking the native session"
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "status", "1", "cancelled", "--session", "6132aaaa", "--evidence", evidence],
      context
    )
    expect(result.exitCode).toBe(0)
    expect((await taskFile(context, nativeSession, "1")).status).toBe("cancelled")
    expect(await taskFile(context, otherSession, "1")).toEqual(otherBefore)
    expect(
      await Bun.file(join(context.tasksDir, nativeSession, ".audit-log.jsonl")).text()
    ).toContain(evidence)
  })

  test("updates multiple existing IDs in the selected session", async () => {
    const context = await fixture()
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "update", "1", "6132-2", "--status", "cancelled", "--session", nativeSession],
      context
    )
    expect(result.exitCode).toBe(0)
    expect((await taskFile(context, nativeSession, "1")).status).toBe("cancelled")
    expect((await taskFile(context, nativeSession, "6132-2")).status).toBe("cancelled")
    expect((await taskFile(context, otherSession, "1")).status).toBe("pending")
  })

  test("preflights every update ID before changing any task", async () => {
    const context = await fixture()
    const before = await taskFile(context, nativeSession, "1")
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "update", "1", "99", "--status", "cancelled", "--session", nativeSession],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("99")
    expect(result.stderr).toContain(nativeSession)
    expect(await taskFile(context, nativeSession, "1")).toEqual(before)
    expect((await taskFile(context, otherSession, "99")).status).toBe("pending")
  })

  test.each([
    "complete",
    "status",
    "update",
  ])("%s rejects an ID found only in another session", async (command) => {
    const context = await fixture()
    const change =
      command === "status"
        ? ["cancelled"]
        : command === "update"
          ? ["--subject", "Recovered task"]
          : []
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", command, "99", ...change, "--session", nativeSession],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("99")
    expect(result.stderr).toContain(nativeSession)
    expect((await taskFile(context, otherSession, "99")).status).toBe("pending")
    expect(await Bun.file(join(context.tasksDir, nativeSession, "99.json")).exists()).toBe(false)
  })

  test("rejects a mismatched prefixed ID even when copied into the selected session", async () => {
    const context = await fixture()
    for (const sessionId of [nativeSession, otherSession]) {
      await Bun.write(
        join(context.tasksDir, sessionId, "abcd-7.json"),
        JSON.stringify(task("abcd-7", "Copied task"))
      )
    }
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "status", "abcd-7", "cancelled", "--session", nativeSession],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("prefix")
    for (const sessionId of [nativeSession, otherSession]) {
      expect((await taskFile(context, sessionId, "abcd-7")).status).toBe("pending")
    }
  })

  test.each([
    { label: "missing session", scope: [] },
    { label: "empty session", scope: ["--session", ""] },
    { label: "flag instead of session", scope: ["--session", "--all-sessions"] },
    { label: "unknown session", scope: ["--session", "missing-session"] },
    {
      label: "duplicate session flag",
      scope: ["--session", nativeSession, "--session", otherSession],
    },
  ])("rejects mutation with $label", async ({ scope }) => {
    const context = await fixture()
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "status", "1", "cancelled", ...scope],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("session")
    expect((await taskFile(context, nativeSession, "1")).status).toBe("pending")
    expect((await taskFile(context, otherSession, "1")).status).toBe("pending")
  })

  test("rejects ambiguous session prefixes before writing", async () => {
    const context = await fixture()
    const ambiguousSession = "6132bbbb-1111-2222-3333-444444444444"
    await writeSession(context.tasksDir, ambiguousSession, [task("1", "Ambiguous task")])
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "status", "1", "cancelled", "--session", "6132"],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("ambiguous")
    expect((await taskFile(context, nativeSession, "1")).status).toBe("pending")
    expect((await taskFile(context, ambiguousSession, "1")).status).toBe("pending")
  })

  test.each([
    { label: "default list", args: [] },
    { label: "list alias", args: ["list"] },
    { label: "all projects", args: ["--all-projects"] },
  ])("requires explicit listing scope for $label", async ({ args }) => {
    const context = await fixture()
    const result = await runCommandInProcess(tasksCommand, ["recover", ...args], context)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("--session")
    expect(result.stderr).toContain("--all-sessions")
  })

  test.each([
    "create",
    "adopt",
    "recover",
    "TaskCreate",
    "TaskUpdate",
    "unknown",
  ])("rejects recovery command %s", async (command) => {
    const context = await fixture()
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", command, "1", "--session", nativeSession],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(command)
    expect((await taskFile(context, nativeSession, "1")).status).toBe("pending")
  })

  test("supports complete dry run without changing the task", async () => {
    const context = await fixture()
    const before = await taskFile(context, nativeSession, "1")
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "complete", "1", "--session", nativeSession, "--dry-run"],
      context
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("found")
    expect(await taskFile(context, nativeSession, "1")).toEqual(before)
  })

  test("preserves completion subject verification", async () => {
    const context = await fixture()
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "complete", "1", "--session", nativeSession, "--verify", "Wrong subject"],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Verification failed")
    expect((await taskFile(context, nativeSession, "1")).status).toBe("pending")
  })

  test("supports scoped audit repair dry run without reconstructing a file", async () => {
    const context = await fixture()
    await Bun.write(
      join(context.tasksDir, nativeSession, ".audit-log.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), taskId: "404", action: "create", subject: "Audit task", newStatus: "pending" })}\n`
    )
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "repair", "--session", nativeSession, "--dry-run", "--json"],
      context
    )
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).sessionId).toBe(nativeSession)
    expect(JSON.parse(result.stdout).dryRun).toBe(true)
    expect(await Bun.file(join(context.tasksDir, nativeSession, "404.json")).exists()).toBe(false)
  })

  test("rejects an unsafe embedded task ID before writing another session", async () => {
    const context = await fixture()
    const unsafeId = `6132-x/../../${otherSession}/1`
    await Bun.write(
      join(context.tasksDir, nativeSession, "legacy.json"),
      JSON.stringify(task(unsafeId, "Malformed legacy task"))
    )
    const before = await taskFile(context, otherSession, "1")
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "status", unsafeId, "cancelled", "--session", nativeSession],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Unsafe recovery task ID")
    expect(await taskFile(context, otherSession, "1")).toEqual(before)
    expect((await taskFile(context, nativeSession, "legacy")).status).toBe("pending")
  })

  test("preflights unsafe repair audit IDs before any reconstruction or cross-session write", async () => {
    const context = await fixture()
    const before = await taskFile(context, otherSession, "1")
    const entries = ["404", `../${otherSession}/1`].map((taskId) => ({
      timestamp: new Date().toISOString(),
      taskId,
      action: "create",
      subject: "Audited task",
      newStatus: "pending",
    }))
    await Bun.write(
      join(context.tasksDir, nativeSession, ".audit-log.jsonl"),
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
    )
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "repair", "--session", nativeSession],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Unsafe recovery task ID")
    expect(await taskFile(context, otherSession, "1")).toEqual(before)
    expect(await Bun.file(join(context.tasksDir, nativeSession, "404.json")).exists()).toBe(false)
  })

  test.each([
    false,
    true,
  ])("requires the exact task file to contain its requested ID: file exists=%s", async (fileExists) => {
    const context = await fixture()
    await Bun.write(
      join(context.tasksDir, nativeSession, "legacy.json"),
      JSON.stringify(task("7", "Legacy mismatched filename"))
    )
    if (fileExists) {
      await Bun.write(
        join(context.tasksDir, nativeSession, "7.json"),
        JSON.stringify(task("8", "Mismatched embedded ID"))
      )
    }
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "status", "7", "cancelled", "--session", nativeSession],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("matching task file")
    expect((await taskFile(context, nativeSession, "legacy")).status).toBe("pending")
    if (fileExists) {
      expect((await taskFile(context, nativeSession, "7")).id).toBe("8")
    } else {
      expect(await Bun.file(join(context.tasksDir, nativeSession, "7.json")).exists()).toBe(false)
    }
  })

  test.each([
    { label: "empty ID", id: "" },
    { label: "non-string ID", id: 12 },
    { label: "missing ID", id: undefined },
    { label: "backslash separator", id: "6132-1\\nested" },
    { label: "hidden metadata filename", id: ".session-meta" },
    { label: "reserved snapshot filename", id: "compact-snapshot" },
  ])("rejects repair with $label", async ({ id }) => {
    const context = await fixture()
    await Bun.write(
      join(context.tasksDir, nativeSession, ".audit-log.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), taskId: id, action: "create", subject: "Malformed audit task", newStatus: "pending" })}\n`
    )
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "repair", "--session", nativeSession],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Unsafe recovery task ID")
    expect((await taskFile(context, nativeSession, "1")).status).toBe("pending")
  })

  test("rejects repair audit IDs whose native prefix names another session", async () => {
    const context = await fixture()
    await Bun.write(
      join(context.tasksDir, nativeSession, ".audit-log.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), taskId: "abcd-7", action: "create", subject: "Wrong session audit task", newStatus: "pending" })}\n`
    )
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "repair", "--session", nativeSession],
      context
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("prefix")
    expect(await Bun.file(join(context.tasksDir, nativeSession, "abcd-7.json")).exists()).toBe(
      false
    )
  })

  test("restores an audited missing record with the selected session prefix", async () => {
    const context = await fixture()
    const before = await taskFile(context, otherSession, "1")
    await Bun.write(
      join(context.tasksDir, nativeSession, ".audit-log.jsonl"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), taskId: "6132-404", action: "create", subject: "Audited native task", newStatus: "pending" })}\n`
    )
    const result = await runCommandInProcess(
      tasksCommand,
      ["recover", "repair", "--session", nativeSession, "--json"],
      context
    )
    expect(result.exitCode).toBe(0)
    expect((await taskFile(context, nativeSession, "6132-404")).subject).toBe("Audited native task")
    expect(await taskFile(context, otherSession, "1")).toEqual(before)
  })
})
