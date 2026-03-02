import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { formatActionPlan } from "./hook-utils.ts"

// ─── formatActionPlan unit tests ─────────────────────────────────────────────

describe("formatActionPlan", () => {
  it("returns empty string for empty steps", () => {
    expect(formatActionPlan([])).toBe("")
  })

  it("formats a single step correctly", () => {
    expect(formatActionPlan(["Do the thing"])).toBe("Action plan:\n  1. Do the thing\n")
  })

  it("numbers multiple steps in order", () => {
    const result = formatActionPlan(["Step one", "Step two", "Step three"])
    expect(result).toBe("Action plan:\n  1. Step one\n  2. Step two\n  3. Step three\n")
  })

  it("preserves special characters in step text", () => {
    const result = formatActionPlan(["Run: git commit -m 'fix'", "Use /push skill"])
    expect(result).toBe("Action plan:\n  1. Run: git commit -m 'fix'\n  2. Use /push skill\n")
  })

  it("starts with 'Action plan:' header", () => {
    expect(formatActionPlan(["a"]).startsWith("Action plan:\n")).toBe(true)
  })

  it("ends with a newline when non-empty", () => {
    expect(formatActionPlan(["any step"]).endsWith("\n")).toBe(true)
  })

  it("uses two-space indent for each numbered step", () => {
    const lines = formatActionPlan(["first", "second"]).split("\n")
    expect(lines[1]).toBe("  1. first")
    expect(lines[2]).toBe("  2. second")
  })

  it("handles step text that is an empty string", () => {
    expect(formatActionPlan([""])).toBe("Action plan:\n  1. \n")
  })

  it("preserves unicode in step text", () => {
    const result = formatActionPlan(["日本語", "中文"])
    expect(result).toContain("  1. 日本語")
    expect(result).toContain("  2. 中文")
  })

  it("output from formatActionPlan is appendable alongside a prose prefix", () => {
    // Mirrors how stop-completion-auditor.ts uses it: prose + formatActionPlan(steps)
    const full = `Create tasks to record the work done:\n${formatActionPlan(["TaskCreate", "TaskUpdate"])}`
    expect(full).toBe(
      "Create tasks to record the work done:\nAction plan:\n  1. TaskCreate\n  2. TaskUpdate\n"
    )
  })

  it("translates canonical tool names when agent-aware rendering is requested", () => {
    const originalEnv = { ...process.env }
    process.env = {
      ...process.env,
      CODEX_THREAD_ID: "test-thread",
    }

    try {
      expect(
        formatActionPlan(["Use TaskCreate to create tasks", "Use TaskUpdate to complete them"], {
          translateToolNames: true,
        })
      ).toBe(
        "Action plan:\n  1. Use update_plan to create tasks\n  2. Use update_plan to complete them\n"
      )
    } finally {
      process.env = originalEnv
    }
  })
})

// ─── stop-completion-auditor — audit log path ────────────────────────────────
//
// These tests exercise the `Array.from(latestStatus.values())` branch that was
// previously broken by a spread-on-MapIterator TS2802 error. The hook is run
// as a subprocess with an isolated HOME so it never touches real task files.
//
// To reach the audit log path the tasks directory must exist but contain no
// `.json` task files (only `.audit-log.jsonl`). A transcript with 12 tool
// calls (above TOOL_CALL_THRESHOLD=10) is provided so the fallback blockStop
// fires when the hook doesn't return early.

const HOOK_PATH = resolve(process.cwd(), "hooks/stop-completion-auditor.ts")
const SESSION_ID = "test-auditor-session-abc123"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

/** Set up an isolated HOME with a tasks dir and a transcript above threshold. */
async function createFixture(): Promise<{
  home: string
  tasksDir: string
  transcriptPath: string
}> {
  return createFixtureWithTools(Array.from({ length: 12 }, () => "Read"))
}

async function createFixtureWithTools(toolNames: string[]): Promise<{
  home: string
  tasksDir: string
  transcriptPath: string
}> {
  const home = await mkdtemp(join(tmpdir(), "swiz-auditor-test-"))
  tempDirs.push(home)
  const tasksDir = join(home, ".claude", "tasks", SESSION_ID)
  await mkdir(tasksDir, { recursive: true })

  const lines: string[] = []
  for (const [i, toolName] of toolNames.entries()) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: toolName, id: `t${i}`, input: {} }] },
      })
    )
  }
  const transcriptPath = join(home, "transcript.jsonl")
  await writeFile(transcriptPath, `${lines.join("\n")}\n`)

  return { home, tasksDir, transcriptPath }
}

