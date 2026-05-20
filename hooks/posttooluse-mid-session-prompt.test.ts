import { describe, expect, setDefaultTimeout, test } from "bun:test"

setDefaultTimeout(30_000)

import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { IssueStore } from "../src/issue-store.ts"
import { projectKeyFromCwd } from "../src/project-key.ts"
import { useTempDir } from "../src/utils/test-utils.ts"

const HOOK = join(import.meta.dir, "posttooluse-mid-session-prompt.ts")

const tmp = useTempDir("swiz-mid-session-prompt-")

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const RECENT_START = Date.now() - 1 * 60 * 60 * 1000 // 1h ago
const OLD_START = Date.now() - 4 * 60 * 60 * 1000 // 4h ago

interface HookResult {
  exitCode: number | null
  stdout: string
  stderr: string
  additionalContext?: string
}

async function runHook(
  cwd: string,
  transcriptPath: string,
  extraInput: Record<string, unknown> = {},
  envOverrides: Record<string, string | undefined> = {}
): Promise<HookResult> {
  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: { ...process.env, ...envOverrides },
  })
  await proc.stdin.write(
    JSON.stringify({
      cwd,
      session_id: "test-session",
      transcript_path: transcriptPath,
      _effectiveSettings: { enforceMidSessionCheckin: true },
      ...extraInput,
    })
  )
  await proc.stdin.end()

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  let additionalContext: string | undefined
  const trimmed = stdout.trim()
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, any>
      additionalContext =
        (parsed.hookSpecificOutput?.additionalContext as string | undefined) ??
        (parsed.systemMessage as string | undefined)
    } catch {}
  }

  return { exitCode: proc.exitCode, stdout: trimmed, stderr, additionalContext }
}

async function initGitRepo(dir: string): Promise<void> {
  const proc = Bun.spawn(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
}

async function runGitCmd(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
}

async function makeCommit(dir: string, filename: string): Promise<void> {
  await writeFile(join(dir, filename), "content")
  await runGitCmd(dir, ["add", filename])
  await runGitCmd(dir, ["config", "user.email", "test@test.com"])
  await runGitCmd(dir, ["config", "user.name", "Test"])
  const oldDate = new Date(Date.now() - 3 * TWO_HOURS_MS).toISOString()
  const proc = Bun.spawn(["git", "-C", dir, "commit", "-m", "old commit"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate },
  })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
}

async function createTranscript(dir: string): Promise<string> {
  const path = join(dir, "transcript.jsonl")
  await writeFile(
    path,
    `${JSON.stringify({ timestamp: new Date(Date.now() - 1000).toISOString(), type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }] } })}\n`
  )
  return path
}

async function createTranscriptWithCheckin(
  dir: string,
  timestampMs = Date.now() - 1000
): Promise<string> {
  const path = join(dir, "transcript.jsonl")
  await writeFile(
    path,
    `${JSON.stringify({ timestamp: new Date(timestampMs).toISOString(), type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "mid-session-checkin" } }] } })}\n`
  )
  return path
}

