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
import { detectCurrentAgentFromHookPayload } from "../src/agent-paths.ts"
import {
  preToolUseAllowWithContext,
  preToolUseDeny,
  runSwizHookAsMain,
  type SwizToolHook,
} from "../src/SwizHook.ts"
import { isFileEditTool, isShellTool } from "../src/tool-matchers.ts"
import { buildIssueGuidance, isSettingDisableCommand } from "../src/utils/inline-hook-helpers.ts"
import {
  buildProtectedTaskStorageDenyReason,
  isAllowedMarkdownShellReadCommand,
  isAllowedSharedSkillShellCommand,
  isAllowedTrashMoveCommand,
  isCodexHomePath,
  isHiddenTopLevelHomePath,
  isPathWithin,
  isProtectedTaskStoragePath,
  isSafeReadOnlyShellCommand,
  isSessionToolResultsPath,
  isSharedAgentsSkillPath,
  resolveCanonical,
  SAFE_READ_ONLY_INSPECTION_HINT,
} from "./sandbox-path-utils.ts"

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
const MEMORY_DIR_RE = /\.claude[/\\]projects[/\\][^/\\]+[/\\]memory[/\\]/

type BlockedShellPath =
  | { kind: "task-storage"; path: string }
  | { kind: "hidden-home"; path: string }
  | { kind: "markdown-read"; path: string }

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
    const fragment = firstQuotedFragment(match).trim()
    if (!fragment || fragments.has(fragment)) continue
    fragments.add(fragment)
    if (containsQuote(fragment)) {
      extractQuotedShellFragments(fragment, fragments, depth + 1)
    }
  }

  return [...fragments]
}

function firstQuotedFragment(match: RegExpMatchArray): string {
  return [match[1], match[2], match[3]].find((fragment) => fragment !== undefined) ?? ""
}

function containsQuote(value: string): boolean {
  return ["'", '"', "`"].some((quote) => value.includes(quote))
}

function expandHomeSubstitution(value: string, homeDir: string): string {
  const commandMatch = value.match(/^\$\(([\s\S]*?)\)(.*)$/)
  if (commandMatch && /(?:\$\{?HOME\}?|~)/.test(commandMatch[1] ?? "")) {
    return `${homeDir}${commandMatch[2] ?? ""}`
  }

  const backtickMatch = value.match(/^`([\s\S]*?)`(.*)$/)
  if (backtickMatch && /(?:\$\{?HOME\}?|~)/.test(backtickMatch[1] ?? "")) {
    return `${homeDir}${backtickMatch[2] ?? ""}`
  }
  return value
}

