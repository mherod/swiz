#!/usr/bin/env bun
// UserPromptSubmit hook: Inject git branch and uncommitted file count

import { emitContext, git } from "./hook-utils.ts"

async function main(): Promise<void> {
  const cwd = process.cwd()
  const branch = await git(["branch", "--show-current"], cwd)
  if (!branch) return

  const porcelain = await git(["status", "--porcelain"], cwd)
  const dirty = porcelain ? porcelain.split("\n").length : 0

  emitContext("UserPromptSubmit", `[git] branch: ${branch} | uncommitted files: ${dirty}`, cwd)
}

if (import.meta.main) void main()
