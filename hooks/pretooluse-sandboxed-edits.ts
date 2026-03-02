#!/usr/bin/env bun

// PreToolUse hook: Block file edits outside the session's cwd and temporary directories.
// Enabled by default; disable with: swiz settings disable sandboxed-edits

import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { readSwizSettings } from "../src/settings.ts"
import { denyPreToolUse, isFileEditTool, type ToolHookInput } from "./hook-utils.ts"

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
  ].join("\n")
)
