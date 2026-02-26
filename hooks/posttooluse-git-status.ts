#!/usr/bin/env bun
// PostToolUse hook: Inject git status context after every tool call

import { git, getGitAheadBehind, parseGitStatus, type ToolHookInput } from "./hook-utils.ts";

export {};

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ToolHookInput;
  const cwd = input.cwd;
  if (!cwd) return;

  // Must be a git repository
  const gitDir = await git(["rev-parse", "--git-dir"], cwd);
  if (!gitDir) return;

  const branch = (await git(["branch", "--show-current"], cwd)) || "(detached)";

  const porcelain = await git(["status", "--porcelain"], cwd);
  const uncommitted = porcelain ? parseGitStatus(porcelain).total : 0;

  let status = `[git] branch: ${branch} | uncommitted files: ${uncommitted}`;

  const aheadBehind = await getGitAheadBehind(cwd);
  if (aheadBehind) {
    const { ahead, behind } = aheadBehind;
    if (ahead > 0 && behind > 0) {
      status += ` | diverged: ${ahead} ahead, ${behind} behind`;
    } else if (ahead > 0) {
      status += ` | ${ahead} unpushed commit(s)`;
    } else if (behind > 0) {
      status += ` | ${behind} behind remote`;
    }
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: status,
      },
    })
  );
}

main();
