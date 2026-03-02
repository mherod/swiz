/**
 * Positive-path integration tests for hooks that previously only had negative-path
 * coverage. Each test verifies the hook produces correct allow/deny decisions and
 * well-formed hookSpecificOutput JSON when all prerequisites are satisfied.
 *
 * Tests create real git repos, task files, and JSONL transcripts as needed.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ─── Shared test infrastructure ─────────────────────────────────────────────

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-pospath-"))
  tempDirs.push(dir)
  return dir
}

interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  json: Record<string, unknown> | null
}

async function runHook(
  script: string,
  stdinPayload: Record<string, unknown>,
  envOverrides: Record<string, string | undefined> = {}
): Promise<HookResult> {
  const payload = JSON.stringify(stdinPayload)
  const env: Record<string, string | undefined> = { ...process.env }
  delete env.CLAUDECODE
  delete env.CURSOR_TRACE_ID
  delete env.GEMINI_CLI
  delete env.GEMINI_PROJECT_DIR
  delete env.CODEX_MANAGED_BY_NPM
  delete env.CODEX_THREAD_ID

  const proc = Bun.spawn(["bun", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, ...envOverrides },
  })
  proc.stdin.write(payload)
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  let json: Record<string, unknown> | null = null
  try {
    if (stdout.trim()) json = JSON.parse(stdout.trim())
  } catch {}

  return { exitCode: proc.exitCode, stdout: stdout.trim(), stderr, json }
}

/** Create a minimal git repo with one commit. */
async function createGitRepo(): Promise<string> {
  const dir = await createTempDir()
  Bun.spawnSync(["git", "init"], { cwd: dir })
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: dir })
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir })
  Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: dir })
  return dir
}

/** Create a JSONL transcript with N tool_use entries of specified names. */
async function createTranscript(dir: string, toolNames: string[]): Promise<string> {
  const path = join(dir, "transcript.jsonl")
  const lines = toolNames.map((name) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name }] },
    })
  )
  await writeFile(path, `${lines.join("\n")}\n`)
  return path
}

