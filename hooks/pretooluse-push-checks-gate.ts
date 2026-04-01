#!/usr/bin/env bun

// PreToolUse hook: Advise on branch/PR/collaboration checks before `git push`.
//
// Hard blocks:
//   0. Behind-remote check — blocks if remote has commits local doesn't have;
//      advises `git pull --rebase --autostash` and /resolve-conflicts skill.
//
// Advisory (surfaced as context if missing):
//   1. Branch check  — `git branch` (confirms current branch)
//   2. PR check      — `gh pr list ... --head` (checks for open PR on branch)
//
// Rationale: pushing without these checks risks pushing large work directly
// to main in a collaborative repo, or creating duplicate PRs.
//
// Dual-mode: SwizToolHook + runSwizHookAsMain.

import { getCollaborationModePolicy } from "../src/collaboration-policy.ts"
import { runSwizHookAsMain } from "../src/RunSwizHookAsMain.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  type SwizHookOutput,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { getEffectiveSwizSettings, readProjectSettings, readSwizSettings } from "../src/settings.ts"
import {
  BRANCH_CHECK_RE,
  CI_WAIT_RE,
  detectForkTopology,
  extractBashCommands,
  formatActionPlan,
  GIT_PUSH_DELETE_RE,
  GIT_PUSH_RE,
  git,
  isShellTool,
  PR_CHECK_RE,
  skillAdvice,
} from "../src/utils/hook-utils.ts"
import { spawnWithTimeout } from "../src/utils/process-utils.ts"
import { toolHookInputSchema } from "./schemas.ts"

