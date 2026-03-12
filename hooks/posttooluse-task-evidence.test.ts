import { describe, expect, it } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { getSessionTasksDir } from "./hook-utils.ts"
import { useTempDir } from "./test-utils.ts"

const HOOK_PATH = resolve(process.cwd(), "hooks/posttooluse-task-evidence.ts")
const SESSION_ID = "test-evidence-session-abc123"

const { create: createHome } = useTempDir("swiz-evidence-test-")

async function createFixture(): Promise<{ home: string; tasksDir: string }> {
  const home = await createHome()
  const tasksDir = getSessionTasksDir(SESSION_ID, home)
  if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
  await mkdir(tasksDir, { recursive: true })
  return { home, tasksDir }
}

async function runHook(
  home: string,
  toolInput: Record<string, unknown>,
  toolName = "TaskUpdate",
  configPath?: string
): Promise<string> {
  const payload = JSON.stringify({
    cwd: process.cwd(),
    session_id: SESSION_ID,
    tool_name: toolName,
    tool_input: toolInput,
  })
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDECODE
  delete env.CURSOR_TRACE_ID
  delete env.GEMINI_CLI
  delete env.GEMINI_PROJECT_DIR
  delete env.CODEX_MANAGED_BY_NPM
  delete env.CODEX_THREAD_ID
  if (configPath) env.TASK_EVIDENCE_CONFIG = configPath

  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()
  const raw = await new Response(proc.stdout).text()
  await proc.exited
  return raw.trim()
}

