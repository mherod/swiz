#!/usr/bin/env bun
// Stop hook: Block stop if current branch has CHANGES_REQUESTED reviews

import { git, gh, isGitRepo, isGitHubRemote, hasGhCli, blockStop, type StopHookInput } from "./hook-utils.ts";

export {};

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;
  const cwd = input.cwd;

  if (!(await isGitRepo(cwd))) return;
  if (!hasGhCli()) return;
  if (!(await isGitHubRemote(cwd))) return;

  const branch = await git(["branch", "--show-current"], cwd);
  if (!branch || branch === "main" || branch === "master") return;

  // Find PR for current branch
  const prRaw = await gh(["pr", "list", "--head", branch, "--state", "open", "--json", "number,title"], cwd);
  if (!prRaw) return;

  let prs: Array<{ number: number; title: string }>;
  try {
    prs = JSON.parse(prRaw);
  } catch {
    return;
  }

  const pr = prs[0];
  if (!pr) return;

  // Get repo name
  const repo = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd);
  if (!repo) return;

  // Get PR reviews
  const reviewsRaw = await gh(["api", `repos/${repo}/pulls/${pr.number}/reviews`], cwd);
  if (!reviewsRaw) return;

  let reviews: Array<{ state: string; user: { login: string }; body?: string }>;
  try {
    reviews = JSON.parse(reviewsRaw);
  } catch {
    return;
  }

  const changesRequested = reviews.filter((r) => r.state === "CHANGES_REQUESTED");
  if (changesRequested.length === 0) return;

  const reviewers = [...new Set(changesRequested.map((r) => r.user.login))].join(", ");
  const details = changesRequested
    .slice(0, 5)
    .map((r) => `- @${r.user.login}: ${r.body || "No comment provided"}`)
    .join("\n");

  let reason = `PR #${pr.number} has changes requested from reviewers.\n\n`;
  reason += `Reviewers: ${reviewers}\n\n`;
  reason += `Requested changes:\n${details}\n\n`;
  reason += "Use the /pr-comments-address skill to address all feedback before stopping.";

  blockStop(reason);
}

main();
