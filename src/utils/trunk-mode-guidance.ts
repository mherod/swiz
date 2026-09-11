import { quotePosixShellArg } from "./shell-patterns.ts"

/** Keep the visible summary and full denial aligned across trunk-mode gates. */
export function trunkModeGuidance(defaultBranch?: string): { summary: string; workflow: string } {
  const branch = defaultBranch || "<default-branch>"
  const branchArg = defaultBranch ? quotePosixShellArg(defaultBranch) : branch
  const resolveBranch = defaultBranch
    ? ""
    : `Resolve <default-branch> from project settings or origin/HEAD first.\n`
  return {
    summary:
      `Trunk mode: implement, verify, commit and push new work directly on ${defaultBranch || "the default branch"}. ` +
      `Do not create a branch or PR. Existing branches/worktrees are for recovery or existing PR work.`,
    workflow:
      resolveBranch +
      `New work: use the default branch (\`${branch}\`) in the primary checkout. ` +
      `Preserve unrelated or peer work before switching; do not carry it onto another branch.\n` +
      `  git switch ${branchArg}\n` +
      `Implement and verify the change, commit on \`${branch}\`, then push directly:\n` +
      `  git push origin ${branchArg}\n` +
      `Do not create a feature branch or a new PR.\n\n` +
      `Existing work only: reuse a verified branch for recovery or to finish an existing PR:\n` +
      `  git switch <existing-branch>\n` +
      `  git worktree add <path> <existing-branch>\n` +
      `For an existing PR, update its branch and PR; merge it when ready, then resume trunk work on \`${branch}\`.\n` +
      `For review of a fetched remote PR head:\n` +
      `  git worktree add --detach <path> refs/remotes/origin/<existing-PR-branch>\n` +
      `Do not leave unpublished commits on a detached HEAD. Keep Git's dirty-checkout and ownership checks intact.`,
  }
}
