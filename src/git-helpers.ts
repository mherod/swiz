// ─── Shared Git & GitHub CLI helpers ─────────────────────────────────────────
//
// Stable entry point for git/gh utilities used by both the core application
// layer (src/) and the hook layer (hooks/). Extracted from hooks/hook-utils.ts
// to remove the src-to-hooks coupling (issue #85).

import { realpathSync } from "node:fs"

/** Run a git command and return trimmed stdout. Returns "" on failure. */
export async function git(args: string[], cwd: string): Promise<string> {
  try {
    const effectiveCwd = cwd.trim() || process.cwd()
    const proc = Bun.spawn(["git", ...args], { cwd: effectiveCwd, stdout: "pipe", stderr: "pipe" })
    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    return proc.exitCode === 0 ? output.trim() : ""
  } catch {
    return ""
  }
}

/** Run a gh CLI command and return trimmed stdout. Returns "" on failure or timeout (3s). */
export async function gh(args: string[], cwd: string): Promise<string> {
  try {
    const effectiveCwd = cwd.trim() || process.cwd()
    const proc = Bun.spawn(["gh", ...args], { cwd: effectiveCwd, stdout: "pipe", stderr: "pipe" })
    let killed = false
    const killTimer = setTimeout(() => {
      killed = true
      proc.kill()
    }, 3000)
    const [output] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(killTimer)
    return !killed && proc.exitCode === 0 ? output.trim() : ""
  } catch {
    return ""
  }
}

/** Run a gh CLI command and parse JSON output. Returns null on failure or invalid JSON. */
export async function ghJson<T>(args: string[], cwd: string): Promise<T | null> {
  const output = await gh(args, cwd)
  if (!output) return null
  try {
    return JSON.parse(output) as T
  } catch {
    return null
  }
}

/** Find the first open PR for a branch and return the requested JSON fields. */
export async function getOpenPrForBranch<T>(
  branch: string,
  cwd: string,
  jsonFields: string
): Promise<T | null> {
  if (!branch) return null
  const prs = await ghJson<T[]>(
    ["pr", "list", "--head", branch, "--state", "open", "--json", jsonFields],
    cwd
  )
  return prs?.[0] ?? null
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await git(["rev-parse", "--git-dir"], cwd)) !== ""
}

export async function isGitHubRemote(cwd: string): Promise<boolean> {
  const url = await git(["remote", "get-url", "origin"], cwd)
  return url.includes("github.com")
}

/** Get the owner/repo slug from the git remote URL (e.g., "mherod/swiz"). */
export async function getRepoSlug(cwd: string): Promise<string | null> {
  const url = await git(["remote", "get-url", "origin"], cwd)
  if (!url) return null
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (sshMatch?.[1]) return sshMatch[1]
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/)
  if (httpsMatch?.[1]) return httpsMatch[1]
  return null
}

export function hasGhCli(): boolean {
  return !!Bun.which("gh")
}

// ─── Path hashing ────────────────────────────────────────────────────────────

/**
 * Generate a canonical hash for a filesystem path.
 * Uses realpathSync() to dereference symlinks, ensuring equivalent repos
 * (accessed via symlink or real path) generate identical hashes.
 * Returns the full untruncated hash to avoid collision vulnerabilities.
 */
export function getCanonicalPathHash(cwd: string): string {
  let realPath: string
  try {
    realPath = realpathSync(cwd)
  } catch {
    realPath = cwd
  }
  return Bun.hash(realPath).toString(16)
}

// ─── Issue helpers ───────────────────────────────────────────────────────────

/**
 * Fetch the state of a GitHub issue. Returns "OPEN", "CLOSED", or null on failure.
 */
export async function issueState(
  issueNumber: number | string,
  cwd: string
): Promise<"OPEN" | "CLOSED" | null> {
  const raw = await gh(
    ["issue", "view", String(issueNumber), "--json", "state", "--jq", ".state"],
    cwd
  )
  if (raw === "OPEN" || raw === "CLOSED") return raw
  return null
}
