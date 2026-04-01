#!/usr/bin/env bun

// CommitMsg hook: Scrub "Co-authored-by" trailers from the commit message.
// Dispatched by lefthook commit-msg via `swiz dispatch commitMsg`.

import { readFileSync, writeFileSync } from "node:fs"
import { z } from "zod"
import { isGitRepo } from "../src/git-helpers.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"

const commitMsgHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  commit_msg_file: z.string().optional(),
})

const CO_AUTHORED_BY_RE = /^Co-authored-by:.*$/gim

export async function evaluateCommitMsgScrubCoauthors(input: unknown): Promise<SwizHookOutput> {
  try {
    const parsed = commitMsgHookInputSchema.parse(input)
    const cwd = parsed.cwd ?? process.cwd()
    const msgFile = parsed.commit_msg_file

    if (!(await isGitRepo(cwd)) || !msgFile) return {}

    const content = readFileSync(msgFile, "utf-8")
    if (CO_AUTHORED_BY_RE.test(content)) {
      const scrubbed = content.replace(CO_AUTHORED_BY_RE, "").trim()
      writeFileSync(msgFile, `${scrubbed}\n`, "utf-8")
      return {
        systemMessage: "Scrubbed 'Co-authored-by' trailers from commit message.",
      }
    }

    return {}
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