async function runHookFull(
  home: string,
  toolInput: Record<string, unknown>,
  toolName = "TaskUpdate",
  configPath?: string
): Promise<{ stdout: string; stderr: string }> {
  const payload = JSON.stringify({
    cwd: process.cwd(),
    session_id: SESSION_ID,
    tool_name: toolName,
    tool_input: toolInput,
  })
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDECODE
  delete env.CURSOR_TRACE_ID
  delete env.GEMINI_CLI
  delete env.GEMINI_PROJECT_DIR
  delete env.CODEX_MANAGED_BY_NPM
  delete env.CODEX_THREAD_ID
  if (configPath) env.TASK_EVIDENCE_CONFIG = configPath

  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

describe("posttooluse-task-evidence", () => {
  it("writes completionEvidence when metadata.evidence is provided", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "1",
      subject: "Push and verify CI",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "1.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "1",
      status: "completed",
      metadata: { evidence: "CI green — conclusion: success" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "1.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green — conclusion: success")
    expect(updated.completionTimestamp).toBeDefined()
  })

  it("does nothing when metadata.evidence is absent", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "2",
      subject: "Some task",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "2.json"), JSON.stringify(task, null, 2))

    await runHook(home, { taskId: "2", status: "completed" })

    const updated = JSON.parse(await readFile(join(tasksDir, "2.json"), "utf-8"))
    expect(updated.completionEvidence).toBeUndefined()
  })

  it("does nothing when metadata.evidence is empty string", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "3",
      subject: "Another task",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "3.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "3",
      status: "completed",
      metadata: { evidence: "" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "3.json"), "utf-8"))
    expect(updated.completionEvidence).toBeUndefined()
  })

  it("preserves existing task fields when writing evidence", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "4",
      subject: "CI verification task",
      description: "Verify CI passes",
      activeForm: "Verifying CI",
      status: "completed",
      blocks: ["5"],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "4.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "4",
      status: "completed",
      metadata: { evidence: "CI passed" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "4.json"), "utf-8"))
    expect(updated.subject).toBe("CI verification task")
    expect(updated.description).toBe("Verify CI passes")
    expect(updated.activeForm).toBe("Verifying CI")
    expect(updated.blocks).toEqual(["5"])
    expect(updated.completionEvidence).toBe("CI passed")
  })

  it("handles missing task file gracefully", async () => {
    const { home } = await createFixture()
    // No task file written — hook should not crash
    const output = await runHook(home, {
      taskId: "99",
      status: "completed",
      metadata: { evidence: "CI green" },
    })
    // Should exit cleanly with no output
    expect(output).toBe("")
  })

  it("extracts evidence from metadata.completionEvidence", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "5", subject: "Alt key", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "5.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "5",
      status: "completed",
      metadata: { completionEvidence: "CI green — all jobs passed" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "5.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green — all jobs passed")
    expect(updated.completionTimestamp).toBeDefined()
  })

  it("works with update_plan tool name (Codex)", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "6", subject: "Codex task", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "6.json"), JSON.stringify(task, null, 2))

    await runHook(
      home,
      { taskId: "6", status: "completed", metadata: { evidence: "CI passed" } },
      "update_plan"
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "6.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI passed")
  })

  it("is idempotent — does not overwrite identical evidence", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "7",
      subject: "Idempotent test",
      status: "completed",
      blocks: [],
      blockedBy: [],
      completionEvidence: "CI green",
      completionTimestamp: "2026-01-01T00:00:00.000Z",
    }
    await writeFile(join(tasksDir, "7.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "7",
      status: "completed",
      metadata: { evidence: "CI green" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "7.json"), "utf-8"))
    // Timestamp should be unchanged since evidence was identical
    expect(updated.completionTimestamp).toBe("2026-01-01T00:00:00.000Z")
  })

  it("handles numeric taskId", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "8", subject: "Numeric ID", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "8.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: 8,
      status: "completed",
      metadata: { evidence: "CI green" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "8.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green")
  })

  it("ignores non-update task tools", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "9", subject: "Ignore me", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "9.json"), JSON.stringify(task, null, 2))

    await runHook(
      home,
      { taskId: "9", status: "completed", metadata: { evidence: "CI green" } },
      "TaskCreate"
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "9.json"), "utf-8"))
    expect(updated.completionEvidence).toBeUndefined()
  })

  // ─── Cross-agent tool name coverage ────────────────────────────────────────

  it("works with TodoWrite tool name (Cursor)", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "10",
      subject: "Cursor task",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "10.json"), JSON.stringify(task, null, 2))

    await runHook(
      home,
      { taskId: "10", status: "completed", metadata: { evidence: "CI passed" } },
      "TodoWrite"
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "10.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI passed")
  })

  it("works with write_todos tool name (Gemini)", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "11",
      subject: "Gemini task",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "11.json"), JSON.stringify(task, null, 2))

    await runHook(
      home,
      { taskId: "11", status: "completed", metadata: { evidence: "CI green" } },
      "write_todos"
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "11.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green")
  })

  // ─── Alternative payload shapes ────────────────────────────────────────────

  it("extracts evidence from top-level tool_input.evidence (flat payload)", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "12",
      subject: "Flat payload",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "12.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "12",
      status: "completed",
      evidence: "CI green — flat",
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "12.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green — flat")
  })

  it("extracts evidence from top-level tool_input.completionEvidence", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "13",
      subject: "Flat alt key",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "13.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "13",
      status: "completed",
      completionEvidence: "CI green — flat alt",
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "13.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green — flat alt")
  })

  it("prefers metadata.evidence over top-level evidence", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "14", subject: "Priority", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "14.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      taskId: "14",
      status: "completed",
      evidence: "top-level evidence",
      metadata: { evidence: "metadata evidence" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "14.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("metadata evidence")
  })

  // ─── Alternative task ID field names ───────────────────────────────────────

  it("resolves task ID from task_id field (snake_case)", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "15", subject: "Snake ID", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "15.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      task_id: "15",
      status: "completed",
      metadata: { evidence: "CI green" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "15.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green")
  })

  it("resolves task ID from id field", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "16", subject: "Bare ID", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "16.json"), JSON.stringify(task, null, 2))

    await runHook(home, {
      id: "16",
      status: "completed",
      metadata: { evidence: "CI green" },
    })

    const updated = JSON.parse(await readFile(join(tasksDir, "16.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green")
  })

  it("prefers taskId over task_id over id", async () => {
    const { home, tasksDir } = await createFixture()
    const task17 = {
      id: "17",
      subject: "Preferred",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    const task18 = { id: "18", subject: "Fallback", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "17.json"), JSON.stringify(task17, null, 2))
    await writeFile(join(tasksDir, "18.json"), JSON.stringify(task18, null, 2))

    // taskId takes priority — task 17 should get evidence, not 18
    await runHook(home, {
      taskId: "17",
      task_id: "18",
      id: "18",
      status: "completed",
      metadata: { evidence: "CI green" },
    })

    const updated17 = JSON.parse(await readFile(join(tasksDir, "17.json"), "utf-8"))
    const updated18 = JSON.parse(await readFile(join(tasksDir, "18.json"), "utf-8"))
    expect(updated17.completionEvidence).toBe("CI green")
    expect(updated18.completionEvidence).toBeUndefined()
  })
})

