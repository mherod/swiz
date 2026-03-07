/**
 * Negative-path regression tests for hooks that lacked dedicated test coverage.
 * Each test verifies the hook exits cleanly (exit 0, no crash) under adverse
 * conditions: missing fields, empty stdin payloads, non-git directories,
 * malformed inputs, and missing environment prerequisites.
 *
 * These complement the existing 22 hardening-regression tests which focus on
 * HOME env, path traversal, and whitespace filtering.
 */
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "./test-utils.ts"

// ─── Shared test infrastructure ─────────────────────────────────────────────

const { create: createTempDir } = useTempDir("swiz-negpath-")

interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Run a hook script as a subprocess with controlled stdin and env.
 */
async function runHook(
  script: string,
  stdinPayload: Record<string, unknown>,
  envOverrides: Record<string, string | undefined> = {}
): Promise<HookResult> {
  const payload = JSON.stringify(stdinPayload)
  const env: Record<string, string | undefined> = { ...process.env, ...envOverrides }

  const proc = Bun.spawn(["bun", script], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  proc.stdin.write(payload)
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited

  return { exitCode: proc.exitCode, stdout: stdout.trim(), stderr }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PreToolUse hooks: negative paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("pretooluse-eslint-config-strength", () => {
  const HOOK = "hooks/pretooluse-eslint-config-strength.ts"

  test("non-eslint file exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "src/index.ts", old_string: "a", new_string: "b" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("no tool_input exits cleanly", async () => {
    const r = await runHook(HOOK, { tool_name: "Edit" })
    expect(r.exitCode).toBe(0)
  })

  test("eslint config with no old_string (new file) is allowed", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Write",
      tool_input: {
        file_path: ".eslintrc.json",
        content: '{"rules": {"no-unused-vars": "error"}}',
      },
    })
    expect(r.exitCode).toBe(0)
  })

  test("eslint config with equal strength is allowed", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: ".eslintrc.json",
        old_string: '"no-unused-vars": "warning"',
        new_string: '"no-unused-vars": "warning"',
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).not.toContain('"deny"')
  })

  test("weakening eslint config is denied", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: ".eslintrc.json",
        old_string: '"no-unused-vars": "warning", "no-undef": "error"',
        new_string: '"no-unused-vars": "off"',
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("deny")
  })

  test("empty file_path exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "", old_string: "a", new_string: "b" },
    })
    expect(r.exitCode).toBe(0)
  })
})

describe("pretooluse-json-validation", () => {
  const HOOK = "hooks/pretooluse-json-validation.ts"

  test("non-settings.json file exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "package.json" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("no tool_input exits cleanly", async () => {
    const r = await runHook(HOOK, { tool_name: "Edit" })
    expect(r.exitCode).toBe(0)
  })

  test("empty file_path exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("nonexistent settings.json file triggers deny", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "/nonexistent/.claude/settings.json" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("deny")
  })
})

describe("pretooluse-no-as-any", () => {
  const HOOK = "hooks/pretooluse-no-as-any.ts"

  test("non-typescript file exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "src/index.js", old_string: "a", new_string: "b as any" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("no old_string (new file) exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Write",
      tool_input: { file_path: "src/index.ts", content: "const x = y as any" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("adding 'as any' to TS file is denied", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/index.ts",
        old_string: "const x = getValue()",
        new_string: "const x = getValue() as any",
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("deny")
  })

  test("removing 'as any' from TS file is allowed", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/index.ts",
        old_string: "const x = getValue() as any",
        new_string: "const x: string = getValue()",
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).not.toContain('"deny"')
  })

  test("empty tool_input exits cleanly", async () => {
    const r = await runHook(HOOK, { tool_name: "Edit", tool_input: {} })
    expect(r.exitCode).toBe(0)
  })
})

describe("pretooluse-no-direct-deps", () => {
  const HOOK = "hooks/pretooluse-no-direct-deps.ts"

  test("non-package.json file exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "src/index.ts", new_string: "code" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("non-edit tool exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("package.json in node_modules exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: "node_modules/foo/package.json",
        new_string: '{"dependencies": {"bar": "1.0"}}',
      },
    })
    expect(r.exitCode).toBe(0)
  })

  test("package.json with dependencies block is denied", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: "package.json",
        new_string: '{"dependencies": {"lodash": "^4.0.0"}}',
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("deny")
  })

  test("package.json with scripts-only edit is allowed", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: "package.json",
        new_string: '{"scripts": {"test": "vitest"}}',
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).not.toContain('"deny"')
  })

  test("invalid JSON in new_string is allowed (catch block)", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {
        file_path: "package.json",
        new_string: "not json at all",
      },
    })
    expect(r.exitCode).toBe(0)
  })

  test("empty new_string exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "package.json" },
    })
    expect(r.exitCode).toBe(0)
  })
})

