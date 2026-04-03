import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { AGENTS } from "../src/agents.ts"
import { getSessionTasksDir } from "../src/tasks/task-recovery.ts"
import { useTempDir } from "../src/utils/test-utils.ts"
import { DIRECT_MERGE_INTENT_RE, isLargeContentPayload } from "./pretooluse-require-tasks.ts"

interface HookResult {
  decision?: string
  reason?: string
}

async function runHook({
  homeDir,
  cwd,
  toolName = "Bash",
  sessionId = "session-123",
  transcriptPath,
  command,
  filePath,
  newString,
  content,
  envOverrides = {},
}: {
  homeDir: string
  cwd?: string
  toolName?: string
  sessionId?: string
  transcriptPath?: string
  command?: string
  filePath?: string
  newString?: string
  content?: string
  envOverrides?: Record<string, string | undefined>
}): Promise<HookResult> {
  const toolInput: Record<string, string> = {}
  if (command !== undefined) toolInput.command = command
  if (filePath !== undefined) toolInput.file_path = filePath
  if (newString !== undefined) toolInput.new_string = newString
  if (content !== undefined) toolInput.content = content
  const payload = JSON.stringify({
    tool_name: toolName,
    session_id: sessionId,
    transcript_path: transcriptPath ?? "",
    tool_input: toolInput,
    // cwd defaults to the swiz project root (a git repo with CLAUDE.md) when omitted
    ...(cwd !== undefined ? { cwd } : {}),
  })
  const env: Record<string, string | undefined> = { ...process.env, HOME: homeDir }
  for (const agent of AGENTS) {
    for (const v of agent.envVars ?? []) env[v] = ""
  }
  const proc = Bun.spawn(["bun", "hooks/pretooluse-require-tasks.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, ...envOverrides },
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()

  const out = await new Response(proc.stdout).text()
  await proc.exited
  if (!out.trim()) return {}

  const parsed = JSON.parse(out.trim())
  const hso = parsed.hookSpecificOutput as Record<string, any> | undefined
  return {
    decision: (hso?.permissionDecision ?? parsed.decision) as string | undefined,
    reason: (hso?.permissionDecisionReason ?? parsed.reason) as string | undefined,
  }
}

const { create: createTempHome } = useTempDir("swiz-require-tasks-")

/** Write a stub transcript file for project discovery */
async function writeTranscript(homeDir: string, cwd: string, sessionId: string) {
  const { projectKeyFromCwd } = await import("../src/transcript-utils.ts")
  const projectKey = projectKeyFromCwd(cwd)
  const dir = join(homeDir, ".claude", "projects", projectKey)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${sessionId}.jsonl`), "")
}

async function writeTask(
  homeDir: string,
  sessionId: string,
  {
    id,
    subject,
    status,
    statusChangedAt,
    completionTimestamp,
    elapsedMs,
    startedAt,
    completedAt,
  }: {
    id: string
    subject: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
    statusChangedAt?: string
    completionTimestamp?: string
    elapsedMs?: number
    startedAt?: number | null
    completedAt?: number | null
  }
) {
  const dir = getSessionTasksDir(sessionId, homeDir)
  if (!dir) throw new Error("Failed to resolve session tasks directory")
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify(
      {
        id,
        subject,
        description: "",
        status,
        blocks: [],
        blockedBy: [],
        ...(statusChangedAt ? { statusChangedAt } : {}),
        ...(completionTimestamp ? { completionTimestamp } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(completedAt !== undefined ? { completedAt } : {}),
      },
      null,
      2
    )
  )
}

async function writeSwizSettings(homeDir: string, settings: Record<string, any>) {
  const dir = join(homeDir, ".swiz")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "settings.json"), JSON.stringify(settings, null, 2))
}

describe("pretooluse-require-tasks", () => {
  test("denies Bash when session has no tasks", async () => {
    const homeDir = await createTempHome()
    const result = await runHook({ homeDir, toolName: "Bash" })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("no incomplete tasks")
  })

  test("denies Bash with prior-session restore message when prior session has incomplete tasks", async () => {
    const homeDir = await createTempHome()
    const cwd = process.cwd() // must be a git repo with CLAUDE.md — swiz root qualifies
    const priorSessionId = `prior-session-${Date.now()}`
    const currentSessionId = `current-session-${Date.now()}`

    // Seed prior session with an incomplete task
    await writeTask(homeDir, priorSessionId, {
      id: "1",
      subject: "Implement cross-session restore",
      status: "in_progress",
    })
    await writeTranscript(homeDir, cwd, priorSessionId)

    // Current session has no tasks
    const result = await runHook({ homeDir, toolName: "Bash", sessionId: currentSessionId, cwd })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("prior session")
    expect(result.reason).toContain("Implement cross-session restore")
    // Verify prior-session completion uses native TaskUpdate guidance
    expect(result.reason).toContain("TaskUpdate")
    expect(result.reason).toContain(priorSessionId)
  })

  test("allows Edit when all tasks are completed (wrap-up work)", async () => {
    // Regression test for: hook was blocking Bash after all tasks marked completed,
    // preventing legitimate wrap-up operations (CI verification, issue comments, etc.)
    const homeDir = await createTempHome()
    const sessionId = "session-abc"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Done task",
      status: "completed",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Cancelled task",
      status: "cancelled",
    })

    const result = await runHook({ homeDir, toolName: "Edit", sessionId })
    // All tasks completed — wrap-up work should be allowed; staleness check skipped
    expect(result.decision).toBeUndefined()
  })

  test("allows Bash when all tasks completed even with stale transcript (wrap-up exemption)", async () => {
    // Regression test for #23: stop-blocked + bash-blocked deadlock.
    // When all tasks are completed, the staleness check must NOT fire —
    // the agent needs to run git commit during wrap-up without being blocked.
    const homeDir = await createTempHome()
    const sessionId = "session-all-done-stale"
    await writeTask(homeDir, sessionId, { id: "1", subject: "Done", status: "completed" })

    // Transcript with a TaskCreate at the start, then 25 non-task calls
    const lines: string[] = []
    const makeEntry = (toolName: string) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: toolName, id: "x", input: {} }] },
      })
    lines.push(makeEntry("TaskCreate"))
    for (let i = 0; i < 25; i++) lines.push(makeEntry("Read"))

    const transcriptPath = join(homeDir, "transcript-all-done.jsonl")
    await writeFile(transcriptPath, `${lines.join("\n")}\n`)

    // Should allow — all tasks done, staleness check is bypassed
    const result = await runHook({ homeDir, toolName: "Bash", sessionId, transcriptPath })
    expect(result.decision).toBeUndefined()
  })

  test("denies Edit when no tasks have ever been created", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-no-tasks"
    // No tasks written — agent is working without any plan

    const result = await runHook({ homeDir, toolName: "Edit", sessionId })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("no incomplete tasks")
  })

  test("allows Shell when at least one pending task exists", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-pending"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Current work",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Next step",
      status: "pending",
    })

    const result = await runHook({ homeDir, toolName: "Shell", sessionId })
    expect(result.decision).toBeUndefined()
  })

  test("allows Edit when at least one in_progress task exists", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-active"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Current work",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Next step",
      status: "pending",
    })

    const result = await runHook({ homeDir, toolName: "Edit", sessionId })
    expect(result.decision).toBeUndefined()
  })

  test("allows with a non-blocking warning when an in-progress task exceeds the default duration threshold", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-slow-warning-default"
    const startedAt = Date.now() - 12 * 60_000
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Verify CI passes",
      status: "in_progress",
      startedAt,
      statusChangedAt: new Date(startedAt).toISOString(),
      elapsedMs: 0,
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Open follow-up issue",
      status: "pending",
    })

    const result = await runHook({ homeDir, toolName: "Bash", sessionId })
    expect(result.decision).toBe("allow")
    expect(result.reason).toContain("Task #1 has been in_progress for 12m")
    expect(result.reason).toContain("consider backgrounding or switching approach")
  })

  test("uses the configured task duration warning threshold", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-slow-warning-configured"
    const startedAt = Date.now() - 2 * 60_000
    await writeSwizSettings(homeDir, { taskDurationWarningMinutes: 1 })
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Investigate slow task",
      status: "in_progress",
      startedAt,
      statusChangedAt: new Date(startedAt).toISOString(),
      elapsedMs: 0,
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Document findings",
      status: "pending",
    })

    const result = await runHook({ homeDir, toolName: "Bash", sessionId })
    expect(result.decision).toBe("allow")
    expect(result.reason).toContain("Task #1 has been in_progress for 2m")
  })

  test("allows when tasks are stale but in_progress task exists", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-stale"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Active task",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Next step",
      status: "pending",
    })

    // Build a transcript: one TaskCreate call, then 21 non-task calls
    const lines: string[] = []
    const makeEntry = (toolName: string) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: toolName, id: "x", input: {} }],
        },
      })
    lines.push(makeEntry("TaskCreate")) // index 0 — last task tool
    for (let i = 0; i < 21; i++) lines.push(makeEntry("Read")) // indices 1–21

    const transcriptPath = join(homeDir, "transcript.jsonl")
    await writeFile(transcriptPath, `${lines.join("\n")}\n`)

    const result = await runHook({ homeDir, toolName: "Bash", sessionId, transcriptPath })
    expect(result.decision).toBeUndefined()
  })

  test("stale-task check skips when in_progress task exists even with agent aliases", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-stale-codex"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Active task",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Next step",
      status: "pending",
    })

    const lines: string[] = []
    const makeEntry = (toolName: string) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: toolName, id: "x", input: {} }],
        },
      })
    lines.push(makeEntry("update_plan"))
    for (let i = 0; i < 21; i++) lines.push(makeEntry("Read"))

    const transcriptPath = join(homeDir, "transcript-codex.jsonl")
    await writeFile(transcriptPath, `${lines.join("\n")}\n`)

    const result = await runHook({
      homeDir,
      toolName: "Bash",
      sessionId,
      transcriptPath,
      envOverrides: { CODEX_THREAD_ID: "test-codex" },
    })
    expect(result.decision).toBeUndefined()
  })

  test("allows when tasks exist and transcript is fresh (< 20 calls since last task tool)", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-fresh"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Active task",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Next step",
      status: "pending",
    })

    const lines: string[] = []
    const makeEntry = (toolName: string) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: toolName, id: "x", input: {} }],
        },
      })
    lines.push(makeEntry("TaskCreate")) // index 0
    for (let i = 0; i < 5; i++) lines.push(makeEntry("Read")) // indices 1–5

    const transcriptPath = join(homeDir, "transcript.jsonl")
    await writeFile(transcriptPath, `${lines.join("\n")}\n`)

    const result = await runHook({ homeDir, toolName: "Edit", sessionId, transcriptPath })
    expect(result.decision).toBeUndefined()
  })

  describe("read-only git exemption", () => {
    test("allows git status without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git status" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git log without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git log --oneline -10" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git diff without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git diff HEAD~1" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git show without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git show HEAD" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git branch without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git branch --show-current" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git rev-parse without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git rev-parse --abbrev-ref HEAD" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git reflog without any tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git reflog --limit 5" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git status with leading pwd prefix", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "pwd && git status" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git commit without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: 'git commit -m "wip"' })
      expect(result.decision).toBeUndefined()
    })

    test("allows git push without tasks (push/pull/fetch are exempt)", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git push origin main" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git checkout without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git checkout -b new-branch" })
      expect(result.decision).toBeUndefined()
    })

    test("allows git switch without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git switch feature-branch" })
      expect(result.decision).toBeUndefined()
    })

    test("allows bun test without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "bun test --concurrent" })
      expect(result.decision).toBeUndefined()
    })

    test("allows pnpm test without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "pnpm test" })
      expect(result.decision).toBeUndefined()
    })

    test("allows bun run lint without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "bun run lint" })
      expect(result.decision).toBeUndefined()
    })

    test("still denies non-exempt commands without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "cat some-file.txt" })
      expect(result.decision).toBe("deny")
    })

    test("allows ls without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "ls -la" })
      expect(result.decision).toBeUndefined()
    })

    test("allows ls with path without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "ls src/" })
      expect(result.decision).toBeUndefined()
    })

    test("allows rg without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "rg 'some pattern' src/" })
      expect(result.decision).toBeUndefined()
    })

    test("allows grep without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "grep -r 'TODO' hooks/" })
      expect(result.decision).toBeUndefined()
    })

    test("allows ls chained after pwd without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "pwd && ls -la" })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("memory markdown exemption", () => {
    test("allows Edit targeting CLAUDE.md with no tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({
        homeDir,
        toolName: "Edit",
        filePath: "/Users/test/project/CLAUDE.md",
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows Write targeting MEMORY.md with no tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({
        homeDir,
        toolName: "Write",
        filePath: "/Users/test/.claude/projects/foo/memory/MEMORY.md",
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit targeting CLAUDE.md at repo root with no tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({
        homeDir,
        toolName: "Edit",
        filePath: "CLAUDE.md",
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit targeting any .md file with no tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({
        homeDir,
        toolName: "Edit",
        filePath: "/Users/test/project/README.md",
      })
      expect(result.decision).toBeUndefined()
    })

    test("still denies Edit targeting .ts files with no tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({
        homeDir,
        toolName: "Edit",
        filePath: "/Users/test/project/src/index.ts",
      })
      expect(result.decision).toBe("deny")
    })

    test("allows Edit when running in Gemini CLI (GEMINI_CLI=1) even with no tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({
        homeDir,
        toolName: "Edit",
        filePath: "/Users/test/project/src/index.ts",
        envOverrides: { GEMINI_CLI: "1" },
      })
      expect(result.decision).toBeUndefined()
    })
  })

  describe("git repo + CLAUDE.md guard", () => {
    test("allows Bash when cwd is not a git repo (no tasks required)", async () => {
      const homeDir = await createTempHome()
      // homeDir is not a git repo — enforcement must be skipped entirely
      const result = await runHook({ homeDir, cwd: homeDir, toolName: "Bash" })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit when cwd is not a git repo (no tasks required)", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({
        homeDir,
        cwd: homeDir,
        toolName: "Edit",
        filePath: "/some/file.ts",
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows Bash when cwd is a git repo but no CLAUDE.md exists in the tree", async () => {
      const homeDir = await createTempHome()
      // Init a bare git repo with no CLAUDE.md
      const repoDir = join(homeDir, "myrepo")
      await mkdir(repoDir, { recursive: true })
      const init = Bun.spawn(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" })
      await init.exited
      // No CLAUDE.md written — guard must exit 0
      const result = await runHook({ homeDir, cwd: repoDir, toolName: "Bash" })
      expect(result.decision).toBeUndefined()
    })

    test("enforces tasks when cwd is a git repo with CLAUDE.md present", async () => {
      const homeDir = await createTempHome()
      const repoDir = join(homeDir, "myrepo")
      await mkdir(repoDir, { recursive: true })
      const init = Bun.spawn(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" })
      await init.exited
      // Write CLAUDE.md so the guard lets enforcement through
      await writeFile(join(repoDir, "CLAUDE.md"), "# Guide\n")

      const sessionId = "session-guarded"
      // No tasks → enforcement fires
      const result = await runHook({
        homeDir,
        cwd: repoDir,
        toolName: "Bash",
        sessionId,
      })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("no incomplete tasks")
    })
  })

  test("skips staleness check when no task tool has been used yet", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-notask-tool"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Active task",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Bootstrap task",
      status: "pending",
    })

    // Transcript with many non-task tool calls but no task tool call
    const lines: string[] = []
    for (let i = 0; i < 30; i++) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: "Read", id: "x", input: {} }],
          },
        })
      )
    }
    const transcriptPath = join(homeDir, "transcript.jsonl")
    await writeFile(transcriptPath, `${lines.join("\n")}\n`)

    // Should allow — staleness only triggers after task tools have been used
    const result = await runHook({ homeDir, toolName: "Bash", sessionId, transcriptPath })
    expect(result.decision).toBeUndefined()
  })

  describe("large-content stale-task exemption (issue #89)", () => {
    /** Helper: build a stale transcript (1 TaskCreate + 21 Reads = 21 calls since task). Includes a pending task to ensure staleness check fires before the pending-task check. */
    async function buildStaleTranscript(homeDir: string, sessionId: string) {
      await writeTask(homeDir, sessionId, {
        id: "1",
        subject: "Active task",
        status: "in_progress",
      })
      await writeTask(homeDir, sessionId, {
        id: "2",
        subject: "Next step",
        status: "pending",
      })
      const lines: string[] = []
      const makeEntry = (toolName: string) =>
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", name: toolName, id: "x", input: {} }],
          },
        })
      lines.push(makeEntry("TaskCreate"))
      for (let i = 0; i < 21; i++) lines.push(makeEntry("Read"))
      const transcriptPath = join(homeDir, `transcript-${sessionId}.jsonl`)
      await writeFile(transcriptPath, `${lines.join("\n")}\n`)
      return transcriptPath
    }

    const largeContent = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")
    const smallContent = "line 1\nline 2\nline 3"

    test("allows Edit with 10+ line new_string when tasks are stale", async () => {
      const homeDir = await createTempHome()
      const sessionId = `session-large-edit-${Date.now()}`
      const transcriptPath = await buildStaleTranscript(homeDir, sessionId)

      const result = await runHook({
        homeDir,
        toolName: "Edit",
        sessionId,
        transcriptPath,
        newString: largeContent,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows Write with 10+ line content when tasks are stale", async () => {
      const homeDir = await createTempHome()
      const sessionId = `session-large-write-${Date.now()}`
      const transcriptPath = await buildStaleTranscript(homeDir, sessionId)

      const result = await runHook({
        homeDir,
        toolName: "Write",
        sessionId,
        transcriptPath,
        content: largeContent,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows Edit with <10 line new_string when tasks are stale but in_progress exists", async () => {
      const homeDir = await createTempHome()
      const sessionId = `session-small-edit-${Date.now()}`
      const transcriptPath = await buildStaleTranscript(homeDir, sessionId)

      const result = await runHook({
        homeDir,
        toolName: "Edit",
        sessionId,
        transcriptPath,
        newString: smallContent,
      })
      expect(result.decision).toBeUndefined()
    })

    test("allows Bash when tasks are stale but in_progress exists", async () => {
      const homeDir = await createTempHome()
      const sessionId = `session-stale-bash-${Date.now()}`
      const transcriptPath = await buildStaleTranscript(homeDir, sessionId)

      const result = await runHook({
        homeDir,
        toolName: "Bash",
        sessionId,
        transcriptPath,
        command: "echo 'large output here'",
      })
      expect(result.decision).toBeUndefined()
    })
  })
})

describe("isLargeContentPayload", () => {
  test("returns true for Edit payload with 10+ line new_string", () => {
    const input = { tool_input: { new_string: Array(10).fill("line").join("\n") } }
    expect(isLargeContentPayload(input)).toBe(true)
  })

  test("returns true for Write payload with 10+ line content", () => {
    const input = { tool_input: { content: Array(15).fill("line").join("\n") } }
    expect(isLargeContentPayload(input)).toBe(true)
  })

  test("returns false for Edit payload with <10 lines", () => {
    const input = { tool_input: { new_string: "one\ntwo\nthree" } }
    expect(isLargeContentPayload(input)).toBe(false)
  })

  test("returns false when no content fields present", () => {
    const input = { tool_input: { command: "ls" } }
    expect(isLargeContentPayload(input)).toBe(false)
  })

  test("returns false for empty input", () => {
    expect(isLargeContentPayload({})).toBe(false)
  })

  test("prefers new_string over content (Edit tool)", () => {
    const input = {
      tool_input: {
        new_string: Array(12).fill("x").join("\n"),
        content: "short",
      },
    }
    expect(isLargeContentPayload(input)).toBe(true)
  })
})

describe("DIRECT_MERGE_INTENT_RE", () => {
  const shouldMatch = [
    "Merge PR",
    "Merge PR #42 into main",
    "merge pr",
    "Merge to main",
    "Merge into main",
    "Merge into master",
    "Merge to master",
    "Rebase and merge",
    "Squash and merge",
    "Merge branch to main",
    "Merge branch into master",
    "Merge directly",
  ]
  for (const subject of shouldMatch) {
    test(`matches: "${subject}"`, () => {
      expect(DIRECT_MERGE_INTENT_RE.test(subject)).toBe(true)
    })
  }

  const shouldNotMatch = [
    "Open PR for review",
    "Request PR review",
    "Create feature branch",
    "Run tests",
    "Push to origin",
    "Merge conflicts in feature branch",
    "Review merge request",
  ]
  for (const subject of shouldNotMatch) {
    test(`does not match: "${subject}"`, () => {
      expect(DIRECT_MERGE_INTENT_RE.test(subject)).toBe(false)
    })
  }
})

describe("strict-no-direct-main merge task blocking", () => {
  test("denies Bash when strict-no-direct-main enabled and task has 'Merge PR' subject", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-merge-pr-block"
    await writeSwizSettings(homeDir, { strictNoDirectMain: true })
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Implement feature",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, { id: "2", subject: "Merge PR", status: "pending" })

    const result = await runHook({ homeDir, toolName: "Bash", sessionId })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("strict-no-direct-main")
    expect(result.reason).toContain("Merge PR")
  })

  test("denies Edit when strict-no-direct-main enabled and task has 'Merge into main'", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-merge-into-main"
    await writeSwizSettings(homeDir, { strictNoDirectMain: true })
    await writeTask(homeDir, sessionId, { id: "1", subject: "Fix bug", status: "in_progress" })
    await writeTask(homeDir, sessionId, { id: "2", subject: "Merge into main", status: "pending" })

    const result = await runHook({
      homeDir,
      toolName: "Edit",
      sessionId,
      filePath: "/some/file.ts",
    })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("strict-no-direct-main")
  })

  test("allows Bash when strict-no-direct-main is disabled even with 'Merge PR' task", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-merge-pr-allowed"
    await writeSwizSettings(homeDir, { strictNoDirectMain: false })
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Implement feature",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, { id: "2", subject: "Merge PR", status: "pending" })

    const result = await runHook({ homeDir, toolName: "Bash", sessionId })
    expect(result.decision).toBeUndefined()
  })

  test("allows Bash when strict-no-direct-main enabled but no merge-intent tasks", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-no-merge-tasks"
    await writeSwizSettings(homeDir, { strictNoDirectMain: true })
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Implement feature",
      status: "in_progress",
    })
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Open PR for review",
      status: "pending",
    })

    const result = await runHook({ homeDir, toolName: "Bash", sessionId })
    expect(result.decision).toBeUndefined()
  })

  test("allows when no swiz settings file exists (fail-open)", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-no-settings"
    // No settings file written — readSwizSettings returns defaults (strictNoDirectMain: false)
    await writeTask(homeDir, sessionId, { id: "1", subject: "Fix thing", status: "in_progress" })
    await writeTask(homeDir, sessionId, { id: "2", subject: "Merge PR", status: "pending" })

    const result = await runHook({ homeDir, toolName: "Bash", sessionId })
    expect(result.decision).toBeUndefined()
  })
})
