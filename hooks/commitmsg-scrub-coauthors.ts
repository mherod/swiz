#!/usr/bin/env bun

// CommitMsg hook: Scrub co-author and AI-generation attribution from commit messages.
// Dispatched by lefthook commit-msg via `swiz dispatch commitMsg`.

import { z } from "zod"
import { type GitRepoResolver, isGitRepoForHookPayload } from "../src/repository-capability.ts"
import type { SwizHook, SwizHookOutput } from "../src/SwizHook.ts"
import { runSwizHookAsMain } from "../src/SwizHook.ts"

const commitMsgHookInputSchema = z.looseObject({
  cwd: z.string().optional(),
  commit_msg_file: z.string().optional(),
})

/**
 * Session-attribution trailers, which agent harnesses inject by convention.
 *
 * These are the forms the co-author and generation patterns miss: a harness told to append
 * `Claude-Session: <url>` produces a line matching neither `^Co-authored-by:` nor
 * `generated…with…claude…code`, so it reached the commit unscrubbed. The bare session URL
 * is included because the trailer key alone is easy to rename.
 */
const SESSION_ATTRIBUTION_RE =
  /^(?:Claude-Session|Generated-With|Assisted-By):|claude\.ai\/code\/session/i

function isProhibitedAttributionLine(line: string): boolean {
  const normalized = line.normalize("NFKC")
  return (
    /^Co-authored-by:.*$/i.test(normalized) ||
    /generated.*with.*claude.*code/i.test(normalized) ||
    SESSION_ATTRIBUTION_RE.test(normalized.trim())
  )
}

export async function evaluateCommitMsgScrubCoauthors(
  input: unknown,
  resolveGitRepo?: GitRepoResolver
): Promise<SwizHookOutput> {
  try {
    const parsed = commitMsgHookInputSchema.parse(input)
    const cwd = parsed.cwd ?? process.cwd()
    const msgFile = parsed.commit_msg_file

    if (!(await isGitRepoForHookPayload(parsed, cwd, resolveGitRepo)) || !msgFile) return {}

    const messageFile = Bun.file(msgFile)
    if (!(await messageFile.exists())) return {}

    const content = await messageFile.text()
    const cutoff = /^# -+ >8 -+\r?$/m.exec(content)?.index ?? content.length
    const message = content.slice(0, cutoff)
    const scrubbedMessage = message.replace(/[^\n]*(?:\n|$)/g, (line) =>
      isProhibitedAttributionLine(line.replace(/\r?\n$/, "")) ? "" : line
    )
    if (scrubbedMessage === message) return {}

    /** Keep retained lines and the entire scissors suffix exactly as Git supplied them. */
    await Bun.write(msgFile, scrubbedMessage + content.slice(cutoff))
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
