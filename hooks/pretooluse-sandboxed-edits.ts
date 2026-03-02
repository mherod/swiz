#!/usr/bin/env bun

// PreToolUse hook: Block file edits outside the session's cwd and temporary directories.
// Enabled by default; disable with: swiz settings disable sandboxed-edits

import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { readSwizSettings } from "../src/settings.ts"
import { denyPreToolUse, git, isFileEditTool, type ToolHookInput } from "./hook-utils.ts"

const input = (await Bun.stdin.json()) as ToolHookInput

if (!isFileEditTool(input.tool_name ?? "")) process.exit(0)

const filePath: string = (input.tool_input?.file_path as string | undefined) ?? ""
if (!filePath) process.exit(0)

const settings = await readSwizSettings()
if (!settings.sandboxedEdits) process.exit(0)

const cwd = resolve(input.cwd ?? process.cwd())
const target = resolve(filePath)

function isWithin(parent: string, child: string): boolean {
  const prefix = parent.endsWith("/") ? parent : parent + "/"
  return child === parent || child.startsWith(prefix)
}

const tmp = tmpdir()
const allowedRoots = [cwd, tmp, "/tmp"]

if (allowedRoots.some((root) => isWithin(root, target))) process.exit(0)

// Discover if the blocked path lives inside a different GitHub repo.
// Walk up from dirname(target) to find the nearest existing directory —
// the target file may not exist yet (new file creation).
let targetDir = dirname(target)
{
  const { stat } = await import("node:fs/promises")
  while (targetDir !== dirname(targetDir)) {
    try {
      await stat(targetDir)
      break
    } catch {
      targetDir = dirname(targetDir)
    }
  }
}
const repoRoot = await git(["rev-parse", "--show-toplevel"], targetDir)
let crossRepoHint = ""
if (repoRoot && repoRoot !== cwd) {
  const remoteUrl = await git(["remote", "get-url", "origin"], repoRoot)
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^\s.]+?)(?:\.git)?$/)
  if (match?.[1]) {
    const slug = match[1]
    crossRepoHint = [
      "",
      `The blocked path is inside a different repository: ${slug}`,
      "If this change is needed, consider filing an issue there so the repo can triage it:",
      `  gh issue create --repo ${slug} --title "..." --body "..."`,
    ].join("\n")
  }
}

denyPreToolUse(
  [
    "File edit blocked: path is outside the session sandbox.",
    "",
    `  Attempted: ${target}`,
    `  Session cwd: ${cwd}`,
    "",
    "Only edits within the current project directory or temporary directories are allowed.",
    "If you need to edit a file outside the project, disable the sandbox:",
    "  swiz settings disable sandboxed-edits",
    crossRepoHint,
  ]
    .filter(Boolean)
    .join("\n")
)
