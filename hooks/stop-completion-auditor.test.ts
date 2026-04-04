import { describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { formatActionPlan } from "../src/action-plan.ts"
import { AGENTS } from "../src/agents.ts"
import { getSessionTasksDir } from "../src/tasks/task-recovery.ts"
import { useTempDir } from "../src/utils/test-utils.ts"

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

  it("supports custom header text", () => {
    expect(formatActionPlan(["Do the thing"], { header: "To resolve:" })).toBe(
      "To resolve:\n  1. Do the thing\n"
    )
  })

  it("still returns empty string for empty steps with custom header", () => {
    expect(formatActionPlan([], { header: "To resolve:" })).toBe("")
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

  it("renders nested sub-steps with letter indices", () => {
    const result = formatActionPlan(["Top step", ["Sub A", "Sub B"], "Next step"])
    expect(result).toBe(
      "Action plan:\n  1. Top step\n     a. Sub A\n     b. Sub B\n  2. Next step\n"
    )
  })

  it("renders deeply nested sub-steps with increasing indent", () => {
    const result = formatActionPlan(["Top", [["Deep A", "Deep B"]]])
    expect(result).toContain("Top")
    expect(result).toContain("Deep A")
    expect(result).toContain("Deep B")
  })

  it("handles mixed flat and nested items", () => {
    const result = formatActionPlan(["Step 1", ["Detail a", "Detail b"], "Step 2", ["Detail c"]])
    expect(result).toContain("  1. Step 1")
    expect(result).toContain("     a. Detail a")
    expect(result).toContain("     b. Detail b")
    expect(result).toContain("  2. Step 2")
    expect(result).toContain("     a. Detail c")
  })

  it("output from formatActionPlan is appendable alongside a prose prefix", () => {
    // Mirrors how stop-completion-auditor.ts uses it: prose + formatActionPlan(steps)
    const full = `No tasks were created this session (12 tool calls made).\n\n${formatActionPlan(["TaskCreate", "TaskUpdate"])}`
    expect(full).toBe(
      "No tasks were created this session (12 tool calls made).\n\nAction plan:\n  1. TaskCreate\n  2. TaskUpdate\n"
    )
  })

  it("translates canonical tool names when agent-aware rendering is requested", () => {
    const originalEnv = { ...process.env }
    process.env = {
      ...process.env,
      CODEX_THREAD_ID: "test-thread",
    }
    delete process.env.CLAUDECODE
    delete process.env.CURSOR_TRACE_ID
    delete process.env.GEMINI_CLI

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

  it("can infer Codex from observed tool names when env detection is unavailable", () => {
    const originalEnv = { ...process.env }
    delete process.env.CLAUDECODE
    delete process.env.CURSOR_TRACE_ID
    delete process.env.GEMINI_CLI
    delete process.env.GEMINI_PROJECT_DIR
    delete process.env.CODEX_MANAGED_BY_NPM
    delete process.env.CODEX_THREAD_ID

    try {
      expect(
        formatActionPlan(["Use TaskCreate to create tasks", "Use TaskUpdate to complete them"], {
          translateToolNames: true,
          observedToolNames: ["shell_command", "apply_patch", "read_file"],
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

const tmp = useTempDir()

/** Set up an isolated HOME with a tasks dir and a transcript above threshold. */
async function createFixture(): Promise<{
  home: string
  tasksDir: string
  transcriptPath: string
}> {
  return await createFixtureWithTools([...Array.from({ length: 12 }, () => "Read"), "TaskList"])
}

async function createFixtureWithTools(toolNames: string[]): Promise<{
  home: string
  tasksDir: string
  transcriptPath: string
}> {
  const home = await tmp.create("swiz-auditor-test-")
  const tasksDir = getSessionTasksDir(SESSION_ID, home)
  if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
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
  for (const agent of AGENTS) {
    for (const v of agent.envVars ?? []) env[v] = ""
  }

  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, ...envOverrides },
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()
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

  it("allows stop when agent lacks task tools (Junie-like)", async () => {
    const { home, tasksDir, transcriptPath } = await createFixture()
    await writeAuditLog(tasksDir, [
      { action: "create", taskId: "1" },
      { action: "status_change", taskId: "1", newStatus: "in_progress" },
    ])
    const result = await runAuditor(home, transcriptPath, {
      JUNIE_DATA: "/tmp/junie-test",
    })
    // Junie has no task tools → skip enforcement → allow
    expect(result.blocked).toBe(false)
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

  it("allows stop with incomplete audit tasks when agent lacks task tools", async () => {
    const { home, tasksDir, transcriptPath } = await createFixture()
    await writeAuditLog(tasksDir, [
      { action: "create", taskId: "1" },
      { action: "status_change", taskId: "1", newStatus: "completed" },
      { action: "create", taskId: "2" },
      { action: "status_change", taskId: "2", newStatus: "pending" },
    ])
    const result = await runAuditor(home, transcriptPath, {
      JUNIE_DATA: "/tmp/junie-test",
    })
    // Junie has no task tools → skip enforcement → allow
    expect(result.blocked).toBe(false)
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

  it("allows stop when audit log missing and agent lacks task tools", async () => {
    const { home, transcriptPath } = await createFixture()
    const result = await runAuditor(home, transcriptPath, {
      JUNIE_DATA: "/tmp/junie-test",
    })
    // Junie has no task tools → skip enforcement → allow
    expect(result.blocked).toBe(false)
  })

  it("allows stop when audit log has no create entries and agent lacks task tools", async () => {
    const { home, tasksDir, transcriptPath } = await createFixture()
    await writeAuditLog(tasksDir, [
      { action: "status_change", taskId: "1", newStatus: "completed" },
    ])
    const result = await runAuditor(home, transcriptPath, {
      JUNIE_DATA: "/tmp/junie-test",
    })
    // Junie has no task tools → skip enforcement → allow
    expect(result.blocked).toBe(false)
  })

  it("allows stop when agent lacks task tools despite many tool calls", async () => {
    const { home, transcriptPath } = await createFixtureWithTools(
      Array.from({ length: 12 }, () => "shell_command")
    )
    const result = await runAuditor(home, transcriptPath, {
      JUNIE_DATA: "/tmp/junie-test",
    })
    // Junie has no task tools → skip enforcement → allow
    expect(result.blocked).toBe(false)
  })

  it("recognises update_plan as task activity and does not block when tasks were used", async () => {
    const { home, transcriptPath } = await createFixtureWithTools(
      Array.from({ length: 12 }, () => "update_plan")
    )
    const result = await runAuditor(home, transcriptPath, {
      CODEX_THREAD_ID: "test-codex-thread",
    })
    expect(result.blocked).toBe(false)
  })
})

// ─── CI verification enforcement ──────────────────────────────────────────────

/** Create a transcript that includes a Bash tool_use with `git push`. */
async function createFixtureWithPush(): Promise<{
  home: string
  tasksDir: string
  transcriptPath: string
}> {
  const home = await tmp.create("swiz-auditor-ci-test-")
  const tasksDir = getSessionTasksDir(SESSION_ID, home)
  if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
  await mkdir(tasksDir, { recursive: true })

  const lines: string[] = []
  // 12 regular tool calls to exceed threshold
  for (let i = 0; i < 12; i++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", id: `t${i}`, input: {} }] },
      })
    )
  }
  // A Bash tool call with `git push`
  lines.push(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            id: "push1",
            input: { command: "git push origin main" },
          },
        ],
      },
    })
  )
  // TaskCreate + TaskList to satisfy task detection and TaskList gate
  lines.push(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "TaskCreate", id: "tc1", input: {} }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "TaskList", id: "tl1", input: {} }] },
    })
  )

  const transcriptPath = join(home, "transcript.jsonl")
  await writeFile(transcriptPath, `${lines.join("\n")}\n`)
  return { home, tasksDir, transcriptPath }
}

