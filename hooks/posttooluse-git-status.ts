#!/usr/bin/env bun
// PostToolUse hook: Inject git status context after every tool call

import { git, type ToolHookInput } from "./hook-utils.ts";

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
  const uncommitted = porcelain ? porcelain.split("\n").length : 0;

  // Remote status
  const upstream = await git(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);

  let status = `[git] branch: ${branch} | uncommitted files: ${uncommitted}`;

  if (upstream) {
    const ahead = parseInt(await git(["rev-list", "--count", "@{upstream}..HEAD"], cwd)) || 0;
    const behind = parseInt(await git(["rev-list", "--count", "HEAD..@{upstream}"], cwd)) || 0;

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
