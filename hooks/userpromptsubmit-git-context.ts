#!/usr/bin/env bun
// UserPromptSubmit hook: Inject git branch and uncommitted file count

import { emitContext, git } from "../src/utils/hook-utils.ts"

async function main(): Promise<void> {
  const input = (await Bun.stdin.json().catch(() => null)) as Record<string, unknown> | null
  const cwd = (input?.cwd as string) ?? process.cwd()
  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return

  const porcelain = await git(["status", "--porcelain"], cwd)
  const dirty = porcelain ? porcelain.split("\n").length : 0

  await emitContext("UserPromptSubmit", `[git] branch: ${branch} | uncommitted files: ${dirty}`)
}

if (import.meta.main) void main()
