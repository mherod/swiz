#!/usr/bin/env bun

// PreToolUse hook: Enforce scope-based push policy for the default branch.
// Classifies changes as trivial (typos, small fixes, docs) or non-trivial (features, refactors).
// Blocks non-trivial work on the default branch in collaborative repositories.
// Trivial work is allowed directly to the default branch in solo projects.
//
// Dual-mode: SwizToolHook + runSwizHookAsMain.

import { detectProjectCollaborationPolicy } from "../src/collaboration-policy.ts"
import { ghJsonViaDaemon } from "../src/git-helpers.ts"
import { runSwizHookAsMain, type SwizHookOutput, type SwizToolHook } from "../src/SwizHook.ts"
import { toolHookInputSchema } from "../src/schemas.ts"
import {
  getEffectiveSwizSettings,
  readProjectSettings,
  readSwizSettings,
  resolvePolicy,
} from "../src/settings.ts"
import {
  classifyChangeScope,
  detectForkTopology,
  extractPrNumber,
  forkPrCreateCmd,
  forkPushCmd,
  GH_PR_MERGE_RE,
  getDefaultBranch,
  getRepoSlug,
  git,
  isDefaultBranch,
  isShellTool,
  parseGitStatSummary,
  preToolUseAllow,
  preToolUseDeny,
  type ToolHookInput,
} from "../src/utils/hook-utils.ts"
import { escapeRegex, GIT_GLOBAL_OPTS } from "../src/utils/shell-patterns.ts"

function buildRepoContext(isCollaborative: boolean, signals: string[]): string {
  return isCollaborative
    ? `a collaborative repository.\n\nCollaboration signals:\n${signals.map((s) => `  - ${s}`).join("\n")}`
    : `a solo repository with strict-no-direct-main enabled.\n\n  To disable strict mode: swiz settings disable strict-no-direct-main`
}

function getCommandAndCwd(hookInput: ToolHookInput): { command: string; cwd: string } {
  const cmd = hookInput.tool_input?.command
  const commandStr = typeof cmd === "string" ? cmd : ""

  let cwdStr = hookInput.cwd
  if (!cwdStr || typeof cwdStr !== "string") {
    const tiCwd = hookInput.tool_input?.cwd
    cwdStr = typeof tiCwd === "string" ? tiCwd : process.cwd()
  }

  return { command: commandStr, cwd: cwdStr }
}

interface PushDenialReasonArgs {
  scopeDescription: string
  fileCount: number
  totalLinesChanged: number
  owner: string
  repo: string
  defaultBranch: string
  repoContext: string
  fork: any
}

function buildPushDenialReason(args: PushDenialReasonArgs): string {
  return `
Non-trivial changes to '${args.defaultBranch}' in ${args.repoContext}

Change scope: ${args.scopeDescription} (${args.fileCount} files, ${args.totalLinesChanged} lines)
Repository: ${args.owner}/${args.repo}

For substantive work, use the feature branch workflow:
  1. Create a feature branch: git checkout -b feat/description
  2. Push: ${forkPushCmd("feat/description", args.fork)}
  3. Open PR: ${forkPrCreateCmd(args.defaultBranch, args.fork)}
  4. Wait for review and approval
  5. Merge via PR (not direct push)

This ensures code review, CI validation, and team coordination.
`
}

interface ScopePolicyArgs {
  isCollaborative: boolean
  strictMode: boolean
  isDocsOnly: boolean
  isTrivial: boolean
  scopeDescription: string
  fileCount: number
  totalLinesChanged: number
  defaultBranch: string
}

function checkScopeAndPolicy(args: ScopePolicyArgs): SwizHookOutput | null {
  if (!args.isCollaborative && !args.strictMode) {
    return preToolUseAllow(
      `Continue in solo-repo push policy: strict-no-direct-main is disabled and '${args.defaultBranch}' accepts ${args.scopeDescription}.`
    )
  }

  if (args.isDocsOnly || args.isTrivial) {
    return preToolUseAllow(
      `Continue in scoped default-branch push mode: ${args.scopeDescription} (${args.fileCount} files, ${args.totalLinesChanged} lines) is within policy for '${args.defaultBranch}'.`
    )
  }

  return null
}

