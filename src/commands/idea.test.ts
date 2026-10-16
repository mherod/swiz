import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withGitClient } from "../git/client.ts"
import { MockGitClient } from "../git/mock-client.ts"
import { testProviderArgs } from "../test-utils/provider-args.ts"
import { runCommandInProcess } from "../utils/test-utils.ts"
import { ideaCommand, parseIdeaArgs } from "./idea.ts"

async function makeTempDir(prefix = "swiz-idea-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function runIdea(
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCommandInProcess(ideaCommand, args, { env })
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
    expect(parsed.timeoutMs).toBe(15_000)
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

  testProviderArgs(parseIdeaArgs, { aliases: ["-p"] })

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
  const idea = {
    title: "Preview the next action",
    summary: "Show users the next action before continuing a session.",
    userProblem: "Users cannot inspect the planned action before execution.",
    roadmapDirection: "Now",
    roadmapRationale: "Make the existing continuation workflow easier to inspect.",
    userFacingGap: "There is no clear preview of the proposed next action.",
    directInstructions: {
      analysis: "Review the existing continuation command.",
      technicalInvestigation: "Inspect the session selection logic.",
      categorizationAndPriority: "Prioritize this as a user-facing improvement.",
      clarificationAndUnblocking: "Use the currently selected session as input.",
      cleanupAndDeprecation: "Keep existing command flags compatible.",
      resolutionCheck: "Verify previews do not execute actions.",
    },
    implementationTasks: [
      "Add preview output",
      "Validate session input",
      "Cover preview behavior",
      "Document the preview",
    ],
    acceptanceCriteria: [
      "Preview shows an action",
      "Preview executes no action",
      "Errors remain visible",
    ],
    labels: { type: "feature", area: "cli", priority: "high" },
    risksAndDependencies: [],
  }

  it("prints exactly one validated JSON object", async () => {
    const dir = await makeTempDir()
    const result = await runIdea(["--dir", dir, "--json"], {
      AI_TEST_RESPONSE: JSON.stringify(idea),
      AI_TEST_TEXT_RESPONSE: "# Invalid streamed Markdown must not be printed",
      AI_TEST_NO_BACKEND: "",
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(idea)
  })

  it("prints no partial JSON when validation fails", async () => {
    const dir = await makeTempDir()
    const result = await runIdea(["--dir", dir, "--json"], {
      AI_TEST_RESPONSE: JSON.stringify({ title: "Incomplete" }),
      AI_TEST_NO_BACKEND: "",
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe("")
  })

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
    expect(prompt).toContain("Return only a JSON object matching this schema")
    expect(prompt).toContain('"risksAndDependencies"')
    const schema = JSON.parse(prompt.split("\n").find((line) => line.startsWith('{"$schema"'))!)
    expect(schema.required).toContain("risksAndDependencies")
    expect(schema.properties.risksAndDependencies).not.toHaveProperty("default")
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

  it("bounds README context while retaining the structured brief", async () => {
    const dir = await makeTempDir()
    await Bun.write(join(dir, "README.md"), `${"x".repeat(8000)}UNBOUNDED_TAIL`)
    const result = await runIdea(["--dir", dir, "--print-prompt"], { AI_TEST_NO_BACKEND: "1" })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("README truncated to 8000 characters")
    expect(result.stdout).not.toContain("UNBOUNDED_TAIL")
    expect(result.stdout).toContain("at most 220 words")
    expect(result.stdout).toContain('"acceptanceCriteria"')
  })
})
