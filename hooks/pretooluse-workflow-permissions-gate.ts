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

interface WorkflowPermissionEdit {
  cwd: string
  filePath: string
}

function getFilePath(toolInput: Record<string, string | undefined> | undefined): string {
  return (toolInput?.file_path ?? "").normalize("NFKC")
}

function getNewContent(toolInput: Record<string, string | undefined> | undefined): string {
  return (toolInput?.new_string ?? toolInput?.content ?? "").normalize("NFKC")
}

function isWorkflowFile(filePath: string): boolean {
  return /\.github\/workflows\/[^/]+\.ya?ml$/.test(filePath)
}

function getWorkflowPermissionEdit(rawInput: unknown): WorkflowPermissionEdit | null {
  const input = rawInput as Record<string, any>
  if (!isFileEditTool(String(input.tool_name ?? ""))) return null

  const toolInput = input.tool_input as Record<string, string | undefined> | undefined
  const filePath = getFilePath(toolInput)
  if (!filePath || !isWorkflowFile(filePath)) return null

  const newContent = getNewContent(toolInput)
  if (!/^\s*permissions\s*:/m.test(newContent)) return null
  return { cwd: (input.cwd as string | undefined) ?? process.cwd(), filePath }
}

const pretoolusWorkflowPermissionsGate: SwizHook = {
  name: "pretooluse-workflow-permissions-gate",
  event: "preToolUse",
  matcher: "Edit|Write",
  timeout: 5,

  async run(rawInput) {
    const edit = getWorkflowPermissionEdit(rawInput)
    if (!edit) return {}
    const currentBranch = await git(["branch", "--show-current"], edit.cwd)
    if (!currentBranch) return {}

    const defaultBranch = await getDefaultBranch(edit.cwd)
    if (currentBranch === defaultBranch) {
      return preToolUseAllow(
        `Continue in default-branch workflow-permissions mode: permissions edits are approved only on '${defaultBranch}'.`
      )
    }

    return preToolUseDeny(buildPermissionsBlockMsg(edit.filePath, currentBranch, defaultBranch))
  },
}

function buildPermissionsBlockMsg(file: string, branch: string, defaultBranch: string): string {
  return [
    "Workflow permission change blocked on non-default branch.",
    "",
    `  File: ${file}`,
    `  Current branch: ${branch}`,
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
}

export default pretoolusWorkflowPermissionsGate

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolusWorkflowPermissionsGate)
