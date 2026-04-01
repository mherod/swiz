#!/usr/bin/env bun

// PreToolUse hook: Enforce scope-based push policy for the default branch.
// Classifies changes as trivial (typos, small fixes, docs) or non-trivial (features, refactors).
// Blocks non-trivial work on the default branch in collaborative repositories.
// Trivial work is allowed directly to the default branch in solo projects.
//
// Dual-mode: SwizToolHook + runSwizHookAsMain.

import { detectProjectCollaborationPolicy } from "../src/collaboration-policy.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
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
  git,
  isDefaultBranch,
  isShellTool,
  parseGitStatSummary,
  type ToolHookInput,
} from "../src/utils/hook-utils.ts"
import { escapeRegex, GIT_GLOBAL_OPTS } from "../src/utils/shell-patterns.ts"
import { toolHookInputSchema } from "./schemas.ts"

export async function evaluatePretooluseMainBranchScopeGate(
  input: unknown
): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input) as ToolHookInput
  if (!isShellTool(hookInput.tool_name ?? "")) return {}

  const command: string = (hookInput.tool_input?.command as string) ?? ""
  const cwd: string = hookInput.cwd ?? (hookInput.tool_input?.cwd as string) ?? process.cwd()

  const trunkModeSettings = await readProjectSettings(cwd)
  if (trunkModeSettings?.trunkMode) {
    return preToolUseAllow("Trunk mode enabled — direct push to default branch allowed")
  }

  const defaultBranch = await getDefaultBranch(cwd)

  const pushToDefaultRe = new RegExp(
    `\\bgit\\s+${GIT_GLOBAL_OPTS}push\\s+(?:-\\w+\\s+)*origin\\s+(${escapeRegex(defaultBranch)})\\b`
  )
  const pushMatch = command.match(pushToDefaultRe)
  const prMergeMatch = GH_PR_MERGE_RE.test(command)

  if (!pushMatch && !prMergeMatch) return {}

  if (prMergeMatch) {
    const collaboration = await detectProjectCollaborationPolicy(cwd)
    const owner = collaboration.repoOwner
    const repo = collaboration.repoName
    if (!owner || !repo) return {}
    const isCollaborative = collaboration.isCollaborative
    const globalSettings = await readSwizSettings()
    const effectiveSettings = getEffectiveSwizSettings(
      globalSettings,
      null,
      await readProjectSettings(cwd)
    )
    const strictMode = effectiveSettings.strictNoDirectMain

    if (!isCollaborative && !strictMode) return {}

    const prNumber = extractPrNumber(command)
    const prRef = prNumber ? `PR #${prNumber}` : "this PR"
    const repoContext = isCollaborative
      ? `a collaborative repository.\n\nCollaboration signals:\n${collaboration.signals.map((s) => `  - ${s}`).join("\n")}`
      : `a solo repository with strict-no-direct-main enabled.\n\n  To disable strict mode: swiz settings disable strict-no-direct-main`

    return preToolUseDeny(`
Merging ${prRef} via \`gh pr merge\` is blocked in ${repoContext}

\`gh pr merge\` lands code directly on '${defaultBranch}', bypassing the intended review workflow.

Allowed merge paths:
  1. Merge via the GitHub web UI after required reviews are approved
  2. Wait for an authorized human to merge the PR
  3. Use auto-merge if branch protection requires it: gh pr merge ${prNumber ?? "<number>"} --auto --squash

Repository: ${owner}/${repo}
`)
  }

  const checkedOutBranch = await git(["branch", "--show-current"], cwd)
  const targetBranch = pushMatch![1]!
  const currentBranch = checkedOutBranch || targetBranch

  if (!isDefaultBranch(currentBranch, defaultBranch)) return {}

  const remoteRef = `origin/${currentBranch}`

  async function resolveDiffRange(): Promise<string> {
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

  const diffRange = await resolveDiffRange()
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
  if (!owner || !repo) return {}
  const isCollaborative = collaboration.isCollaborative

  const globalSettings = await readSwizSettings()
  const effectiveSettings = getEffectiveSwizSettings(globalSettings, null, projectSettings)
  const strictMode = effectiveSettings.strictNoDirectMain

  if (!isCollaborative && !strictMode) {
    return preToolUseAllow(
      `Solo repo without strict mode — push to '${defaultBranch}' allowed (${scopeDescription})`
    )
  }

  if (isDocsOnly || isTrivial) {
    return preToolUseAllow(
      `Scope is ${scopeDescription} (${fileCount} files, ${totalLinesChanged} lines) — allowed on '${defaultBranch}'`
    )
  }

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

  const repoContext = isCollaborative
    ? `a collaborative repository.\n\nCollaboration signals:\n${collaboration.signals.map((s) => `  - ${s}`).join("\n")}`
    : `a solo repository with strict-no-direct-main enabled.\n\n  To disable strict mode: swiz settings disable strict-no-direct-main`

  const reason = `
Non-trivial changes to '${defaultBranch}' in ${repoContext}

Change scope: ${scopeDescription} (${fileCount} files, ${totalLinesChanged} lines)
Repository: ${owner}/${repo}

For substantive work, use the feature branch workflow:
  1. Create a feature branch: git checkout -b feat/description
  2. Push: ${forkPushCmd("feat/description", fork)}
  3. Open PR: ${forkPrCreateCmd(defaultBranch, fork)}
  4. Wait for review and approval
  5. Merge via PR (not direct push)

This ensures code review, CI validation, and team coordination.
`

  return preToolUseDeny(reason)
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