async function resolveDiffRange(cwd: string, remoteRef: string): Promise<string> {
  const isShallow = await git(["rev-parse", "--is-shallow-repository"], cwd)
  if (isShallow === "true") {
    await git(["fetch", "--unshallow", "origin"], cwd)
  }

  if ((await git(["rev-parse", "--verify", remoteRef], cwd)) !== "") {
    return `${remoteRef}..HEAD`
  }

  const mergeBase = await git(["merge-base", remoteRef, "HEAD"], cwd)
  if (mergeBase) {
    return `${mergeBase}..HEAD`
  }

  if ((await git(["rev-parse", "--verify", "HEAD~1"], cwd)) !== "") {
    return "HEAD~1..HEAD"
  }

  const countStr = await git(["rev-list", "--count", "HEAD"], cwd)
  const count = parseInt(countStr, 10)
  if (count > 1) {
    return `HEAD~${count - 1}..HEAD`
  }

  return ""
}

/** Production branches that require PR-based workflow (no direct gh pr merge). */
const PRODUCTION_BRANCHES = new Set(["main", "master", "prod", "production"])

/** Integration branches where direct merges are part of the promotion workflow. */
const INTEGRATION_BRANCHES = new Set([
  "dev",
  "develop",
  "staging",
  "next",
  "release",
  "integration",
])

function isProductionBranch(branch: string): boolean {
  return PRODUCTION_BRANCHES.has(branch.toLowerCase())
}

function isIntegrationBranch(branch: string): boolean {
  return INTEGRATION_BRANCHES.has(branch.toLowerCase())
}

/** Returns the PR's base (target) branch, or empty string on failure. */
async function getPrBaseBranch(prNumber: string, cwd: string): Promise<string | null> {
  // Try IssueStore cache first (synced via issue-store-sync, includes baseRefName)
  try {
    const { getIssueStore } = await import("../src/issue-store.ts")
    const repoSlug = await getRepoSlug(cwd)
    if (repoSlug) {
      const store = getIssueStore()
      const pr = store.getPullRequest<{ baseRefName?: string }>(repoSlug, parseInt(prNumber, 10))
      if (pr?.baseRefName) return pr.baseRefName
    }
  } catch {
    // IssueStore unavailable — fall through to API
  }

  // Fallback: query the GitHub API directly
  const repoSlug = await getRepoSlug(cwd)
  if (!repoSlug) return null
  try {
    const result = await ghJsonViaDaemon<{ base?: { ref?: string } }>(
      ["api", `repos/${repoSlug}/pulls/${prNumber}`],
      cwd
    )
    return result?.base?.ref ?? null
  } catch {
    return null
  }
}

/** Returns the PR's mergeable status and required review state. */
async function getPrMergeability(
  prNumber: string,
  cwd: string
): Promise<{ mergeable: boolean; statusContext: string }> {
  const repoSlug = await getRepoSlug(cwd)
  if (!repoSlug) return { mergeable: false, statusContext: "Could not determine repository" }

  try {
    const result = await ghJsonViaDaemon<{
      mergeStateStatus?: string
      mergeable?: boolean | null
      reviewDecision?: string
      statusCheckRollup?: Array<{ conclusion?: string }>
    }>(["api", `repos/${repoSlug}/pulls/${prNumber}`], cwd)

    const mergeStateStatus = result?.mergeStateStatus ?? "UNKNOWN"
    const mergeable = result?.mergeable !== false
    const reviewDecision = result?.reviewDecision ?? "PENDING"

    // Check common merge-blocking states
    const canMerge =
      mergeable !== false &&
      mergeStateStatus === "MERGEABLE" &&
      (reviewDecision === "APPROVED" || reviewDecision === "REVIEW_REQUIRED")

    const statusContext = [mergeStateStatus, `review: ${reviewDecision}`].filter(Boolean).join(", ")

    return { mergeable: canMerge, statusContext }
  } catch {
    return { mergeable: false, statusContext: "Could not fetch PR status from GitHub" }
  }
}

