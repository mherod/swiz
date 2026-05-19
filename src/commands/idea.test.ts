import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withGitClient } from "../git/client.ts"
import { MockGitClient } from "../git/mock-client.ts"
import { ideaCommand, parseIdeaArgs } from "./idea.ts"

const INDEX_PATH = join(import.meta.dir, "..", "..", "index.ts")

async function makeTempDir(prefix = "swiz-idea-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function runIdea(
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", INDEX_PATH, "idea", ...args], {
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

async function captureConsoleLog(fn: () => Promise<void>): Promise<string> {
  const original = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  try {
    await fn()
  } finally {
    console.log = original
  }
  return lines.join("\n")
}

describe("parseIdeaArgs", () => {
  it("uses defaults", () => {
    const parsed = parseIdeaArgs([])
    expect(parsed.targetDir).toBe(process.cwd())
    expect(parsed.model).toBeUndefined()
    expect(parsed.timeoutMs).toBe(90_000)
  })

  it("parses dir, model, and timeout", () => {
    const parsed = parseIdeaArgs([
      "--dir",
      "/tmp/project",
      "--model",
      "gemini-2.5-pro",
      "--timeout",
      "9000",
    ])
    expect(parsed.targetDir).toBe("/tmp/project")
    expect(parsed.model).toBe("gemini-2.5-pro")
    expect(parsed.timeoutMs).toBe(9000)
  })

  it("parses --provider flag", () => {
    expect(parseIdeaArgs(["--provider", "gemini"]).provider).toBe("gemini")
    expect(parseIdeaArgs(["--provider", "openrouter"]).provider).toBe("openrouter")
    expect(parseIdeaArgs(["-p", "gemini"]).provider).toBe("gemini")
  })

  it("defaults provider to undefined", () => {
    expect(parseIdeaArgs([]).provider).toBeUndefined()
  })

  it("throws on invalid --provider value", () => {
    expect(() => parseIdeaArgs(["--provider", "openai"])).toThrow(
      'must be "gemini", "claude", or "openrouter"'
    )
  })

  it("accepts claude as a valid --provider value", () => {
    expect(parseIdeaArgs(["--provider", "claude"]).provider).toBe("claude")
  })

  it("throws when --provider is missing a value", () => {
    expect(() => parseIdeaArgs(["--provider"])).toThrow("Missing value for --provider")
  })

  it("throws on unknown args", () => {
    expect(() => parseIdeaArgs(["--wat"])).toThrow("Unknown argument")
  })

  it("defaults json and printPrompt to false", () => {
    const parsed = parseIdeaArgs([])
    expect(parsed.json).toBe(false)
    expect(parsed.printPrompt).toBe(false)
  })

  it("parses --json flag", () => {
    expect(parseIdeaArgs(["--json"]).json).toBe(true)
    expect(parseIdeaArgs(["-j"]).json).toBe(true)
  })

  it("parses --print-prompt flag", () => {
    expect(parseIdeaArgs(["--print-prompt"]).printPrompt).toBe(true)
  })

  it("combines --json with other flags", () => {
    const parsed = parseIdeaArgs(["--json", "--provider", "gemini"])
    expect(parsed.json).toBe(true)
    expect(parsed.provider).toBe("gemini")
  })
})

describe("ideaCommand", () => {
  it("uses README plus last 8 commit messages in the generated prompt", async () => {
    const dir = await makeTempDir()
    await writeFile(
      join(dir, "README.md"),
      "# Demo Project\n\nA project that manages contributor workflows.\n"
    )

    const git = new MockGitClient((args) => {
      if (args[0] === "log" && args.includes("--max-count=8")) {
        return Array.from({ length: 8 }, (_, idx) => `feat: step ${10 - idx}`).join("\n")
      }
      return { exitCode: 1 }
    })

    const prompt = await withGitClient(
      git,
      async () =>
        await captureConsoleLog(async () => await ideaCommand.run(["--dir", dir, "--print-prompt"]))
    )

    expect(prompt).toContain("<readme>")
    expect(prompt).toContain("A project that manages contributor workflows.")
    expect(prompt).toContain("Prioritize product direction and roadmap progression")
    expect(prompt).toContain("Target a user-facing functionality gap")
    expect(prompt).toContain("immediately actionable GitHub issue")
    expect(prompt).toContain("Write as direct instructions in imperative voice.")
    expect(prompt).toContain("Provide concrete implementation tasks and acceptance criteria")
    expect(prompt).toMatch(/\n1\. feat: step 10\n/)
    expect(prompt).toMatch(/\n8\. feat: step 3\n/)
    expect(prompt).not.toMatch(/\n\d+\. feat: step 2\n/)
    expect(prompt).not.toMatch(/\n\d+\. feat: step 1\n/)
    expect(git.calls.map((call) => call.args)).toContainEqual([
      "log",
      "--max-count=8",
      "--pretty=%s",
    ])
  })

  it("errors when no AI provider is available", async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, "README.md"), "# Demo\n")

    const result = await runIdea(["--dir", dir], {
      GEMINI_API_KEY: "",
      // Suppress all providers (Gemini + Codex) to simulate no-backend environment.
      AI_TEST_NO_BACKEND: "1",
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("No AI provider available")
  })
})
