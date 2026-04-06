import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, readdir, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { commitFile, makeTempGitRepo, useTempDir } from "../src/utils/test-utils.ts"
import { checkChangelogStaleness } from "./stop-auto-continue/changelog-staleness.ts"
import {
  __testOnly_DEDUP_MAX_FILES,
  __testOnly_getSuggestionsPath,
  __testOnly_pruneOldSuggestionLogs,
  __testOnly_recordSuggestion,
} from "./stop-auto-continue/suggestion-log.ts"
import { isWorkflowSuggestion, normalizeTerminateArgs } from "./stop-auto-continue.ts"

// Subprocess-based tests spawn `bun hooks/stop-auto-continue.ts` which is
// slower on CI runners (Ubuntu) than locally. Bump from the default 10s.
setDefaultTimeout(30_000)

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface HookResult {
  decision?: string
  reason?: string
  rawOutput: string
  stderr: string
}

const BUN_EXE = Bun.which("bun") ?? "bun"

const { create: createTempDir } = useTempDir("swiz-auto-continue-")

/** Builds a minimal JSONL transcript with the given number of tool calls and a user turn. */
function buildTranscript(toolCallCount: number, userMessage = "What is the status?"): string {
  const lines: string[] = []
  // One user turn
  lines.push(JSON.stringify({ type: "user", message: { content: userMessage } }))
  // Assistant turns with tool_use blocks
  for (let i = 0; i < toolCallCount; i++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", id: `t${i}`, input: {} }],
        },
      })
    )
  }
  return `${lines.join("\n")}\n`
}

let sessionCounter = 0