async function handlePrMerge(
  command: string,
  cwd: string,
  defaultBranch: string
): Promise<SwizHookOutput | null> {
  const collaboration = await detectProjectCollaborationPolicy(cwd)
  const owner = collaboration.repoOwner
  const repo = collaboration.repoName
  if (!owner || !repo) return null
  const isCollaborative = collaboration.isCollaborative
  const globalSettings = await readSwizSettings()
  const effectiveSettings = getEffectiveSwizSettings(
    globalSettings,
    null,
    await readProjectSettings(cwd)
  )
  const strictMode = effectiveSettings.strictNoDirectMain

  if (!isCollaborative && !strictMode) return null

  const prNumber = extractPrNumber(command)
  if (!prNumber) return null

  const baseBranch = await getPrBaseBranch(prNumber, cwd)

  if (baseBranch === null) {
    return preToolUseDeny(`
Pull Request verification failed.

Could not determine the target branch for PR #${prNumber} (GitHub API request failed).
Please verify the PR number and your network connection, then try again.
`)
  }

  // Allow merges to integration branches — part of the dev→main promotion workflow
  if (isIntegrationBranch(baseBranch)) {
    return preToolUseAllow(
      `Continue in promotion-merge mode: integration branch '${baseBranch}' is approved for direct promotion workflow merges.`
    )
  }

  // Only block merges to production branches
  if (!isProductionBranch(baseBranch) && baseBranch !== defaultBranch) {
    return preToolUseAllow(
      `Continue in non-production merge mode: '${baseBranch}' is outside production branch policy.`
    )
  }

  // If we are merging into a production branch, check if the PR is approved/ready.
  const prStatus = await getPrMergeability(prNumber, cwd)

  if (prStatus.mergeable) {
    return preToolUseAllow(
      `Continue in approved-production-merge mode: PR #${prNumber} is approved and mergeable (${prStatus.statusContext}).`
    )
  }

  const prRef = prNumber ? `PR #${prNumber}` : "this PR"
  const repoContext = buildRepoContext(isCollaborative, collaboration.signals)

  return preToolUseDeny(`
Merging ${prRef} via \`gh pr merge\` is currently blocked in ${repoContext}

The PR is not in a fully approved, mergeable state (${prStatus.statusContext}).
\`gh pr merge\` directly to '${baseBranch}' is restricted to approved PRs.

Allowed merge paths:
  1. Wait for required CI checks and reviews to finish, then rerun \`gh pr merge\`
  2. Merge via the GitHub web UI after required reviews are approved
  3. Use auto-merge if branch protection requires it: gh pr merge ${prNumber} --auto --squash

Repository: ${owner}/${repo}
`)
}