function expandHomePrefix(value: string, homeDir: string): string {
  return value
    .replace(/^\$HOME\//, `${homeDir}/`)
    .replace(/^\$\{HOME\}\//, `${homeDir}/`)
    .replace(/^\$\(HOME\)\//, `${homeDir}/`)
}

async function resolveNormalizedShellPath(
  value: string,
  cwd: string,
  homeDir: string
): Promise<string | null> {
  if (isAbsolute(value) || value.startsWith("/")) return await resolveCanonical(value)
  if (value.startsWith("~")) return await resolveCanonical(join(homeDir, value.slice(2)))
  if (value.startsWith(".") || value === "") return await resolveCanonical(resolve(cwd, value))
  return null
}

async function normalizeShellPath(
  rawPath: string,
  cwd: string,
  homeDir: string
): Promise<string | null> {
  if (!rawPath) return null

  let value = rawPath.trim()
  if (!value) return null
  value = expandHomeSubstitution(value, homeDir).replace(/^[`"']+|[`"'`]+$/g, "")
  return await resolveNormalizedShellPath(expandHomePrefix(value, homeDir), cwd, homeDir)
}

async function isHiddenHomePathInCommand(
  rawPath: string,
  cwd: string,
  homeDir: string,
  allowCodexHome: boolean
): Promise<boolean> {
  const resolved = await normalizeShellPath(rawPath, cwd, homeDir)
  if (!resolved) return false
  // The session's own persisted tool-result/output files live under a hidden
  // home dir but are the agent's own working data — never block reading them.
  if (isSessionToolResultsPath(resolved)) return false
  if (allowCodexHome && isCodexHomePath(resolved, homeDir)) return false
  if (!isHiddenTopLevelHomePath(resolved, homeDir)) return false

  const normalizedCwd = cwd.replace(/\\/g, "/")
  const normalizedHome = homeDir.replace(/\\/g, "/").replace(/\/$/, "")
  const normalizedResolved = resolved.replace(/\\/g, "/")
  const hiddenRoot = `${normalizedHome}/${normalizedResolved.slice(normalizedHome.length + 1).split("/")[0]}`

  return !isPathWithin(hiddenRoot, normalizedCwd)
}

function collectShellPathCandidates(command: string, hasPathBuilder: boolean): Set<string> {
  const candidates = new Set<string>([
    ...(command.match(/[^\s]+/g) ?? []),
    ...Array.from(command.matchAll(COMMAND_SUBST_SWIZ_RE)).map((match) => match[0]!),
    ...Array.from(command.matchAll(BACKTICK_SUBST_SWIZ_RE)).map((match) => match[0]!),
  ])
  for (const fragment of extractQuotedShellFragments(command)) {
    if (!isPathLikeFragment(fragment)) continue
    if (fragment.startsWith(".") && !hasPathBuilder) continue
    candidates.add(fragment)
  }
  return candidates
}

function candidateValues(rawToken: string): string[] {
  const token = rawToken.replace(/^[{}()]+|[;|&(){};]+$/g, "")
  if (!token || token.startsWith("-")) return []
  const assignment = token.split("=")
  return assignment.length === 2 ? [assignment[1]!] : [token]
}

interface ShellPathContext {
  command: string
  cwd: string
  homeDir: string
  allowCodexHome: boolean
  hasHomeReference: boolean
  hasPathBuilder: boolean
}

async function allowedHiddenHomeCandidate(
  candidate: string,
  resolvedCandidate: string | null,
  ctx: ShellPathContext
): Promise<boolean> {
  if (await isAllowedTrashMoveCommand(ctx.command, ctx.cwd, ctx.homeDir)) return true
  if (!resolvedCandidate) return false
  const isSharedSkill =
    isSharedAgentsSkillPath(candidate, ctx.homeDir) ||
    isSharedAgentsSkillPath(resolvedCandidate, ctx.homeDir)
  return isSharedSkill && isAllowedSharedSkillShellCommand(ctx.command, candidate)
}

interface DirectShellClassification {
  matched: boolean
  blocked: BlockedShellPath | null
}

async function classifyDirectShellCandidate(
  candidate: string,
  resolved: string | null,
  ctx: ShellPathContext
): Promise<DirectShellClassification> {
  const isTaskStorage = Boolean(resolved && isProtectedTaskStoragePath(resolved))
  const isHiddenHome = await isHiddenHomePathInCommand(
    candidate,
    ctx.cwd,
    ctx.homeDir,
    ctx.allowCodexHome
  )
  if (!isTaskStorage && !isHiddenHome) return { matched: false, blocked: null }

  if (isAllowedMarkdownShellReadCommand(ctx.command, candidate)) {
    return { matched: true, blocked: { kind: "markdown-read", path: candidate } }
  }
  if (isTaskStorage && resolved) {
    return { matched: true, blocked: { kind: "task-storage", path: resolved } }
  }
  const allowed = await allowedHiddenHomeCandidate(candidate, resolved, ctx)
  return {
    matched: true,
    blocked: allowed ? null : { kind: "hidden-home", path: candidate },
  }
}

async function classifyShellCandidate(
  candidate: string,
  ctx: ShellPathContext
): Promise<BlockedShellPath | null> {
  const resolved = await normalizeShellPath(candidate, ctx.cwd, ctx.homeDir)
  const direct = await classifyDirectShellCandidate(candidate, resolved, ctx)
  if (direct.matched) return direct.blocked
  if (!ctx.hasHomeReference || !ctx.hasPathBuilder) return null
  const hiddenViaBuilder = await isHiddenHomePathInCommand(
    candidate,
    ctx.homeDir,
    ctx.homeDir,
    ctx.allowCodexHome
  )
  return hiddenViaBuilder ? { kind: "hidden-home", path: candidate } : null
}

async function shouldBlockShellCommand(
  command: string,
  cwd: string,
  allowCodexHome: boolean
): Promise<BlockedShellPath | null> {
  const homeDir = homedir()
  if (!homeDir || !command) return null
  const canonicalHomeDir = await resolveCanonical(homeDir)
  const canonicalCwd = await resolveCanonical(cwd)
  const hasPathBuilder = PATH_BUILDER_RE.test(command)
  const context: ShellPathContext = {
    command,
    cwd: canonicalCwd,
    homeDir: canonicalHomeDir,
    allowCodexHome,
    hasHomeReference: HOME_REFERENCE_RE.test(command),
    hasPathBuilder,
  }
  const seen = new Set<string>()

  for (const rawToken of collectShellPathCandidates(command, hasPathBuilder)) {
    for (const candidate of candidateValues(rawToken)) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      if (!candidate.includes("/") && !candidate.startsWith("~") && !candidate.startsWith("."))
        continue
      const blocked = await classifyShellCandidate(candidate, context)
      if (blocked) return blocked
    }
  }

  return null
}

function buildSafeReadOnlyAllowMessage(blockedPath: string): string {
  return [
    "Read-only inspection command approved for a hidden home-directory path.",
    "",
    `Attempted path: ${blockedPath}.`,
    "",
    SAFE_READ_ONLY_INSPECTION_HINT,
  ].join("\n")
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

function settingMutationBlock(command: string) {
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
  if (!isPersonalIssuesGateDisableCommand(command)) return null
  return preToolUseDeny(
    "Disabling personalRepoIssuesGate is not permitted from agent Bash commands.\n\n" +
      "This gate can only be disabled by the user directly at the terminal.\n" +
      buildIssueGuidance(null)
  )
}

function blockedShellOutput(blocked: BlockedShellPath, command: string) {
  if (blocked.kind === "task-storage") {
    return preToolUseDeny(buildProtectedTaskStorageDenyReason(blocked.path))
  }
  if (blocked.kind === "markdown-read" || isSafeReadOnlyShellCommand(command)) {
    return preToolUseAllowWithContext(
      "Read-only inspection command is allowed.",
      buildSafeReadOnlyAllowMessage(blocked.path)
    )
  }
  if (MEMORY_DIR_RE.test(blocked.path)) {
    return preToolUseDeny(
      [
        "Shell commands referencing the memory directory are not permitted.",
        "",
        `Attempted path: ${blocked.path}.`,
        "",
        "Use /update-memory to add session learnings to the project CLAUDE.md file instead.",
        "",
        SAFE_READ_ONLY_INSPECTION_HINT,
      ].join("\n")
    )
  }
  return preToolUseDeny(
    [
      "Hidden home-directory path references in shell commands are blocked under sandbox mode.",
      "",
      `Attempted path: ${blocked.path}.`,
      "",
      "Use shell commands only on paths inside the current dispatch cwd unless that cwd is itself the hidden home path.",
      "",
      SAFE_READ_ONLY_INSPECTION_HINT,
    ].join("\n")
  )
}

async function evaluateShellSandbox(
  input: Record<string, any>,
  toolInput: Record<string, string> | undefined,
  allowCodexHome: boolean
) {
  const command = (toolInput?.command ?? "").normalize("NFKC")
  const mutationBlock = settingMutationBlock(command)
  if (mutationBlock) return mutationBlock
  const blocked = await shouldBlockShellCommand(command, input.cwd ?? process.cwd(), allowCodexHome)
  return blocked ? blockedShellOutput(blocked, command) : null
}

function evaluateFileSandbox(toolInput: Record<string, string> | undefined) {
  const filePath = (toolInput?.file_path ?? "").normalize("NFKC")
  if (isProtectedTaskStoragePath(filePath)) {
    return preToolUseDeny(buildProtectedTaskStorageDenyReason(filePath))
  }
  if (!SWIZ_CONFIG_RE.test(filePath)) return null
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

const pretoolUseProtectSandbox: SwizToolHook = {
  name: "pretooluse-protect-sandbox",
  event: "preToolUse",
  matcher: "Bash|Edit|Write|NotebookEdit",
  timeout: 5,

  async run(rawInput) {
    const input = rawInput as Record<string, any>
    const toolName: string = (input.tool_name as string) ?? ""
    const toolInput = input.tool_input as Record<string, string> | undefined
    const allowCodexHome = detectCurrentAgentFromHookPayload(input)?.id === "codex"

    if (isShellTool(toolName)) {
      const result = await evaluateShellSandbox(input, toolInput, allowCodexHome)
      if (result) return result
    }

    if (isFileEditTool(toolName)) {
      const result = evaluateFileSandbox(toolInput)
      if (result) return result
    }

    return {}
  },
}

export default pretoolUseProtectSandbox

// ─── Standalone execution (file-based dispatch / manual testing) ────────────
if (import.meta.main) await runSwizHookAsMain(pretoolUseProtectSandbox)
