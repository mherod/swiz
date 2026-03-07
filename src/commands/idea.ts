import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { z } from "zod"
import { detectFrameworks, detectProjectStack } from "../detect-frameworks.ts"
import { hasGeminiApiKey, promptGeminiObject } from "../gemini.ts"
import type { Command } from "../types.ts"

const DEFAULT_TIMEOUT_MS = 25_000
const README_CHAR_LIMIT = 24_000
const COMMIT_COUNT = 8

const IssueIdeaSchema = z.object({
  title: z.string().min(6),
  summary: z.string().min(20),
  userProblem: z.string().min(20),
  roadmapDirection: z.enum(["Now", "Next", "Later"]),
  roadmapRationale: z.string().min(20),
  userFacingGap: z.string().min(20),
  directInstructions: z.object({
    analysis: z.string().min(10),
    technicalInvestigation: z.string().min(10),
    categorizationAndPriority: z.string().min(10),
    clarificationAndUnblocking: z.string().min(10),
    cleanupAndDeprecation: z.string().min(10),
    resolutionCheck: z.string().min(10),
  }),
  implementationTasks: z.array(z.string().min(8)).min(4).max(10),
  acceptanceCriteria: z.array(z.string().min(8)).min(3).max(10),
  labels: z.object({
    type: z.string().min(2),
    area: z.string().min(2),
    priority: z.string().min(2),
  }),
  risksAndDependencies: z.array(z.string().min(6)).max(8).optional().default([]),
})

type IssueIdea = z.infer<typeof IssueIdeaSchema>

export interface IdeaArgs {
  targetDir: string
  model?: string
  timeoutMs: number
}

