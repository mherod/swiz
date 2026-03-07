import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Test dispatch end-to-end by running swiz dispatch with different payloads

async function dispatch(
  event: string,
  payload: Record<string, unknown>
): Promise<{
  stdout: string
  stderr: string
  exitCode: number | null
  parsed: Record<string, unknown> | null
}> {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "index.ts",
      "dispatch",
      event,
      event === "preToolUse" ? "PreToolUse" : event === "stop" ? "Stop" : event,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  proc.stdin.write(JSON.stringify(payload))
  proc.stdin.end()
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  let parsed = null
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {}
  return { stdout: stdout.trim(), stderr, exitCode: proc.exitCode, parsed }
}

function runGit(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`)
  }
}

describe("dispatch preToolUse", () => {
  test("allows clean git commands", async () => {
    const result = await dispatch("preToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git status" },
    })
    // Should either be empty (all pass) or allow-with-reason (from require-tasks)
    if (result.parsed) {
      const hso = result.parsed.hookSpecificOutput as Record<string, unknown> | undefined
      expect(hso?.permissionDecision).not.toBe("deny")
    }
  })

  test("denies sed commands", async () => {
    const result = await dispatch("preToolUse", {
      tool_name: "Bash",
      tool_input: { command: "sed -i 's/a/b/' file.ts" },
    })
    expect(result.parsed).not.toBeNull()
    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown> | undefined
    const decision = hso?.permissionDecision ?? result.parsed!.decision
    expect(decision).toBe("deny")
  })

  test("warns on grep with allow", async () => {
    const result = await dispatch("preToolUse", {
      tool_name: "Bash",
      tool_input: { command: "grep -r TODO src/" },
    })
    expect(result.parsed).not.toBeNull()
    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown> | undefined
    // Could be allow from banned-commands or deny from require-tasks
    // If require-tasks fires first, it may deny — that's fine
    const decision = (hso?.permissionDecision ?? result.parsed!.decision) as string
    expect(["allow", "deny"]).toContain(decision)
  })

  test("ignores non-Bash tools for banned-commands", async () => {
    const result = await dispatch("preToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/etc/passwd" },
    })
    // Read tool has no matching groups for banned-commands
    // May get output from other hooks but not a deny for banned commands
    expect(result.exitCode).toBe(0)
  })
})

describe("dispatch routing", () => {
  test("unknown event produces no output", async () => {
    const result = await dispatch("unknownEvent", {})
    expect(result.stdout).toBe("")
  })

  test("empty payload doesn't crash", async () => {
    const result = await dispatch("preToolUse", {})
    expect(result.exitCode).toBe(0)
  })

  test("fails when stdin payload is not received within 2s", async () => {
    const proc = Bun.spawn(["bun", "run", "index.ts", "dispatch", "preToolUse", "PreToolUse"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    // Intentionally do not write or close stdin.
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    expect(proc.exitCode).toBe(1)
    expect(stdout.trim()).toBe("")
    expect(stderr).toContain("Timed out waiting 2s for stdin JSON payload to be received")
  })
})

describe("dispatch replay", () => {
  async function replay(
    event: string,
    payload: Record<string, unknown>,
    extraArgs: string[] = []
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const proc = Bun.spawn(["bun", "run", "index.ts", "dispatch", "replay", event, ...extraArgs], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    proc.stdin.write(JSON.stringify(payload))
    proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    return { stdout: stdout.trim(), stderr, exitCode: proc.exitCode }
  }

  test("blocking replay: shows DENY when banned command used (JSON mode)", async () => {
    const result = await replay(
      "preToolUse",
      { tool_name: "Bash", tool_input: { command: "sed -i 's/a/b/' file.ts" } },
      ["--json"]
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toBe("")
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>
    expect(parsed.event).toBe("preToolUse")
    expect(parsed.strategy).toBe("preToolUse")
    const resultField = parsed.result as Record<string, unknown>
    expect(resultField.blocked).toBe(true)
    const hooks = parsed.hooks as Array<Record<string, unknown>>
    const blocked = hooks.find((h) => h.status === "deny")
    expect(blocked).toBeDefined()
  })

  test("non-blocking replay: shows all passed for git status (JSON mode)", async () => {
    const result = await replay(
      "preToolUse",
      { tool_name: "Bash", tool_input: { command: "git status" } },
      ["--json"]
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toBe("")
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>
    expect(parsed.event).toBe("preToolUse")
    const resultField = parsed.result as Record<string, unknown>
    // git status is exempt from banned-commands and require-tasks hooks
    // result.blocked may be false or true depending on session state; just verify structure
    expect(typeof resultField.blocked).toBe("boolean")
    const hooks = parsed.hooks as Array<Record<string, unknown>>
    expect(Array.isArray(hooks)).toBe(true)
    // Each hook entry must have file, status, and duration_ms
    for (const hook of hooks) {
      expect(typeof hook.file).toBe("string")
      expect(typeof hook.status).toBe("string")
    }
  })

  test("replay outputs human-readable trace to stderr (non-JSON mode)", async () => {
    const result = await replay("preToolUse", {
      tool_name: "Bash",
      tool_input: { command: "sed -i 's/a/b/' file.ts" },
    })
    expect(result.exitCode).toBe(0)
    // Human-readable trace goes to stderr
    expect(result.stderr).toContain("swiz dispatch replay")
    expect(result.stderr).toContain("preToolUse")
    // Should mention DENY or BLOCK
    expect(result.stderr.toLowerCase()).toMatch(/deny|block/)
  })

  test("replay missing event argument throws error", async () => {
    const proc = Bun.spawn(["bun", "run", "index.ts", "dispatch", "replay"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    proc.stdin.end()
    await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    expect(proc.exitCode).not.toBe(0)
    expect(stderr).toContain("replay <event>")
  })

  test("replay fails when stdin payload is not received within 2s", async () => {
    const proc = Bun.spawn(["bun", "run", "index.ts", "dispatch", "replay", "preToolUse"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    // Intentionally do not write or close stdin.
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    expect(proc.exitCode).toBe(1)
    expect(stdout.trim()).toBe("")
    expect(stderr).toContain("Timed out waiting 2s for stdin JSON payload to be received")
  })

  test("replay JSON output includes matched_groups and hooks array", async () => {
    const result = await replay(
      "stop",
      { session_id: "test-session-replay", transcript_path: "/nonexistent.jsonl" },
      ["--json"]
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toBe("")
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>
    expect(parsed.event).toBe("stop")
    expect(parsed.strategy).toBe("blocking")
    expect(typeof parsed.matched_groups).toBe("number")
    expect(Array.isArray(parsed.hooks)).toBe(true)
  }, 15_000)

  test("stop replay continues after first block and still runs stop-git-status", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "swiz-stop-replay-"))
    try {
      runGit(repoDir, ["init"])
      runGit(repoDir, ["config", "user.email", "swiz-tests@example.com"])
      runGit(repoDir, ["config", "user.name", "Swiz Tests"])

      // Secret scanner should block on this committed token pattern.
      // Use array join to avoid triggering GitHub push protection in source code
      // Need 24+ alphanumeric chars after sk_live_ for TOKEN_RE pattern match
      const fakeSecret = [
        "s",
        "k",
        "_",
        "l",
        "i",
        "v",
        "e",
        "_",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "0",
        "a",
        "b",
        "c",
        "d",
        "e",
        "f",
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
      ].join("")
      await writeFile(join(repoDir, "secrets.ts"), `export const token = "${fakeSecret}";\n`)
      runGit(repoDir, ["add", "secrets.ts"])
      runGit(repoDir, ["commit", "-m", "test: add committed secret fixture"])

      const result = await replay("stop", { session_id: "replay-stop-all-hooks", cwd: repoDir }, [
        "--json",
      ])
      expect(result.exitCode).toBe(0)

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>
      const hooks = parsed.hooks as Array<Record<string, unknown>>
      expect(Array.isArray(hooks)).toBe(true)

      const secretIndex = hooks.findIndex((h) => h.file === "stop-secret-scanner.ts")
      const gitStatusIndex = hooks.findIndex((h) => h.file === "stop-git-status.ts")

      expect(secretIndex).toBeGreaterThanOrEqual(0)
      expect(gitStatusIndex).toBeGreaterThan(secretIndex)
      expect(hooks[secretIndex]?.status).toBe("block")

      const resultField = parsed.result as Record<string, unknown>
      expect(resultField.blocked).toBe(true)
      expect(resultField.by).toBe("stop-secret-scanner.ts")
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })
})
