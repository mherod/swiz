#!/usr/bin/env bun

// PreToolUse hook: Block agent Bash commands that disable sandboxed-edits.
//
// The sandbox prevents agents from editing files outside the session project.
// An agent can trivially bypass it by running `swiz settings disable sandboxed-edits`.
// This hook denies that command unconditionally — the sandbox can only be
// disabled by the user directly at the terminal (where this hook never fires).
//
// Dual-mode: exports a SwizToolHook for inline dispatch and remains
// executable as a standalone script for backwards compatibility and testing.

import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { runSwizHookAsMain, type SwizToolHook } from "../src/SwizHook.ts"
import { isFileEditTool, isShellTool } from "../src/tool-matchers.ts"
import { preToolUseDeny } from "../src/utils/hook-utils.ts"
import { buildIssueGuidance, isSettingDisableCommand } from "../src/utils/inline-hook-helpers.ts"
import { isHiddenTopLevelHomePath, resolveCanonical } from "./sandbox-path-utils.ts"

// All recognised aliases for the sandboxedEdits setting
const SANDBOX_ALIASES = ["sandboxed-edits", "sandboxededits", "sandboxed_edits", "sandboxedEdits"]

// All recognised aliases for the trunkMode setting
const TRUNK_MODE_ALIASES = ["trunk-mode", "trunkmode", "trunk_mode", "trunkMode"]

// All recognised aliases for the personalRepoIssuesGate setting
const PERSONAL_ISSUES_ALIASES = [
  "personal-repo-issues-gate",
  "personalrepoissuesgate",
  "personal_repo_issues_gate",
  "personalRepoIssuesGate",
]

// Matches any JSON file directly inside a .swiz/ directory.
// Direct edits to these files bypass setting validation and schema enforcement,
// and can be used to disable sandbox protections — so we block them unconditionally,
// exactly as we block `swiz settings disable sandboxed-edits` shell commands.
const SWIZ_CONFIG_RE = /(?:^|[/\\])\.swiz[/\\][^/\\]+\.json$/

const COMMAND_SUBST_SWIZ_RE = /\$\((?:[^()]+|[\s\S]*?)\)\s*\/\.swiz\/[^\s"'`;|&]*/g
const BACKTICK_SUBST_SWIZ_RE = /`[^`]*`\s*\/\.swiz\/[^\s"'`;|&]*/g
const HOME_REFERENCE_RE =
  /\b(?:os\.)?homedir\s*\(\)|\bhomedir\s*\(\)|process\.env\.(?:HOME|USERPROFILE)|\$\{?HOME\}?/i
const PATH_BUILDER_RE = /\b(?:path\.)?(?:join|resolve)\s*\(/i
const SHELL_QUOTED_FRAGMENT_RE = /'([^']*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g

function isWithin(parent: string, child: string): boolean {
  const normalizedParent = parent.replace(/\\/g, "/")
  const normalizedChild = child.replace(/\\/g, "/")
  const normalizedPrefix = normalizedParent.endsWith("/")
    ? normalizedParent
    : `${normalizedParent}/`
  return normalizedChild === normalizedParent || normalizedChild.startsWith(normalizedPrefix)
}

function isPathLikeFragment(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\")
  )
}

function extractQuotedShellFragments(
  command: string,
  fragments = new Set<string>(),
  depth = 0
): string[] {
  if (depth > 4) return [...fragments]

  for (const match of command.matchAll(SHELL_QUOTED_FRAGMENT_RE)) {
    const fragment = (match[1] ?? match[2] ?? match[3] ?? "").trim()
    if (!fragment || fragments.has(fragment)) continue
    fragments.add(fragment)
    if (fragment.includes("'") || fragment.includes('"') || fragment.includes("`")) {
      extractQuotedShellFragments(fragment, fragments, depth + 1)
    }
  }

  return [...fragments]
}