export function parseIdeaArgs(args: string[]): IdeaArgs {
  let targetDir = process.cwd()
  let model: string | undefined
  let timeoutMs = DEFAULT_TIMEOUT_MS

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    const next = args[i + 1]

    if (arg === "--dir" || arg === "-d") {
      if (!next) throw new Error("Missing value for --dir")
      targetDir = resolve(next)
      i++
      continue
    }
    if (arg === "--model" || arg === "-m") {
      if (!next) throw new Error("Missing value for --model")
      model = next
      i++
      continue
    }
    if (arg === "--timeout" || arg === "-t") {
      if (!next) throw new Error("Missing value for --timeout")
      const parsed = Number.parseInt(next, 10)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--timeout must be a positive integer, got: ${next}`)
      }
      timeoutMs = parsed
      i++
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return { targetDir, model, timeoutMs }
}

async function readReadmeContent(targetDir: string): Promise<string | null> {
  const candidates = ["README.md", "Readme.md", "readme.md"]
  for (const fileName of candidates) {
    const path = join(targetDir, fileName)
    if (!existsSync(path)) continue
    const text = await Bun.file(path).text()
    if (text.trim()) return text
  }
  return null
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[README truncated to ${maxChars} characters]`
}

function readRecentCommitMessages(targetDir: string, count: number): string[] {
  try {
    const proc = Bun.spawnSync(
      ["git", "-C", targetDir, "log", `--max-count=${count}`, "--pretty=%s"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    if (proc.exitCode !== 0) return []
    const stdout = new TextDecoder().decode(proc.stdout).trim()
    if (!stdout) return []
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function buildPrompt(context: {
  projectName: string
  targetDir: string
  readme: string | null
  commits: string[]
  frameworks: string[]
  stacks: string[]
}): string {
  const commitsBlock =
    context.commits.length > 0
      ? context.commits.map((msg, idx) => `${idx + 1}. ${msg}`).join("\n")
      : "No recent git commit messages were found."

  const readmeBlock = context.readme
    ? truncate(context.readme, README_CHAR_LIMIT)
    : "README not found."

  return [
    "You are preparing a GitHub issue-refinement brief for this repository.",
    "Propose one creative but realistic next initiative that fits this codebase and recent commit direction.",
    "Prioritize product direction and roadmap progression over internal engineering tasks.",
    "Target a user-facing functionality gap that real users would notice and value.",
    "Do not propose a purely internal tooling/infra/CI refactor unless it is directly bundled with a concrete user-facing capability in this same initiative.",
    "Output must describe an immediately actionable GitHub issue that an engineer can start implementing right now.",
    "Write as direct instructions in imperative voice.",
    "Adopt the workflow essence of issue refinement: analysis, technical investigation, categorization and priority, clarification and unblocking, cleanup and deprecation, and resolution checks.",
    "Be decisive and concrete. Avoid vague guidance.",
    "Provide concrete implementation tasks and acceptance criteria, not just strategy.",
    "Use label suggestions that match common GitHub conventions (type/area/priority).",
    "",
    `Project name: ${context.projectName}`,
    `Project directory: ${context.targetDir}`,
    `Detected stacks: ${context.stacks.length > 0 ? context.stacks.join(", ") : "unknown"}`,
    `Detected frameworks: ${context.frameworks.length > 0 ? context.frameworks.join(", ") : "unknown"}`,
    "",
    "<recent_commits>",
    commitsBlock,
    "</recent_commits>",
    "",
    "<readme>",
    readmeBlock,
    "</readme>",
  ].join("\n")
}

function renderIssueDescription(idea: IssueIdea): string {
  const risksSection =
    idea.risksAndDependencies.length > 0
      ? `\n## Risks & Dependencies\n${idea.risksAndDependencies.map((risk) => `- ${risk}`).join("\n")}\n`
      : ""

  return [
    `Issue: ${idea.title}`,
    "",
    "## Summary",
    idea.summary,
    "",
    "## User Problem",
    idea.userProblem,
    "",
    "## Roadmap Direction",
    `- Direction: ${idea.roadmapDirection}`,
    `- Rationale: ${idea.roadmapRationale}`,
    "",
    "## User-Facing Gap To Close",
    idea.userFacingGap,
    "",
    "## Direct Instructions",
    `1. Analysis & information gathering: ${idea.directInstructions.analysis}`,
    `2. Technical investigation: ${idea.directInstructions.technicalInvestigation}`,
    `3. Categorization & priority: ${idea.directInstructions.categorizationAndPriority}`,
    `4. Clarification & unblocking: ${idea.directInstructions.clarificationAndUnblocking}`,
    `5. Cleanup & deprecation: ${idea.directInstructions.cleanupAndDeprecation}`,
    `6. Resolution check: ${idea.directInstructions.resolutionCheck}`,
    "",
    "## Implementation Tasks",
    ...idea.implementationTasks.map((task) => `- [ ] ${task}`),
    "",
    "## Acceptance Criteria",
    ...idea.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
    "",
    "## Labels",
    `- type: ${idea.labels.type}`,
    `- area: ${idea.labels.area}`,
    `- priority: ${idea.labels.priority}`,
    risksSection.trimEnd(),
  ]
    .filter(Boolean)
    .join("\n")
}

export const ideaCommand: Command = {
  name: "idea",
  description: "Use Gemini to propose a creative next idea for the current project",
  usage: "swiz idea [--dir <path>] [--model <name>] [--timeout <ms>]",
  options: [
    { flags: "--dir, -d <path>", description: "Project directory to analyze (default: cwd)" },
    {
      flags: "--model, -m <name>",
      description: "Gemini model override (default: gemini-flash-latest)",
    },
    {
      flags: "--timeout, -t <ms>",
      description: `Gemini request timeout in ms (default: ${DEFAULT_TIMEOUT_MS})`,
    },
  ],
  async run(args: string[]) {
    if (!hasGeminiApiKey()) {
      throw new Error("No Gemini API key found. Set GEMINI_API_KEY env var.")
    }

    const { targetDir, model, timeoutMs } = parseIdeaArgs(args)
    const [readme, frameworks, stacks] = await Promise.all([
      readReadmeContent(targetDir),
      Promise.resolve(Array.from(detectFrameworks(targetDir)).sort()),
      Promise.resolve(detectProjectStack(targetDir)),
    ])
    const commits = readRecentCommitMessages(targetDir, COMMIT_COUNT)
    const prompt = buildPrompt({
      projectName: basename(targetDir),
      targetDir,
      readme,
      commits,
      frameworks,
      stacks,
    })

    const idea = await promptGeminiObject(prompt, IssueIdeaSchema, { model, timeout: timeoutMs })
    console.log(renderIssueDescription(idea))
  },
}
