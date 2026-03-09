import { describe, expect, it } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseIdeaArgs } from "./idea.ts"

const STRUCTURED_IDEA_FIXTURE = {
  title: "feat(project): add guided project kickoff",
  summary:
    "Ship a guided kickoff flow that helps new users create their first project plan in under 3 minutes and understand what to do next.",
  userProblem:
    "New users currently land in an empty state and do not know how to transform their idea into actionable work, causing early drop-off.",
  roadmapDirection: "Now",
  roadmapRationale:
    "Improving first-session activation directly supports near-term growth goals and creates a stronger base for future collaboration features.",
  userFacingGap:
    "Users cannot currently go from blank project to a structured issue plan with clear next steps from inside the product.",
  directInstructions: {
    analysis:
      "Review onboarding funnels and identify where users abandon before creating the first actionable issue.",
    technicalInvestigation:
      "Inspect CLI command discovery and template rendering paths to define where the kickoff flow should be wired in.",
    categorizationAndPriority:
      "Apply labels `feature`, `area/onboarding`, and `priority/high` and remove any triage labels.",
    clarificationAndUnblocking:
      "Document assumptions for the first-launch UX and request confirmation only on unresolved product constraints.",
    cleanupAndDeprecation:
      "Mark legacy empty-state copy paths for removal once the kickoff flow becomes the default entry point.",
    resolutionCheck:
      "Verify that a new user can complete the kickoff flow and exit with at least one fully actionable issue description.",
  },
  implementationTasks: [
    "Add a new kickoff command entry point in the CLI help and command registry.",
    "Implement a step-by-step prompt sequence that captures goal, audience, and constraints.",
    "Generate and display a paste-ready issue description with tasks and acceptance criteria.",
    "Add automated tests covering happy path and missing-input validation.",
  ],
  acceptanceCriteria: [
    "A first-time user can generate an actionable issue description without editing files manually.",
    "Output includes clear implementation tasks and acceptance criteria by default.",
    "Command help text clearly explains when to use the kickoff flow.",
  ],
  labels: {
    type: "feature",
    area: "area/onboarding",
    priority: "priority/high",
  },
  risksAndDependencies: [
    "Depends on stable prompt-template rendering for structured issue output.",
  ],
}

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

function runGit(dir: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode === 0) return
  const err = new TextDecoder().decode(proc.stderr)
  throw new Error(`git ${args.join(" ")} failed: ${err}`)
}

async function initRepoWithCommits(dir: string): Promise<void> {
  runGit(dir, ["init"])
  runGit(dir, ["config", "user.email", "swiz-test@example.com"])
  runGit(dir, ["config", "user.name", "Swiz Test"])

  for (let i = 1; i <= 10; i++) {
    await writeFile(join(dir, `file-${i}.txt`), `value-${i}\n`)
    runGit(dir, ["add", "."])
    runGit(dir, ["commit", "-m", `feat: step ${i}`])
  }
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
    expect(parseIdeaArgs(["--provider", "codex"]).provider).toBe("codex")
    expect(parseIdeaArgs(["-p", "gemini"]).provider).toBe("gemini")
  })

  it("defaults provider to undefined", () => {
    expect(parseIdeaArgs([]).provider).toBeUndefined()
  })

  it("throws on invalid --provider value", () => {
    expect(() => parseIdeaArgs(["--provider", "openai"])).toThrow(
      'must be "gemini", "codex", or "claude"'
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
})

describe("ideaCommand", () => {
  it("uses README plus last 8 commit messages in the Gemini prompt", async () => {
    const dir = await makeTempDir()
    await initRepoWithCommits(dir)
    await writeFile(
      join(dir, "README.md"),
      "# Demo Project\n\nA project that manages contributor workflows.\n"
    )

    const promptCapture = join(dir, "captured-prompt.txt")
    const result = await runIdea(["--dir", dir], {
      AI_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-key",
      GEMINI_TEST_RESPONSE: JSON.stringify(STRUCTURED_IDEA_FIXTURE),
      GEMINI_TEST_CAPTURE_FILE: promptCapture,
    })

    expect(result.stdout).toContain("Issue: feat(project): add guided project kickoff")
    expect(result.stdout).toContain("## Implementation Tasks")
    expect(result.stdout).toContain("## Acceptance Criteria")
    expect(result.stdout).toContain("## Labels")
    expect(result.stdout).toContain(
      "- [ ] Add a new kickoff command entry point in the CLI help and command registry."
    )

    const prompt = await Bun.file(promptCapture).text()
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