async function runHook({
  transcriptContent,
  stopHookActive = false,
  extraEnv = {},
  cwd,
  sessionId,
}: {
  transcriptContent: string
  stopHookActive?: boolean
  extraEnv?: Record<string, string>
  cwd?: string
  sessionId?: string
}): Promise<HookResult> {
  const workDir = await createTempDir()
  const transcriptPath = join(workDir, "transcript.jsonl")
  await writeFile(transcriptPath, transcriptContent)

  const hookCwd = cwd ?? workDir

  const payload = JSON.stringify({
    transcript_path: transcriptPath,
    stop_hook_active: stopHookActive,
    session_id: sessionId ?? `test-session-${++sessionCounter}`,
    cwd: hookCwd,
  })

  // Isolate HOME so the hook reads autoContinue: true from a temp settings file
  // instead of the real ~/.swiz/settings.json (which may have autoContinue: false).
  const fakeHome = await createTempDir()
  const fakeSwizDir = join(fakeHome, ".swiz")
  await mkdir(fakeSwizDir, { recursive: true })
  await writeFile(join(fakeSwizDir, "settings.json"), JSON.stringify({ autoContinue: true }))

  // Strip CLAUDECODE (would alter agent detection) and GEMINI_API_KEY (tests control it).
  const { CLAUDECODE: _cc, GEMINI_API_KEY: _gk, ...cleanEnv } = process.env
  const proc = Bun.spawn([BUN_EXE, "hooks/stop-auto-continue.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...cleanEnv,
      HOME: fakeHome,
      // Never talk to the real daemon from tests.
      SWIZ_NO_DAEMON: "1",
      // Mock all external AI backends by default so tests never spawn real CLIs.
      // When a mock AI seam is active (AI_TEST_RESPONSE or AI_TEST_CAPTURE_FILE),
      // omit AI_TEST_NO_BACKEND so hasAiProvider() returns true and the seam is used.
      ...("AI_TEST_RESPONSE" in extraEnv ||
      "AI_TEST_CAPTURE_FILE" in extraEnv ||
      "AI_TEST_THROW" in extraEnv
        ? {}
        : { AI_TEST_NO_BACKEND: "1" }),
      ...extraEnv,
    },
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()

  const [rawOutput, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (!rawOutput.trim()) return { rawOutput, stderr }

  try {
    const parsed = JSON.parse(rawOutput.trim())
    return {
      decision: parsed.decision,
      reason: parsed.reason,
      rawOutput,
      stderr,
    }
  } catch {
    return { rawOutput, stderr }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("stop-auto-continue", () => {
  test("recordSuggestion creates missing parent directory (no sync fs)", async () => {
    const homeDir = await createTempDir()
    // HOME is not read by recordSuggestion, but getSuggestionsPath uses getHomeDirOrNull() which
    // derives from process.env.HOME — set it for this isolated unit test.
    const prevHome = process.env.HOME
    process.env.HOME = homeDir
    try {
      const sessionId = `test-session-suggestions-${Date.now()}`
      const path = __testOnly_getSuggestionsPath(sessionId)

      // Ensure parent dir doesn't exist beforehand.
      const parent = join(homeDir, ".swiz")
      expect(await Bun.file(parent).exists()).toBe(false)

      const count = await __testOnly_recordSuggestion(sessionId, "hello")

      expect(count).toBe(1)
      expect(await Bun.file(path).exists()).toBe(true)
      const parsed = await Bun.file(path).json()
      expect(parsed).toEqual({ seen: { hello: 1 } })
    } finally {
      process.env.HOME = prevHome
    }
  })

  describe("pruneOldSuggestionLogs", () => {
    test("deletes stale suggestion files by age (no orphaned empty files)", async () => {
      const homeDir = await createTempDir()
      const swizDir = join(homeDir, ".swiz")
      await mkdir(swizDir, { recursive: true })
      const stalePath = join(swizDir, "stop-suggestions-stale.json")
      const freshPath = join(swizDir, "stop-suggestions-fresh.json")
      await writeFile(stalePath, '{"seen":{}}')
      await writeFile(freshPath, '{"seen":{}}')
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      await utimes(stalePath, eightDaysAgo, eightDaysAgo)

      const prevHome = process.env.HOME
      process.env.HOME = homeDir
      try {
        await __testOnly_pruneOldSuggestionLogs()
      } finally {
        process.env.HOME = prevHome
      }

      expect(await Bun.file(stalePath).exists()).toBe(false)
      expect(await Bun.file(freshPath).exists()).toBe(true)
    })

    test("cap removes oldest files by mtime; newest DEDUP_MAX_FILES remain", async () => {
      const homeDir = await createTempDir()
      const swizDir = join(homeDir, ".swiz")
      await mkdir(swizDir, { recursive: true })
      const base = Date.now()
      const cap = __testOnly_DEDUP_MAX_FILES
      const extra = 5
      for (let i = 0; i < cap + extra; i++) {
        const p = join(swizDir, `stop-suggestions-cap-${i}.json`)
        await writeFile(p, '{"seen":{}}')
        const t = new Date(base + i * 60_000)
        await utimes(p, t, t)
      }

      const prevHome = process.env.HOME
      process.env.HOME = homeDir
      try {
        await __testOnly_pruneOldSuggestionLogs()
      } finally {
        process.env.HOME = prevHome
      }

      const names = (await readdir(swizDir)).filter(
        (e) => e.startsWith("stop-suggestions-cap-") && e.endsWith(".json")
      )
      expect(names.length).toBe(cap)
      for (let i = 0; i < extra; i++) {
        expect(names).not.toContain(`stop-suggestions-cap-${i}.json`)
      }
      for (let i = extra; i < cap + extra; i++) {
        expect(names).toContain(`stop-suggestions-cap-${i}.json`)
      }
    })

    test("does not remove non-suggestion files under .swiz", async () => {
      const homeDir = await createTempDir()
      const swizDir = join(homeDir, ".swiz")
      await mkdir(swizDir, { recursive: true })
      const otherPath = join(swizDir, "settings.json")
      await writeFile(otherPath, "{}\n")
      const stalePath = join(swizDir, "stop-suggestions-only-stale.json")
      await writeFile(stalePath, '{"seen":{}}')
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      await utimes(stalePath, eightDaysAgo, eightDaysAgo)

      const prevHome = process.env.HOME
      process.env.HOME = homeDir
      try {
        await __testOnly_pruneOldSuggestionLogs()
      } finally {
        process.env.HOME = prevHome
      }

      expect(await Bun.file(otherPath).exists()).toBe(true)
      expect(await Bun.file(stalePath).exists()).toBe(false)
    })
  })

  test("allows stop when auto-continue is disabled in global swiz settings", async () => {
    const homeDir = await createTempDir()
    await mkdir(join(homeDir, ".swiz"), { recursive: true })
    await writeFile(join(homeDir, ".swiz", "settings.json"), '{\n  "autoContinue": false\n}\n')

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      extraEnv: { HOME: homeDir },
    })

    expect(result.decision).toBeUndefined()
    expect(result.stderr).toContain("[stop-auto-continue:AUTO_CONTINUE_DISABLED]")
  })

  test("session override takes precedence over global setting", async () => {
    const homeDir = await createTempDir()
    await mkdir(join(homeDir, ".swiz"), { recursive: true })
    await writeFile(
      join(homeDir, ".swiz", "settings.json"),
      '{\n  "autoContinue": false,\n  "sessions": {\n    "test-session": {\n      "autoContinue": true\n    }\n  }\n}\n'
    )

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      sessionId: "test-session",
      extraEnv: { HOME: homeDir },
    })

    // Session override enables auto-continue → deterministic filler blocks
    expect(result.decision).toBe("block")
    expect(result.reason).toBeDefined()
  })

  test("blocks with deterministic filler suggestion for a substantive session", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(10),
    })

    // Deterministic filler suggestion should block stop with a next step
    expect(result.decision).toBe("block")
    expect(result.reason).toBeDefined()
  })

  test("blocks stop for small sessions with filler suggestion", async () => {
    const result = await runHook({
      transcriptContent: buildTranscript(3),
    })

    // Deterministic filler should still produce a suggestion
    expect(result.decision).toBe("block")
    expect(result.reason).toBeDefined()
  })
})