// ─── Config-driven normalization tests ─────────────────────────────────────

describe("posttooluse-task-evidence config", () => {
  async function writeConfig(dir: string, config: Record<string, unknown>): Promise<string> {
    const configPath = join(dir, "custom-evidence-config.json")
    await writeFile(configPath, JSON.stringify(config, null, 2))
    return configPath
  }

  it("accepts a custom tool name added via config", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "20",
      subject: "Custom tool",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "20.json"), JSON.stringify(task, null, 2))

    const configPath = await writeConfig(home, {
      toolNames: ["TaskUpdate", "FutureAgentTool"],
      evidenceKeys: ["evidence"],
      taskIdFields: ["taskId"],
    })

    await runHook(
      home,
      { taskId: "20", status: "completed", metadata: { evidence: "custom tool works" } },
      "FutureAgentTool",
      configPath
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "20.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("custom tool works")
  })

  it("accepts a custom evidence key added via config", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "21", subject: "Custom key", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "21.json"), JSON.stringify(task, null, 2))

    const configPath = await writeConfig(home, {
      toolNames: ["TaskUpdate"],
      evidenceKeys: ["evidence", "ciResult"],
      taskIdFields: ["taskId"],
    })

    await runHook(
      home,
      { taskId: "21", status: "completed", metadata: { ciResult: "all green" } },
      "TaskUpdate",
      configPath
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "21.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("all green")
  })

  it("accepts a custom task ID field added via config", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "22", subject: "Custom ID", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "22.json"), JSON.stringify(task, null, 2))

    const configPath = await writeConfig(home, {
      toolNames: ["TaskUpdate"],
      evidenceKeys: ["evidence"],
      taskIdFields: ["planItemId", "taskId"],
    })

    await runHook(
      home,
      { planItemId: "22", status: "completed", metadata: { evidence: "custom ID field" } },
      "TaskUpdate",
      configPath
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "22.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("custom ID field")
  })

  it("falls back to defaults when config is missing", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "23", subject: "No config", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "23.json"), JSON.stringify(task, null, 2))

    await runHook(
      home,
      { taskId: "23", status: "completed", metadata: { evidence: "defaults work" } },
      "TaskUpdate",
      join(home, "nonexistent-config.json")
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "23.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("defaults work")
  })

  it("falls back to defaults when config has invalid JSON", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "24", subject: "Bad config", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "24.json"), JSON.stringify(task, null, 2))

    const configPath = join(home, "bad-config.json")
    await writeFile(configPath, "not valid json {{{")

    await runHook(
      home,
      { taskId: "24", status: "completed", metadata: { evidence: "fallback works" } },
      "TaskUpdate",
      configPath
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "24.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("fallback works")
  })

  it("falls back per-field when config has partial invalid types", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "25",
      subject: "Partial bad",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "25.json"), JSON.stringify(task, null, 2))

    const configPath = await writeConfig(home, {
      toolNames: "not-an-array",
      evidenceKeys: ["evidence", "customKey"],
      taskIdFields: [123, "taskId"],
    })

    // toolNames is invalid (string, not array) → falls back to defaults → TaskUpdate works
    // taskIdFields has a number → falls back to defaults → taskId works
    // evidenceKeys is valid → customKey should work
    await runHook(
      home,
      { taskId: "25", status: "completed", metadata: { customKey: "partial fallback" } },
      "TaskUpdate",
      configPath
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "25.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("partial fallback")
  })

  it("rejects unknown tool name not in custom config", async () => {
    const { home, tasksDir } = await createFixture()
    const task = {
      id: "26",
      subject: "Rejected tool",
      status: "completed",
      blocks: [],
      blockedBy: [],
    }
    await writeFile(join(tasksDir, "26.json"), JSON.stringify(task, null, 2))

    const configPath = await writeConfig(home, {
      toolNames: ["OnlyThisTool"],
      evidenceKeys: ["evidence"],
      taskIdFields: ["taskId"],
    })

    // TaskUpdate is NOT in the custom config's toolNames
    await runHook(
      home,
      { taskId: "26", status: "completed", metadata: { evidence: "should not write" } },
      "TaskUpdate",
      configPath
    )

    const updated = JSON.parse(await readFile(join(tasksDir, "26.json"), "utf-8"))
    expect(updated.completionEvidence).toBeUndefined()
  })
})

