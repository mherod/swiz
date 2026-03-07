import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { projectKeyFromCwd } from "../transcript-utils.ts"
import { parseReflectArgs, reflectCommand } from "./reflect.ts"

const tempDirs: string[] = []
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

const ENV_KEYS = [
  "GEMINI_API_KEY",
  "GEMINI_TEST_RESPONSE",
  "GEMINI_TEST_CAPTURE_FILE",
  "GEMINI_TEST_THROW",
  "HOME",
] as const

type EnvKey = (typeof ENV_KEYS)[number]
type EnvSnapshot = Partial<Record<EnvKey, string | undefined>>

function snapshotEnv(): EnvSnapshot {
  const snap: EnvSnapshot = {}
  for (const key of ENV_KEYS) {
    snap[key] = process.env[key]
  }
  return snap
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snap[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function makeTempDir(prefix = "swiz-reflect-test-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
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
})

describe("reflectCommand", () => {
  let envBefore: EnvSnapshot
  let logOutput: string[]
  let stdoutOutput: string[]
  let stderrOutput: string[]

  beforeEach(() => {
    envBefore = snapshotEnv()
    logOutput = []
    stdoutOutput = []
    stderrOutput = []
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logOutput.push(args.join(" "))
    })
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      if (typeof chunk === "string") {
        stdoutOutput.push(chunk)
      } else if (chunk instanceof Uint8Array) {
        stdoutOutput.push(new TextDecoder().decode(chunk))
      } else if (chunk !== undefined && chunk !== null) {
        stdoutOutput.push(String(chunk))
      }
      return true
    }) as any)
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      if (typeof chunk === "string") {
        stderrOutput.push(chunk)
      } else if (chunk instanceof Uint8Array) {
        stderrOutput.push(new TextDecoder().decode(chunk))
      } else if (chunk !== undefined && chunk !== null) {
        stderrOutput.push(String(chunk))
      }
      return true
    }) as any)
  })

  afterEach(async () => {
    restoreEnv(envBefore)
    vi.restoreAllMocks()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (!dir) continue
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("uses the selected session transcript in the Gemini prompt", async () => {
    const home = await makeTempDir("swiz-reflect-home-")
    const projectDir = join(home, "workspace", "demo-proj")
    const sessionId = "4f21f1c7-1111-2222-3333-444444444444"
    await mkdir(projectDir, { recursive: true })
    await createClaudeTranscript(home, projectDir, sessionId)

    const promptCapture = join(home, "captured-reflect-prompt.txt")
    process.env.HOME = home
    process.env.GEMINI_API_KEY = "test-key"
    process.env.GEMINI_TEST_RESPONSE = JSON.stringify(STRUCTURED_REFLECTION_FIXTURE)
    process.env.GEMINI_TEST_CAPTURE_FILE = promptCapture

    await reflectCommand.run(["3", "--dir", projectDir])

    const output = logOutput.join("\n")
    expect(output).toContain("1. **Skipped verification**:")
    expect(output).toContain("2. **Wrong file target**:")
    expect(output).toContain("3. **Ignored user correction**:")
    expect(output).toContain(
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
    expect(stderrOutput.join("")).toContain("Submitting prompt to model...")
    expect(stderrOutput.join("")).toContain("Buffering streamed response:")
  })

  it("prints the generated prompt and skips Gemini calls", async () => {
    const home = await makeTempDir("swiz-reflect-prompt-home-")
    const projectDir = join(home, "workspace", "prompt-proj")
    const sessionId = "8a54a655-1111-2222-3333-444444444444"
    await mkdir(projectDir, { recursive: true })
    await createClaudeTranscript(home, projectDir, sessionId)

    process.env.HOME = home
    delete process.env.GEMINI_API_KEY
    process.env.GEMINI_TEST_THROW = "1"

    await reflectCommand.run(["2", "--dir", projectDir, "--print-prompt"])

    const output = logOutput.join("\n")
    expect(output).toContain("Identify exactly 2 distinct mistakes")
    expect(output).toContain("<conversation_transcript>")
    expect(output).toContain("Please run the failing tests before editing src/auth.ts.")
  })

  it("prints structured JSON with --json", async () => {
    const home = await makeTempDir("swiz-reflect-json-home-")
    const projectDir = join(home, "workspace", "json-proj")
    const sessionId = "2d2dbedf-1111-2222-3333-444444444444"
    await mkdir(projectDir, { recursive: true })
    await createClaudeTranscript(home, projectDir, sessionId)

    process.env.HOME = home
    process.env.GEMINI_API_KEY = "test-key"
    process.env.GEMINI_TEST_RESPONSE = JSON.stringify(STRUCTURED_REFLECTION_FIXTURE)

    await reflectCommand.run(["3", "--dir", projectDir, "--json"])

    expect(logOutput.length).toBe(0)
    const parsed = JSON.parse(stdoutOutput.join("")) as { mistakes?: Array<{ label?: string }> }
    expect(parsed.mistakes?.length).toBe(3)
    expect(parsed.mistakes?.[0]?.label).toBe("Skipped verification")
    expect(stderrOutput.join("")).toBe("")
  })

  it("errors when no transcripts exist for the project", async () => {
    const home = await makeTempDir("swiz-reflect-empty-home-")
    const projectDir = join(home, "workspace", "empty-proj")
    await mkdir(projectDir, { recursive: true })

    process.env.HOME = home
    process.env.GEMINI_API_KEY = "test-key"

    await expect(reflectCommand.run(["--dir", projectDir])).rejects.toThrow(
      `No transcripts found for: ${projectDir}`
    )
  })
})
