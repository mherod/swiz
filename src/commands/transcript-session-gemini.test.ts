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
  home: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bun", "run", "index.ts", ...args], {
    cwd: process.cwd(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
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
})