// ─── Config validation warning tests ───────────────────────────────────────

describe("posttooluse-task-evidence config validation warnings", () => {
  async function writeConfig(dir: string, config: Record<string, unknown>): Promise<string> {
    const configPath = join(dir, "warn-evidence-config.json")
    await writeFile(configPath, JSON.stringify(config, null, 2))
    return configPath
  }

  const defaultInput = {
    taskId: "30",
    status: "completed",
    metadata: { evidence: "CI green" },
  }

  it("warns when toolNames is not an array", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "30", subject: "Warn", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "30.json"), JSON.stringify(task, null, 2))
    const configPath = await writeConfig(home, {
      toolNames: "not-array",
      evidenceKeys: ["evidence"],
      taskIdFields: ["taskId"],
    })

    const result = await runHookFull(home, defaultInput, "TaskUpdate", configPath)
    expect(result.stderr).toContain("[task-evidence-config] toolNames:")
    expect(result.stderr).toContain("expected array, got string")
    // Falls back to defaults — TaskUpdate still works
    const updated = JSON.parse(await readFile(join(tasksDir, "30.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green")
  })

  it("warns and removes non-string elements", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "31", subject: "Warn", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "31.json"), JSON.stringify(task, null, 2))
    const configPath = await writeConfig(home, {
      toolNames: ["TaskUpdate", 42, true, null],
      evidenceKeys: ["evidence"],
      taskIdFields: ["taskId"],
    })

    const result = await runHookFull(
      home,
      { taskId: "31", status: "completed", metadata: { evidence: "works" } },
      "TaskUpdate",
      configPath
    )
    expect(result.stderr).toContain("non-string element(s) removed")
    const updated = JSON.parse(await readFile(join(tasksDir, "31.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("works")
  })

  it("warns and removes empty strings", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "32", subject: "Warn", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "32.json"), JSON.stringify(task, null, 2))
    const configPath = await writeConfig(home, {
      toolNames: ["TaskUpdate", "", "  "],
      evidenceKeys: ["evidence"],
      taskIdFields: ["taskId"],
    })

    const result = await runHookFull(
      home,
      { taskId: "32", status: "completed", metadata: { evidence: "works" } },
      "TaskUpdate",
      configPath
    )
    expect(result.stderr).toContain("empty string(s) removed")
    const updated = JSON.parse(await readFile(join(tasksDir, "32.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("works")
  })

  it("warns and removes duplicates", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "33", subject: "Warn", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "33.json"), JSON.stringify(task, null, 2))
    const configPath = await writeConfig(home, {
      toolNames: ["TaskUpdate", "TaskUpdate", "TodoWrite"],
      evidenceKeys: ["evidence"],
      taskIdFields: ["taskId"],
    })

    const result = await runHookFull(
      home,
      { taskId: "33", status: "completed", metadata: { evidence: "works" } },
      "TaskUpdate",
      configPath
    )
    expect(result.stderr).toContain("duplicate(s) removed")
    const updated = JSON.parse(await readFile(join(tasksDir, "33.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("works")
  })

  it("warns and falls back when array resolves to empty after cleaning", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "34", subject: "Warn", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "34.json"), JSON.stringify(task, null, 2))
    const configPath = await writeConfig(home, {
      toolNames: ["", "  "],
      evidenceKeys: ["evidence"],
      taskIdFields: ["taskId"],
    })

    const input = { taskId: "34", status: "completed", metadata: { evidence: "CI green" } }
    const result = await runHookFull(home, input, "TaskUpdate", configPath)
    expect(result.stderr).toContain("resolved to empty array")
    expect(result.stderr).toContain("using defaults")
    // Falls back — TaskUpdate still works
    const updated = JSON.parse(await readFile(join(tasksDir, "34.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green")
  })

  it("warns about unknown config keys", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "35", subject: "Warn", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "35.json"), JSON.stringify(task, null, 2))
    const configPath = await writeConfig(home, {
      toolNames: ["TaskUpdate"],
      evidenceKeys: ["evidence"],
      taskIdFields: ["taskId"],
      unknownField: true,
      anotherBadKey: "value",
    })

    const input = { taskId: "35", status: "completed", metadata: { evidence: "CI green" } }
    const result = await runHookFull(home, input, "TaskUpdate", configPath)
    expect(result.stderr).toContain("unknown config key(s) ignored")
    expect(result.stderr).toContain("unknownField")
    const updated = JSON.parse(await readFile(join(tasksDir, "35.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green")
  })

  it("warns when config root is not an object", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "36", subject: "Warn", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "36.json"), JSON.stringify(task, null, 2))
    const configPath = join(home, "array-config.json")
    await writeFile(configPath, JSON.stringify(["not", "an", "object"]))

    const input = { taskId: "36", status: "completed", metadata: { evidence: "CI green" } }
    const result = await runHookFull(home, input, "TaskUpdate", configPath)
    expect(result.stderr).toContain("config root must be an object")
    // Falls back to all defaults
    const updated = JSON.parse(await readFile(join(tasksDir, "36.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green")
  })

  it("allows $schema and $comment keys without warning", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "37", subject: "Warn", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "37.json"), JSON.stringify(task, null, 2))
    const configPath = await writeConfig(home, {
      $schema: "./some-schema.json",
      $comment: "This is fine",
      toolNames: ["TaskUpdate"],
      evidenceKeys: ["evidence"],
      taskIdFields: ["taskId"],
    })

    const input = { taskId: "37", status: "completed", metadata: { evidence: "CI green" } }
    const result = await runHookFull(home, input, "TaskUpdate", configPath)
    // No warning about $schema or $comment
    expect(result.stderr).not.toContain("unknown config key")
    const updated = JSON.parse(await readFile(join(tasksDir, "37.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green")
  })

  it("produces no warnings for valid config", async () => {
    const { home, tasksDir } = await createFixture()
    const task = { id: "38", subject: "Warn", status: "completed", blocks: [], blockedBy: [] }
    await writeFile(join(tasksDir, "38.json"), JSON.stringify(task, null, 2))
    const configPath = await writeConfig(home, {
      toolNames: ["TaskUpdate"],
      evidenceKeys: ["evidence"],
      taskIdFields: ["taskId"],
    })

    const input = { taskId: "38", status: "completed", metadata: { evidence: "CI green" } }
    const result = await runHookFull(home, input, "TaskUpdate", configPath)
    expect(result.stderr).not.toContain("[task-evidence-config]")
    const updated = JSON.parse(await readFile(join(tasksDir, "38.json"), "utf-8"))
    expect(updated.completionEvidence).toBe("CI green")
  })
})