export async function evaluatePretoolusePushChecksGate(input: unknown): Promise<SwizHookOutput> {
  const hookInput = toolHookInputSchema.parse(input)
  if (!isShellTool(hookInput.tool_name ?? "")) return {}

  const command: string = (hookInput.tool_input?.command as string) ?? ""

  if (!GIT_PUSH_RE.test(command) || GIT_PUSH_DELETE_RE.test(command)) return {}

  const transcriptPath: string = hookInput.transcript_path ?? ""
  if (!transcriptPath) return {}

  const cwd: string = (hookInput.tool_input?.cwd as string) ?? hookInput.cwd ?? process.cwd()

  const behindResult = await spawnWithTimeout(["git", "rev-list", "--count", "HEAD..@{upstream}"], {
    cwd,
    timeoutMs: 5000,
  })
  const behindCount = parseInt(behindResult.stdout.trim(), 10)

  if (!Number.isNaN(behindCount) && behindCount > 0) {
    const conflictAdvice = skillAdvice(
      "resolve-conflicts",
      "If rebase produces merge conflicts, use the /resolve-conflicts skill to resolve them before pushing.",
      "If rebase produces merge conflicts, resolve them with `git add <file>` and `git rebase --continue`, or abort with `git rebase --abort`."
    )

    return await preToolUseDeny(
      `Remote is ahead by ${behindCount} commit${behindCount === 1 ? "" : "s"} — pull before pushing.\n\n` +
        `Run: \`git pull --rebase --autostash\`\n\n` +
        conflictAdvice
    )
  }

  const forkTopology = await detectForkTopology(cwd)

  if (forkTopology && !forkTopology.hasUpstreamRemote) {
    return preToolUseAllow(
      `Fork detected — \`origin\` is a fork of \`${forkTopology.upstreamSlug}\`.\n\n` +
        `Set up the upstream remote for sync:\n` +
        `  git remote add upstream https://github.com/${forkTopology.upstreamSlug}.git\n` +
        `  git fetch upstream\n\n` +
        `After pushing, open a PR against upstream:\n` +
        `  gh pr create --repo ${forkTopology.upstreamSlug}`
    )
  }

  const WIP_SUBJECT_RE = /^(wip[:\s]|fixup!|squash!)/i

  const subjectsResult = await spawnWithTimeout(
    ["git", "log", "@{upstream}..HEAD", "--format=%s"],
    {
      cwd,
      timeoutMs: 5000,
    }
  )

  if (subjectsResult.exitCode === 0 && subjectsResult.stdout.trim()) {
    const subjects = subjectsResult.stdout.trim().split("\n")
    const offending = subjects.filter((s) => WIP_SUBJECT_RE.test(s))

    if (offending.length > 0) {
      return await preToolUseDeny(
        `Push blocked — outgoing commits contain temporary subjects that must be squashed first.\n\n` +
          `Offending commits:\n` +
          offending.map((s) => `  • ${s}`).join("\n") +
          `\n\nRun: \`git rebase -i --autosquash @{upstream}\` to clean up before pushing.`
      )
    }
  }

  const [diffResult, fileNamesResult, priorCommandsResult, globalSettings, projectSettings] =
    await Promise.all([
      spawnWithTimeout(["git", "diff", "@{upstream}..HEAD"], { cwd, timeoutMs: 10000 }),
      spawnWithTimeout(["git", "diff", "--name-only", "@{upstream}..HEAD"], {
        cwd,
        timeoutMs: 5000,
      }),
      extractBashCommands(transcriptPath),
      readSwizSettings(),
      readProjectSettings(cwd),
    ])

  const effectiveSettingsEarly = getEffectiveSwizSettings(globalSettings, null, projectSettings)

  if (!effectiveSettingsEarly.skipSecretScan && diffResult.exitCode === 0 && diffResult.stdout) {
    const addedLines = diffResult.stdout
      .split("\n")
      .filter((l) => !l.startsWith("-") || l.startsWith("---"))

    const PEM_HEADER = /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/
    const API_KEY_PREFIXES = new RegExp(
      [
        "sk-live-[A-Za-z0-9]{20,}",
        "sk-proj-[A-Za-z0-9]{20,}",
        "ghp_[A-Za-z0-9]{36,}",
        "gho_[A-Za-z0-9]{36,}",
        "ghs_[A-Za-z0-9]{36,}",
        "AKIA[0-9A-Z]{16}",
      ].join("|")
    )

    const secretMatches: string[] = []
    for (const line of addedLines) {
      if (PEM_HEADER.test(line) || API_KEY_PREFIXES.test(line)) {
        secretMatches.push(line.slice(0, 80) + (line.length > 80 ? "…" : ""))
      }
    }

    if (secretMatches.length > 0) {
      return await preToolUseDeny(
        `Potential secret or credential detected in outgoing diff — push blocked.\n\n` +
          `Matching lines (truncated):\n` +
          secretMatches.map((l) => `  ${l}`).join("\n") +
          `\n\nInspect with \`git diff @{upstream}..HEAD\`, then:\n` +
          `  1. Remove the secret from the file\n` +
          `  2. Soft-reset to amend: \`git reset --soft HEAD~1\`\n` +
          `  3. Rotate the credential immediately — treat it as compromised\n\n` +
          `To disable this check: \`swiz settings enable skip-secret-scan\``
      )
    }
  }

  const largeFileWarnItems: string[] = []

  if (fileNamesResult.exitCode === 0 && fileNamesResult.stdout) {
    const warnThresholdKb = effectiveSettingsEarly.largeFileSizeKb
    const blockThresholdKb = effectiveSettingsEarly.largeFileSizeBlockKb
    const allowPatterns: string[] = projectSettings?.largeFileAllowPatterns ?? []

    function globToRegex(pattern: string): RegExp {
      return new RegExp(
        `^${pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "\u2B1B")
          .replace(/\*/g, "[^/]*")
          .replace(/\u2B1B/g, ".*")
          .replace(/\?/g, "[^/]")}$`
      )
    }

    function formatSize(bytes: number): string {
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      return `${Math.floor(bytes / 1024)} KB`
    }

    const changedFiles = fileNamesResult.stdout
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)

    const blockFiles: string[] = []

    await Promise.all(
      changedFiles.map(async (filePath) => {
        if (allowPatterns.some((p) => globToRegex(p).test(filePath))) return

        const treeEntry = await git(["ls-tree", "HEAD", "--", filePath], cwd)
        if (!treeEntry) return

        const blobHash = treeEntry.split(/\s+/)[2]
        if (!blobHash || blobHash === "0000000000000000000000000000000000000000") return

        const sizeStr = await git(["cat-file", "-s", blobHash], cwd)
        const sizeBytes = parseInt(sizeStr ?? "0", 10)
        if (Number.isNaN(sizeBytes) || sizeBytes === 0) return

        const sizeKb = sizeBytes / 1024
        const label = `${formatSize(sizeBytes)} — ${filePath}`

        if (sizeKb >= blockThresholdKb) {
          blockFiles.push(label)
        } else if (sizeKb >= warnThresholdKb) {
          largeFileWarnItems.push(`Large file advisory (>${warnThresholdKb} KB): ${label}`)
        }
      })
    )

    if (blockFiles.length > 0) {
      return await preToolUseDeny(
        `Large file(s) in outgoing batch exceed the ${blockThresholdKb} KB block threshold — push blocked.\n\n` +
          blockFiles.map((f) => `  ${f}`).join("\n") +
          `\n\nTo resolve:\n` +
          `  1. Add the file to .gitignore\n` +
          `  2. Soft-reset to remove it from history: \`git reset --soft HEAD~1\`\n` +
          `  3. Re-commit without the large file\n\n` +
          `To change the threshold: \`swiz settings set large-file-size-block-kb <N>\``
      )
    }
  }

  const priorCommands = priorCommandsResult
  const effectiveSettings = effectiveSettingsEarly
  const modePolicy = getCollaborationModePolicy(effectiveSettings.collaborationMode)

  const hasBranchCheck = priorCommands.some((c) => BRANCH_CHECK_RE.test(c))
  const hasPRCheck = priorCommands.some((c) => PR_CHECK_RE.test(c))
  const hasCICheck =
    effectiveSettings.ignoreCi || !modePolicy.prHooksActive
      ? true
      : priorCommands.some((c) => CI_WAIT_RE.test(c))

  if (hasBranchCheck && hasPRCheck && hasCICheck && largeFileWarnItems.length === 0) {
    return preToolUseAllow("All pre-push checks found in transcript (branch, PR, CI)")
  }

  const missing: string[] = [...largeFileWarnItems]
  if (!hasBranchCheck) {
    missing.push("Branch check (not run yet): `git branch --show-current`")
  }
  if (!hasPRCheck) {
    missing.push(
      "Open-PR check (not run yet): " +
        "`gh pr list --state open --head $(git branch --show-current)`"
    )
  }
  if (!hasCICheck) {
    missing.push(
      `CI check (not run yet, required for ${effectiveSettings.collaborationMode} mode): ` +
        "`swiz ci-wait $(git rev-parse HEAD) --timeout 300`"
    )
  }

  return preToolUseAllow(
    `Advisory: some pre-push checks are missing.\n\n` +
      formatActionPlan(missing, {
        header: "The following checks have not been run in this session:",
      }) +
      `\n\nConsider running these checks to avoid pushing large work directly\n` +
      `to main in a collaborative repo, or creating duplicate PRs.`
  )
}

const pretoolusePushChecksGate: SwizToolHook = {
  name: "pretooluse-push-checks-gate",
  event: "preToolUse",
  timeout: 5,
  run(input) {
    return evaluatePretoolusePushChecksGate(input)
  },
}

export default pretoolusePushChecksGate

if (import.meta.main) {
  await runSwizHookAsMain(pretoolusePushChecksGate)
}
