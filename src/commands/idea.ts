import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { z } from "zod"
import {
  type AiProviderId,
  hasAiProvider,
  promptObject,
  promptStreamText,
} from "../ai-providers.ts"
import { detectFrameworks, detectProjectStack } from "../detect-frameworks.ts"
import { extractJsonCandidate } from "../extract-json-candidate.ts"
import { createStreamBufferReporter } from "../stream-buffer-reporter.ts"
import type { Command } from "../types.ts"

const DEFAULT_TIMEOUT_MS = 90_000
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
  json: boolean
  printPrompt: boolean
  provider?: AiProviderId
}

interface IdeaParseState {
  targetDir: string
  model?: string
  timeoutMs: number
  json: boolean
  printPrompt: boolean
  provider?: AiProviderId
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got: ${value}`)
  }
  return parsed
}

function parseProvider(value: string): AiProviderId {
  if (value === "gemini" || value === "claude" || value === "openrouter") return value
  throw new Error(`--provider must be "gemini", "claude", or "openrouter", got: ${value}`)
}

type IdeaValueOption = {
  names: string[]
  missingMessage: string
  apply: (state: IdeaParseState, value: string) => void
}

const VALUE_OPTIONS: IdeaValueOption[] = [
  {
    names: ["--dir", "-d"],
    missingMessage: "Missing value for --dir",
    apply: (state, value) => {
      state.targetDir = resolve(value)
    },
  },
  {
    names: ["--model", "-m"],
    missingMessage: "Missing value for --model",
    apply: (state, value) => {
      state.model = value
    },
  },
  {
    names: ["--timeout", "-t"],
    missingMessage: "Missing value for --timeout",
    apply: (state, value) => {
      state.timeoutMs = parsePositiveInt(value, "--timeout")
    },
  },
  {
    names: ["--provider", "-p"],
    missingMessage: "Missing value for --provider",
    apply: (state, value) => {
      state.provider = parseProvider(value)
    },
  },
]

function applyValueOption(arg: string, next: string | undefined, state: IdeaParseState): boolean {
  const option = VALUE_OPTIONS.find((entry) => entry.names.includes(arg))
  if (!option) return false
  if (!next) throw new Error(option.missingMessage)
  option.apply(state, next)
  return true
}

export function parseIdeaArgs(args: string[]): IdeaArgs {
  const state: IdeaParseState = {
    targetDir: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    printPrompt: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (applyValueOption(arg, args[i + 1], state)) {
      i++
      continue
    }

    if (arg === "--json" || arg === "-j") {
      state.json = true
      continue
    }

    if (arg === "--print-prompt") {
      state.printPrompt = true
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return {
    targetDir: state.targetDir,
    model: state.model,
    timeoutMs: state.timeoutMs,
    json: state.json,
    printPrompt: state.printPrompt,
    provider: state.provider,
  }
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

function parseIdeaFromJsonText(text: string): IssueIdea {
  const candidate = extractJsonCandidate(text)
  const parsed = JSON.parse(candidate) as unknown
  return IssueIdeaSchema.parse(parsed)
}

export const ideaCommand: Command = {
  name: "idea",
  description: "Use Gemini to propose a creative next idea for the current project",
  usage: "swiz idea [--dir <path>] [--model <name>] [--timeout <ms>] [--json] [--print-prompt]",
  options: [
    { flags: "--dir, -d <path>", description: "Project directory to analyze (default: cwd)" },
    {
      flags: "--model, -m <name>",
      description: "Model override (provider-specific default applies when omitted)",
    },
    {
      flags: "--timeout, -t <ms>",
      description: `Request timeout in ms (default: ${DEFAULT_TIMEOUT_MS})`,
    },
    {
      flags: "--json, -j",
      description: "Print structured idea JSON instead of formatted markdown",
    },
    { flags: "--print-prompt", description: "Print the generated prompt and exit" },
    {
      flags: "--provider, -p <name>",
      description:
        'AI provider override: "gemini", "claude", or "openrouter" (default: auto-select)',
    },
  ],
  async run(args: string[]) {
    const { targetDir, model, timeoutMs, json, printPrompt, provider } = parseIdeaArgs(args)
    const [readme, frameworks, stacks] = await Promise.all([
      readReadmeContent(targetDir),
      detectFrameworks(targetDir).then((f) => Array.from(f).sort()),
      detectProjectStack(targetDir),
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

    if (printPrompt) {
      console.log(prompt)
      return
    }

    if (!hasAiProvider()) {
      throw new Error(
        "No AI provider available. Set GEMINI_API_KEY, OPENROUTER_API_KEY, or install the claude CLI."
      )
    }

    let idea: IssueIdea
    const bufferReporter = createStreamBufferReporter({ enabled: !json })
    try {
      bufferReporter.startSubmitting()
      const streamed = await promptStreamText(prompt, {
        model,
        timeout: timeoutMs,
        provider,
        onTextPart: (textPart: string) => {
          if (json) {
            process.stdout.write(textPart)
            return
          }
          bufferReporter.onChunk(textPart)
        },
      })
      bufferReporter.finish()
      idea = parseIdeaFromJsonText(streamed)
      if (json) {
        if (process.stdout.isTTY) process.stdout.write("\n")
        return
      }
    } catch (error) {
      bufferReporter.finish()
      if (json) throw error

      idea = await promptObject(prompt, IssueIdeaSchema, {
        model,
        timeout: timeoutMs,
        provider,
      })
    }

    if (json) {
      console.log(JSON.stringify(idea, null, 2))
      return
    }
    console.log(renderIssueDescription(idea))
  },
}
