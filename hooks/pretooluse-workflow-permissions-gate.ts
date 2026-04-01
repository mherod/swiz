#!/usr/bin/env bun

// PreToolUse hook: Block changes to `permissions:` blocks in GitHub Actions
// workflow files when working on a non-default branch.
//
// GitHub Actions security model: workflow permission changes made in a PR branch
// do NOT take effect until merged to the default branch. This creates a blind spot
// where elevated permissions appear inert during PR review but silently activate
// upon merge.
//
// This hook prevents accidental privilege escalation by blocking permission edits
// on feature branches with an explanatory message.
//
// Dual-mode: exports a SwizHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { git } from "../src/git-helpers.ts"
import {
  preToolUseAllow,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizHook,
} from "../src/SwizHook.ts"
import { isFileEditTool } from "../src/tool-matchers.ts"
import { getDefaultBranch } from "../src/utils/git-utils.ts"

const pretoolusWorkflowPermissionsGate: SwizHook = {
  name: "pretooluse-workflow-permissions-gate",
  event: "preToolUse",
  matcher: "Edit|Write",
  timeout: 5,

  async run(rawInput) {
    const input = rawInput as Record<string, any>
    if (!isFileEditTool(String(input.tool_name ?? ""))) return {}

    const toolInput = input.tool_input as Record<string, string | undefined> | undefined
    const filePath: string = (toolInput?.file_path ?? "").normalize("NFKC")
    if (!filePath) return {}

    // Only check .github/workflows/ YAML files
    const workflowPathRe = /\.github\/workflows\/[^/]+\.ya?ml$/
    if (!workflowPathRe.test(filePath)) return {}

    // Get the new content being written — Edit uses new_string, Write uses content
    const newContent: string = (toolInput?.new_string ?? toolInput?.content ?? "").normalize("NFKC")

    // Check if the new content contains a permissions: keyword
    const permissionsRe = /^\s*permissions\s*:/m
    if (!permissionsRe.test(newContent)) return {}

    // Determine current and default branches
    const cwd = (input.cwd as string | undefined) ?? process.cwd()
    const currentBranch = await git(["branch", "--show-current"], cwd)
    if (!currentBranch) return {} // Detached HEAD or not a git repo — allow

    const defaultBranch = await getDefaultBranch(cwd)

    // On default branch — allow (direct pushes to main are gated by other hooks)
    if (currentBranch === defaultBranch) {
      return preToolUseAllow(
        `Workflow permissions edit on default branch '${defaultBranch}' — allowed`
      )
    }

    return preToolUseDeny(
      [
        "Workflow permission change blocked on non-default branch.",
        "",
        `  File: ${filePath}`,
        `  Current branch: ${currentBranch}`,
        `  Default branch: ${defaultBranch}`,
        "",
        "GitHub Actions security model: workflow `permissions:` changes made in a",
        "PR branch do NOT take effect until merged to the default branch. This",
        "creates a dangerous blind spot:",
        "",
        "  1. The elevated permissions appear inert during PR CI (runs with",
        "     existing default-branch permissions)",
        "  2. Reviewers may not scrutinize the change since 'it didn't break anything'",
        "  3. Upon merge, the elevated permissions silently activate",
        "",
        "Instead of modifying workflow permissions:",
        "  - Use repository Settings → Actions → General → Workflow permissions",
        "  - Scope GITHUB_TOKEN in individual steps with `permissions:` on the default branch only",
        `  - If this change is intentional, make it directly on '${defaultBranch}'`,
      ].join("\n")
    )
  },
}

export default pretoolusWorkflowPermissionsGate

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusWorkflowPermissionsGate)
