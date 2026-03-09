import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../transcript-utils.ts"
import { parseReflectArgs } from "./reflect.ts"

const STRUCTURED_REFLECTION_FIXTURE = {
  mistakes: [
    {
      label: "Skipped verification",
      whatHappened:
        "Started editing src/session.ts before reading the failing tests even after the user explicitly said to run them first",
      whyWrong:
        "That inverted the diagnosis order and made it likely the patch would target symptoms instead of the demonstrated failure",
      whatToDoInstead: "Run the failing tests and inspect the error output before editing code",
    },
    {
      label: "Wrong file target",
      whatHappened:
        "Moved straight to src/session.ts even though the transcript only tied the issue to src/auth.ts",
      whyWrong:
        "That sent the investigation into the wrong file and forced the user to correct the direction",
      whatToDoInstead:
        "Trace the failing path from the transcript evidence before choosing a file to edit",
    },
    {
      label: "Ignored user correction",
      whatHappened:
        "Only switched to inspecting tests after the user pointed out the skipped verification and wrong target",
      whyWrong:
        "That wasted a round of work and showed the correction was reactive instead of part of the original plan",
      whatToDoInstead:
        "Incorporate the user's explicit workflow instructions before taking the first implementation step",
    },
  ],
}

const INDEX_PATH = join(import.meta.dir, "..", "..", "index.ts")

async function makeTempDir(prefix = "swiz-reflect-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function createClaudeTranscript(
  home: string,
  projectDir: string,
  sessionId: string
): Promise<void> {
  const transcriptDir = join(home, ".claude", "projects", projectKeyFromCwd(projectDir))
  await mkdir(transcriptDir, { recursive: true })

  const lines = [
    JSON.stringify({
      type: "user",
      message: { content: "Please run the failing tests before editing src/auth.ts." },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: "I can fix it faster by editing src/session.ts right now." },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: `${projectDir}/src/session.ts` },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: { content: "That skipped verification and targeted the wrong file." },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: "I'll inspect the tests after this patch." },
    }),
  ]

  await writeFile(join(transcriptDir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`)
}

async function runReflect(
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", INDEX_PATH, "reflect", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode ?? 1 }
}

describe("parseReflectArgs", () => {
  it("uses defaults", () => {
    const parsed = parseReflectArgs([])
    expect(parsed.count).toBe(5)
    expect(parsed.targetDir).toBe(process.cwd())
    expect(parsed.sessionQuery).toBeNull()
    expect(parsed.model).toBeUndefined()
    expect(parsed.timeoutMs).toBe(90_000)
    expect(parsed.json).toBe(false)
    expect(parsed.printPrompt).toBe(false)
  })

  it("parses positional count plus flags", () => {
    const parsed = parseReflectArgs([
      "3",
      "--dir",
      "/tmp/project",
      "--session",
      "abc123",
      "--model",
      "gemini-2.5-pro",
      "--timeout",
      "9000",
    ])

    expect(parsed.count).toBe(3)
    expect(parsed.targetDir).toBe("/tmp/project")
    expect(parsed.sessionQuery).toBe("abc123")
    expect(parsed.model).toBe("gemini-2.5-pro")
    expect(parsed.timeoutMs).toBe(9000)
  })

  it("throws on unknown args", () => {
    expect(() => parseReflectArgs(["--wat"])).toThrow("Unknown argument")
  })

  it("parses json and print-prompt flags", () => {
    const parsed = parseReflectArgs(["--json", "--print-prompt"])
    expect(parsed.json).toBe(true)
    expect(parsed.printPrompt).toBe(true)
  })

  it("parses --provider flag", () => {
    expect(parseReflectArgs(["--provider", "gemini"]).provider).toBe("gemini")
    expect(parseReflectArgs(["--provider", "codex"]).provider).toBe("codex")
  })

  it("defaults provider to undefined", () => {
    expect(parseReflectArgs([]).provider).toBeUndefined()
  })

  it("throws on invalid --provider value", () => {
    expect(() => parseReflectArgs(["--provider", "openai"])).toThrow(
      'must be "gemini", "codex", or "claude"'
    )
  })

  it("accepts claude as a valid --provider value", () => {
    expect(parseReflectArgs(["--provider", "claude"]).provider).toBe("claude")
  })

  it("throws when --provider is missing a value", () => {
    expect(() => parseReflectArgs(["--provider"])).toThrow("Missing value for --provider")
  })
})

describe("reflectCommand", () => {
  it("uses the selected session transcript in the Gemini prompt", async () => {
    const home = await makeTempDir("swiz-reflect-home-")
    const projectDir = join(home, "workspace", "demo-proj")
    const sessionId = "4f21f1c7-1111-2222-3333-444444444444"
    await mkdir(projectDir, { recursive: true })
    await createClaudeTranscript(home, projectDir, sessionId)

    const promptCapture = join(home, "captured-reflect-prompt.txt")
    const result = await runReflect(["3", "--dir", projectDir], {
      HOME: home,
      AI_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-key",
      GEMINI_TEST_RESPONSE: JSON.stringify(STRUCTURED_REFLECTION_FIXTURE),
      GEMINI_TEST_CAPTURE_FILE: promptCapture,
    })

    expect(result.stdout).toContain("1. **Skipped verification**:")
    expect(result.stdout).toContain("2. **Wrong file target**:")
    expect(result.stdout).toContain("3. **Ignored user correction**:")
    expect(result.stdout).toContain(
      "Run the failing tests and inspect the error output before editing code."
    )

    const prompt = await Bun.file(promptCapture).text()
    expect(prompt).toContain("Project: demo-proj")
    expect(prompt).toContain(`Session id: ${sessionId}`)
    expect(prompt).toContain("Transcript provider: claude")
    expect(prompt).toContain("Identify exactly 3 distinct mistakes")
    expect(prompt).toContain("Please run the failing tests before editing src/auth.ts.")
    expect(prompt).toContain("That skipped verification and targeted the wrong file.")
    expect(prompt).toContain("I can fix it faster by editing src/session.ts right now.")
    expect(result.stderr).toContain("Submitting prompt to model...")
    expect(result.stderr).toContain("Buffering streamed response:")
  })

  it("prints the generated prompt and skips Gemini calls", async () => {
    const home = await makeTempDir("swiz-reflect-prompt-home-")
    const projectDir = join(home, "workspace", "prompt-proj")
    const sessionId = "8a54a655-1111-2222-3333-444444444444"
    await mkdir(projectDir, { recursive: true })
    await createClaudeTranscript(home, projectDir, sessionId)

    const result = await runReflect(["2", "--dir", projectDir, "--print-prompt"], {
      HOME: home,
      GEMINI_TEST_THROW: "1",
    })

    expect(result.stdout).toContain("Identify exactly 2 distinct mistakes")
    expect(result.stdout).toContain("<conversation_transcript>")
    expect(result.stdout).toContain("Please run the failing tests before editing src/auth.ts.")
  })

  it("prints structured JSON with --json", async () => {
    const home = await makeTempDir("swiz-reflect-json-home-")
    const projectDir = join(home, "workspace", "json-proj")
    const sessionId = "2d2dbedf-1111-2222-3333-444444444444"
    await mkdir(projectDir, { recursive: true })
    await createClaudeTranscript(home, projectDir, sessionId)

    const result = await runReflect(["3", "--dir", projectDir, "--json"], {
      HOME: home,
      AI_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-key",
      GEMINI_TEST_RESPONSE: JSON.stringify(STRUCTURED_REFLECTION_FIXTURE),
    })

    const parsed = JSON.parse(result.stdout) as { mistakes?: Array<{ label?: string }> }
    expect(parsed.mistakes?.length).toBe(3)
    expect(parsed.mistakes?.[0]?.label).toBe("Skipped verification")
    expect(result.stderr).toBe("")
  })

  it("errors when no transcripts exist for the project", async () => {
    const home = await makeTempDir("swiz-reflect-empty-home-")
    const projectDir = join(home, "workspace", "empty-proj")
    await mkdir(projectDir, { recursive: true })

    const result = await runReflect(["--dir", projectDir], {
      HOME: home,
      GEMINI_API_KEY: "test-key",
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(`No transcripts found for: ${projectDir}`)
  })
})
