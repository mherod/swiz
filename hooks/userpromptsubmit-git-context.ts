#!/usr/bin/env bun
// UserPromptSubmit hook: Inject git branch and uncommitted file count

import { git } from "./hook-utils.ts";

export {};

async function main(): Promise<void> {
  const branch = await git(["branch", "--show-current"], process.cwd());
  if (!branch) return;

  const porcelain = await git(["status", "--porcelain"], process.cwd());
  const dirty = porcelain ? porcelain.split("\n").length : 0;

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `[git] branch: ${branch} | uncommitted files: ${dirty}`,
      },
    })
  );
}

main();
