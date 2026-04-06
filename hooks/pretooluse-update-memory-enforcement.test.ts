import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { writeFile } from "node:fs/promises"

// Subprocess tests need extra headroom under concurrent test suite load
setDefaultTimeout(30_000)

import { join } from "node:path"
import { getSessionTasksDir } from "../src/tasks/task-recovery.ts"
import {
  createEnforcementProjectDir,
  type HookResult,
  useTempDir,
} from "../src/utils/test-utils.ts"

const HOOK = "hooks/pretooluse-update-memory-enforcement.ts"
const REMINDER_FRAGMENT =
  "record a DO or DON'T rule that proactively builds the required steps into your standard development workflow."
const SELF_SENTINEL = "MEMORY CAPTURE ENFORCEMENT"

const { create: createTempDir } = useTempDir("swiz-update-memory-")

async function createTranscript(dir: string, lines: unknown[]): Promise<string> {
  const path = join(dir, "transcript.jsonl")
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
  return path
}

async function runHook(
  stdinPayload: Record<string, any>,
  extraEnv?: Record<string, string>
): Promise<HookResult> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  })
  await proc.stdin.write(JSON.stringify(stdinPayload))
  await proc.stdin.end()

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  let json: Record<string, any> | null = null
  try {
    if (stdout.trim()) json = JSON.parse(stdout.trim())
  } catch {}

  return { exitCode: proc.exitCode, stdout: stdout.trim(), stderr, json }
}

function hookFeedback(text: string): Record<string, any> {
  return {
    type: "user",
    message: {
      content: `Stop hook feedback: ${text}`,
    },
  }
}

function toolUse(name: string, input: Record<string, any>): Record<string, any> {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name, input }],
    },
  }
}

