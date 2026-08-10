// push-ci is the always-wait-for-CI facade over the canonical push-wait flow.

import type { Command } from "../types.ts"
import { executePushFlow, parsePushWaitArgs } from "./push-wait.ts"

export interface PushCiArgs {
  remote: string
  branch: string
  cooldownTimeout: number
  ciTimeout: number
  extraArgs: string[]
  cwd?: string
}

export function parsePushCiArgs(args: string[]): PushCiArgs {
  const parsed = parsePushWaitArgs(args)
  return {
    remote: parsed.remote,
    branch: parsed.branch,
    cooldownTimeout: parsed.timeout,
    ciTimeout: parsed.ciTimeout,
    extraArgs: parsed.extraArgs,
    cwd: parsed.cwd,
  }
}

export const pushCiCommand: Command = {
  name: "push-ci",
  description: "Push, verify the remote branch, then wait for authoritative CI results",
  usage: "swiz push-ci [remote] [branch] [--cwd <dir>] [--timeout <s>] [--ci-timeout <s>]",
  options: [
    { flags: "--cwd <dir>", description: "Working directory for git push (default: cwd)" },
    { flags: "--timeout, -t <seconds>", description: "Max cooldown wait (default: 120)" },
    { flags: "--ci-timeout <seconds>", description: "Max CI wait (default: 300)" },
  ],
  async run(args) {
    const parsed = parsePushCiArgs(args)
    await executePushFlow({
      remote: parsed.remote,
      branch: parsed.branch,
      cooldownTimeout: parsed.cooldownTimeout,
      ciTimeout: parsed.ciTimeout,
      waitForCi: true,
      extraArgs: parsed.extraArgs,
      cwd: parsed.cwd ?? process.cwd(),
    })
  },
}
