export interface GitContextMessageStatus {
  branch: string
  total: number
  modified: number
  added: number
  deleted: number
  untracked: number
  lines: string[]
  ahead: number
  behind: number
  upstream: string | null
  upstreamGone: boolean
}

export interface BranchStateSettings {
  trunkMode: boolean
  strictNoDirectMain: boolean
  collaborationMode: string
}

export interface GitContextLineOptions {
  collaborationMode?: string
  trunkMode?: boolean
  strictNoDirectMain?: boolean
  defaultBranch?: string
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function thisThese(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? `this ${singular}` : `these ${pluralForm}`
}

function describeUpstream(upstream: string | null, upstreamGone: boolean): string {
  if (upstreamGone) {
    return [
      `, and upstream ${upstream} is gone.`,
      "We should choose a new upstream or push this branch again.",
    ].join(" ")
  }
  if (upstream) return ` tracking ${upstream}.`
  return " with no upstream. We should set an upstream before relying on push or pull status."
}

function describeWorkingTree(uncommitted: number): string {
  if (uncommitted === 0) return " The working tree is clean."
  return [
    ` ${plural(uncommitted, "uncommitted file")}.`,
    "We should commit these uncommitted changes before switching context or stopping.",
  ].join(" ")
}

function describeSyncState(ahead: number, behind: number): string {
  if (ahead > 0 && behind > 0) {
    return [
      ` Branch has diverged: ${plural(ahead, "local commit")} not pushed`,
      `and ${plural(behind, "remote commit")} not pulled.`,
      "We should pull or rebase, resolve any conflicts, then push.",
    ].join(" ")
  }
  if (ahead > 0) {
    return ` ${plural(ahead, "commit")} not yet pushed. We should push ${thisThese(ahead, "commit")}.`
  }
  if (behind > 0) {
    return ` ${plural(behind, "commit")} behind remote. We should pull or rebase before pushing.`
  }
  return ""
}

export function normalizeCommitSummary(line: string): string {
  return line.replace(/\s+/g, " ").trim()
}

function describeUnpushedCommitSummaries(ahead: number, summaries: string[] = []): string {
  if (ahead <= 0 || summaries.length === 0) return ""
  const visible = summaries.map(normalizeCommitSummary).filter(Boolean).slice(0, 3)
  if (visible.length === 0) return ""
  const remaining = Math.max(0, ahead - visible.length)
  const suffix = remaining > 0 ? `; +${remaining} more` : ""
  return ` Unpushed commits: ${visible.join("; ")}${suffix}.`
}

function normalizeGitContextLineOptions(
  input: string | GitContextLineOptions | undefined
): GitContextLineOptions {
  if (typeof input === "string") return { collaborationMode: input }
  return input ?? {}
}

function describeBranchWorkflow(options: GitContextLineOptions): string {
  const defaultBranch = options.defaultBranch ?? "the default branch"

  if (options.trunkMode && options.strictNoDirectMain) {
    return "Trunk mode and strict no-direct-main are both enabled; we should resolve that workflow conflict before pushing."
  }
  if (options.trunkMode) {
    return `Trunk mode is active: keep work on ${defaultBranch} and push directly when ready.`
  }
  if (options.strictNoDirectMain) {
    return `Strict no-direct-main is active: use a feature branch and PR before pushing to ${defaultBranch}.`
  }
  return ""
}

function describeCollaborationPolicy(options: GitContextLineOptions): string {
  const collaborationMode = options.collaborationMode ?? "auto"
  return collaborationMode === "auto" ? "" : `Collaboration mode: ${collaborationMode}.`
}

function describeTrunkBranchMismatch(branch: string, options: GitContextLineOptions): string {
  if (
    options.trunkMode &&
    branch !== "(detached)" &&
    options.defaultBranch &&
    branch !== options.defaultBranch
  ) {
    return `Current branch is ${branch}; trunk mode expects ${options.defaultBranch}.`
  }
  return ""
}

function describeWorkflowPolicy(branch: string, options: GitContextLineOptions): string {
  const parts = [
    describeBranchWorkflow(options),
    describeCollaborationPolicy(options),
    describeTrunkBranchMismatch(branch, options),
  ].filter(Boolean)

  return parts.length > 0 ? ` ${parts.join(" ")}` : ""
}

/** Warning displayed when the repository is in a detached HEAD state. */
export const DETACHED_HEAD_WARNING =
  "HEAD is detached, so new commits will not belong to a branch. We should create a branch with 'git switch -c <name>' or 'git checkout -b <name>' before committing work we need to keep."

/**
 * Single-line git summary for agent context (PostToolUse / status line style).
 * Produces constructive prose so the consuming model can parse it naturally.
 */
export function buildGitContextLine(
  gitStatus: GitContextMessageStatus,
  collabModeOrOptions: string | GitContextLineOptions = "auto",
  unpushedCommitSummaries: string[] = []
): string {
  const { branch, total: uncommitted, ahead, behind, upstream, upstreamGone } = gitStatus
  const options = normalizeGitContextLineOptions(collabModeOrOptions)

  let line = branch === "(detached)" ? "HEAD is detached" : `On branch ${branch}`
  line += describeUpstream(upstream, upstreamGone)
  line += describeWorkingTree(uncommitted)
  line += describeSyncState(ahead, behind)
  line += describeUnpushedCommitSummaries(ahead, unpushedCommitSummaries)

  if (branch === "(detached)") {
    line += ` ${DETACHED_HEAD_WARNING}`
  }

  line += describeWorkflowPolicy(branch, options)

  return line
}

export function buildBranchStateSystemMessage(
  gitStatus: GitContextMessageStatus,
  effective: BranchStateSettings
): string {
  const { branch, total: uncommitted, ahead, behind } = gitStatus
  const parts: string[] = []

  if (uncommitted > 0) {
    if (effective.trunkMode) {
      parts.push(
        `We should commit these ${plural(uncommitted, "uncommitted file")} directly to ${branch} with /commit; trunk mode is active.`
      )
    } else if (effective.strictNoDirectMain && (branch === "main" || branch === "master")) {
      parts.push(
        `We should move these ${plural(uncommitted, "uncommitted file")} onto a feature branch and open a PR; strictNoDirectMain is enabled on ${branch}.`
      )
    } else {
      parts.push(
        `We should commit these ${plural(uncommitted, "uncommitted file")} with /commit before switching branches or stopping.`
      )
    }
  }

  if (ahead > 0) {
    if (effective.collaborationMode === "team") {
      parts.push(
        `We should open a PR for these ${plural(ahead, "local commit")}; team collaboration mode does not expect a direct push.`
      )
    } else if (effective.trunkMode) {
      parts.push(`We should push ${thisThese(ahead, "commit")} to ${branch} with /push.`)
    } else {
      parts.push(`We should push ${thisThese(ahead, "commit")} with /push when ready.`)
    }
  }

  if (behind > 0) {
    parts.push(
      `We should pull or rebase the ${plural(behind, "remote commit")} before pushing. If conflicts appear, resolve them before continuing.`
    )
  }

  return parts.join(" ")
}

export function buildConstructiveGitSummary(
  gitStatus: GitContextMessageStatus,
  upstream: string
): string {
  const { total, ahead, behind, branch } = gitStatus
  const parts: string[] = []

  if (total > 0) {
    parts.push(`We should commit these ${plural(total, "uncommitted change")} before stopping.`)
  }

  if (ahead > 0 && behind > 0) {
    parts.push(
      `Branch '${branch}' has local commits and remote commits out of sync with '${upstream}'. We should pull or rebase, resolve any conflicts, then push.`
    )
  } else if (behind > 0) {
    parts.push(
      `Branch '${branch}' is behind '${upstream}'. We should pull or rebase before pushing.`
    )
  } else if (ahead > 0) {
    parts.push(`We should push ${thisThese(ahead, "commit")} to '${upstream}'.`)
  }

  return parts.join(" ")
}

export function buildUncommittedReason(
  status: GitContextMessageStatus,
  upstream: string,
  behind: number
): string {
  const { total, modified, added, deleted, untracked, lines, branch } = status

  const summary = [
    modified > 0 ? `${modified} modified` : "",
    added > 0 ? `${added} added` : "",
    deleted > 0 ? `${deleted} deleted` : "",
    untracked > 0 ? `${untracked} untracked` : "",
  ]
    .filter(Boolean)
    .join(", ")

  let reason = `Uncommitted changes detected: ${summary} (${total} file(s))\n\n`
  reason += "Files with changes:\n"
  reason += lines
    .slice(0, 20)
    .map((l) => `  ${l}`)
    .join("\n")
  if (total > 20) reason += `\n  ... and ${total - 20} more file(s)`
  reason += "\n\n"

  if (behind > 0) {
    reason += `Note: branch '${branch}' is also ${behind} commit(s) behind '${upstream}' - after committing you will need to pull before pushing.\n\n`
  }

  return reason
}

export function describeRemoteState(
  branch: string,
  upstream: string,
  ahead: number,
  behind: number
): string {
  if (behind > 0 && ahead > 0) {
    return (
      `Branch '${branch}' has diverged from '${upstream}'.\n` +
      `  ${ahead} local commit(s) not yet pushed\n` +
      `  ${behind} remote commit(s) not yet pulled\n\n`
    )
  }
  if (behind > 0) {
    return `Branch '${branch}' is ${behind} commit(s) behind '${upstream}'.\n\n`
  }
  return `Unpushed commits on branch '${branch}': ${ahead} commit(s) ahead of '${upstream}'.\n\n`
}

export function selectTaskSubject(hasUncommitted: boolean, ahead: number, behind: number): string {
  if (hasUncommitted && (ahead > 0 || behind > 0)) return "Commit changes and sync with remote"
  if (hasUncommitted) return "Commit uncommitted changes"
  if (behind > 0) return "Pull remote changes before pushing"
  return "Push branch to remote"
}

export function buildTaskDesc(opts: {
  cwd: string
  hasUncommitted: boolean
  branch: string
  upstream: string
  behind: number
  ahead: number
}): string {
  const { cwd, hasUncommitted, branch, upstream, behind, ahead } = opts
  return [
    hasUncommitted && `Git repository has uncommitted changes at ${cwd}.`,
    behind > 0 && `Branch '${branch}' is ${behind} commit(s) behind '${upstream}'.`,
    ahead > 0 && `Branch has ${ahead} unpushed commit(s) ahead of '${upstream}'.`,
    "Complete the action plan before stopping.",
  ]
    .filter(Boolean)
    .join(" ")
}