describe("pretooluse-no-task-delegation", () => {
  const HOOK = "hooks/pretooluse-no-task-delegation.ts"

  test("prompt with TaskCreate is denied", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Task",
      tool_input: { prompt: "Create tasks using TaskCreate for each step" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("deny")
  })

  test("prompt mentioning 'task' as domain noun is allowed", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Task",
      tool_input: { prompt: "Create a task queue implementation" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).not.toContain('"deny"')
  })

  test("empty prompt exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Task",
      tool_input: { prompt: "" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("no tool_input exits cleanly", async () => {
    const r = await runHook(HOOK, { tool_name: "Task" })
    expect(r.exitCode).toBe(0)
  })
})

describe("pretooluse-task-subject-validation", () => {
  const HOOK = "hooks/pretooluse-task-subject-validation.ts"

  test("simple subject is allowed", async () => {
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "Fix authentication bug" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).not.toContain('"deny"')
  })

  test("compound subject with 'and' is denied", async () => {
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "Fix authentication and update tests and deploy" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("deny")
  })

  test("empty subject exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("no tool_input exits cleanly", async () => {
    const r = await runHook(HOOK, { tool_name: "TaskCreate" })
    expect(r.exitCode).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// PostToolUse hooks: negative paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("posttooluse-git-status", () => {
  const HOOK = "hooks/posttooluse-git-status.ts"

  test("empty cwd exits cleanly", async () => {
    const r = await runHook(HOOK, { cwd: "" })
    expect(r.exitCode).toBe(0)
  })

  test("non-git directory exits cleanly", async () => {
    const tmp = await createTempDir()
    const r = await runHook(HOOK, { cwd: tmp })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("nonexistent cwd exits cleanly", async () => {
    const r = await runHook(HOOK, { cwd: "/nonexistent/path/xyz" })
    expect(r.exitCode).toBe(0)
  })

  test("no cwd field exits cleanly", async () => {
    const r = await runHook(HOOK, {})
    expect(r.exitCode).toBe(0)
  })
})

describe("posttooluse-json-validation", () => {
  const HOOK = "hooks/posttooluse-json-validation.ts"

  test("non-json file exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "src/index.ts" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("no file_path exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: {},
    })
    expect(r.exitCode).toBe(0)
  })

  test("no tool_input exits cleanly", async () => {
    const r = await runHook(HOOK, { tool_name: "Edit" })
    expect(r.exitCode).toBe(0)
  })

  test("nonexistent json file triggers block", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "/nonexistent/file.json" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("block")
  })

  test("valid json file passes", async () => {
    const tmp = await createTempDir()
    const jsonFile = join(tmp, "test.json")
    await Bun.write(jsonFile, '{"valid": true}')
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: jsonFile },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("invalid json file triggers block", async () => {
    const tmp = await createTempDir()
    const jsonFile = join(tmp, "broken.json")
    await Bun.write(jsonFile, '{"broken": ')
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: jsonFile },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("block")
  })
})

