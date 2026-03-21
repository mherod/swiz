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

import { fileEditHookInputSchema } from "./schemas.ts"
import {
  allowPreToolUse,
  denyPreToolUse,
  getDefaultBranch,
  git,
  isFileEditTool,
} from "./utils/hook-utils.ts"

const input = fileEditHookInputSchema.parse(await Bun.stdin.json())

if (!isFileEditTool(input.tool_name ?? "")) process.exit(0)

const filePath: string = (input.tool_input?.file_path as string | undefined) ?? ""
if (!filePath) process.exit(0)

// Only check .github/workflows/ YAML files
const workflowPathRe = /\.github\/workflows\/[^/]+\.ya?ml$/
if (!workflowPathRe.test(filePath)) process.exit(0)

// Get the new content being written — Edit uses new_string, Write uses content
// NFKC normalization handled by fileEditHookInputSchema.transform()
const newContent: string = input.tool_input?.new_string ?? input.tool_input?.content ?? ""

// Check if the new content contains a permissions: keyword
// Match both top-level `permissions:` and job-level `permissions:` in YAML
const permissionsRe = /^\s*permissions\s*:/m
if (!permissionsRe.test(newContent)) process.exit(0)

// Determine current and default branches
const cwd = input.cwd ?? process.cwd()
const currentBranch = await git(["branch", "--show-current"], cwd)
if (!currentBranch) process.exit(0) // Detached HEAD or not a git repo — allow

const defaultBranch = await getDefaultBranch(cwd)

// On default branch — allow (direct pushes to main are gated by other hooks)
if (currentBranch === defaultBranch) {
  allowPreToolUse(`Workflow permissions edit on default branch '${defaultBranch}' — allowed`)
}

denyPreToolUse(
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
