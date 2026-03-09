import { homedir } from "node:os"
import type { Command } from "../types.ts"

// Known sandbox-to-repo mappings for auto-inferring --repo from a blocked file path.
const SANDBOX_REPO_MAP: Array<{ prefix: string; repo: string }> = [
  { prefix: `${homedir()}/.claude/skills/`, repo: "mherod/skills" },
  { prefix: `${homedir()}/.cursor/skills/`, repo: "mherod/skills" },
  { prefix: `${homedir()}/.claude/hooks/`, repo: "mherod/.claude" },
]

export function inferRepo(filePath: string): string | null {
  for (const { prefix, repo } of SANDBOX_REPO_MAP) {
    if (filePath.startsWith(prefix)) return repo
  }
  return null
}

export function relativeFilePath(filePath: string): string {
  for (const { prefix } of SANDBOX_REPO_MAP) {
    if (filePath.startsWith(prefix)) return filePath.slice(prefix.length)
  }
  return filePath
}

function buildIssueBody(opts: {
  filePath: string
  line: number | null
  snippet: string | null
  successCriteria: string[]
  context: string | null
}): string {
  const { filePath, line, snippet, successCriteria, context } = opts
  const relPath = relativeFilePath(filePath)

  const locationLine = line != null ? `**Line:** ${line}` : ""
  const locationBlock = [`**File:** \`${relPath}\``, locationLine].filter(Boolean).join("  \n")

  const snippetBlock = snippet
    ? `\n## Exact change\n\n${locationBlock}\n\n\`\`\`\n${snippet}\n\`\`\``
    : `\n## Location\n\n${locationBlock}`

  const contextBlock = context ? `\n## Context\n\n${context}` : ""

  const criteriaBlock =
    successCriteria.length > 0
      ? `\n## Success criteria\n\n${successCriteria.map((c) => `- [ ] ${c}`).join("\n")}`
      : ""

  return (
    `## What needs changing\n\nEdit \`${relPath}\` is blocked by the session sandbox.\n` +
    `The owning repository must apply this change directly.` +
    snippetBlock +
    contextBlock +
    criteriaBlock
  )
}

function parseArgs(args: string[]): {
  filePath: string | null
  line: number | null
  snippet: string | null
  repo: string | null
  title: string | null
  successCriteria: string[]
  context: string | null
} {
  let filePath: string | null = null
  let line: number | null = null
  let snippet: string | null = null
  let repo: string | null = null
  let title: string | null = null
  const successCriteria: string[] = []
  let context: string | null = null

  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    const next = args[i + 1]
    switch (flag) {
      case "--file":
      case "-f":
        filePath = next ?? null
        i++
        break
      case "--line":
      case "-l":
        line = next != null ? parseInt(next, 10) : null
        i++
        break
      case "--snippet":
      case "-s":
        snippet = next ?? null
        i++
        break
      case "--repo":
      case "-r":
        repo = next ?? null
        i++
        break
      case "--title":
      case "-t":
        title = next ?? null
        i++
        break
      case "--success-criteria":
      case "--criteria":
      case "-c":
        if (next) {
          successCriteria.push(next)
          i++
        }
        break
      case "--context":
        context = next ?? null
        i++
        break
    }
  }

  return { filePath, line, snippet, repo, title, successCriteria, context }
}

export const crossRepoIssueCommand: Command = {
  name: "cross-repo-issue",
  description:
    "File a GitHub issue with exact change details when a sandbox edit is blocked. " +
    "Auto-infers --repo from known sandbox paths (~/.claude/skills/ → mherod/skills, ~/.cursor/skills/ → mherod/skills, ~/.claude/hooks/ → mherod/.claude).",
  usage:
    "swiz cross-repo-issue --file <path> --title <title> [--line <n>] [--snippet <text>] [--repo <owner/repo>] [--criteria <text>]... [--context <text>]",
  options: [
    { flags: "--file, -f <path>", description: "Absolute path of the blocked file" },
    { flags: "--title, -t <text>", description: "Issue title" },
    { flags: "--line, -l <n>", description: "Line number of the insertion/change point" },
    { flags: "--snippet, -s <text>", description: "Exact code snippet to insert or replace" },
    {
      flags: "--repo, -r <owner/repo>",
      description: "Target repo (inferred from --file if in a known sandbox path)",
    },
    {
      flags: "--criteria, -c <text>",
      description: "Success criterion (repeatable)",
    },
    { flags: "--context <text>", description: "Additional context or background" },
  ],
  async run(args) {
    const opts = parseArgs(args)

    if (!opts.filePath) {
      throw new Error(`--file is required.\n${this.usage}`)
    }
    if (!opts.title) {
      throw new Error(`--title is required.\n${this.usage}`)
    }

    // Auto-infer repo from file path if not provided
    const repo = opts.repo ?? inferRepo(opts.filePath)
    if (!repo) {
      throw new Error(
        `--repo is required: could not infer repo from path "${opts.filePath}".\n` +
          `Known sandbox paths: ${SANDBOX_REPO_MAP.map((m) => m.prefix).join(", ")}`
      )
    }

    const body = buildIssueBody({
      filePath: opts.filePath,
      line: opts.line,
      snippet: opts.snippet,
      successCriteria: opts.successCriteria,
      context: opts.context,
    })

    const proc = Bun.spawn(
      ["gh", "issue", "create", "--repo", repo, "--title", opts.title, "--body", body],
      { cwd: process.cwd(), stdout: "pipe", stderr: "inherit" }
    )
    const output = await new Response(proc.stdout).text()
    await proc.exited

    if (proc.exitCode !== 0) {
      throw new Error(`gh issue create failed with exit code ${proc.exitCode}`)
    }

    const url = output.trim()
    console.log(`  Issue filed: ${url}`)
    console.log(`  Repo: ${repo}`)
    console.log(
      `  File: ${relativeFilePath(opts.filePath)}${opts.line != null ? `:${opts.line}` : ""}`
    )
  },
}