async function handlePushMatch(
  pushMatch: RegExpMatchArray,
  cwd: string,
  defaultBranch: string
): Promise<SwizHookOutput | null> {
  const checkedOutBranch = await git(["branch", "--show-current"], cwd)
  const currentBranch = checkedOutBranch || pushMatch[1]!

  if (!isDefaultBranch(currentBranch, defaultBranch)) return null

  const remoteRef = `origin/${currentBranch}`
  const diffRange = await resolveDiffRange(cwd, remoteRef)
  const fork = await detectForkTopology(cwd)

  if (!diffRange) {
    return preToolUseDeny(`
Push blocked: could not determine diff range for change analysis.

No valid comparison ref found (tried origin/${currentBranch}, merge-base, HEAD~N, local history).
This typically means the repository has only one commit and no remote tracking branch.

Remediation:
  1. Verify the remote is configured: git remote -v
  2. Fetch remote refs: git fetch origin
  3. If this is the initial push, use a feature branch:
     git checkout -b feat/description && ${forkPushCmd("feat/description", fork)} && ${forkPrCreateCmd(currentBranch, fork)}
`)
  }

  const diffStat = await git(["diff", diffRange, "--stat"], cwd)
  const diffFiles = await git(["diff", "--name-only", diffRange], cwd)
  const changedFiles = diffFiles.trim().split("\n").filter(Boolean)

  const projectSettings = await readProjectSettings(cwd)
  const policy = resolvePolicy(projectSettings)

  const {
    statParsingFailed,
    isTrivial,
    isDocsOnly,
    scopeDescription,
    fileCount,
    totalLinesChanged,
  } = classifyChangeScope(parseGitStatSummary(diffStat), changedFiles, {
    trivialMaxFiles: policy.trivialMaxFiles,
    trivialMaxLines: policy.trivialMaxLines,
  })

  const collaboration = await detectProjectCollaborationPolicy(cwd)
  const owner = collaboration.repoOwner
  const repo = collaboration.repoName
  if (!owner || !repo) return null
  const isCollaborative = collaboration.isCollaborative

  const globalSettings = await readSwizSettings()
  const effectiveSettings = getEffectiveSwizSettings(globalSettings, null, projectSettings)
  const strictMode = effectiveSettings.strictNoDirectMain

  const policyResult = checkScopeAndPolicy({
    isCollaborative,
    strictMode,
    isDocsOnly,
    isTrivial,
    scopeDescription,
    fileCount,
    totalLinesChanged,
    defaultBranch,
  })
  if (policyResult) return policyResult

  if (statParsingFailed) {
    return preToolUseDeny(`
Push blocked: git diff --stat could not be parsed, but ${changedFiles.length} file(s) were detected via --name-only.

Scope: ${scopeDescription}
Repository: ${owner}/${repo}
Detected files:
${changedFiles.map((f) => `  - ${f}`).join("\n")}

This is a fail-closed guard — when change scope cannot be determined, the push is blocked to prevent unreviewed changes.

Remediation:
  1. Run: git diff --stat origin/${currentBranch}..HEAD
  2. Verify the output shows a summary line (e.g. "3 files changed, 10 insertions(+)")
  3. If the summary is missing or malformed, check for binary-only or rename-only changes
  4. If this is a false positive, use a feature branch instead:
     git checkout -b feat/description && ${forkPushCmd("feat/description", fork)} && ${forkPrCreateCmd(currentBranch, fork)}
`)
  }

  return preToolUseDeny(
    buildPushDenialReason({
      scopeDescription,
      fileCount,
      totalLinesChanged,
      owner,
      repo,
      defaultBranch,
      repoContext: buildRepoContext(isCollaborative, collaboration.signals),
      fork,
    })
  )
}

export async function evaluatePretooluseMainBranchScopeGate(
  input: unknown
): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input) as ToolHookInput
  if (!hookInput.tool_name || !isShellTool(hookInput.tool_name)) return {}

  const { command, cwd } = getCommandAndCwd(hookInput)

  const trunkModeSettings = await readProjectSettings(cwd)
  if (trunkModeSettings?.trunkMode) {
    return preToolUseAllow(
      "Continue in trunk-mode push policy: direct pushes to the default branch are allowed."
    )
  }

  const defaultBranch = await getDefaultBranch(cwd)

  const pushToDefaultRe = new RegExp(
    `\\bgit\\s+${GIT_GLOBAL_OPTS}push\\s+(?:-\\w+\\s+)*origin\\s+(${escapeRegex(defaultBranch)})\\b`
  )

  const pushMatch = command.match(pushToDefaultRe)
  if (pushMatch) {
    const result = await handlePushMatch(pushMatch, cwd, defaultBranch)
    if (result) return result
  }

  const prMergeMatch = GH_PR_MERGE_RE.test(command)
  if (prMergeMatch) {
    const result = await handlePrMerge(command, cwd, defaultBranch)
    if (result) return result
  }

  return {}
}

const pretooluseMainBranchScopeGate: SwizToolHook = {
  name: "pretooluse-main-branch-scope-gate",
  event: "preToolUse",
  timeout: 10,
  run(input) {
    return evaluatePretooluseMainBranchScopeGate(input)
  },
}

export default pretooluseMainBranchScopeGate

if (import.meta.main) {
  await runSwizHookAsMain(pretooluseMainBranchScopeGate)
}
