#!/usr/bin/env bun

/** Block commits whose staged file snapshots expose the current user's absolute home path. */

import { isAbsolute, parse } from "node:path"
import { git } from "../src/git-helpers.ts"
import {
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHook,
  type SwizHookOutput,
} from "../src/SwizHook.ts"
import { shellHookInputSchema } from "../src/schemas.ts"
import { isShellTool } from "../src/tool-matchers.ts"
import {
  GIT_COMMIT_RE,
  gitSubcommandRe,
  stripQuotedShellStrings,
} from "../src/utils/shell-patterns.ts"

const GIT_INDEX_MUTATION_RE = gitSubcommandRe("(?:add|rm|mv)\\b")

interface HomePathGuardOptions {
  homeDir?: string | null
}

function resolveAbsoluteHomePath(homeDir: string | null | undefined): string | null {
  const candidate = homeDir?.trim()
  if (!candidate || !isAbsolute(candidate)) return null

  const withoutTrailingSeparators = candidate.replace(/[\\/]+$/, "")
  const rootWithoutTrailingSeparators = parse(candidate).root.replace(/[\\/]+$/, "")
  if (!withoutTrailingSeparators || withoutTrailingSeparators === rootWithoutTrailingSeparators) {
    return null
  }
  return withoutTrailingSeparators
}

function splitNullTerminatedPaths(output: string): string[] {
  return output.split("\0").filter(Boolean)
}

async function findStagedHomePathMatches(cwd: string, homePath: string): Promise<string[]> {
  const stagedOutput = await git(
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    cwd
  )
  const stagedPaths = new Set(splitNullTerminatedPaths(stagedOutput))
  if (stagedPaths.size === 0) return []

  const matchingOutput = await git(["grep", "--cached", "-F", "-l", "-z", "-e", homePath], cwd)
  return splitNullTerminatedPaths(matchingOutput)
    .filter((path) => stagedPaths.has(path))
    .sort()
}

function formatDenyReason(paths: string[]): string {
  const visible = paths.slice(0, 20)
  const hiddenCount = paths.length - visible.length
  const pathList = visible.map((path) => `  - ${path}`).join("\n")
  const remainder = hiddenCount > 0 ? `\n  - ...and ${hiddenCount} more` : ""

  return (
    "BLOCKED: staged file content contains your absolute home directory.\n\n" +
    `Affected staged files:\n${pathList}${remainder}\n\n` +
    "Replace the absolute path with `~`, `$HOME`, or a repository-relative path. " +
    "Then re-stage every affected file with `git add` and retry the commit."
  )
}

function mutatesIndexBeforeCommit(command: string): boolean {
  const mutation = command.match(GIT_INDEX_MUTATION_RE)
  const commit = command.match(GIT_COMMIT_RE)
  return (
    mutation?.index !== undefined && commit?.index !== undefined && mutation.index < commit.index
  )
}

type CommitCommandDecision = "ignore" | "scan" | "stage-separately"

function classifyCommitCommand(rawCommand: string): CommitCommandDecision {
  const command = stripQuotedShellStrings(rawCommand)
  if (!GIT_COMMIT_RE.test(command)) return "ignore"
  if (mutatesIndexBeforeCommit(command)) return "stage-separately"
  return "scan"
}

async function evaluateCommitCommand(
  parsed: ReturnType<typeof shellHookInputSchema.parse>,
  options: HomePathGuardOptions
): Promise<SwizHookOutput> {
  const decision = classifyCommitCommand(parsed.tool_input?.command ?? "")
  if (decision === "ignore") return {}
  if (decision === "stage-separately") {
    return preToolUseDeny(
      "BLOCKED: stage files and commit them in separate shell tool calls.\n\n" +
        "Swiz must inspect the final Git index after staging completes. Run the `git add`, `git rm`, " +
        "or `git mv` command first, then run `git commit` separately."
    )
  }

  const homePath = resolveAbsoluteHomePath(options.homeDir ?? process.env.HOME)
  if (!homePath) return {}

  const cwd = parsed.cwd ?? process.cwd()
  const matches = await findStagedHomePathMatches(cwd, homePath)
  return matches.length > 0 ? preToolUseDeny(formatDenyReason(matches)) : {}
}

export async function evaluateNoHomePaths(
  input: unknown,
  options: HomePathGuardOptions = {}
): Promise<SwizHookOutput> {
  try {
    const parsed = shellHookInputSchema.parse(input)
    if (!isShellTool(parsed.tool_name ?? "")) return {}
    return await evaluateCommitCommand(parsed, options)
  } catch {
    return {}
  }
}

const pretooluseNoHomePaths: SwizHook = {
  name: "pretooluse-no-home-paths",
  event: "preToolUse",
  matcher: "Bash",
  timeout: 10,
  run(input) {
    return evaluateNoHomePaths(input)
  },
}

export default pretooluseNoHomePaths

if (import.meta.main) await runSwizHookAsMain(pretooluseNoHomePaths)
