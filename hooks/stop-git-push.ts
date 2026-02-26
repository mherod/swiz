#!/usr/bin/env bun
// Stop hook: Block stop if current branch has unpushed commits

import { git, isGitRepo, blockStop, createSessionTask, skillAdvice, type StopHookInput } from "./hook-utils.ts";

export {};

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;
  const cwd = input.cwd;

  if (!(await isGitRepo(cwd))) return;

  const branch = await git(["branch", "--show-current"], cwd);
  if (!branch) return; // detached HEAD

  // Must have a remote
  const remoteUrl = await git(["remote", "get-url", "origin"], cwd);
  if (!remoteUrl) return;

  // Must have an upstream tracking branch
  const upstream = await git(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  if (!upstream) return;

  const ahead = parseInt(await git(["rev-list", "--count", "@{upstream}..HEAD"], cwd));
  const behind = parseInt(await git(["rev-list", "--count", "HEAD..@{upstream}"], cwd));

  // If parsing failed, allow stop
  if (isNaN(ahead) || isNaN(behind)) return;

  // Block if behind remote — must pull first
  if (behind > 0) {
    let reason: string;
    if (ahead > 0) {
      reason = `Branch '${branch}' has diverged from '${upstream}'.\n\n`;
      reason += `  ${ahead} local commit(s) not yet pushed\n`;
      reason += `  ${behind} remote commit(s) not yet pulled\n\n`;
    } else {
      reason = `Branch '${branch}' is ${behind} commit(s) behind '${upstream}'.\n\n`;
    }
    reason += "Run: git pull --rebase --autostash\n\n";
    reason += skillAdvice(
      "resolve-conflicts",
      "If conflicts arise during the rebase, use the /resolve-conflicts skill to resolve them, then push with /push.",
      "If conflicts arise during the rebase, resolve them manually, then run: git push origin " + branch
    );

    await createSessionTask(
      input.session_id,
      "stop-git-push-behind-task-created",
      "Pull remote changes before pushing",
      `Branch '${branch}' is ${behind} commit(s) behind '${upstream}'. Run: git pull --rebase --autostash. Resolve conflicts if any, then push.`
    );

    blockStop(reason);
  }

  // Block if unpushed commits
  if (ahead > 0) {
    let reason = `Unpushed commits detected on branch '${branch}'.\n\n`;
    reason += `${ahead} commit(s) ahead of '${upstream}'.\n\n`;
    reason += skillAdvice(
      "push",
      "Use the /push skill to push your changes before stopping.",
      `Push your changes before stopping:\n  git push origin ${branch}`
    );

    await createSessionTask(
      input.session_id,
      "stop-git-push-task-created",
      "Push branch to remote",
      `Branch '${branch}' has ${ahead} unpushed commit(s) ahead of '${upstream}'. Push changes to remote before stopping.`
    );

    blockStop(reason);
  }
}

main();
