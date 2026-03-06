import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-transcript-gemini-test-"))
  tempDirs.push(dir)
  return dir
}

async function runSwiz(
  args: string[],
  home: string,
  envOverrides: Record<string, string | undefined> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of [
    "CLAUDECODE",
    "GEMINI_CLI",
    "GEMINI_PROJECT_DIR",
    "CODEX_MANAGED_BY_NPM",
    "CODEX_THREAD_ID",
  ]) {
    delete env[key]
  }
  env.HOME = home
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }

  const proc = Bun.spawn(["bun", "run", "index.ts", ...args], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  proc.stdin.end()
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode }
}

function stripAnsi(text: string): string {
  let out = ""
  let i = 0
  while (i < text.length) {
    if (text[i] === "\u001b" && text[i + 1] === "[") {
      i += 2
      while (i < text.length && text[i] !== "m") i++
      if (i < text.length) i++
      continue
    }
    out += text[i]!
    i++
  }
  return out
}

async function createGeminiSession(
  home: string,
  projectDir: string,
  sessionId: string
): Promise<void> {
  const bucket = basename(projectDir)
  const bucketDir = join(home, ".gemini", "tmp", bucket)
  const chatsDir = join(bucketDir, "chats")
  await mkdir(chatsDir, { recursive: true })
  await writeFile(join(bucketDir, ".project_root"), `${projectDir}\n`)
  await writeFile(
    join(chatsDir, "session-2026-03-05T10-00-abcdef12.json"),
    JSON.stringify({
      sessionId,
      startTime: "2026-03-05T10:00:00.000Z",
      lastUpdated: "2026-03-05T10:00:01.000Z",
      messages: [
        {
          type: "user",
          timestamp: "2026-03-05T10:00:00.000Z",
          content: [{ text: "Hello from Gemini session" }],
        },
        {
          type: "gemini",
          timestamp: "2026-03-05T10:00:01.000Z",
          content: "Hi from Gemini assistant",
          toolCalls: [{ name: "run_shell_command", args: { command: "echo hi" } }],
        },
      ],
    })
  )
}

async function createAntigravitySession(
  home: string,
  projectDir: string,
  sessionId: string
): Promise<void> {
  const conversationsDir = join(home, ".gemini", "antigravity", "conversations")
  const brainDir = join(home, ".gemini", "antigravity", "brain", sessionId)
  await mkdir(conversationsDir, { recursive: true })
  await mkdir(brainDir, { recursive: true })
  await writeFile(join(conversationsDir, `${sessionId}.pb`), Buffer.from([0x0a, 0x01, 0x00]))
  await writeFile(join(brainDir, "task.md"), `# Task\nImplement update in file://${projectDir}\n`)
}

async function createCodexSession(
  home: string,
  projectDir: string,
  sessionId: string
): Promise<void> {
  const codexDir = join(home, ".codex", "sessions", "2026", "03", "05")
  await mkdir(codexDir, { recursive: true })
  const sessionPath = join(codexDir, `rollout-2026-03-05T10-00-00-${sessionId}.jsonl`)

  const lines = [
    JSON.stringify({
      timestamp: "2026-03-05T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: sessionId,
        timestamp: "2026-03-05T10:00:00.000Z",
        cwd: projectDir,
        originator: "codex_cli_rs",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-05T10:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Hello from Codex session",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-05T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hi from Codex assistant" }],
      },
    }),
  ]
  await writeFile(sessionPath, `${lines.join("\n")}\n`)
}

async function createDebugLog(home: string, sessionId: string, lines: string[]): Promise<void> {
  const debugDir = join(home, ".claude", "debug")
  await mkdir(debugDir, { recursive: true })
  await writeFile(join(debugDir, `${sessionId}.txt`), `${lines.join("\n")}\n`)
}

