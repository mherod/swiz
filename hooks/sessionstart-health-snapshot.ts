#!/usr/bin/env bun
// SessionStart hook: Inject project health snapshot as additionalContext

import { git, gh, isGitRepo, isGitHubRemote, hasGhCli, type SessionHookInput } from "./hook-utils.ts";

export {};

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as SessionHookInput;
  const cwd = input.cwd;
  if (!cwd) return;

  if (!(await isGitRepo(cwd))) return;
  if (!(await isGitHubRemote(cwd))) return;

  const parts: string[] = [];

  // Git status summary
  const branch = await git(["branch", "--show-current"], cwd);
  const porcelain = await git(["status", "--porcelain"], cwd);
  const uncommitted = porcelain ? porcelain.split("\n").length : 0;
  const ahead = (await git(["rev-list", "--count", "@{upstream}..HEAD"], cwd)) || "?";

  parts.push(`Git: branch=${branch}, uncommitted=${uncommitted}, unpushed=${ahead}.`);

  // Open PRs (fast, limit output)
  if (hasGhCli()) {
    const prsRaw = await gh(["pr", "list", "--state", "open", "--limit", "5", "--json", "number,title,reviewDecision"], cwd);
    if (prsRaw) {
      try {
        const prs = JSON.parse(prsRaw) as Array<{ reviewDecision?: string }>;
        if (prs.length > 0) {
          const changesReq = prs.filter((p) => p.reviewDecision === "CHANGES_REQUESTED").length;
          let prInfo = `PRs: ${prs.length} open`;
          if (changesReq > 0) prInfo += `, ${changesReq} need changes`;
          parts.push(prInfo + ".");
        }
      } catch {}
    }

    // Latest CI on current branch
    if (branch) {
      const runRaw = await gh(["run", "list", "--branch", branch, "--limit", "1", "--json", "status,conclusion,workflowName"], cwd);
      if (runRaw) {
        try {
          const runs = JSON.parse(runRaw) as Array<{ status: string; conclusion: string; workflowName: string }>;
          const run = runs[0];
          if (run) {
            if (run.status === "completed") {
              parts.push(`CI (${run.workflowName}): ${run.conclusion}.`);
            } else {
              parts.push(`CI (${run.workflowName}): ${run.status}.`);
            }
          }
        } catch {}
      }
    }
  }

  if (parts.length === 0) return;

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: parts.join(" "),
      },
    })
  );
}

main();
