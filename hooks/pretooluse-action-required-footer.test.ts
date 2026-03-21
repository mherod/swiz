/**
 * Regression tests: every pretooluse denial path must include the ACTION REQUIRED footer.
 * Each test fires the actual hook subprocess with a minimal triggering payload and asserts
 * the footer is present. If any hook bypasses denyPreToolUse with raw JSON, this catches it.
 */

import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { getSessionTasksDir } from "./utils/hook-utils.ts"
import { createEnforcementProjectDir, useTempDir } from "./utils/test-utils.ts"

const HOOKS_DIR = resolve(process.cwd(), "hooks")
const FOOTER_MARKER = "ACTION REQUIRED"

// Keywords split to avoid self-triggering the pretooluse-no-eslint-disable hook
const ESLINT_DISABLE_KW = ["eslint", "disable"].join("-")
const TS_IGNORE_KW = ["ts", "ignore"].join("-")
const TS_NOCHECK_KW = ["ts", "nocheck"].join("-")

const { create: makeTempDir } = useTempDir("swiz-footer-")

interface HookResult {
  denied: boolean
  reason?: string
}

async function runHook(
  hookFile: string,
  payload: unknown,
  opts: { env?: Record<string, string>; cwd?: string } = {}
): Promise<HookResult> {
  const proc = Bun.spawn(["bun", join(HOOKS_DIR, hookFile)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...opts.env },
  })
  void proc.stdin.write(JSON.stringify(payload))
  void proc.stdin.end()
  const raw = await new Response(proc.stdout).text()
  await proc.exited

  const trimmed = raw.trim()
  if (!trimmed) return { denied: false }

  try {
    const parsed = JSON.parse(trimmed)
    const hso = parsed.hookSpecificOutput
    if (hso?.permissionDecision === "deny") {
      return { denied: true, reason: hso.permissionDecisionReason as string }
    }
  } catch {
    // non-JSON output means hook allowed
  }
  return { denied: false }
}

