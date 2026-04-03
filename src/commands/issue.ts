import { getRepoSlug } from "../git-helpers.ts"
import { getIssueStore } from "../issue-store.ts"
import type { Command } from "../types.ts"
import { closeIssue, commentOnIssue, resolveIssue } from "./issue/operations.ts"
import { handleList, handleSync } from "./issue/sync-display.ts"

export type { ResolveResult } from "./issue/operations.ts"

function usage(): string {
  return (
    "Usage: swiz issue <subcommand> [options]\n" +
    "Subcommands: close, comment, resolve, cache-bust, sync, list\n" +
    "  swiz issue close <number>\n" +
    "  swiz issue comment <number> --body <text>\n" +
    "  swiz issue resolve <number> [--body <text>]\n" +
    "  swiz issue cache-bust [--repo <slug>]\n" +
    "  swiz issue sync [<repo>]\n" +
    "  swiz issue list [<repo>]"
  )
}

function parseBodyArg(args: string[]): string | undefined {
  for (let i = 2; i < args.length; i++) {
    if ((args[i] === "--body" || args[i] === "-b") && args[i + 1]) return args[i + 1]
  }
  return undefined
}

async function handleCacheBust(args: string[]): Promise<void> {
  const repoFlag = args.indexOf("--repo")
  const cwd = process.cwd()
  const slug = repoFlag >= 0 && args[repoFlag + 1] ? args[repoFlag + 1] : await getRepoSlug(cwd)
  const store = getIssueStore()
  if (slug) {
    store.clearCachedData(slug)
    console.log(`  Cache cleared for ${slug}`)
  } else {
    store.clearAllCachedData()
    console.log("  All cached data cleared")
  }
}

export const issueCommand: Command = {
  name: "issue",
  description: "Interact with GitHub issues and store (guards against operating on closed issues)",
  usage: "swiz issue <subcommand> [options]",
  options: [
    { flags: "close <number>", description: "Close an issue (skips if already closed)" },
    {
      flags: "comment <number> --body <text>",
      description: "Comment on an issue (skips if already closed)",
    },
    {
      flags: "resolve <number> [--body <text>]",
      description:
        "Idempotent resolve: fetch state, always post comment, close only if OPEN. " +
        "Reports accurate final state whether issue was open or already closed.",
    },
    { flags: "--body, -b <text>", description: "Comment body (for comment and resolve)" },
    {
      flags: "cache-bust [--repo <slug>]",
      description:
        "Clear cached issue/PR/CI data. Defaults to current repo; omit --repo to clear all.",
    },
    {
      flags: "sync [<repo>]",
      description:
        "Manually sync upstream GitHub state (issues, PRs, CI, labels) into the local store. " +
        "Defaults to current repo.",
    },
    {
      flags: "list [<repo>] [--mine]",
      description:
        "List open issues and pull requests. Use --mine to filter to issues assigned to you.",
    },
  ],
  async run(args: string[]) {
    const sub = args[0]
    if (sub === "cache-bust") return handleCacheBust(args)
    if (sub === "sync") return handleSync(args)
    if (sub === "list") return handleList(args)

    const number = args[1]
    if (!sub || !number) throw new Error(`Missing arguments.\n${usage()}`)
    if (sub === "close") return closeIssue(number)

    const body = parseBodyArg(args)
    if (sub === "comment") {
      if (!body) throw new Error(`--body is required for the comment subcommand.\n${usage()}`)
      return commentOnIssue(number, body)
    }
    if (sub === "resolve") {
      await resolveIssue(number, body)
      return
    }

    throw new Error(`Unknown subcommand: ${sub}\n${usage()}`)
  },
}