describe("pretooluse-update-memory-enforcement", () => {
  test("denies normal work until the update-memory skill is read", async () => {
    // createEnforcementProjectDir(createTempDir) gives a git repo + CLAUDE.md with an old mtime so the
    // cooldown does not fire and enforcement runs as expected.
    const dir = await createEnforcementProjectDir(createTempDir)
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
    ])

    const result = await runHook({
      cwd: dir,
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts", new_string: "export const x = 1\n" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    const hso = result.json?.hookSpecificOutput as Record<string, any>
    expect(hso?.permissionDecision).toBe("deny")
    expect(String(hso?.permissionDecisionReason)).toContain(SELF_SENTINEL)
    expect(String(hso?.permissionDecisionReason)).toContain("Read the /update-memory skill")
  })

  test("allows reading the update-memory skill after the reminder", async () => {
    const dir = await createTempDir()
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
    ])

    const result = await runHook({
      tool_name: "Bash",
      tool_input: {
        command: "sed -n '1,200p' /Users/test/.codex/skills/update-memory/SKILL.md",
      },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("allows the markdown write once the skill read is already in the transcript", async () => {
    const dir = await createTempDir()
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      toolUse("Read", { file_path: "/Users/test/.codex/skills/update-memory/SKILL.md" }),
    ])

    const result = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "CLAUDE.md", new_string: "DO: update memory immediately.\n" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("allows normal work after the reminder has already been satisfied", async () => {
    const dir = await createTempDir()
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      toolUse("Read", { file_path: "/Users/test/.codex/skills/update-memory/SKILL.md" }),
      toolUse("Write", {
        file_path: "CLAUDE.md",
        content: "DO: update memory immediately.\n",
      }),
    ])

    const result = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts", new_string: "export const y = 2\n" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("allows the markdown write even when the skill read is not yet in the transcript (same-turn case)", async () => {
    // Reproduces the deadlock: skill Read and Edit happen in the same response turn,
    // so the transcript hasn't captured the skill Read yet when the Edit hook fires.
    const dir = await createTempDir()
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      // Skill read is absent — simulating the same-turn case where the transcript
      // hasn't been written yet for the current assistant turn.
    ])

    const result = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "CLAUDE.md", new_string: "DO: update memory immediately.\n" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("ignores its own prior denials when locating the active reminder", async () => {
    const dir = await createTempDir()
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      toolUse("Read", { file_path: "/Users/test/.codex/skills/update-memory/SKILL.md" }),
      hookFeedback(
        `${SELF_SENTINEL}: still pending. Use the /update-memory skill to ${REMINDER_FRAGMENT}`
      ),
    ])

    const result = await runHook({
      tool_name: "Edit",
      tool_input: {
        file_path: "CLAUDE.md",
        new_string: "DO: record the rule before continuing.\n",
      },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("skips enforcement when context compaction occurred after the trigger (issue #22)", async () => {
    // Regression test for: memory gate fires in resumed session even though
    // compliance evidence was in the archived pre-compaction window.
    // The post-compaction marker injected by sessionstart-compact-context.ts
    // must cause the gate to skip — the agent cannot re-satisfy a pre-compact gate.
    const dir = await createTempDir()
    const POST_COMPACT_MARKER = "Post-compaction context"
    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      // Compaction happened — compliance evidence is now in archived window
      { type: "system", content: `${POST_COMPACT_MARKER}: Use rg instead of grep. ...` },
      // No skill read, no markdown write visible post-compaction
    ])

    const result = await runHook({
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'wip'" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("") // allowed — compaction cleared the gate
  })

  test("still enforces when compaction occurred BEFORE the trigger (new post-compact trigger)", async () => {
    // Compaction happened, THEN a new stop hook fired with a fresh REMINDER_FRAGMENT.
    // The gate should still enforce — this is a new, genuine trigger.
    const dir = await createEnforcementProjectDir(createTempDir)
    const POST_COMPACT_MARKER = "Post-compaction context"
    const transcript = await createTranscript(dir, [
      // Compaction happened first
      { type: "system", content: `${POST_COMPACT_MARKER}: Use rg instead of grep. ...` },
      // Then a new stop hook fired with a fresh trigger
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      // No compliance evidence
    ])

    const result = await runHook({
      cwd: dir,
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts", new_string: "export const a = 1\n" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    const hso = result.json?.hookSpecificOutput as Record<string, any>
    expect(hso?.permissionDecision).toBe("deny") // new post-compact trigger must enforce
  })

  test("skips enforcement when a CLAUDE.md in cwd was modified within the cooldown window", async () => {
    const dir = await createTempDir()
    // Write a fresh CLAUDE.md into the temp dir — mtime will be "now"
    const { writeFile } = await import("node:fs/promises")
    await writeFile(`${dir}/CLAUDE.md`, "DO: update memory immediately.\n")

    const transcript = await createTranscript(dir, [
      hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      // No skill read, no markdown write in transcript — but cooldown should bypass
    ])

    const result = await runHook({
      cwd: dir,
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts", new_string: "export const z = 3\n" },
      transcript_path: transcript,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("") // allowed — cooldown active
  })

  describe("in-progress task exemption", () => {
    test("skips enforcement when session has an in_progress task", async () => {
      const dir = await createEnforcementProjectDir(createTempDir)
      const fakeHome = await createTempDir()
      const sessionId = `test-session-${Date.now()}`
      const tasksDir = getSessionTasksDir(sessionId, fakeHome)
      if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
      await Bun.write(
        join(tasksDir, "task-1.json"),
        JSON.stringify({ id: "1", status: "in_progress", subject: "Implement fix" })
      )

      const transcript = await createTranscript(dir, [
        hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
        // No compliance evidence — but exemption should skip enforcement
      ])

      const result = await runHook(
        {
          cwd: dir,
          tool_name: "Edit",
          tool_input: { file_path: "src/app.ts", new_string: "export const x = 1\n" },
          transcript_path: transcript,
          session_id: sessionId,
        },
        { HOME: fakeHome }
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("") // skipped — active task in progress
    })

    test("enforces when session has only completed tasks (no in_progress)", async () => {
      const dir = await createEnforcementProjectDir(createTempDir)
      const fakeHome = await createTempDir()
      const sessionId = `test-session-${Date.now()}`
      const tasksDir = getSessionTasksDir(sessionId, fakeHome)
      if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
      await Bun.write(
        join(tasksDir, "task-1.json"),
        JSON.stringify({ id: "1", status: "completed", subject: "Done task" })
      )

      const transcript = await createTranscript(dir, [
        hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      ])

      const result = await runHook(
        {
          cwd: dir,
          tool_name: "Edit",
          tool_input: { file_path: "src/app.ts", new_string: "export const x = 1\n" },
          transcript_path: transcript,
          session_id: sessionId,
        },
        { HOME: fakeHome }
      )

      expect(result.exitCode).toBe(0)
      const hso = result.json?.hookSpecificOutput as Record<string, any>
      expect(hso?.permissionDecision).toBe("deny") // enforcement active — no in_progress tasks
    })

    test("enforces when session has no task files", async () => {
      const dir = await createEnforcementProjectDir(createTempDir)
      const fakeHome = await createTempDir()
      const sessionId = `test-session-${Date.now()}`
      // No tasks directory created for this session

      const transcript = await createTranscript(dir, [
        hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      ])

      const result = await runHook(
        {
          cwd: dir,
          tool_name: "Edit",
          tool_input: { file_path: "src/app.ts", new_string: "export const x = 1\n" },
          transcript_path: transcript,
          session_id: sessionId,
        },
        { HOME: fakeHome }
      )

      expect(result.exitCode).toBe(0)
      const hso = result.json?.hookSpecificOutput as Record<string, any>
      expect(hso?.permissionDecision).toBe("deny") // enforcement active — no task directory
    })

    test("skips enforcement when one task is in_progress and another is completed", async () => {
      const dir = await createEnforcementProjectDir(createTempDir)
      const fakeHome = await createTempDir()
      const sessionId = `test-session-${Date.now()}`
      const tasksDir = getSessionTasksDir(sessionId, fakeHome)
      if (!tasksDir) throw new Error("Failed to resolve session tasks directory")
      await Bun.write(
        join(tasksDir, "task-1.json"),
        JSON.stringify({ id: "1", status: "completed", subject: "Done task" })
      )
      await Bun.write(
        join(tasksDir, "task-2.json"),
        JSON.stringify({ id: "2", status: "in_progress", subject: "Active work" })
      )

      const transcript = await createTranscript(dir, [
        hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      ])

      const result = await runHook(
        {
          cwd: dir,
          tool_name: "Bash",
          tool_input: { command: "git diff" },
          transcript_path: transcript,
          session_id: sessionId,
        },
        { HOME: fakeHome }
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("") // skipped — still has active task
    })
  })

  describe("git repo + CLAUDE.md guard", () => {
    test("skips enforcement when cwd is not a git repo", async () => {
      const nonGitDir = await createTempDir()
      const transcript = await createTranscript(nonGitDir, [
        hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      ])

      // cwd is not a git repo — enforcement must be skipped entirely
      const result = await runHook({
        cwd: nonGitDir,
        tool_name: "Edit",
        tool_input: { file_path: "src/app.ts", new_string: "export const x = 1\n" },
        transcript_path: transcript,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("") // skipped — not a git repo
    })

    test("skips enforcement when cwd is a git repo but has no CLAUDE.md in the tree", async () => {
      const repoDir = await createTempDir()
      // Init a git repo with no CLAUDE.md
      const init = Bun.spawn(["git", "init"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" })
      await init.exited

      const transcript = await createTranscript(repoDir, [
        hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      ])

      const result = await runHook({
        cwd: repoDir,
        tool_name: "Edit",
        tool_input: { file_path: "src/app.ts", new_string: "export const x = 1\n" },
        transcript_path: transcript,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("") // skipped — no CLAUDE.md
    })

    test("enforces when cwd is a git repo with CLAUDE.md present", async () => {
      // createEnforcementProjectDir(createTempDir) gives git repo + CLAUDE.md with old mtime (cooldown inactive)
      const repoDir = await createEnforcementProjectDir(createTempDir)

      const transcript = await createTranscript(repoDir, [
        hookFeedback(`Use the /update-memory skill to ${REMINDER_FRAGMENT}`),
      ])

      const result = await runHook({
        cwd: repoDir,
        tool_name: "Edit",
        tool_input: { file_path: "src/app.ts", new_string: "export const x = 1\n" },
        transcript_path: transcript,
      })

      expect(result.exitCode).toBe(0)
      const hso = result.json?.hookSpecificOutput as Record<string, any>
      expect(hso?.permissionDecision).toBe("deny") // enforcement active
    })
  })
})
