#!/usr/bin/env bun

// CommitMsg hook: Scrub co-author and AI-generation attribution from commit messages.
// Dispatched by lefthook commit-msg via `swiz dispatch commitMsg`.

import { z } from "zod"
import { isGitRepo } from "../src/git-helpers.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"

const commitMsgHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  commit_msg_file: z.string().optional(),
})

function isProhibitedAttributionLine(line: string): boolean {
  const normalized = line.normalize("NFKC")
  return (
    /^Co-authored-by:.*$/i.test(normalized) || /generated.*with.*claude.*code/i.test(normalized)
  )
}

export async function evaluateCommitMsgScrubCoauthors(input: unknown): Promise<SwizHookOutput> {
  try {
    const parsed = commitMsgHookInputSchema.parse(input)
    const cwd = parsed.cwd ?? process.cwd()
    const msgFile = parsed.commit_msg_file

    if (!(await isGitRepo(cwd)) || !msgFile) return {}

    const messageFile = Bun.file(msgFile)
    if (!(await messageFile.exists())) return {}

    const content = await messageFile.text()
    const lines = content.split(/\r?\n/)
    const scrubbedLines = lines.filter((line) => !isProhibitedAttributionLine(line))
    if (scrubbedLines.length === lines.length) return {}

    const scrubbed = scrubbedLines.join("\n").trim()
    await Bun.write(msgFile, `${scrubbed}\n`)
    return {
      systemMessage: "Scrubbed prohibited commit attribution.",
    }
  } catch {
    return {}
  }
}

const commitMsgScrubCoauthors: SwizHook<Record<string, any>> = {
  name: "commitmsg-scrub-coauthors",
  event: "commitMsg",
  scheduled: true,
  timeout: 5,
  run(input) {
    return evaluateCommitMsgScrubCoauthors(input)
  },
}

export default commitMsgScrubCoauthors

if (import.meta.main) {
  await runSwizHookAsMain(commitMsgScrubCoauthors)
}
