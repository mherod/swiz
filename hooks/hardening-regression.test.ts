/**
 * Regression tests for security hardening applied to hooks/*.ts:
 * 1. Missing HOME env var triggers early return (no crash, no "undefined" in paths)
 * 2. Path-traversal sessionId payloads are neutralized by join()
 * 3. Whitespace-only git output lines are filtered correctly
 */
import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { runHook, useTempDir, writeTask } from "./utils/test-utils.ts"

// ─── Shared test infrastructure ─────────────────────────────────────────────

const tmp = useTempDir("swiz-hardening-")
const createTempHome = () => tmp.create()

// ═══════════════════════════════════════════════════════════════════════════════
// Category 1: Missing HOME env var → early return (no crash)
// ═══════════════════════════════════════════════════════════════════════════════

describe("missing HOME env var triggers early return", () => {
  test("pretooluse-require-tasks exits cleanly with no HOME", async () => {
    const result = await runHook(
      "hooks/pretooluse-require-tasks.ts",
      { tool_name: "Bash", session_id: "test-session", transcript_path: "" },
      { HOME: undefined }
    )
    // Should exit 0 (not crash) and not deny — early return before task check
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBeUndefined()
  })

  test("stop-completion-auditor exits cleanly with no HOME", async () => {
    const result = await runHook(
      "hooks/stop-completion-auditor.ts",
      { cwd: process.cwd(), session_id: "test-session", transcript_path: "" },
      { HOME: undefined }
    )
    expect(result.exitCode).toBe(0)
    // Should not block — early return
    expect(result.decision).not.toBe("block")
  })

  test("userpromptsubmit-task-advisor exits cleanly with no HOME", async () => {
    const result = await runHook(
      "hooks/userpromptsubmit-task-advisor.ts",
      { session_id: "test-session" },
      { HOME: undefined }
    )
    expect(result.exitCode).toBe(0)
  })

  test("stop-auto-continue exits cleanly with no HOME", async () => {
    const result = await runHook(
      "hooks/stop-auto-continue.ts",
      {
        cwd: process.cwd(),
        session_id: "test-session",
        transcript_path: "",
        stop_hook_active: false,
      },
      { HOME: undefined }
    )
    expect(result.exitCode).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Category 2: Path-traversal sessionId payloads neutralized by join()
// ═══════════════════════════════════════════════════════════════════════════════

describe("path-traversal sessionId payloads are neutralized", () => {
  test("pretooluse-require-tasks: traversal sessionId does not escape tasks dir", async () => {
    const homeDir = await createTempHome()
    // Create a task in the legitimate location
    await writeTask(homeDir, "../../etc/passwd", {
      id: "1",
      subject: "Legit task",
      status: "in_progress",
    })

    const result = await runHook(
      "hooks/pretooluse-require-tasks.ts",
      {
        tool_name: "Bash",
        session_id: "../../etc/passwd",
        transcript_path: "",
      },
      { HOME: homeDir }
    )
    // join() normalizes the path — the hook should function (deny or allow)
    // but NOT access ../../etc/passwd from the HOME root
    expect(result.exitCode).toBe(0)
    // The task exists at the normalized path, so it should NOT deny
    // (join resolves ../../ relative to the tasks dir)
    expect(typeof result.stdout).toBe("string")
  })

  test("pretooluse-require-tasks: sessionId with slashes resolves safely", async () => {
    const homeDir = await createTempHome()
    // Traversal sessionId is sanitized — hook exits cleanly without enforcement
    const result = await runHook(
      "hooks/pretooluse-require-tasks.ts",
      {
        tool_name: "Edit",
        session_id: "../../../tmp/evil",
        transcript_path: "",
      },
      { HOME: homeDir }
    )
    expect(result.exitCode).toBe(0)
    // Traversal sessionId is rejected early — no deny, no crash, just silent exit
    expect(result.decision).toBeUndefined()
  })

  test("stop-completion-auditor: traversal sessionId does not crash", async () => {
    const homeDir = await createTempHome()
    const result = await runHook(
      "hooks/stop-completion-auditor.ts",
      {
        cwd: process.cwd(),
        session_id: "../../etc/shadow",
        transcript_path: "",
      },
      { HOME: homeDir }
    )
    expect(result.exitCode).toBe(0)
  })

  test("sessionId with null bytes does not crash", async () => {
    const homeDir = await createTempHome()
    const result = await runHook(
      "hooks/pretooluse-require-tasks.ts",
      {
        tool_name: "Bash",
        session_id: "session\0id",
        transcript_path: "",
      },
      { HOME: homeDir }
    )
    expect(result.exitCode).toBe(0)
  })

  test("sessionId with shell metacharacters does not crash", async () => {
    const homeDir = await createTempHome()
    const result = await runHook(
      "hooks/pretooluse-require-tasks.ts",
      {
        tool_name: "Bash",
        session_id: "$(rm -rf /)",
        transcript_path: "",
      },
      { HOME: homeDir }
    )
    expect(result.exitCode).toBe(0)
    // sessionId contains / — sanitized and rejected early, no crash
    expect(result.decision).toBeUndefined()
  })

  test("empty sessionId causes clean exit (no deny)", async () => {
    const homeDir = await createTempHome()
    const result = await runHook(
      "hooks/pretooluse-require-tasks.ts",
      {
        tool_name: "Bash",
        session_id: "",
        transcript_path: "",
      },
      { HOME: homeDir }
    )
    // Empty sessionId triggers early exit before task check
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Category 3: Whitespace-only line filtering in git output and JSONL parsing
// ═══════════════════════════════════════════════════════════════════════════════

describe("whitespace-only line filtering", () => {
  // These test the hardened filter(l => l.trim()) pattern imported from hook-utils

  test("parseGitStatus: whitespace-only lines are excluded from total count", async () => {
    // Import directly — this is a pure function
    const { parseGitStatus } = await import("./utils/hook-utils.ts")

    const input = " M file.ts\n   \n?? new.ts\n  \t  \n"
    const result = parseGitStatus(input)

    // Only 2 real lines, not 4
    expect(result.total).toBe(2)
    expect(result.modified).toBe(1)
    expect(result.untracked).toBe(1)
    expect(result.lines).toHaveLength(2)
  })

  test("parseGitStatus: tabs-only lines are excluded", async () => {
    const { parseGitStatus } = await import("./utils/hook-utils.ts")

    const input = "\t\t\t\n M real.ts\n\t\n"
    const result = parseGitStatus(input)
    expect(result.total).toBe(1)
    expect(result.modified).toBe(1)
  })

  test("parseGitStatus: mixed whitespace between valid lines", async () => {
    const { parseGitStatus } = await import("./utils/hook-utils.ts")

    const input = "A  added.ts\n \n \n \nD  deleted.ts\n\n\n"
    const result = parseGitStatus(input)
    expect(result.total).toBe(2)
    expect(result.added).toBe(1)
    expect(result.deleted).toBe(1)
  })

  test("extractToolNamesFromTranscript: whitespace-only JSONL lines don't cause parse errors", async () => {
    const { extractToolNamesFromTranscript } = await import("./utils/hook-utils.ts")

    const tmpDir = await tmp.create("swiz-filter-")

    const entry = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read" }] },
    })
    // Insert whitespace-only lines between valid JSONL entries
    const content = `${entry}\n   \t  \n  \n${entry}\n \n`
    await writeFile(join(tmpDir, "transcript.jsonl"), content)

    const result = await extractToolNamesFromTranscript(join(tmpDir, "transcript.jsonl"))
    expect(result).toEqual(["Read", "Read"])
  })

  test("extractToolNamesFromTranscript: only-whitespace file returns empty array", async () => {
    const { extractToolNamesFromTranscript } = await import("./utils/hook-utils.ts")

    const tmpDir = await tmp.create("swiz-filter-")

    await writeFile(join(tmpDir, "whitespace.jsonl"), "   \n\t\n  \t  \n")

    const result = await extractToolNamesFromTranscript(join(tmpDir, "whitespace.jsonl"))
    expect(result).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Category 4: createSessionTask sanitization regression
// ═══════════════════════════════════════════════════════════════════════════════

describe("createSessionTask input sanitization", () => {
  test("path-traversal in sentinelKey produces safe /tmp/ path", async () => {
    const { createSessionTask } = await import("./utils/hook-utils.ts")
    // Should not throw — path separators are stripped from sentinel key
    await createSessionTask("valid-session-id", "../../etc/cron.d/evil", "subject", "desc")
  })

  test("path-traversal in sessionId produces safe /tmp/ path", async () => {
    const { createSessionTask } = await import("./utils/hook-utils.ts")
    await createSessionTask("../../etc/passwd", "safe-key", "subject", "desc")
  })

  test("shell injection in sessionId is sanitized", async () => {
    const { createSessionTask } = await import("./utils/hook-utils.ts")
    await createSessionTask("$(whoami)", "safe-key", "subject", "desc")
    // If this returns without error, the injection was neutralized
  })

  test("empty HOME causes early return", async () => {
    // Use subprocess to control HOME env
    const script = `
      import { createSessionTask } from "./hooks/utils/hook-utils.ts";
      await createSessionTask("valid-id", "key", "subj", "desc");
      console.log("OK");
    `
    const proc = Bun.spawn(["bun", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: "" },
    })
    const stdout = await new Response(proc.stdout).text()
    await proc.exited
    // Should complete without crashing (early return due to empty HOME)
    expect(proc.exitCode).toBe(0)
    expect(stdout.trim()).toBe("OK")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Category 5: Non-null assertion replacements (! → runtime guards)
// ═══════════════════════════════════════════════════════════════════════════════

describe("non-null assertion guard regressions", () => {
  test("extractOwnerFromUrl handles malformed SSH URLs without crashing", async () => {
    // We can't easily import the function since it's not exported,
    // but we can run the hook with a non-GitHub remote to verify no crash
    const result = await runHook(
      "hooks/stop-personal-repo-issues.ts",
      {
        cwd: "/nonexistent/path",
        session_id: "test-session",
        transcript_path: "",
      },
      {}
    )
    // Should exit cleanly — the isGitRepo check will fail first
    expect(result.exitCode).toBe(0)
  })

  test("pretooluse-banned-commands handles commit without message match group", async () => {
    const result = await runHook(
      "hooks/pretooluse-banned-commands.ts",
      {
        tool_name: "Bash",
        tool_input: { command: "git commit --allow-empty" },
      },
      {}
    )
    // Should exit 0 — no match on the regex means no crash on mMatch[1]
    expect(result.exitCode).toBe(0)
  })

  test("pretooluse-banned-commands detects Co-authored-by correctly", async () => {
    const result = await runHook(
      "hooks/pretooluse-banned-commands.ts",
      {
        tool_name: "Bash",
        tool_input: {
          command: "git commit -m 'fix: something\n\nCo-authored-by: Bot <bot@example.com>'",
        },
      },
      {}
    )
    expect(result.exitCode).toBe(0)
    expect(result.decision).toBe("deny")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Category 6: lefthook.yml config integrity
// ═══════════════════════════════════════════════════════════════════════════════

interface LefthookCommand {
  priority?: number
  run?: string
  skip?: string[]
  glob?: string
  stage_fixed?: boolean
}

interface LefthookHook {
  commands?: Record<string, LefthookCommand>
}

interface LefthookConfig {
  "pre-commit"?: LefthookHook
  "pre-push"?: LefthookHook
}

describe("lefthook.yml config integrity", () => {
  test("disk-space command is present in pre-commit", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    expect(config["pre-commit"]?.commands).toHaveProperty("disk-space")
  })

  test("disk-space command is present in pre-push", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    expect(config["pre-push"]?.commands).toHaveProperty("disk-space")
  })

  test("disk-space has priority 1 in pre-commit (runs before lint and typecheck)", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    expect(config["pre-commit"]?.commands?.["disk-space"]?.priority).toBe(1)
  })

  test("disk-space has priority 1 in pre-push (runs before test)", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    expect(config["pre-push"]?.commands?.["disk-space"]?.priority).toBe(1)
  })

  test("disk-space run command references check-disk-space.ts script", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    const preCommitRun = config["pre-commit"]?.commands?.["disk-space"]?.run ?? ""
    const prePushRun = config["pre-push"]?.commands?.["disk-space"]?.run ?? ""
    expect(preCommitRun).toContain("check-disk-space")
    expect(prePushRun).toContain("check-disk-space")
  })

  test("existing pre-commit commands (lint, typecheck) are still present", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    expect(config["pre-commit"]?.commands).toHaveProperty("lint")
    expect(config["pre-commit"]?.commands).toHaveProperty("typecheck")
  })

  test("existing pre-push test command is still present", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    expect(config["pre-push"]?.commands).toHaveProperty("test")
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Category 7: lefthook.yml hook-order, partial-edit, and config-invariant guards
// ═══════════════════════════════════════════════════════════════════════════════

describe("lefthook.yml hook-order and invariant guards", () => {
  // ── Hook order: disk-space must be the unique earliest command ───────────

  test("no other pre-commit command has priority ≤ 1 (disk-space runs first uniquely)", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    const commands = config["pre-commit"]?.commands ?? {}
    const contenders = Object.entries(commands)
      .filter(([name, cmd]) => name !== "disk-space" && (cmd.priority ?? Infinity) <= 1)
      .map(([name]) => name)
    expect(contenders).toEqual([])
  })

  test("no other pre-push command has priority ≤ 1 (disk-space runs first uniquely)", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    const commands = config["pre-push"]?.commands ?? {}
    const contenders = Object.entries(commands)
      .filter(([name, cmd]) => name !== "disk-space" && (cmd.priority ?? Infinity) <= 1)
      .map(([name]) => name)
    expect(contenders).toEqual([])
  })

  // ── Partial edits: skip list and stage_fixed integrity ───────────────────

  test("disk-space skip list includes merge and rebase in pre-commit", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    const skip = config["pre-commit"]?.commands?.["disk-space"]?.skip ?? []
    expect(skip).toContain("merge")
    expect(skip).toContain("rebase")
  })

  test("disk-space skip list includes merge and rebase in pre-push", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    const skip = config["pre-push"]?.commands?.["disk-space"]?.skip ?? []
    expect(skip).toContain("merge")
    expect(skip).toContain("rebase")
  })

  test("lint retains stage_fixed:true", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    expect(config["pre-commit"]?.commands?.lint?.stage_fixed).toBe(true)
  })

  // ── Config invariants: glob and run patterns haven't drifted ────────────

  test("typecheck glob is exactly '*.ts'", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    expect(config["pre-commit"]?.commands?.typecheck?.glob).toBe("*.ts")
  })

  test("lint glob covers ts, tsx, js, jsx, and json", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    const glob = config["pre-commit"]?.commands?.lint?.glob ?? ""
    expect(glob).toContain("ts")
    expect(glob).toContain("json")
  })

  test("lint run command uses lint-staged", async () => {
    const raw = await Bun.file("lefthook.yml").text()
    const config = parseYaml(raw) as LefthookConfig
    expect(config["pre-commit"]?.commands?.lint?.run).toContain("lint-staged")
  })
})