describe("posttooluse-prettier-ts", () => {
  const HOOK = "hooks/posttooluse-prettier-ts.ts"

  test("non-edit tool exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Bash",
      tool_input: { file_path: "src/index.ts" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("non-typescript file exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "src/style.css" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("empty file_path exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "Edit",
      tool_input: { file_path: "" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("no file_path in tool_input exits cleanly", async () => {
    const r = await runHook(HOOK, { tool_name: "Edit", tool_input: {} })
    expect(r.exitCode).toBe(0)
  })
})

describe("posttooluse-task-advisor", () => {
  const HOOK = "hooks/posttooluse-task-advisor.ts"

  test("empty transcript_path exits cleanly", async () => {
    const r = await runHook(HOOK, { transcript_path: "" })
    expect(r.exitCode).toBe(0)
  })

  test("no transcript_path exits cleanly", async () => {
    const r = await runHook(HOOK, {})
    expect(r.exitCode).toBe(0)
  })

  test("nonexistent transcript exits cleanly", async () => {
    const r = await runHook(HOOK, { transcript_path: "/nonexistent/transcript.jsonl" })
    expect(r.exitCode).toBe(0)
  })
})

describe("posttooluse-task-subject-validation", () => {
  const HOOK = "hooks/posttooluse-task-subject-validation.ts"

  test("simple subject passes", async () => {
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "Fix one thing" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).not.toContain('"block"')
  })

  test("compound subject is blocked", async () => {
    // Both parts after "and" must start with action verbs for detection
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "Fix authentication and update deploy pipeline" },
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("block")
  })

  test("empty subject exits cleanly", async () => {
    const r = await runHook(HOOK, {
      tool_name: "TaskCreate",
      tool_input: { subject: "" },
    })
    expect(r.exitCode).toBe(0)
  })

  test("no tool_input exits cleanly", async () => {
    const r = await runHook(HOOK, { tool_name: "TaskCreate" })
    expect(r.exitCode).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// SessionStart hooks: negative paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("sessionstart-compact-context", () => {
  const HOOK = "hooks/sessionstart-compact-context.ts"

  test("fresh session (no matcher) exits cleanly with no output", async () => {
    const r = await runHook(HOOK, { matcher: "", cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("unknown matcher exits cleanly with no output", async () => {
    const r = await runHook(HOOK, { matcher: "unknown_event", cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("compact matcher emits context", async () => {
    const r = await runHook(HOOK, { matcher: "compact", cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("Post-compaction context")
  })

  test("resume matcher emits context", async () => {
    const r = await runHook(HOOK, { matcher: "resume", cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("Post-compaction context")
  })

  test("no matcher field exits cleanly", async () => {
    const r = await runHook(HOOK, { cwd: process.cwd() })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("sessionstart-health-snapshot", () => {
  const HOOK = "hooks/sessionstart-health-snapshot.ts"

  test("empty cwd exits cleanly", async () => {
    const r = await runHook(HOOK, { cwd: "" })
    expect(r.exitCode).toBe(0)
  })

  test("non-git directory exits cleanly", async () => {
    const tmp = await createTempDir()
    const r = await runHook(HOOK, { cwd: tmp })
    expect(r.exitCode).toBe(0)
  })

  test("nonexistent cwd exits cleanly", async () => {
    const r = await runHook(HOOK, { cwd: "/nonexistent/path/xyz" })
    expect(r.exitCode).toBe(0)
  })

  test("no cwd field exits cleanly", async () => {
    const r = await runHook(HOOK, {})
    expect(r.exitCode).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Stop hooks: negative paths (non-git / missing tool scenarios)
// ═══════════════════════════════════════════════════════════════════════════════

describe("stop-branch-conflicts", () => {
  const HOOK = "hooks/stop-branch-conflicts.ts"

  test("non-git directory exits cleanly", async () => {
    const tmp = await createTempDir()
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("nonexistent cwd exits cleanly", async () => {
    const r = await runHook(HOOK, { cwd: "/nonexistent/path", session_id: "test" })
    expect(r.exitCode).toBe(0)
  })
})

describe("stop-completion-auditor (extended)", () => {
  const HOOK = "hooks/stop-completion-auditor.ts"

  test("missing HOME exits cleanly", async () => {
    const r = await runHook(
      HOOK,
      { cwd: process.cwd(), session_id: "test", transcript_path: "" },
      { HOME: undefined }
    )
    expect(r.exitCode).toBe(0)
  })

  test("nonexistent session directory exits cleanly (short session)", async () => {
    const tmp = await createTempDir()
    const r = await runHook(
      HOOK,
      { cwd: process.cwd(), session_id: "nonexistent-session-id", transcript_path: "" },
      { HOME: tmp }
    )
    expect(r.exitCode).toBe(0)
  })

  test("empty session_id exits cleanly", async () => {
    const r = await runHook(HOOK, {
      cwd: process.cwd(),
      session_id: "",
      transcript_path: "",
    })
    expect(r.exitCode).toBe(0)
  })
})

describe("stop-git-push (now merged into stop-git-status)", () => {
  const HOOK = "hooks/stop-git-status.ts"

  test("non-git directory exits cleanly", async () => {
    const tmp = await createTempDir()
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })

  test("nonexistent cwd exits cleanly", async () => {
    const r = await runHook(HOOK, { cwd: "/nonexistent/path", session_id: "test" })
    expect(r.exitCode).toBe(0)
  })

  test("git repo without remote exits cleanly", async () => {
    const tmp = await createTempDir()
    Bun.spawnSync(["git", "init"], { cwd: tmp })
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: tmp })
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("stop-git-status (extended)", () => {
  const HOOK = "hooks/stop-git-status.ts"

  test("non-git directory exits cleanly", async () => {
    const tmp = await createTempDir()
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("clean git repo exits cleanly", async () => {
    const tmp = await createTempDir()
    Bun.spawnSync(["git", "init"], { cwd: tmp })
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: tmp })
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })

  test("dirty git repo emits block", async () => {
    const tmp = await createTempDir()
    Bun.spawnSync(["git", "init"], { cwd: tmp })
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: tmp })
    await Bun.write(join(tmp, "dirty.txt"), "uncommitted")
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("block")
    expect(r.stdout).toContain("Uncommitted changes")
  })
})

describe("stop-github-ci", () => {
  const HOOK = "hooks/stop-github-ci.ts"

  test("non-git directory exits cleanly", async () => {
    const tmp = await createTempDir()
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })

  test("git repo without GitHub remote exits cleanly", async () => {
    const tmp = await createTempDir()
    Bun.spawnSync(["git", "init"], { cwd: tmp })
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: tmp })
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })
})

describe("stop-large-files", () => {
  const HOOK = "hooks/stop-large-files.ts"

  test("non-git directory exits cleanly", async () => {
    const tmp = await createTempDir()
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })

  test("git repo with no commits exits cleanly", async () => {
    const tmp = await createTempDir()
    Bun.spawnSync(["git", "init"], { cwd: tmp })
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })

  test("git repo with only small files exits cleanly", async () => {
    const tmp = await createTempDir()
    Bun.spawnSync(["git", "init"], { cwd: tmp })
    await Bun.write(join(tmp, "small.txt"), "hello")
    Bun.spawnSync(["git", "add", "."], { cwd: tmp })
    Bun.spawnSync(["git", "commit", "-m", "add small file"], { cwd: tmp })
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("stop-lint-staged", () => {
  const HOOK = "hooks/stop-lint-staged.ts"

  test("directory without package.json exits cleanly", async () => {
    const tmp = await createTempDir()
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })

  test("package.json without lint-staged exits cleanly", async () => {
    const tmp = await createTempDir()
    await Bun.write(join(tmp, "package.json"), '{"name": "test", "scripts": {}}')
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })

  test("invalid package.json exits cleanly", async () => {
    const tmp = await createTempDir()
    await Bun.write(join(tmp, "package.json"), "not json")
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })
})

describe("stop-lockfile-drift", () => {
  const HOOK = "hooks/stop-lockfile-drift.ts"

  test("non-git directory exits cleanly", async () => {
    const tmp = await createTempDir()
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })

  test("git repo with no package.json changes exits cleanly", async () => {
    const tmp = await createTempDir()
    Bun.spawnSync(["git", "init"], { cwd: tmp })
    await Bun.write(join(tmp, "readme.md"), "hello")
    Bun.spawnSync(["git", "add", "."], { cwd: tmp })
    Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: tmp })
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("")
  })
})

describe("stop-pr-changes-requested", () => {
  const HOOK = "hooks/stop-pr-changes-requested.ts"

  test("non-git directory exits cleanly", async () => {
    const tmp = await createTempDir()
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })

  test("git repo without GitHub remote exits cleanly", async () => {
    const tmp = await createTempDir()
    Bun.spawnSync(["git", "init"], { cwd: tmp })
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: tmp })
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })
})

describe("stop-pr-description", () => {
  const HOOK = "hooks/stop-pr-description.ts"

  test("non-git directory exits cleanly", async () => {
    const tmp = await createTempDir()
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })

  test("git repo without GitHub remote exits cleanly", async () => {
    const tmp = await createTempDir()
    Bun.spawnSync(["git", "init"], { cwd: tmp })
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: tmp })
    const r = await runHook(HOOK, { cwd: tmp, session_id: "test" })
    expect(r.exitCode).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// UserPromptSubmit hooks: negative paths
// ═══════════════════════════════════════════════════════════════════════════════

describe("userpromptsubmit-git-context", () => {
  const HOOK = "hooks/userpromptsubmit-git-context.ts"

  test("hook exits cleanly in any environment", async () => {
    // This hook uses process.cwd() directly, not input.cwd
    // We just verify it doesn't crash with a minimal payload
    const r = await runHook(HOOK, { session_id: "test" })
    expect(r.exitCode).toBe(0)
  })
})