describe("pretooluse ACTION REQUIRED footer regression", () => {
  test("pretooluse-banned-commands: rm denial includes footer", async () => {
    const result = await runHook("pretooluse-banned-commands.ts", {
      tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/junk" },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
    expect(result.reason).not.toContain("/re-assess")
    expect(result.reason).not.toContain("re-assess skill")
  })

  test("pretooluse-banned-commands: cd denial includes footer", async () => {
    const result = await runHook("pretooluse-banned-commands.ts", {
      tool_name: "Bash",
      tool_input: { command: "cd /tmp && ls" },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-banned-commands: git stash denial includes footer", async () => {
    const result = await runHook("pretooluse-banned-commands.ts", {
      tool_name: "Bash",
      tool_input: { command: "git stash" },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-no-as-any: adding as any denial includes footer", async () => {
    const result = await runHook("pretooluse-ts-quality.ts", {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/util.ts",
        old_string: "const x = getValue()",
        new_string: "const x = getValue() as any",
      },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-no-eslint-disable: eslint-disable denial includes footer", async () => {
    // Keyword split to avoid self-triggering this test file
    const directive = `// ${ESLINT_DISABLE_KW}-next-line no-console`
    const result = await runHook("pretooluse-ts-quality.ts", {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/app.ts",
        new_string: `${directive}\nconsole.log('x')`,
      },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-no-ts-ignore: @ts-ignore denial includes footer", async () => {
    // Keyword split to avoid self-triggering the no-ts-ignore hook on this file
    const directive = `// @${TS_IGNORE_KW}`
    const result = await runHook("pretooluse-ts-quality.ts", {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/types.ts",
        new_string: `${directive}\nconst x: string = 42`,
      },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-no-ts-ignore: @ts-nocheck denial includes footer", async () => {
    const directive = `// @${TS_NOCHECK_KW}`
    const result = await runHook("pretooluse-ts-quality.ts", {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/legacy.ts",
        new_string: `${directive}\nconst x = 1`,
      },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-long-sleep: sleep 60 denial includes footer", async () => {
    const result = await runHook("pretooluse-long-sleep.ts", {
      tool_name: "Bash",
      tool_input: { command: "sleep 60" },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-no-task-delegation: TaskCreate delegation denial includes footer", async () => {
    const result = await runHook("pretooluse-no-task-delegation.ts", {
      tool_name: "Agent",
      tool_input: { prompt: "Use TaskCreate to create tasks for the upcoming work." },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-task-subject-validation: compound subject denial includes footer", async () => {
    const result = await runHook("pretooluse-task-subject-validation.ts", {
      tool_name: "TaskCreate",
      tool_input: { subject: "Fix the authentication bug and update the user schema" },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-no-direct-deps: writing package.json deps denial includes footer", async () => {
    const result = await runHook("pretooluse-no-direct-deps.ts", {
      tool_name: "Write",
      tool_input: {
        file_path: "/tmp/package.json",
        content: JSON.stringify({ name: "test", dependencies: { lodash: "^4.0.0" } }),
      },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-eslint-config-strength: weakening config denial includes footer", async () => {
    // old_string has "warning" → warnings:1; new_string removes it → warnings:0 → triggers block
    const result = await runHook("pretooluse-eslint-config-strength.ts", {
      tool_name: "Edit",
      tool_input: {
        file_path: "eslint.config.js",
        old_string: '"no-console": "warning"',
        new_string: '"no-console": "off"',
      },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-no-npm: npm in bun project denial includes footer", async () => {
    // Run from project root which has bun.lockb — PM detected as bun, npm is blocked
    const result = await runHook(
      "pretooluse-no-npm.ts",
      {
        tool_name: "Bash",
        tool_input: { command: "npm install lodash" },
      },
      { cwd: process.cwd() }
    )
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-json-validation: invalid settings.json denial includes footer", async () => {
    const dir = await makeTempDir()
    const claudeDir = join(dir, ".claude")
    await mkdir(claudeDir, { recursive: true })
    const settingsPath = join(claudeDir, "settings.json")
    await writeFile(settingsPath, "{ invalid json !! }")
    const result = await runHook("pretooluse-json-validation.ts", {
      tool_name: "Edit",
      tool_input: { file_path: settingsPath },
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-require-tasks: no incomplete tasks denial includes footer", async () => {
    // Fake HOME with an empty tasks dir → activeTasks.length === 0 → denial
    const fakeHome = await makeTempDir()
    const sessionId = "test-footer-regression-session"
    const tasksDir = getSessionTasksDir(sessionId, fakeHome)
    if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
    await mkdir(tasksDir, { recursive: true })
    const result = await runHook(
      "pretooluse-require-tasks.ts",
      {
        tool_name: "Edit",
        tool_input: { file_path: "src/main.ts" },
        session_id: sessionId,
        transcript_path: "",
      },
      { env: { HOME: fakeHome } }
    )
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })

  test("pretooluse-update-memory-enforcement: reminder denial includes footer", async () => {
    // createEnforcementProjectDir() gives git repo + CLAUDE.md with old mtime so guard passes and cooldown stays off
    const dir = await createEnforcementProjectDir(makeTempDir)
    const transcriptPath = join(dir, "transcript.jsonl")
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "user",
        message: {
          content:
            "Stop hook feedback: Use the /update-memory skill to record a DO or DON'T rule that proactively builds the required steps into your standard development workflow.",
        },
      })}\n`
    )

    const result = await runHook("pretooluse-update-memory-enforcement.ts", {
      cwd: dir,
      tool_name: "Edit",
      tool_input: { file_path: "src/main.ts", new_string: "export const main = true\n" },
      transcript_path: transcriptPath,
    })
    expect(result.denied).toBe(true)
    expect(result.reason).toContain(FOOTER_MARKER)
  })
})