describe("Provider transcript/session command support", () => {
  test("swiz transcript --list discovers Gemini sessions", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-proj")
    const sessionId = "abcdef12-1111-2222-3333-444444444444"
    await mkdir(projectDir, { recursive: true })
    await createGeminiSession(home, projectDir, sessionId)

    const result = await runSwiz(["transcript", "--list", "--dir", projectDir], home)
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    expect(out).toContain(sessionId)
  })

  test("swiz transcript --session renders Gemini turns", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-proj")
    const sessionId = "abcdef12-1111-2222-3333-444444444444"
    await mkdir(projectDir, { recursive: true })
    await createGeminiSession(home, projectDir, sessionId)

    const result = await runSwiz(
      ["transcript", "--session", sessionId.slice(0, 8), "--dir", projectDir],
      home
    )
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    expect(out).toContain("USER")
    expect(out).toContain("ASSISTANT")
    expect(out).toContain("Hello from Gemini session")
    expect(out).toContain("Hi from Gemini assistant")
  })

  test("swiz session --list includes Gemini sessions", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-proj")
    const sessionId = "abcdef12-1111-2222-3333-444444444444"
    await mkdir(projectDir, { recursive: true })
    await createGeminiSession(home, projectDir, sessionId)

    const result = await runSwiz(["session", "--list", "--dir", projectDir], home)
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    expect(out).toContain(sessionId)
  })

  test("swiz transcript --list discovers Codex sessions", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-codex")
    const sessionId = "019cbc01-1111-7222-8333-444444444444"
    await mkdir(projectDir, { recursive: true })
    await createCodexSession(home, projectDir, sessionId)

    const result = await runSwiz(["transcript", "--list", "--dir", projectDir], home)
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    expect(out).toContain(sessionId)
  })

  test("swiz transcript --session renders Codex turns", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-codex")
    const sessionId = "019cbc01-5555-7666-8777-888888888888"
    await mkdir(projectDir, { recursive: true })
    await createCodexSession(home, projectDir, sessionId)

    const result = await runSwiz(
      ["transcript", "--session", sessionId.slice(0, 8), "--dir", projectDir],
      home
    )
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    expect(out).toContain("USER")
    expect(out).toContain("ASSISTANT")
    expect(out).toContain("Hello from Codex session")
    expect(out).toContain("Hi from Codex assistant")
  })

  test("swiz transcript --include-debug renders matching debug log lines", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-codex")
    const sessionId = "019cbc01-7777-7888-8999-aaaaaaaaaaaa"
    await mkdir(projectDir, { recursive: true })
    await createCodexSession(home, projectDir, sessionId)
    await createDebugLog(home, sessionId, [
      "2026-03-06T04:29:06.552Z [DEBUG] debug line one",
      "2026-03-06T04:29:06.553Z [DEBUG] debug line two",
    ])

    const result = await runSwiz(
      ["transcript", "--session", sessionId.slice(0, 8), "--dir", projectDir, "--include-debug"],
      home
    )
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    // Debug lines are interleaved inline; each is prefixed with │ and a timestamp
    expect(out).toContain("│")
    expect(out).toContain("[DEBUG] debug line one")
    expect(out).toContain("[DEBUG] debug line two")
  })

  test("swiz transcript --include-debug sorts out-of-order debug lines by timestamp", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-codex")
    const sessionId = "019cbc01-7777-7888-8999-bbbbbbbbbbbb"
    await mkdir(projectDir, { recursive: true })
    await createCodexSession(home, projectDir, sessionId)
    // Intentionally write lines out of chronological order
    await createDebugLog(home, sessionId, [
      "2026-03-06T04:29:06.900Z [DEBUG] later line",
      "2026-03-06T04:29:06.100Z [DEBUG] earlier line",
      "no-timestamp-line should be skipped",
    ])

    const result = await runSwiz(
      ["transcript", "--session", sessionId.slice(0, 8), "--dir", projectDir, "--include-debug"],
      home
    )
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    // Both timestamped lines must appear; no-timestamp continuation is attached to the preceding event
    expect(out).toContain("[DEBUG] earlier line")
    expect(out).toContain("[DEBUG] later line")
    expect(out).toContain("no-timestamp-line should be skipped")
    // Earlier line must appear before later line in output
    const earlyIdx = out.indexOf("[DEBUG] earlier line")
    const lateIdx = out.indexOf("[DEBUG] later line")
    expect(earlyIdx).toBeLessThan(lateIdx)
  })

  test("swiz transcript --include-debug renders equal-timestamp debug lines in file order", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-codex")
    const sessionId = "019cbc01-7777-7888-8999-cccccccccccc"
    await mkdir(projectDir, { recursive: true })
    await createCodexSession(home, projectDir, sessionId)
    // Three lines share an identical timestamp — tie-breaker must preserve file order
    await createDebugLog(home, sessionId, [
      "2026-03-06T04:29:06.500Z [DEBUG] first concurrent",
      "2026-03-06T04:29:06.500Z [DEBUG] second concurrent",
      "2026-03-06T04:29:06.500Z [DEBUG] third concurrent",
    ])

    const result = await runSwiz(
      ["transcript", "--session", sessionId.slice(0, 8), "--dir", projectDir, "--include-debug"],
      home
    )
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    const firstIdx = out.indexOf("[DEBUG] first concurrent")
    const secondIdx = out.indexOf("[DEBUG] second concurrent")
    const thirdIdx = out.indexOf("[DEBUG] third concurrent")
    expect(firstIdx).toBeLessThan(secondIdx)
    expect(secondIdx).toBeLessThan(thirdIdx)
  })

  test("swiz transcript --include-debug keeps lines with invalid timestamps using fallback ordering", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-codex")
    const sessionId = "019cbc01-7777-7888-8999-dddddddddddd"
    await mkdir(projectDir, { recursive: true })
    await createCodexSession(home, projectDir, sessionId)
    // Third line has an out-of-range month (13) which matches the regex but Date parsing returns NaN
    await createDebugLog(home, sessionId, [
      "2026-03-06T04:29:06.100Z [DEBUG] valid first",
      "2026-13-06T04:29:06.200Z [DEBUG] invalid timestamp but kept",
      "2026-03-06T04:29:06.300Z [DEBUG] valid last",
    ])

    const result = await runSwiz(
      ["transcript", "--session", sessionId.slice(0, 8), "--dir", projectDir, "--include-debug"],
      home
    )
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    // All three lines must appear — the invalid-timestamp line must not be silently dropped
    expect(out).toContain("[DEBUG] valid first")
    expect(out).toContain("[DEBUG] invalid timestamp but kept")
    expect(out).toContain("[DEBUG] valid last")
  })

  test("swiz transcript --include-debug keeps leading invalid-timestamp lines sorted before valid ones", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-codex")
    const sessionId = "019cbc01-7777-7888-8999-eeeeeeeeeeee"
    await mkdir(projectDir, { recursive: true })
    await createCodexSession(home, projectDir, sessionId)
    // First two lines have out-of-range timestamps (no prior valid ts to inherit)
    await createDebugLog(home, sessionId, [
      "2026-99-06T04:29:06.100Z [DEBUG] leading invalid first",
      "2026-99-06T04:29:06.200Z [DEBUG] leading invalid second",
      "2026-03-06T04:29:06.300Z [DEBUG] valid after",
    ])

    const result = await runSwiz(
      ["transcript", "--session", sessionId.slice(0, 8), "--dir", projectDir, "--include-debug"],
      home
    )
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    // All three lines must appear
    expect(out).toContain("[DEBUG] leading invalid first")
    expect(out).toContain("[DEBUG] leading invalid second")
    expect(out).toContain("[DEBUG] valid after")
    // Leading invalid lines must sort before the valid one (ts=0 < any real epoch ms)
    const firstInvalidIdx = out.indexOf("[DEBUG] leading invalid first")
    const secondInvalidIdx = out.indexOf("[DEBUG] leading invalid second")
    const validIdx = out.indexOf("[DEBUG] valid after")
    expect(firstInvalidIdx).toBeLessThan(secondInvalidIdx)
    expect(secondInvalidIdx).toBeLessThan(validIdx)
  })

  test("swiz transcript --include-debug attaches continuation lines to the preceding event", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-codex")
    const sessionId = "019cbc01-7777-7888-8999-ffffffffffff"
    await mkdir(projectDir, { recursive: true })
    await createCodexSession(home, projectDir, sessionId)
    // Second line has no timestamp — it is a continuation of the first event
    await createDebugLog(home, sessionId, [
      "2026-03-06T04:29:06.100Z [DEBUG] main line",
      "  continuation detail here",
      "2026-03-06T04:29:06.200Z [DEBUG] next event",
    ])

    const result = await runSwiz(
      ["transcript", "--session", sessionId.slice(0, 8), "--dir", projectDir, "--include-debug"],
      home
    )
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    // Continuation line must appear in output (not silently dropped)
    expect(out).toContain("continuation detail here")
    expect(out).toContain("[DEBUG] main line")
    expect(out).toContain("[DEBUG] next event")
    // Continuation must appear before the next timestamped event
    const contIdx = out.indexOf("continuation detail here")
    const nextIdx = out.indexOf("[DEBUG] next event")
    expect(contIdx).toBeLessThan(nextIdx)
  })

  test("swiz transcript --include-debug preserves leading continuation-only lines before any timestamped event", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-codex")
    const sessionId = "019cbc01-7777-7888-8999-111111111111"
    await mkdir(projectDir, { recursive: true })
    await createCodexSession(home, projectDir, sessionId)
    // File starts with continuation lines before any ISO-prefixed line
    await createDebugLog(home, sessionId, [
      "no-timestamp header line",
      "another headerless line",
      "2026-03-06T04:29:06.500Z [DEBUG] first real event",
    ])

    const result = await runSwiz(
      ["transcript", "--session", sessionId.slice(0, 8), "--dir", projectDir, "--include-debug"],
      home
    )
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    // Leading continuation lines must appear in output — not silently discarded
    expect(out).toContain("no-timestamp header line")
    expect(out).toContain("another headerless line")
    expect(out).toContain("[DEBUG] first real event")
  })

  test("swiz session --list includes Codex sessions", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-codex")
    const sessionId = "019cbc01-9999-7aaa-8bbb-cccccccccccc"
    await mkdir(projectDir, { recursive: true })
    await createCodexSession(home, projectDir, sessionId)

    const result = await runSwiz(["session", "--list", "--dir", projectDir], home)
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    expect(out).toContain(sessionId)
  })

  test("swiz transcript defaults to all providers when no agent is detected", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-mixed")
    const geminiSessionId = "abcdef12-aaaa-bbbb-cccc-444444444444"
    const codexSessionId = "019cbc01-dddd-7eee-8fff-111111111111"
    await mkdir(projectDir, { recursive: true })
    await createGeminiSession(home, projectDir, geminiSessionId)
    await createCodexSession(home, projectDir, codexSessionId)

    const result = await runSwiz(["transcript", "--list", "--dir", projectDir], home)
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    expect(out).toContain(geminiSessionId)
    expect(out).toContain(codexSessionId)
  })

  test("swiz transcript scopes to detected agent provider by default", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-mixed")
    const geminiSessionId = "abcdef12-eeee-ffff-aaaa-444444444444"
    const codexSessionId = "019cbc01-2222-7333-8444-555555555555"
    await mkdir(projectDir, { recursive: true })
    await createGeminiSession(home, projectDir, geminiSessionId)
    await createCodexSession(home, projectDir, codexSessionId)

    const result = await runSwiz(["transcript", "--list", "--dir", projectDir], home, {
      CODEX_THREAD_ID: "thread-1",
    })
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    expect(out).toContain(codexSessionId)
    expect(out).not.toContain(geminiSessionId)
  })

  test("swiz transcript --all overrides detected agent scoping", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-mixed")
    const geminiSessionId = "abcdef12-1111-ffff-aaaa-444444444444"
    const codexSessionId = "019cbc01-6666-7777-8888-999999999999"
    await mkdir(projectDir, { recursive: true })
    await createGeminiSession(home, projectDir, geminiSessionId)
    await createCodexSession(home, projectDir, codexSessionId)

    const result = await runSwiz(["transcript", "--list", "--all", "--dir", projectDir], home, {
      CODEX_THREAD_ID: "thread-2",
    })
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    expect(out).toContain(geminiSessionId)
    expect(out).toContain(codexSessionId)
  })

  test("swiz transcript rejects --all combined with explicit agent flag", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-mixed")
    await mkdir(projectDir, { recursive: true })

    const result = await runSwiz(["transcript", "--all", "--codex", "--dir", projectDir], home)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("cannot be combined")
  })

  test("swiz transcript --list discovers Antigravity sessions", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-antigravity")
    const sessionId = "4a8bc58e-a064-4eb6-9758-e4d25047164b"
    await mkdir(projectDir, { recursive: true })
    await createAntigravitySession(home, projectDir, sessionId)

    const result = await runSwiz(["transcript", "--list", "--dir", projectDir], home)
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    expect(out).toContain(sessionId)
  })

  test("swiz session --list includes Antigravity sessions", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-antigravity")
    const sessionId = "5e7a548f-8e78-4b72-b088-4a5db389f5fc"
    await mkdir(projectDir, { recursive: true })
    await createAntigravitySession(home, projectDir, sessionId)

    const result = await runSwiz(["session", "--list", "--dir", projectDir], home)
    expect(result.exitCode).toBe(0)
    const out = stripAnsi(result.stdout)
    expect(out).toContain(sessionId)
  })

  test("swiz transcript --session shows clear Antigravity unsupported-format diagnostic", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-antigravity")
    const sessionId = "f0a88e68-b0d4-4604-98c1-ae016f73c8c4"
    await mkdir(projectDir, { recursive: true })
    await createAntigravitySession(home, projectDir, sessionId)

    const result = await runSwiz(
      ["transcript", "--session", sessionId.slice(0, 8), "--dir", projectDir],
      home
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Antigravity protobuf format (.pb)")
  })

  test("swiz continue --session resolves Antigravity IDs and reports unsupported format", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-antigravity")
    const sessionId = "0d55a399-3e40-42e5-9d55-cb8ead43c4ce"
    await mkdir(projectDir, { recursive: true })
    await createAntigravitySession(home, projectDir, sessionId)

    const result = await runSwiz(
      ["continue", "--session", sessionId.slice(0, 8), "--dir", projectDir, "--print"],
      home
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Antigravity protobuf format (.pb)")
    expect(result.stderr).not.toContain("No session matching")
  })

  test("swiz continue --session resolves Codex session IDs", async () => {
    const home = await createTempHome()
    const projectDir = join(home, "workspace", "demo-codex")
    const sessionId = "019cbc02-1ddd-7eee-8fff-000000000000"
    await mkdir(projectDir, { recursive: true })
    await createCodexSession(home, projectDir, sessionId)

    const result = await runSwiz(
      ["continue", "--session", sessionId.slice(0, 8), "--dir", projectDir, "--print"],
      home
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/No AI backend found|Authentication required/)
    expect(result.stderr).not.toContain("No session matching")
  })
})