/** Create a task file in the given session directory. */
async function createTaskFile(
  homeDir: string,
  sessionId: string,
  task: { id: string; subject: string; status: string }
): Promise<void> {
  const dir = join(homeDir, ".claude", "tasks", sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${task.id}.json`),
    JSON.stringify({ ...task, description: "", blocks: [], blockedBy: [] })
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PreToolUse hooks: positive paths — correct output format
// ═══════════════════════════════════════════════════════════════════════════════

describe("pretooluse-eslint-config-strength: positive paths", () => {
  const HOOK = "hooks/pretooluse-eslint-config-strength.ts"

  test("strengthening rules emits allow with correct hookSpecificOutput", async () => {
    // countEnforcements counts raw "warning"/"error" keyword occurrences.
    // To "strengthen" without decreasing warning count, add an error rule alongside existing warning.
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: ".eslintrc.json",
        old_string: '"no-unused-vars": "warning"',
        new_string: '"no-unused-vars": "warning", "semi": "error"',
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.hookEventName).toBe("PreToolUse")
    expect(hso?.permissionDecision).toBe("allow")
  })

  test("adding new rules emits allow", async () => {
    // Modern flat config format: eslint.config.js (no dot prefix)
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: "eslint.config.js",
        old_string: '"no-unused-vars": "error"',
        new_string: '"no-unused-vars": "error", "no-undef": "warning"',
      },
    })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.permissionDecision).toBe("allow")
  })

  test("weakening rules emits deny with structured output", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: ".eslintrc.json",
        old_string: '"semi": "warning", "quotes": "error"',
        new_string: '"semi": "off"',
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.hookEventName).toBe("PreToolUse")
    expect(hso?.permissionDecision).toBe("deny")
    expect(typeof hso?.permissionDecisionReason).toBe("string")
    expect(hso?.permissionDecisionReason).toContain("sacred")
  })
})

describe("pretooluse-json-validation: positive paths", () => {
  const HOOK = "hooks/pretooluse-json-validation.ts"

  test("valid settings.json produces no output (implicit allow)", async () => {
    const tmp = await createTempDir()
    const settingsDir = join(tmp, ".claude")
    await mkdir(settingsDir, { recursive: true })
    const settingsPath = join(settingsDir, "settings.json")
    await writeFile(settingsPath, '{"hooks": []}')

    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: settingsPath },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("invalid settings.json emits deny with structured output", async () => {
    const tmp = await createTempDir()
    const settingsDir = join(tmp, ".claude")
    await mkdir(settingsDir, { recursive: true })
    const settingsPath = join(settingsDir, "settings.json")
    await writeFile(settingsPath, '{"broken": ')

    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: settingsPath },
    })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.hookEventName).toBe("PreToolUse")
    expect(hso?.permissionDecision).toBe("deny")
  })
})

describe("pretooluse-no-as-any: positive paths", () => {
  const HOOK = "hooks/pretooluse-no-as-any.ts"

  test("same 'as any' count emits allow with correct format", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/utils.ts",
        old_string: "const x = val as any",
        new_string: "const y = val as any",
      },
    })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.hookEventName).toBe("PreToolUse")
    expect(hso?.permissionDecision).toBe("allow")
  })

  test("reducing 'as any' count emits allow", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/utils.tsx",
        old_string: "const a = x as any; const b = y as any;",
        new_string: "const a: string = x; const b: number = y;",
      },
    })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.permissionDecision).toBe("allow")
  })

  test("adding 'as any' emits deny with reason", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/app.ts",
        old_string: "const data = fetchData()",
        new_string: "const data = fetchData() as any",
      },
    })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.permissionDecision).toBe("deny")
    expect(hso?.permissionDecisionReason).toContain("Type safety")
  })
})

describe("pretooluse-no-direct-deps: positive paths", () => {
  const HOOK = "hooks/pretooluse-no-direct-deps.ts"

  test("editing package.json scripts emits no output (allow)", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: "package.json",
        new_string: '{"name": "app", "version": "1.0.0", "scripts": {"start": "bun run index.ts"}}',
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("adding devDependencies emits deny with reason", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Write",
      tool_input: {
        file_path: "package.json",
        content: '{"devDependencies": {"vitest": "^1.0.0"}}',
      },
    })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.permissionDecision).toBe("deny")
    expect(hso?.permissionDecisionReason).toContain("package manager")
  })
})

describe("pretooluse-no-task-delegation: positive paths", () => {
  const HOOK = "hooks/pretooluse-no-task-delegation.ts"

  test("prompt with TodoWrite emits deny with structured reason", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Task",
      tool_input: { prompt: "Use TodoWrite to plan the upcoming work" },
    })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.permissionDecision).toBe("deny")
    expect(hso?.permissionDecisionReason).toContain("NEVER delegate")
  })

  test("prompt with TaskUpdate emits deny", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Task",
      tool_input: { prompt: "Mark all tasks complete with TaskUpdate" },
    })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.permissionDecision).toBe("deny")
  })

  test("safe prompt produces no output (allow)", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Task",
      tool_input: { prompt: "Analyze the codebase and find performance bottlenecks" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("pretooluse-task-subject-validation: positive paths", () => {
  const HOOK = "hooks/pretooluse-task-subject-validation.ts"

  test("compound subject with two action verbs emits deny with suggestions", async () => {
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "Fix authentication and update deploy pipeline" },
    })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.hookEventName).toBe("PreToolUse")
    expect(hso?.permissionDecision).toBe("deny")
    expect(typeof hso?.permissionDecisionReason).toBe("string")
    const reason = hso?.permissionDecisionReason as string
    expect(reason).toContain("compound")
    expect(reason).toContain("Fix authentication")
  })

  test("subject with multiple issue refs emits deny with per-issue split", async () => {
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "Fix #12 and #34" },
    })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.permissionDecision).toBe("deny")
    const reason = hso?.permissionDecisionReason as string
    expect(reason).toContain("#12")
    expect(reason).toContain("#34")
  })

  test("simple focused subject produces no output", async () => {
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "Implement user authentication flow" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// PostToolUse hooks: positive paths — context injection
// ═══════════════════════════════════════════════════════════════════════════════

describe("posttooluse-git-status: positive paths", () => {
  const HOOK = "hooks/posttooluse-git-status.ts"

  test("emits branch and uncommitted count in git repo", async () => {
    const repo = await createGitRepo()
    const r = await runHook(HOOK, { cwd: repo })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.hookEventName).toBe("PostToolUse")
    const ctx = hso?.additionalContext as string
    expect(ctx).toContain("[git] branch:")
    expect(ctx).toContain("uncommitted files:")
  })

  test("reports uncommitted files count accurately", async () => {
    const repo = await createGitRepo()
    await writeFile(join(repo, "file1.txt"), "a")
    await writeFile(join(repo, "file2.txt"), "b")
    const r = await runHook(HOOK, { cwd: repo })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    const ctx = hso?.additionalContext as string
    expect(ctx).toContain("uncommitted files: 2")
  })

  test("reports zero uncommitted for clean repo", async () => {
    const repo = await createGitRepo()
    const r = await runHook(HOOK, { cwd: repo })
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    const ctx = hso?.additionalContext as string
    expect(ctx).toContain("uncommitted files: 0")
  })
})

describe("posttooluse-json-validation: positive paths", () => {
  const HOOK = "hooks/posttooluse-json-validation.ts"

  test("valid JSON file produces no output", async () => {
    const tmp = await createTempDir()
    const jsonPath = join(tmp, "config.json")
    await writeFile(jsonPath, '{"key": "value", "nested": {"a": 1}}')
    const r = await runHook(HOOK, {
      tool_name: "Write",
      tool_input: { file_path: jsonPath },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("invalid JSON emits block with reason", async () => {
    const tmp = await createTempDir()
    const jsonPath = join(tmp, "bad.json")
    await writeFile(jsonPath, "{invalid json")
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: jsonPath },
    })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    expect(r.json?.decision).toBe("block")
    expect(r.json?.reason).toContain("JSON validation failed")
  })
})

describe("posttooluse-task-advisor: positive paths", () => {
  const HOOK = "hooks/posttooluse-task-advisor.ts"

  test("emits creation countdown when approaching threshold", async () => {
    const tmp = await createTempDir()
    // 3 tool calls, no TaskCreate → remaining = 5 - 3 = 2 (within ≤3 range)
    const transcript = await createTranscript(tmp, ["Read", "Glob", "Read"])
    const r = await runHook(HOOK, { transcript_path: transcript })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.hookEventName).toBe("PostToolUse")
    expect(hso?.additionalContext).toContain("TaskCreate required")
  })

  test("emits warning at 4/5 tool calls before creation threshold", async () => {
    const tmp = await createTempDir()
    // 4 calls → remaining = 5 - 4 = 1 (within ≤1 range)
    const transcript = await createTranscript(tmp, ["Read", "Glob", "Read", "Bash"])
    const r = await runHook(HOOK, { transcript_path: transcript })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    const ctx = hso?.additionalContext as string
    expect(ctx).toContain("1 tool call(s)")
    expect(ctx).toContain("blocked")
  })

  test("uses the current agent's create-task alias in countdown messaging", async () => {
    const tmp = await createTempDir()
    const transcript = await createTranscript(tmp, ["Read", "Glob", "Read"])
    const r = await runHook(
      HOOK,
      { transcript_path: transcript },
      { CODEX_THREAD_ID: "test-codex" }
    )
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    const ctx = hso?.additionalContext as string
    expect(ctx).toContain("update_plan required")
  })

  test("no output for small transcript (below threshold)", async () => {
    const tmp = await createTempDir()
    // 1 tool call → remaining = 5 - 1 = 4 (> 3, and total < 2)
    const transcript = await createTranscript(tmp, ["Read"])
    const r = await runHook(HOOK, { transcript_path: transcript })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("emits staleness countdown when task tools used but stale", async () => {
    const tmp = await createTempDir()
    // TaskCreate at index 0, then 8 more calls → callsSinceTask = 8, remaining = 10-8 = 2
    const tools = ["TaskCreate", "Read", "Glob", "Read", "Edit", "Bash", "Read", "Glob", "Read"]
    const transcript = await createTranscript(tmp, tools)
    const r = await runHook(HOOK, { transcript_path: transcript })
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    const ctx = hso?.additionalContext as string
    expect(ctx).toContain("Task update required")
  })

  test("treats update_plan as a task tool for staleness countdown", async () => {
    const tmp = await createTempDir()
    const tools = ["update_plan", "Read", "Glob", "Read", "Edit", "Bash", "Read", "Glob", "Read"]
    const transcript = await createTranscript(tmp, tools)
    const r = await runHook(
      HOOK,
      { transcript_path: transcript },
      { CODEX_THREAD_ID: "test-codex" }
    )
    expect(r.exitCode).toBe(0)
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    const ctx = hso?.additionalContext as string
    expect(ctx).toContain("Task update required")
  })

  test("no staleness warning when task tools used recently", async () => {
    const tmp = await createTempDir()
    // TaskCreate at index 0, then 2 calls → remaining = 10-2 = 8 (> 4)
    const transcript = await createTranscript(tmp, ["TaskCreate", "Read", "Glob"])
    const r = await runHook(HOOK, { transcript_path: transcript })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("posttooluse-task-subject-validation: positive paths", () => {
  const HOOK = "hooks/posttooluse-task-subject-validation.ts"

  test("compound subject emits block with suggestions", async () => {
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "Fix authentication and update deploy pipeline" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    expect(r.json?.decision).toBe("block")
    expect(r.json?.reason).toContain("compound")
    expect(r.json?.reason).toContain("Delete this task")
  })

  test("subject with 3+ comma-separated items emits block", async () => {
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "Fix login, fix signup, and fix logout" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.json?.decision).toBe("block")
    const reason = r.json?.reason as string
    expect(reason).toContain("Fix login")
  })

  test("simple subject produces no output", async () => {
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "Implement OAuth2 flow" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("posttooluse-prettier-ts: positive paths", () => {
  const HOOK = "hooks/posttooluse-prettier-ts.ts"

  test("TS file without prettier available exits cleanly (no crash)", async () => {
    const tmp = await createTempDir()
    const tsFile = join(tmp, "test.ts")
    await writeFile(tsFile, "const x = 1")
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: tsFile },
      cwd: tmp,
    })
    expect(r.exitCode).toBe(0)
    // No prettier found in temp dir → silent exit
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SessionStart hooks: positive paths — context injection
// ═══════════════════════════════════════════════════════════════════════════════

describe("sessionstart-compact-context: positive paths", () => {
  const HOOK = "hooks/sessionstart-compact-context.ts"

  test("compact matcher emits well-formed hookSpecificOutput", async () => {
    const r = await runHook(HOOK, { matcher: "compact", cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.hookEventName).toBe("SessionStart")
    const ctx = hso?.additionalContext as string
    expect(ctx).toContain("rg instead of grep")
    expect(ctx).toContain("Edit")
    expect(ctx).toContain("co-author")
  })
})

describe("sessionstart-health-snapshot: positive paths", () => {
  const HOOK = "hooks/sessionstart-health-snapshot.ts"

  test("emits git health info in repo with GitHub remote", async () => {
    const repo = await createGitRepo()
    // The hook requires isGitHubRemote(cwd) to emit git info.
    // Add a fake GitHub remote so the git path is exercised.
    Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:test/repo.git"], { cwd: repo })
    const r = await runHook(HOOK, { cwd: repo })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.hookEventName).toBe("SessionStart")
    const ctx = hso?.additionalContext as string
    expect(ctx).toContain("Git:")
    expect(ctx).toContain("branch=")
  })

  test("emits git info in real project repo", async () => {
    const r = await runHook(HOOK, { cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.hookEventName).toBe("SessionStart")
    const ctx = hso?.additionalContext as string
    expect(ctx).toContain("Git:")
    expect(ctx).toContain("branch=")
    expect(ctx).toContain("uncommitted=")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Stop hooks: positive paths — correct block/allow decisions
// ═══════════════════════════════════════════════════════════════════════════════

describe("stop-git-status: positive paths", () => {
  const HOOK = "hooks/stop-git-status.ts"

  test("dirty repo emits block with file summary", async () => {
    const repo = await createGitRepo()
    await writeFile(join(repo, "modified.ts"), "export const x = 1")
    await writeFile(join(repo, "new.txt"), "untracked")
    const r = await runHook(HOOK, { cwd: repo, session_id: "test-pos" })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    expect(r.json?.decision).toBe("block")
    const reason = r.json?.reason as string
    expect(reason).toContain("Uncommitted changes")
    expect(reason).toContain("2 untracked")
    expect(reason).toContain("ACTION REQUIRED")
  })

  test("dirty repo with staged files reports them", async () => {
    const repo = await createGitRepo()
    await writeFile(join(repo, "staged.ts"), "export default {}")
    Bun.spawnSync(["git", "add", "staged.ts"], { cwd: repo })
    const r = await runHook(HOOK, { cwd: repo, session_id: "test-staged" })
    expect(r.exitCode).toBe(0)
    const reason = r.json?.reason as string
    expect(reason).toContain("1 added")
  })

  test("clean repo allows stop (no output)", async () => {
    const repo = await createGitRepo()
    const r = await runHook(HOOK, { cwd: repo, session_id: "test-clean" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("stop-large-files: positive paths", () => {
  const HOOK = "hooks/stop-large-files.ts"

  test("repo with only small files allows stop", async () => {
    const repo = await createGitRepo()
    await writeFile(join(repo, "small.ts"), "export const x = 1")
    Bun.spawnSync(["git", "add", "."], { cwd: repo })
    Bun.spawnSync(["git", "commit", "-m", "add small file"], { cwd: repo })
    const r = await runHook(HOOK, { cwd: repo, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("repo with large file (>500KB) blocks stop", async () => {
    const repo = await createGitRepo()
    // Create a file > 500KB
    const largeContent = "x".repeat(600 * 1024)
    await writeFile(join(repo, "huge.bin"), largeContent)
    Bun.spawnSync(["git", "add", "."], { cwd: repo })
    Bun.spawnSync(["git", "commit", "-m", "add large file"], { cwd: repo })
    const r = await runHook(HOOK, { cwd: repo, session_id: "test-large" })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    expect(r.json?.decision).toBe("block")
    const reason = r.json?.reason as string
    expect(reason).toContain("Large files")
    expect(reason).toContain("huge.bin")
  })
})

describe("stop-completion-auditor: positive paths", () => {
  const HOOK = "hooks/stop-completion-auditor.ts"

  test("all tasks completed allows stop", async () => {
    const homeDir = await createTempDir()
    const sessionId = "test-all-complete"
    await createTaskFile(homeDir, sessionId, {
      id: "1",
      subject: "Task A",
      status: "completed",
    })
    await createTaskFile(homeDir, sessionId, {
      id: "2",
      subject: "Task B",
      status: "completed",
    })
    const r = await runHook(
      HOOK,
      { cwd: process.cwd(), session_id: sessionId, transcript_path: "" },
      { HOME: homeDir }
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("incomplete task blocks stop with task details", async () => {
    const homeDir = await createTempDir()
    const sessionId = "test-incomplete"
    await createTaskFile(homeDir, sessionId, {
      id: "1",
      subject: "Implement feature X",
      status: "in_progress",
    })
    await createTaskFile(homeDir, sessionId, {
      id: "2",
      subject: "Write tests",
      status: "pending",
    })
    const r = await runHook(
      HOOK,
      { cwd: process.cwd(), session_id: sessionId, transcript_path: "" },
      { HOME: homeDir }
    )
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    expect(r.json?.decision).toBe("block")
    const reason = r.json?.reason as string
    expect(reason).toContain("Incomplete tasks")
    expect(reason).toContain("#1 [in_progress]: Implement feature X")
    expect(reason).toContain("#2 [pending]: Write tests")
  })

  test("mix of completed and incomplete shows only incomplete", async () => {
    const homeDir = await createTempDir()
    const sessionId = "test-mixed"
    await createTaskFile(homeDir, sessionId, {
      id: "1",
      subject: "Done task",
      status: "completed",
    })
    await createTaskFile(homeDir, sessionId, {
      id: "2",
      subject: "Still working",
      status: "in_progress",
    })
    const r = await runHook(
      HOOK,
      { cwd: process.cwd(), session_id: sessionId, transcript_path: "" },
      { HOME: homeDir }
    )
    expect(r.exitCode).toBe(0)
    expect(r.json?.decision).toBe("block")
    const reason = r.json?.reason as string
    expect(reason).toContain("Still working")
    expect(reason).not.toContain("Done task")
  })

  test("substantial session without tasks blocks stop", async () => {
    const homeDir = await createTempDir()
    const tmp = await createTempDir()
    // Create transcript with 12 tool calls (above TOOL_CALL_THRESHOLD=10) but no task tools
    const tools = [
      "Read",
      "Glob",
      "Read",
      "Edit",
      "Bash",
      "Read",
      "Write",
      "Read",
      "Glob",
      "Edit",
      "Read",
      "Bash",
    ]
    const transcript = await createTranscript(tmp, tools)
    const r = await runHook(
      HOOK,
      { cwd: process.cwd(), session_id: "test-no-tasks", transcript_path: transcript },
      { HOME: homeDir }
    )
    expect(r.exitCode).toBe(0)
    expect(r.json?.decision).toBe("block")
    const reason = r.json?.reason as string
    expect(reason).toContain("No tasks were created")
    expect(reason).toContain("12 tool calls")
  })
})

describe("stop-git-push: positive paths (now merged into stop-git-status)", () => {
  const HOOK = "hooks/stop-git-status.ts"

  test("repo without remote allows stop", async () => {
    const repo = await createGitRepo()
    const r = await runHook(HOOK, { cwd: repo, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("repo with unpushed commits to local bare remote blocks", async () => {
    // Create a normal repo, push to a bare remote, then add an unpushed commit
    const sourceDir = await createTempDir()
    Bun.spawnSync(["git", "init"], { cwd: sourceDir })
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: sourceDir })
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: sourceDir })
    await writeFile(join(sourceDir, "init.txt"), "init")
    Bun.spawnSync(["git", "add", "."], { cwd: sourceDir })
    Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: sourceDir })

    // Create bare remote from source
    const bareDir = await createTempDir()
    Bun.spawnSync(["git", "clone", "--bare", sourceDir, `${bareDir}/repo.git`])

    // Clone the bare remote to get tracking
    const cloneDir = await createTempDir()
    Bun.spawnSync(["git", "clone", `${bareDir}/repo.git`, "work"], { cwd: cloneDir })
    const workDir = join(cloneDir, "work")
    Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: workDir })
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: workDir })

    // Create an unpushed commit
    await writeFile(join(workDir, "new.txt"), "content")
    Bun.spawnSync(["git", "add", "."], { cwd: workDir })
    Bun.spawnSync(["git", "commit", "-m", "unpushed"], { cwd: workDir })

    const r = await runHook(HOOK, { cwd: workDir, session_id: "test-unpushed" })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    expect(r.json?.decision).toBe("block")
    const reason = r.json?.reason as string
    expect(reason).toContain("Unpushed commits")
    expect(reason).toContain("1 commit(s)")
  })
})

describe("stop-branch-conflicts: positive paths", () => {
  const HOOK = "hooks/stop-branch-conflicts.ts"

  test("main branch skips conflict check", async () => {
    const repo = await createGitRepo()
    const r = await runHook(HOOK, { cwd: repo, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("feature branch without remote allows stop", async () => {
    const repo = await createGitRepo()
    Bun.spawnSync(["git", "checkout", "-b", "feature/test"], { cwd: repo })
    const r = await runHook(HOOK, { cwd: repo, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("stop-lint-staged: positive paths", () => {
  const HOOK = "hooks/stop-lint-staged.ts"

  test("project without lint-staged allows stop", async () => {
    const tmp = await createTempDir()
    await writeFile(
      join(tmp, "package.json"),
      '{"name": "test", "version": "1.0.0", "scripts": {"test": "echo ok"}}'
    )
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("stop-lockfile-drift: positive paths", () => {
  const HOOK = "hooks/stop-lockfile-drift.ts"

  test("repo with no dependency changes allows stop", async () => {
    const repo = await createGitRepo()
    // Write file at root level (no subdirectory needed)
    await writeFile(join(repo, "index.ts"), "export default {}")
    Bun.spawnSync(["git", "add", "."], { cwd: repo })
    Bun.spawnSync(["git", "commit", "-m", "add source"], { cwd: repo })
    const r = await runHook(HOOK, { cwd: repo, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("stop-pr-changes-requested: positive paths", () => {
  const HOOK = "hooks/stop-pr-changes-requested.ts"

  test("main branch skips PR check", async () => {
    const repo = await createGitRepo()
    const r = await runHook(HOOK, { cwd: repo, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("stop-pr-description: positive paths", () => {
  const HOOK = "hooks/stop-pr-description.ts"

  test("main branch skips PR description check", async () => {
    const repo = await createGitRepo()
    const r = await runHook(HOOK, { cwd: repo, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("stop-github-ci: positive paths", () => {
  const HOOK = "hooks/stop-github-ci.ts"

  test("repo without GitHub remote allows stop", async () => {
    const repo = await createGitRepo()
    const r = await runHook(HOOK, { cwd: repo, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// UserPromptSubmit hooks: positive paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("userpromptsubmit-git-context: positive paths", () => {
  const HOOK = "hooks/userpromptsubmit-git-context.ts"

  test("emits git branch info in git repo", async () => {
    // This hook uses process.cwd() which is the swiz repo
    const r = await runHook(HOOK, { session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.json).not.toBeNull()
    const hso = r.json?.hookSpecificOutput as Record<string, unknown>
    expect(hso?.hookEventName).toBe("UserPromptSubmit")
    const ctx = hso?.additionalContext as string
    expect(ctx).toContain("[git] branch:")
    expect(ctx).toContain("uncommitted files:")
  })
})