// Removed: AI prompt capture, markup filtering, reflections, critiques, ambition mode,
// task section, and prompt content tests — all tested removed Gemini AI integration.
// Surviving behavior (filler suggestions, dedup, workflow filter) tested above and below.

// ─── Workflow suggestion filter unit tests ─────────────────────────────────

describe("isWorkflowSuggestion", () => {
  describe("blocks workflow/git-process suggestions", () => {
    const blocked = [
      "Implement a guard-aware push orchestration module in plugg-platform",
      "Implement a hard-fail in the push skill that blocks any direct main push",
      "Implement bot-aware collaboration detection in the push skill by excluding bot-authored PRs",
      "Implement hook-bot suggestion filtering so outputs exclude workflow/git-process guidance",
      "Add a pre-push hook that validates branch naming conventions",
      "Fix the stop hook to detect stale sessions",
      "Implement a collaboration guard that blocks git push to main",
      "Update the commit skill to enforce conventional commits",
      "Wire up a pre-commit hook for lint-staged checks",
      "Add feature branch enforcement to the push guard",
      "Implement branch policy that requires pull requests for main",
      "Modify the collaboration signal detection to exclude bots",
    ]

    for (const suggestion of blocked) {
      test(`blocks: "${suggestion.slice(0, 60)}..."`, () => {
        expect(isWorkflowSuggestion(suggestion)).toBe(true)
      })
    }
  })

  describe("allows product/code-focused suggestions", () => {
    const allowed = [
      "Implement user profile endpoint with avatar upload support",
      "Add error handling for network timeout in the API client",
      "Fix the date parser to handle ISO 8601 timezone offsets",
      "Build a caching layer for frequently accessed database queries",
      "Extend the search API to support fuzzy matching",
      "Add pagination to the list endpoints",
      "Implement webhook delivery retry with exponential backoff",
      "Fix the login flow to handle expired refresh tokens",
      // Product-level suggestions about the swiz hook framework itself (issue #177 false-positives)
      "Implement session-aware transcript scanning in the hook system",
      "Implement session-aware parsing in the hook framework",
      "Add hook-aware context injection to the session start flow",
      "Fix session boundary detection in the hook infrastructure",
      "Update the hook system to use readSessionLines for cross-session awareness",
    ]

    for (const suggestion of allowed) {
      test(`allows: "${suggestion.slice(0, 60)}..."`, () => {
        expect(isWorkflowSuggestion(suggestion)).toBe(false)
      })
    }
  })

  describe("still blocks specific hook-file implementation directives", () => {
    const blocked = [
      "Implement the pretooluse-repeated-lint-test hook to track consecutive runs",
      "Fix posttooluse-task-output.ts hook to strip ANSI before pattern matching",
      "Update stop-auto-continue.ts hook to use session-scoped transcript scanning",
      "Add a pretooluse-foo hook that validates branch naming conventions",
    ]

    for (const suggestion of blocked) {
      test(`blocks: "${suggestion.slice(0, 60)}..."`, () => {
        expect(isWorkflowSuggestion(suggestion)).toBe(true)
      })
    }
  })

  describe("skipPrPattern behavior", () => {
    test("exempts pull-request phrase when skipPrPattern is enabled", () => {
      expect(
        isWorkflowSuggestion("Open a pull request for this fix", { skipPrPattern: true })
      ).toBe(false)
    })

    test("still blocks other workflow suggestions when skipPrPattern is enabled", () => {
      expect(isWorkflowSuggestion("Run git push origin main", { skipPrPattern: true })).toBe(true)
    })
  })
})

