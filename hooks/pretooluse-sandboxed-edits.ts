#!/usr/bin/env bun

// PreToolUse hook: Block file edits outside the session's cwd and temporary directories.
// Enabled by default; disable with: swiz settings disable sandboxed-edits

import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { readSwizSettings } from "../src/settings.ts"
import { denyPreToolUse, git, isFileEditTool, type ToolHookInput } from "./hook-utils.ts"

const input = (await Bun.stdin.json()) as ToolHookInput

if (!isFileEditTool(input.tool_name ?? "")) process.exit(0)

const filePath: string = (input.tool_input?.file_path as string | undefined) ?? ""
if (!filePath) process.exit(0)

const settings = await readSwizSettings()
if (!settings.sandboxedEdits) process.exit(0)

/**
 * Resolve the canonical (real) path for any path, whether or not it exists.
 *
 * Algorithm:
 *   1. Attempt fs.realpath() on the full path — succeeds for existing paths,
 *      following every symlink in the chain recursively (handles chained symlinks).
 *   2. If the path doesn't exist, walk up to the nearest existing ancestor,
 *      realpath() that ancestor, then re-append the remaining segments.
 *
 * This ensures ALL path comparisons operate in a consistent canonical namespace,
 * preventing bypass via:
 *   - Chained symlinks  (link1→link2→/outside): realpath() follows every hop
 *   - Symlinks in allowed roots (tmpdir→/private/tmp on macOS): all roots use
 *     the same resolution so isWithin() comparisons are always apples-to-apples
 *   - New-file creation through a symlink dir (cwd/link/new.ts where link→/etc):
 *     realpath(cwd/link) resolves to /etc before the non-existent file segment
 */
async function resolveCanonical(p: string): Promise<string> {
  const absolute = resolve(p)
  try {
    return await realpath(absolute)
  } catch {
    let dir = dirname(absolute)
    let rest = basename(absolute)
    while (dir !== dirname(dir)) {
      try {
        const realDir = await realpath(dir)
        return join(realDir, rest)
      } catch {
        rest = join(basename(dir), rest)
        dir = dirname(dir)
      }
    }
    return absolute
  }
}

function isWithin(parent: string, child: string): boolean {
  const prefix = parent.endsWith("/") ? parent : `${parent}/`
  return child === parent || child.startsWith(prefix)
}

interface RemoteInfo {
  host: string
  slug: string // "owner/repo"
}

/**
 * Parse a git remote URL into {host, slug} for HTTPS, SSH colon, SSH slash,
 * and git+ssh:// formats. Returns null if the URL cannot be recognised.
 *
 * Handled formats:
 *   https://host/owner/repo[.git][/]
 *   [git+]ssh://[user@]host/owner/repo[.git]
 *   [user@]host:owner/repo[.git]     (SSH colon / SCP-like notation)
 */
function parseRemoteUrl(url: string): RemoteInfo | null {
  if (!url) return null

  // HTTPS: https://host/owner/repo[.git][/]
  let m = url.match(/^https?:\/\/([^/:]+)\/([^/\s]+\/[^/\s]+?)(?:\.git)?(?:\/)?$/)
  if (m?.[1] && m?.[2]) return { host: m[1], slug: m[2] }

  // SSH slash notation: [git+]ssh://[user@]host/owner/repo[.git]
  m = url.match(/^(?:git\+)?ssh:\/\/(?:[^@/]+@)?([^/]+)\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/)
  if (m?.[1] && m?.[2]) return { host: m[1], slug: m[2] }

  // SSH colon notation: [user@]host:owner/repo[.git]  (SCP-like, e.g. git@github.com:owner/repo)
  m = url.match(/^(?:[^@\s:]+@)?([^:/\s]+):([^/\s]+\/[^/\s]+?)(?:\.git)?$/)
  if (m?.[1] && m?.[2]) return { host: m[1], slug: m[2] }

  return null
}

/**
 * Returns true when host is github.com or a GitHub Enterprise Server instance
 * registered in the gh CLI config (~/.config/gh/hosts.yml).
 */
async function isGitHubHost(host: string): Promise<boolean> {
  if (host === "github.com") return true
  const home = process.env.HOME
  if (!home) return false
  try {
    const content = await Bun.file(`${home}/.config/gh/hosts.yml`).text()
    // hosts.yml has each hostname as a top-level YAML key followed by ":"
    const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`^${escaped}:`, "m").test(content)
  } catch {
    return false
  }
}

// All paths are resolved through resolveCanonical so the isWithin() check
// operates in a uniform canonical namespace — no mix of logical and real paths.
const cwd = await resolveCanonical(input.cwd ?? process.cwd())
const target = await resolveCanonical(filePath)

// /tmp is a symlink on macOS (/tmp → /private/tmp); resolveCanonical gives the
// real path so the namespace stays consistent with the resolved target.
const tmp = await resolveCanonical(tmpdir())
const tmpLiteral = await resolveCanonical("/tmp")
// ~/.claude/projects/ is always allowed: Claude Code stores per-project
// auto-memory files there (e.g. memory/MEMORY.md). Blocking it creates a
// deadlock with the memory-enforcement hook.
// resolveCanonical walks up to HOME (which exists) when .claude/projects
// hasn't been created yet, ensuring the prefix always matches the target's
// canonical form.
const claudeProjectsDir = process.env.HOME
  ? await resolveCanonical(`${process.env.HOME}/.claude/projects`)
  : null
const allowedRoots = [cwd, tmp, tmpLiteral, ...(claudeProjectsDir ? [claudeProjectsDir] : [])]

if (allowedRoots.some((root) => isWithin(root, target))) process.exit(0)

// Discover if the blocked path lives inside a different GitHub repo.
// dirname(target) is already canonical so the git walk identifies the true
// owning repo even when the path arrived through symlinks.
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
  const remote = parseRemoteUrl(remoteUrl)
  if (remote && (await isGitHubHost(remote.host))) {
    const hostnameFlag = remote.host !== "github.com" ? ` --hostname ${remote.host}` : ""
    crossRepoHint = [
      "",
      `The blocked path is inside a different repository: ${remote.slug}`,
      "If this change is needed, consider filing an issue there so the repo can triage it:",
      `  gh issue create --repo ${remote.slug}${hostnameFlag} --title "..." --body "..."`,
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
    "If you need to edit a file outside the project, file an issue on the target repo instead:",
    "  gh issue create --repo <owner>/<repo> --title '...' --body '...'",
    crossRepoHint,
  ]
    .filter(Boolean)
    .join("\n")
)