describe("posttooluse-mid-session-prompt", () => {
  test("(a) session <3h → no suggestion", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    // add >10 dirty files to ensure signals would fire if age check passed
    for (let i = 0; i < 12; i++) {
      await writeFile(join(dir, `dirty-${i}.txt`), "x")
    }
    const transcriptPath = await createTranscript(dir)

    const result = await runHook(dir, transcriptPath, {
      _testSessionStartMs: RECENT_START,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.additionalContext).toBeUndefined()
  })

  test("old mid-session-checkin in transcript still suggests when signals fire", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    await makeCommit(dir, "init.txt")
    for (let i = 0; i < 12; i++) {
      await writeFile(join(dir, `dirty-${i}.txt`), "x")
    }
    const transcriptPath = await createTranscriptWithCheckin(dir, Date.now() - 21 * 60 * 1000)

    const result = await runHook(dir, transcriptPath, {
      _testSessionStartMs: OLD_START,
    })
    expect(result.exitCode).toBe(0)
    expect(result.additionalContext).toBeDefined()
    expect(result.additionalContext).toContain("mid-session-checkin")
  })

  test("(b) recent mid-session-checkin in transcript → no suggestion", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    for (let i = 0; i < 12; i++) {
      await writeFile(join(dir, `dirty-${i}.txt`), "x")
    }
    const transcriptPath = await createTranscriptWithCheckin(dir)

    const result = await runHook(dir, transcriptPath, {
      _testSessionStartMs: OLD_START,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.additionalContext).toBeUndefined()
  })

  test("(c) old session, no signals → no suggestion", async () => {
    const dir = await tmp.create()
    const transcriptDir = await tmp.create() // separate dir to keep git tree clean
    await initGitRepo(dir)
    await makeCommit(dir, "file.txt") // commit exists but tree is clean
    const transcriptPath = await createTranscript(transcriptDir)

    const result = await runHook(dir, transcriptPath, {
      _testSessionStartMs: OLD_START,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.additionalContext).toBeUndefined()
  })

  test("(d) >10 uncommitted files → suggestion fires", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    await makeCommit(dir, "init.txt")
    for (let i = 0; i < 12; i++) {
      await writeFile(join(dir, `dirty-${i}.txt`), "x")
    }
    const transcriptPath = await createTranscript(dir)

    const result = await runHook(dir, transcriptPath, {
      _testSessionStartMs: OLD_START,
    })
    expect(result.exitCode).toBe(0)
    expect(result.additionalContext).toBeDefined()
    expect(result.additionalContext).toContain("uncommitted files")
    expect(result.additionalContext).toContain("mid-session-checkin")
  })

  test("(e) stale last commit + dirty tree → suggestion fires", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    await makeCommit(dir, "init.txt")
    // Add a few (≤10) dirty files — won't trigger signal (d) but will trigger (e)
    for (let i = 0; i < 3; i++) {
      await writeFile(join(dir, `dirty-${i}.txt`), "x")
    }
    const transcriptPath = await createTranscript(dir)

    const result = await runHook(dir, transcriptPath, {
      _testSessionStartMs: OLD_START,
    })
    expect(result.exitCode).toBe(0)
    expect(result.additionalContext).toBeDefined()
    expect(result.additionalContext).toContain("ago with dirty tree")
    expect(result.additionalContext).toContain("mid-session-checkin")
  })

  test("recent session commit record suppresses stale git-log signal", async () => {
    const dir = await tmp.create()
    const home = await tmp.create()
    await initGitRepo(dir)
    await makeCommit(dir, "init.txt")
    for (let i = 0; i < 3; i++) {
      await writeFile(join(dir, `dirty-${i}.txt`), "x")
    }
    const store = new IssueStore(join(home, ".swiz", "issues.db"))
    try {
      store.recordSessionCommit(projectKeyFromCwd(dir), "test-session", Date.now())
    } finally {
      store.close()
    }
    const transcriptPath = await createTranscript(dir)

    const result = await runHook(
      dir,
      transcriptPath,
      {
        _testSessionStartMs: OLD_START,
      },
      { HOME: home }
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.additionalContext).toBeUndefined()
  })

  test("(h) enforceMidSessionCheckin false → no suggestion", async () => {
    const dir = await tmp.create()
    await initGitRepo(dir)
    await makeCommit(dir, "init.txt")
    for (let i = 0; i < 12; i++) {
      await writeFile(join(dir, `dirty-${i}.txt`), "x")
    }
    const transcriptPath = await createTranscript(dir)

    const proc = Bun.spawn(["bun", HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: dir,
      env: { ...process.env },
    })
    await proc.stdin.write(
      JSON.stringify({
        cwd: dir,
        session_id: "test-session",
        transcript_path: transcriptPath,
        _testSessionStartMs: OLD_START,
        _effectiveSettings: { enforceMidSessionCheckin: false },
      })
    )
    await proc.stdin.end()
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited

    expect(proc.exitCode).toBe(0)
    expect(stdout.trim()).toBe("")
  })
})