describe("stop-completion-auditor — CI verification enforcement", () => {
  it("blocks when all tasks completed, push detected, but no CI evidence", async () => {
    const { home, tasksDir, transcriptPath } = await createFixtureWithPush()
    // Write a completed task WITHOUT CI evidence
    await writeFile(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Implement feature",
        status: "completed",
        completionEvidence: "tests pass locally",
        blocks: [],
        blockedBy: [],
      })
    )
    const result = await runAuditor(home, transcriptPath)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("CI verification evidence")
  })

  it("allows stop without CI evidence when ignore-ci is enabled", async () => {
    const { home, tasksDir, transcriptPath } = await createFixtureWithPush()
    await mkdir(join(home, ".swiz"), { recursive: true })
    await writeFile(join(home, ".swiz", "settings.json"), JSON.stringify({ ignoreCi: true }))
    await writeFile(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Implement feature",
        status: "completed",
        completionEvidence: "tests pass locally",
        blocks: [],
        blockedBy: [],
      })
    )
    const result = await runAuditor(home, transcriptPath)
    expect(result.blocked).toBe(false)
  })

  it("allows stop when a completed task has CI evidence in completionEvidence", async () => {
    const { home, tasksDir, transcriptPath } = await createFixtureWithPush()
    await writeFile(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Implement feature",
        status: "completed",
        completionEvidence: "CI green — conclusion: success",
        blocks: [],
        blockedBy: [],
      })
    )
    const result = await runAuditor(home, transcriptPath)
    expect(result.blocked).toBe(false)
  })

  it("allows stop when a completed task has CI evidence in subject", async () => {
    const { home, tasksDir, transcriptPath } = await createFixtureWithPush()
    await writeFile(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Push and verify CI — CI passed",
        status: "completed",
        blocks: [],
        blockedBy: [],
      })
    )
    const result = await runAuditor(home, transcriptPath)
    expect(result.blocked).toBe(false)
  })

  it("does not trigger CI check when no push detected in transcript", async () => {
    // Use regular fixture (no push in transcript)
    const { home, tasksDir, transcriptPath } = await createFixture()
    await writeFile(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Implement feature",
        status: "completed",
        completionEvidence: "done",
        blocks: [],
        blockedBy: [],
      })
    )
    const result = await runAuditor(home, transcriptPath)
    // No push → no CI enforcement → allow stop
    expect(result.blocked).toBe(false)
  })

  it("recognises 'conclusion: success' as valid CI evidence", async () => {
    const { home, tasksDir, transcriptPath } = await createFixtureWithPush()
    await writeFile(
      join(tasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Push and verify CI",
        status: "completed",
        completionEvidence: "conclusion: success",
        blocks: [],
        blockedBy: [],
      })
    )
    const result = await runAuditor(home, transcriptPath)
    expect(result.blocked).toBe(false)
  })

  it("finds CI evidence from sibling session in same project", async () => {
    const home = await tmp.create("swiz-auditor-cross-session-")

    const CURRENT_SESSION = "current-session-aaa"
    const SIBLING_SESSION = "sibling-session-bbb"

    // Set up project directory with two transcript files (sibling sessions)
    const projectDir = join(home, ".claude", "projects", "test-project")
    await mkdir(projectDir, { recursive: true })

    // Build transcript lines with a git push for the current session
    const lines: string[] = []
    for (let i = 0; i < 12; i++) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Read", id: `t${i}`, input: {} }] },
        })
      )
    }
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              id: "push1",
              input: { command: "git push origin main" },
            },
          ],
        },
      })
    )
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "TaskCreate", id: "tc1", input: {} }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "TaskList", id: "tl1", input: {} }] },
      })
    )

    // Write both transcript files in project dir
    const currentTranscript = join(projectDir, `${CURRENT_SESSION}.jsonl`)
    const siblingTranscript = join(projectDir, `${SIBLING_SESSION}.jsonl`)
    await writeFile(currentTranscript, `${lines.join("\n")}\n`)
    await writeFile(siblingTranscript, `${lines.join("\n")}\n`)

    // Current session: completed task WITHOUT CI evidence
    const currentTasksDir = getSessionTasksDir(CURRENT_SESSION, home)
    if (!currentTasksDir) throw new Error("Failed to resolve current session tasks directory")
    await mkdir(currentTasksDir, { recursive: true })
    await writeFile(
      join(currentTasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Implement feature",
        status: "completed",
        completionEvidence: "tests pass",
        blocks: [],
        blockedBy: [],
      })
    )

    // Sibling session: completed task WITH CI evidence
    const siblingTasksDir = getSessionTasksDir(SIBLING_SESSION, home)
    if (!siblingTasksDir) throw new Error("Failed to resolve sibling session tasks directory")
    await mkdir(siblingTasksDir, { recursive: true })
    await writeFile(
      join(siblingTasksDir, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Push and verify CI",
        status: "completed",
        completionEvidence: "CI green — conclusion: success, run 12345",
        blocks: [],
        blockedBy: [],
      })
    )

    // Run auditor with the custom session ID
    const payload = JSON.stringify({
      cwd: process.cwd(),
      session_id: CURRENT_SESSION,
      transcript_path: currentTranscript,
    })
    const env: Record<string, string | undefined> = { ...process.env, HOME: home }
    for (const agent of AGENTS) {
      for (const v of agent.envVars ?? []) delete env[v]
    }

    const proc = Bun.spawn(["bun", HOOK_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    })
    await proc.stdin.write(payload)
    await proc.stdin.end()
    const raw = await new Response(proc.stdout).text()
    await proc.exited

    const trimmed = raw.trim()
    if (trimmed) {
      const parsed = JSON.parse(trimmed)
      expect(parsed.decision).not.toBe("block")
    }
    // Empty output = allowed stop (no block)
  })
})
