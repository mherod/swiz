#!/usr/bin/env bun
/**
 * Stop hook: Check if personal repo has open issues
 * Blocks stop if a personal GitHub repo has open issues
 */

export {};

interface HookInput {
  cwd: string;
  session_id?: string;
  stop_hook_active?: boolean;
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--git-dir"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function getRemoteUrl(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "config", "--get", "origin.url"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim() || null;
  } catch {
    return null;
  }
}

function extractOwnerFromUrl(remoteUrl: string): string | null {
  // SSH: git@github.com:owner/repo.git
  // HTTPS: https://github.com/owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\//);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = remoteUrl.match(/github\.com\/([^/]+)\//);
  if (httpsMatch) return httpsMatch[1];

  return null;
}

async function getCurrentGitHubUser(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim() || null;
  } catch {
    return null;
  }
}

async function getOpenIssueCount(cwd: string): Promise<number> {
  try {
    const proc = Bun.spawn(
      ["gh", "issue", "list", "--state", "open", "--json", "number", "--jq", "length"],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const count = parseInt(output.trim(), 10);
    return isNaN(count) ? 0 : count;
  } catch {
    return 0;
  }
}

async function getOpenPRsWithFeedback(
  cwd: string,
  currentUser: string
): Promise<number> {
  try {
    const proc = Bun.spawn(
      [
        "gh",
        "pr",
        "list",
        "--state",
        "open",
        "--author",
        currentUser,
        "--json",
        "number,reviewDecision",
        "--jq",
        'map(select(.reviewDecision == "CHANGES_REQUESTED" or .reviewDecision == "REVIEW_REQUIRED")) | length',
      ],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const count = parseInt(output.trim(), 10);
    return isNaN(count) ? 0 : count;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  try {
    const input = await Bun.stdin.json() as HookInput;
    const cwd = input.cwd;

    // Check if it's a git repo
    if (!(await isGitRepo(cwd))) {
      console.log(JSON.stringify({ ok: true }));
      return;
    }

    // Get remote URL
    const remoteUrl = await getRemoteUrl(cwd);
    if (!remoteUrl || !remoteUrl.includes("github.com")) {
      console.log(JSON.stringify({ ok: true }));
      return;
    }

    // Extract owner
    const owner = extractOwnerFromUrl(remoteUrl);
    if (!owner) {
      console.log(JSON.stringify({ ok: true }));
      return;
    }

    // Get current GitHub user
    const currentUser = await getCurrentGitHubUser();
    if (!currentUser) {
      console.log(JSON.stringify({ ok: true }));
      return;
    }

    // Check if it's a personal repo
    if (owner !== currentUser) {
      console.log(JSON.stringify({ ok: true }));
      return;
    }

    // Get open issue count
    const issueCount = await getOpenIssueCount(cwd);

    // Get open PRs with feedback
    const prCount = await getOpenPRsWithFeedback(cwd, currentUser);

    // If no issues and no PRs with feedback, allow stop
    if (issueCount === 0 && prCount === 0) {
      console.log(JSON.stringify({ ok: true }));
      return;
    }

    // Build block reason based on what needs attention
    let reasonLines: string[] = [];

    if (issueCount > 0) {
      reasonLines.push(
        `You have ${issueCount} open issue(s) in this personal repository.`
      );
      reasonLines.push(
        "Use the /work-on-issues skill to pick up and resolve issues:"
      );
      reasonLines.push("  /work-on-issues — Start working on the next issue");
    }

    if (prCount > 0) {
      if (reasonLines.length > 0) reasonLines.push("");
      reasonLines.push(
        `You have ${prCount} open PR(s) with pending feedback (CHANGES_REQUESTED or REVIEW_REQUIRED).`
      );
      reasonLines.push(
        "Use the /work-on-prs skill to address all feedback and resolve reviews:"
      );
      reasonLines.push("  /work-on-prs — Start working on the next PR");
    }

    reasonLines.push("");
    reasonLines.push("Personal repos should stay clean. Work items represent code that needs finishing.");
    reasonLines.push("");
    reasonLines.push(
      "ACTION REQUIRED: You must act on this now. This hook will block every stop attempt until resolved. Do not try to stop again without completing the required action. If you believe this is a false positive, use the /re-assess skill to re-evaluate your assumptions — the hook's findings take authority over your own assessment."
    );

    const reason = reasonLines.join("\n");
    console.log(JSON.stringify({ decision: "block", reason }));
  } catch (error) {
    // On error, allow stop (fail open)
    console.log(JSON.stringify({ ok: true }));
  }
}

main();
