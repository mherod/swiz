import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
  envOverrides = {},
}: {
  homeDir: string
  cwd?: string
  toolName?: string
  sessionId?: string
  transcriptPath?: string
  command?: string
  filePath?: string
  envOverrides?: Record<string, string | undefined>
}): Promise<HookResult> {
  const toolInput: Record<string, string> = {}
  if (command !== undefined) toolInput.command = command
  if (filePath !== undefined) toolInput.file_path = filePath
  const payload = JSON.stringify({
    tool_name: toolName,
    session_id: sessionId,
    transcript_path: transcriptPath ?? "",
    tool_input: toolInput,
    // cwd defaults to the swiz project root (a git repo with CLAUDE.md) when omitted
    ...(cwd !== undefined ? { cwd } : {}),
  })
  const env: Record<string, string | undefined> = { ...process.env, HOME: homeDir }
  delete env.CLAUDECODE
  delete env.CURSOR_TRACE_ID
  delete env.GEMINI_CLI
  delete env.GEMINI_PROJECT_DIR
  delete env.CODEX_MANAGED_BY_NPM
  delete env.CODEX_THREAD_ID
  const proc = Bun.spawn(["bun", "hooks/pretooluse-require-tasks.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, ...envOverrides },
  })
  proc.stdin.write(payload)
  proc.stdin.end()

  const out = await new Response(proc.stdout).text()
  await proc.exited
  if (!out.trim()) return {}

  const parsed = JSON.parse(out.trim())
  const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined
  return {
    decision: (hso?.permissionDecision ?? parsed.decision) as string | undefined,
    reason: (hso?.permissionDecisionReason ?? parsed.reason) as string | undefined,
  }
}

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-require-tasks-"))
  tempDirs.push(dir)
  return dir
}

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
  }: {
    id: string
    subject: string
    status: "pending" | "in_progress" | "completed" | "cancelled"
  }
) {
  const dir = join(homeDir, ".claude", "tasks", sessionId)
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
      },
      null,
      2
    )
  )
}

describe("pretooluse-require-tasks", () => {
  test("denies Bash when session has no tasks and auto-creates bootstrap", async () => {
    const homeDir = await createTempHome()
    const result = await runHook({ homeDir, toolName: "Bash" })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bootstrap task")
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

  test("denies Edit when no tasks have ever been created and auto-creates bootstrap", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-no-tasks"
    // No tasks written — agent is working without any plan

    const result = await runHook({ homeDir, toolName: "Edit", sessionId })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bootstrap task")
  })

  test("allows Shell when at least one pending task exists", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-pending"
    await writeTask(homeDir, sessionId, {
      id: "1",
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

    const result = await runHook({ homeDir, toolName: "Edit", sessionId })
    expect(result.decision).toBeUndefined()
  })

  test("denies when tasks exist but are stale (20+ calls since last task tool)", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-stale"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Active task",
      status: "in_progress",
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
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("stale")
    expect(result.reason).toContain("Use TaskUpdate")
    expect(result.reason).toContain("Use TaskCreate")
  })

  test("stale-task denial uses the current agent task tool aliases", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-stale-codex"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Active task",
      status: "in_progress",
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
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("Use update_plan")
  })

  test("allows when tasks exist and transcript is fresh (< 20 calls since last task tool)", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-fresh"
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Active task",
      status: "in_progress",
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

    test("still denies git commit without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: 'git commit -m "wip"' })
      expect(result.decision).toBe("deny")
    })

    test("allows git push without tasks (push/pull/fetch are exempt)", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git push origin main" })
      expect(result.decision).toBeUndefined()
    })

    test("still denies git checkout without tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({ homeDir, command: "git checkout -b new-branch" })
      expect(result.decision).toBe("deny")
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

    test("still denies Edit targeting other .md files with no tasks", async () => {
      const homeDir = await createTempHome()
      const result = await runHook({
        homeDir,
        toolName: "Edit",
        filePath: "/Users/test/project/README.md",
      })
      expect(result.decision).toBe("deny")
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
      // No tasks → enforcement fires, auto-creates bootstrap
      const result = await runHook({
        homeDir,
        cwd: repoDir,
        toolName: "Bash",
        sessionId,
      })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("bootstrap task")
    })
  })

  test("skips staleness check when no task tool has been used yet", async () => {
    const homeDir = await createTempHome()
    const sessionId = "session-notask-tool"
    await writeTask(homeDir, sessionId, {
      id: "1",
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
})