async function normalizeShellPath(
  rawPath: string,
  cwd: string,
  homeDir: string
): Promise<string | null> {
  if (!rawPath) return null

  let value = rawPath.trim()
  if (!value) return null

  const commandSubstitutionMatch = value.match(/^\$\(([\s\S]*?)\)(.*)$/)
  if (commandSubstitutionMatch && /(?:\$\{?HOME\}?|~)/.test(commandSubstitutionMatch[1] ?? "")) {
    value = `${homeDir}${commandSubstitutionMatch[2] ?? ""}`
  }

  const backtickSubstitutionMatch = value.match(/^`([\s\S]*?)`(.*)$/)
  if (backtickSubstitutionMatch && /(?:\$\{?HOME\}?|~)/.test(backtickSubstitutionMatch[1] ?? "")) {
    value = `${homeDir}${backtickSubstitutionMatch[2] ?? ""}`
  }

  value = value.replace(/^[`"']+|[`"'`]+$/g, "")

  value = value
    .replace(/^\$HOME\//, `${homeDir}/`)
    .replace(/^\$\{HOME\}\//, `${homeDir}/`)
    .replace(/^\$\(HOME\)\//, `${homeDir}/`)

  if (isAbsolute(value) || value.startsWith("/")) return await resolveCanonical(value)
  if (value.startsWith("~")) return await resolveCanonical(join(homeDir, value.slice(2)))
  if (value.startsWith(".") || value === "") return await resolveCanonical(resolve(cwd, value))

  // Relative paths without dot prefix (e.g. `package.json`) stay relative
  // to the current command cwd, but they cannot point at top-level hidden home
  // entries, so they are irrelevant for this check.
  return null
}

async function isHiddenHomePathInCommand(
  rawPath: string,
  cwd: string,
  homeDir: string
): Promise<boolean> {
  const resolved = await normalizeShellPath(rawPath, cwd, homeDir)
  if (!resolved) return false
  if (!isHiddenTopLevelHomePath(resolved, homeDir)) return false

  const normalizedCwd = cwd.replace(/\\/g, "/")
  const normalizedHome = homeDir.replace(/\\/g, "/").replace(/\/$/, "")
  const normalizedResolved = resolved.replace(/\\/g, "/")
  const hiddenRoot = `${normalizedHome}/${normalizedResolved.slice(normalizedHome.length + 1).split("/")[0]}`

  return !isWithin(hiddenRoot, normalizedCwd)
}

async function shouldBlockShellCommand(command: string, cwd: string): Promise<string | null> {
  const homeDir = homedir()
  if (!homeDir || !command) return null
  const canonicalHomeDir = await resolveCanonical(homeDir)
  const canonicalCwd = await resolveCanonical(cwd)
  const hasHomeReference = HOME_REFERENCE_RE.test(command)
  const hasPathBuilder = PATH_BUILDER_RE.test(command)

  const tokens = command.match(/[^\s]+/g) ?? []
  const candidates = new Set<string>([
    ...tokens,
    ...Array.from(command.matchAll(COMMAND_SUBST_SWIZ_RE)).map((m) => m[0]!),
    ...Array.from(command.matchAll(BACKTICK_SUBST_SWIZ_RE)).map((m) => m[0]!),
  ])
  for (const fragment of extractQuotedShellFragments(command)) {
    if (!isPathLikeFragment(fragment)) continue
    if (fragment.startsWith(".") && !hasPathBuilder) continue
    candidates.add(fragment)
  }
  const seen = new Set<string>()

  for (const rawToken of candidates) {
    const token = rawToken.replace(/^[{}()]+|[;|&(){};]+$/g, "")
    if (!token) continue
    if (token.startsWith("-")) continue

    const assignmentSplit = token.split("=")
    const candidates = assignmentSplit.length === 2 ? [assignmentSplit[1]!] : [token]

    for (const candidate of candidates) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      if (!candidate.includes("/") && !candidate.startsWith("~") && !candidate.startsWith("."))
        continue

      if (await isHiddenHomePathInCommand(candidate, canonicalCwd, canonicalHomeDir)) {
        return candidate
      }
      if (
        hasHomeReference &&
        hasPathBuilder &&
        (await isHiddenHomePathInCommand(candidate, canonicalHomeDir, canonicalHomeDir))
      ) {
        return candidate
      }
    }
  }

  return null
}

/**
 * Returns true when the command attempts to disable the sandboxed-edits setting.
 * Matches both disable paths:
 *   swiz settings disable <alias>
 *   swiz settings set <alias> false
 */
export function isSandboxDisableCommand(command: string): boolean {
  return isSettingDisableCommand(command, SANDBOX_ALIASES)
}

/**
 * Returns true when the command attempts to disable the trunk-mode setting.
 */
export function isTrunkModeDisableCommand(command: string): boolean {
  return isSettingDisableCommand(command, TRUNK_MODE_ALIASES)
}

/**
 * Returns true when the command attempts to disable the personalRepoIssuesGate setting.
 */
export function isPersonalIssuesGateDisableCommand(command: string): boolean {
  return isSettingDisableCommand(command, PERSONAL_ISSUES_ALIASES)
}

const pretoolUseProtectSandbox: SwizToolHook = {
  name: "pretooluse-protect-sandbox",
  event: "preToolUse",
  matcher: "Bash|Edit|Write|NotebookEdit",
  timeout: 5,

  async run(rawInput) {
    const input = rawInput as Record<string, any>
    const toolName: string = (input.tool_name as string) ?? ""
    const toolInput = input.tool_input as Record<string, string> | undefined

    if (isShellTool(toolName)) {
      const command: string = (toolInput?.command ?? "").normalize("NFKC")
      if (isSandboxDisableCommand(command)) {
        return preToolUseDeny(
          "Disabling sandboxed-edits is not permitted from agent Bash commands.\n\n" +
            "The sandbox can only be disabled by the user directly at the terminal.\n" +
            buildIssueGuidance(null)
        )
      }
      if (isTrunkModeDisableCommand(command)) {
        return preToolUseDeny(
          "Disabling trunk-mode is not permitted from agent Bash commands.\n\n" +
            "Trunk mode can only be disabled by the user directly at the terminal.\n" +
            buildIssueGuidance(null)
        )
      }
      if (isPersonalIssuesGateDisableCommand(command)) {
        return preToolUseDeny(
          "Disabling personalRepoIssuesGate is not permitted from agent Bash commands.\n\n" +
            "This gate can only be disabled by the user directly at the terminal.\n" +
            buildIssueGuidance(null)
        )
      }

      const blockedPath = await shouldBlockShellCommand(command, input.cwd ?? process.cwd())
      if (blockedPath) {
        const MEMORY_DIR_RE = /\.claude[/\\]projects[/\\][^/\\]+[/\\]memory[/\\]/
        if (MEMORY_DIR_RE.test(blockedPath)) {
          return preToolUseDeny(
            [
              "Shell commands referencing the memory directory are not permitted.",
              "",
              `  Attempted: ${blockedPath}`,
              "",
              "Use /update-memory to add session learnings to the project CLAUDE.md file instead.",
            ].join("\n")
          )
        }
        return preToolUseDeny(
          [
            "Hidden home-directory path references in shell commands are blocked under sandbox mode.",
            "",
            `  Attempted: ${blockedPath}`,
            "",
            "Use shell commands only on paths inside the current dispatch cwd unless that cwd is",
            "itself that hidden home path.",
          ].join("\n")
        )
      }
    }

    if (isFileEditTool(toolName)) {
      const filePath: string = (toolInput?.file_path ?? "").normalize("NFKC")
      if (SWIZ_CONFIG_RE.test(filePath)) {
        return preToolUseDeny(
          "Editing swiz config files directly is not permitted from agent file edits.\n\n" +
            "Use the swiz CLI instead:\n" +
            "  swiz settings set <key> <value>\n" +
            "  swiz settings enable <setting>\n" +
            "  swiz settings disable <setting>\n" +
            "  swiz state set <state>\n" +
            buildIssueGuidance(null)
        )
      }
    }

    return {}
  },
}

export default pretoolUseProtectSandbox

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolUseProtectSandbox)