// ─── normalizeTerminateArgs unit tests ────────────────────────────────────────

describe("normalizeTerminateArgs", () => {
  test("skip with valid code and message passes through unchanged", () => {
    const { safeAction, normalizedArgs } = normalizeTerminateArgs("skip", ["MY_CODE", "my message"])
    expect(safeAction).toBe("skip")
    expect(normalizedArgs[0]).toBe("MY_CODE")
    expect(normalizedArgs[1]).toBe("my message")
  })

  test("block with valid reason passes through unchanged", () => {
    const { safeAction, normalizedArgs } = normalizeTerminateArgs("block", ["Stop for reason X"])
    expect(safeAction).toBe("block")
    expect(normalizedArgs[0]).toBe("Stop for reason X")
  })

  test("unknown action defaults to block (safe fallback)", () => {
    const { safeAction } = normalizeTerminateArgs("unknown-action", ["some reason"])
    expect(safeAction).toBe("block")
  })

  test("empty action string defaults to block", () => {
    const { safeAction } = normalizeTerminateArgs("", [])
    expect(safeAction).toBe("block")
  })

  test("skip with empty code normalizes to UNKNOWN", () => {
    const { normalizedArgs } = normalizeTerminateArgs("skip", ["", "msg"])
    expect(normalizedArgs[0]).toBe("UNKNOWN")
  })

  test("skip with whitespace-only code normalizes to UNKNOWN", () => {
    const { normalizedArgs } = normalizeTerminateArgs("skip", ["   ", "msg"])
    expect(normalizedArgs[0]).toBe("UNKNOWN")
  })

  test("skip with empty message normalizes to fallback text", () => {
    const { normalizedArgs } = normalizeTerminateArgs("skip", ["CODE", ""])
    expect(normalizedArgs[1]).toBe("unspecified exit reason")
  })

  test("skip with no args normalizes both code and message", () => {
    const { safeAction, normalizedArgs } = normalizeTerminateArgs("skip", [])
    expect(safeAction).toBe("skip")
    expect(normalizedArgs[0]).toBe("UNKNOWN")
    expect(normalizedArgs[1]).toBe("unspecified exit reason")
  })

  test("block with empty reason normalizes to malformed-payload fallback", () => {
    const { normalizedArgs } = normalizeTerminateArgs("block", [""])
    expect(normalizedArgs[0]).toContain("unexpected termination")
  })

  test("block with whitespace-only reason normalizes to malformed-payload fallback", () => {
    const { normalizedArgs } = normalizeTerminateArgs("block", ["   "])
    expect(normalizedArgs[0]).toContain("unexpected termination")
  })

  test("block with no args normalizes to malformed-payload fallback", () => {
    const { normalizedArgs } = normalizeTerminateArgs("block", [])
    expect(normalizedArgs[0]).toContain("unexpected termination")
  })

  test("unknown action with non-empty payload produces block with that payload", () => {
    const { safeAction, normalizedArgs } = normalizeTerminateArgs("invalid", ["some reason"])
    expect(safeAction).toBe("block")
    expect(normalizedArgs[0]).toBe("some reason")
  })
})

// ─── checkChangelogStaleness ─────────────────────────────────────────────────

describe("checkChangelogStaleness", () => {
  const tmp = useTempDir()

  test("detects CHANGELOG.md when cwd is a subdirectory of the repo", async () => {
    const repoDir = await makeTempGitRepo(tmp)

    // Commit CHANGELOG.md with a backdated committer timestamp so it appears stale
    await writeFile(join(repoDir, "CHANGELOG.md"), "# Changelog\n")
    const addCl = Bun.spawn(["git", "add", "CHANGELOG.md"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
    })
    await addCl.exited
    const commitCl = Bun.spawn(["git", "commit", "-m", "add changelog"], {
      cwd: repoDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" },
    })
    await commitCl.exited

    // Add a recent commit to make changelog stale
    await commitFile(repoDir, "file.txt", "hello\n")

    // Create a subdirectory and call from there
    const subdir = join(repoDir, "subdir")
    await mkdir(subdir, { recursive: true })

    // Should detect staleness even from nested cwd
    const result = await checkChangelogStaleness(subdir)
    expect(result).not.toBe("")
    expect(result).toContain("CHANGELOG")
  })

  test("returns empty string for repo without CHANGELOG.md", async () => {
    const repoDir = await makeTempGitRepo(tmp)

    const result = await checkChangelogStaleness(repoDir)
    expect(result).toBe("")
  })
})