/** Write an audit log with the given entries. */
async function writeAuditLog(tasksDir: string, entries: object[]): Promise<void> {
  const content = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`
  await writeFile(join(tasksDir, ".audit-log.jsonl"), content)
}

/** Run the auditor hook and return whether it blocked and why. */
async function runAuditor(
  home: string,
  transcriptPath: string,
  envOverrides: Record<string, string> = {}
): Promise<{ blocked: boolean; reason?: string; raw: string }> {
  const payload = JSON.stringify({
    cwd: process.cwd(),
    session_id: SESSION_ID,
    transcript_path: transcriptPath,
  })
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDECODE
  delete env.CURSOR_TRACE_ID
  delete env.GEMINI_CLI
  delete env.GEMINI_PROJECT_DIR
  delete env.CODEX_MANAGED_BY_NPM
  delete env.CODEX_THREAD_ID

  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, ...envOverrides },
  })
  proc.stdin.write(payload)
  proc.stdin.end()
  const raw = await new Response(proc.stdout).text()
  await proc.exited

  const trimmed = raw.trim()
  if (!trimmed) return { blocked: false, raw: "" }
  try {
    const parsed = JSON.parse(trimmed)
    return { blocked: parsed.decision === "block", reason: parsed.reason, raw: trimmed }
  } catch {
    return { blocked: false, raw: trimmed }
  }
}

describe("stop-completion-auditor — audit log / Array.from(latestStatus.values()) path", () => {
  it("allows stop when all tasks are completed via audit log", async () => {
    const { home, tasksDir, transcriptPath } = await createFixture()
    await writeAuditLog(tasksDir, [
      { action: "create", taskId: "1" },
      { action: "status_change", taskId: "1", newStatus: "in_progress" },
      { action: "status_change", taskId: "1", newStatus: "completed" },
    ])
    const result = await runAuditor(home, transcriptPath)
    // created=1, incomplete=0 → returns early (allow stop)
    expect(result.blocked).toBe(false)
  })

  it("falls through to block when latest status is still in_progress", async () => {
    const { home, tasksDir, transcriptPath } = await createFixture()
    await writeAuditLog(tasksDir, [
      { action: "create", taskId: "1" },
      { action: "status_change", taskId: "1", newStatus: "in_progress" },
    ])
    const result = await runAuditor(home, transcriptPath)
    // incomplete=1 → condition false → toolCallCount≥10 → blocks
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("No completed tasks on record")
  })

  it("only the latest status_change per taskId counts — in_progress overwritten by completed", async () => {
    // Regression for Array.from(latestStatus.values()):
    // Map iteration must respect insertion order so the last write wins.
    const { home, tasksDir, transcriptPath } = await createFixture()
    await writeAuditLog(tasksDir, [
      { action: "create", taskId: "42" },
      { action: "status_change", taskId: "42", newStatus: "pending" },
      { action: "status_change", taskId: "42", newStatus: "in_progress" },
      { action: "status_change", taskId: "42", newStatus: "completed" },
    ])
    const result = await runAuditor(home, transcriptPath)
    // Last write is "completed" → incomplete=0 → allow stop
    expect(result.blocked).toBe(false)
  })

  it("correctly counts incomplete across multiple tasks — one completed, one still pending", async () => {
    const { home, tasksDir, transcriptPath } = await createFixture()
    await writeAuditLog(tasksDir, [
      { action: "create", taskId: "1" },
      { action: "status_change", taskId: "1", newStatus: "completed" },
      { action: "create", taskId: "2" },
      { action: "status_change", taskId: "2", newStatus: "pending" },
    ])
    const result = await runAuditor(home, transcriptPath)
    // incomplete=1 (task 2 is pending) → blocks
    expect(result.blocked).toBe(true)
  })

  it("gracefully ignores invalid JSON lines in audit log", async () => {
    const { home, tasksDir, transcriptPath } = await createFixture()
    const content =
      JSON.stringify({ action: "create", taskId: "1" }) +
      "\nnot valid json\n{broken: json}\n" +
      JSON.stringify({ action: "status_change", taskId: "1", newStatus: "completed" }) +
      "\n"
    await writeFile(join(tasksDir, ".audit-log.jsonl"), content)
    const result = await runAuditor(home, transcriptPath)
    // Invalid lines filtered; valid entries show completed → allow stop
    expect(result.blocked).toBe(false)
  })

  it("falls through to block when audit log file does not exist", async () => {
    const { home, tasksDir: _tasksDir, transcriptPath } = await createFixture()
    // tasks dir exists but has no .json files and no audit log
    const result = await runAuditor(home, transcriptPath)
    // Bun.file().text() throws → catch swallows → toolCallCount≥10 → blocks
    expect(result.blocked).toBe(true)
  })

  it("falls through when audit log contains no create entries", async () => {
    const { home, tasksDir, transcriptPath } = await createFixture()
    // Status changes with no corresponding create entries
    await writeAuditLog(tasksDir, [
      { action: "status_change", taskId: "1", newStatus: "completed" },
    ])
    const result = await runAuditor(home, transcriptPath)
    // created=0 → condition (created>0 && incomplete===0) is false
    // → toolCallCount≥10 → blocks
    expect(result.blocked).toBe(true)
  })

  it("block reason contains formatActionPlan-formatted step list", async () => {
    const { home, tasksDir: _tasksDir, transcriptPath } = await createFixture()
    // No audit log → falls through to blockStop with formatActionPlan steps
    const result = await runAuditor(home, transcriptPath)
    expect(result.blocked).toBe(true)
    // Verify the numbered action plan appears in the reason
    expect(result.reason).toContain("Action plan:")
    expect(result.reason).toContain("  1. Use TaskCreate")
    expect(result.reason).toContain("  2. Use TaskUpdate")
  })

  it("uses the current agent's task tool alias in the action plan", async () => {
    const { home, tasksDir: _tasksDir, transcriptPath } = await createFixture()
    const result = await runAuditor(home, transcriptPath, {
      CODEX_THREAD_ID: "test-codex-thread",
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("  1. Use update_plan")
    expect(result.reason).toContain("  2. Use update_plan")
  })

  it("recognises update_plan as task activity and does not block when tasks were used", async () => {
    const {
      home,
      tasksDir: _tasksDir,
      transcriptPath,
    } = await createFixtureWithTools(Array.from({ length: 12 }, () => "update_plan"))
    const result = await runAuditor(home, transcriptPath, {
      CODEX_THREAD_ID: "test-codex-thread",
    })
    expect(result.blocked).toBe(false)
  })
})
