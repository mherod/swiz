#!/usr/bin/env bun
// Stop hook: Block stop if current branch has conflicts with origin/main
// Checks both GitHub PR merge state (authoritative) and local merge-tree (fallback)

import { git, gh, isGitRepo, hasGhCli, blockStop, type StopHookInput } from "./hook-utils.ts";

export {};

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;
  const cwd = input.cwd;

  if (!(await isGitRepo(cwd))) return;

  const branch = await git(["branch", "--show-current"], cwd);
  if (!branch) return; // detached HEAD

  // Skip if on main or master
  if (branch === "main" || branch === "master") return;

  // --- GitHub PR merge state check (authoritative) ---
  if (hasGhCli()) {
    const prRaw = await gh(
      ["pr", "view", branch, "--json", "mergeable,mergeStateStatus,state,number,url"],
      cwd
    );
    if (prRaw) {
      try {
        const pr = JSON.parse(prRaw) as {
          state: string;
          mergeable: string;
          mergeStateStatus: string;
          number: number;
          url: string;
        };

        if (pr.state === "OPEN" && pr.mergeable === "CONFLICTING") {
          let reason = `PR #${pr.number} for branch '${branch}' has merge conflicts (GitHub: mergeable=CONFLICTING, mergeStateStatus=${pr.mergeStateStatus}).\n\n`;
          reason += `${pr.url}\n\n`;
          reason += "Use the /rebase-onto-main skill to rebase and resolve conflicts before stopping.";
          blockStop(reason);
        }

        // If GitHub says it's clean, trust it
        if (pr.state === "OPEN" && pr.mergeable === "MERGEABLE") return;
      } catch {}
    }
  }

  // --- Local merge-tree check (fallback for branches without PRs) ---
  const originMain = await git(["rev-parse", "origin/main"], cwd);
  if (!originMain) return;

  const behindStr = await git(["rev-list", "--count", "HEAD..origin/main"], cwd);
  const behind = parseInt(behindStr);
  if (isNaN(behind) || behind === 0) return;

  const mergeBase = await git(["merge-base", "HEAD", "origin/main"], cwd);
  if (!mergeBase) return;

  const mergeTree = await git(["merge-tree", mergeBase, "HEAD", "origin/main"], cwd);
  const conflictCount = (mergeTree.match(/^<<<<<</gm) ?? []).length;

  if (conflictCount > 0) {
    let reason = `Branch '${branch}' has conflicts with origin/main.\n\n`;
    reason += `${conflictCount} conflict(s) detected — ${behind} commit(s) on origin/main not yet in this branch.\n\n`;
    reason += "Use the /rebase-onto-main skill to rebase and resolve conflicts before stopping.";
    blockStop(reason);
  }
}

main();
