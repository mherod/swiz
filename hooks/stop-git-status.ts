#!/usr/bin/env bun
// Stop hook: Block stop if git repository has uncommitted changes

import { git, isGitRepo, blockStop, createSessionTask, type StopHookInput } from "./hook-utils.ts";

export {};

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;
  const cwd = input.cwd;

  if (!(await isGitRepo(cwd))) return;

  const porcelain = await git(["status", "--porcelain"], cwd);
  if (!porcelain) return;

  const lines = porcelain.split("\n").filter(Boolean);
  const total = lines.length;

  // Count files by status
  let modified = 0, added = 0, deleted = 0, untracked = 0;
  for (const line of lines) {
    if (line.startsWith(" M")) modified++;
    else if (line.startsWith("A ")) added++;
    else if (line.startsWith("D ")) deleted++;
    else if (line.startsWith("??")) untracked++;
  }

  const parts: string[] = [];
  if (modified > 0) parts.push(`${modified} modified`);
  if (added > 0) parts.push(`${added} added`);
  if (deleted > 0) parts.push(`${deleted} deleted`);
  if (untracked > 0) parts.push(`${untracked} untracked`);
  const summary = parts.join(", ");

  let reason = "Uncommitted changes detected in git repository.\n\n";
  reason += `Status: ${summary} (${total} file(s))\n\n`;
  reason += "Files with changes:\n";
  reason += lines.slice(0, 20).map((l) => `  ${l}`).join("\n");
  if (total > 20) reason += `\n  ... and ${total - 20} more file(s)`;
  reason += "\n\nUse the /commit skill to review and commit your changes before stopping.";

  await createSessionTask(
    input.session_id,
    "stop-git-status-task-created",
    "Commit uncommitted changes",
    `Git repository at ${cwd} has uncommitted changes (${summary}). Use the /commit skill to stage and commit your changes before stopping.`
  );

  blockStop(reason);
}

main();
