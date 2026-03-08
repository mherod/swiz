// ─── Shared Git & GitHub CLI helpers ─────────────────────────────────────────
//
// Stable entry point for git/gh utilities used by both the core application
// layer (src/) and the hook layer (hooks/). Extracted from hooks/hook-utils.ts
// to remove the src-to-hooks coupling (issue #85).

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname } from "node:path"

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

// ─── gh helpers ───────────────────────────────────────────────────────────────

const GH_API_CACHE_DURATION: string = process.env.GH_API_CACHE_DURATION || "20s"

/**
 * Returns true when the gh api arg list represents a read-only GET request.
 * Used to decide whether to inject `--cache` for `gh api` calls.
 * Mutating methods (POST, PATCH, DELETE, PUT) return false.
 */
export function isReadOnlyGhApiArgs(args: string[]): boolean {
  if (args[0] !== "api") return false
  const methodIdx = args.findIndex((a) => a === "--method" || a === "-X")
  if (methodIdx >= 0) {
    const method = args[methodIdx + 1]?.toUpperCase()
    return method === "GET"
  }
  return true
}

/**
 * Inject `--cache <duration>` into a `gh api` arg list if it's a read-only GET
 * and the caller hasn't already specified `--cache`.
 */
export function withApiCache(args: string[]): string[] {
  if (!isReadOnlyGhApiArgs(args)) return args
  if (args.includes("--cache")) return args
  return ["api", "--cache", GH_API_CACHE_DURATION, ...args.slice(1)]
}

/** Run a gh CLI command and return trimmed stdout. Returns "" on failure or timeout (3s).
 *  Read-only `gh api` calls automatically use `--cache` for built-in HTTP caching. */
export async function gh(args: string[], cwd: string): Promise<string> {
  const effectiveCwd = cwd.trim() || process.cwd()
  const effectiveArgs = args[0] === "api" ? withApiCache(args) : args

  try {
    const proc = Bun.spawn(["gh", ...effectiveArgs], {
      cwd: effectiveCwd,
      stdout: "pipe",
      stderr: "pipe",
    })
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
    if (!killed && proc.exitCode === 0) {
      return output.trim()
    }
    return ""
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

// ─── Git worktree / path resolution ─────────────────────────────────────────

/**
 * Walk up from `cwd` to find the `.git` directory (or file for worktrees).
 * Returns `{ gitDir, workTree }` or `null` if not inside a git repo.
 */
export function resolveGitPaths(cwd: string): { gitDir: string; workTree: string } | null {
  let dir = cwd
  while (true) {
    const candidate = `${dir}/.git`
    if (existsSync(candidate)) {
      try {
        const st = statSync(candidate)
        if (st.isDirectory()) return { gitDir: candidate, workTree: dir }
        const content = readFileSync(candidate, "utf8").trim()
        if (content.startsWith("gitdir: ")) {
          return { gitDir: content.slice("gitdir: ".length).trim(), workTree: dir }
        }
      } catch {
        /* fall through */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ─── Git status data layer ────────────────────────────────────────────────────

/** Raw git branch + working-tree counts, without any ANSI formatting. */
export interface GitBranchStatus {
  branch: string
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
  stash: number
  /** Non-zero only when `git status --porcelain=2` is unavailable (fallback). */
  changedFallback: number
}

/**
 * Return branch name and working-tree counts for `cwd`, or `null` if `cwd`
 * is not inside a git repository or no branch can be determined.
 */
export async function getGitBranchStatus(cwd: string): Promise<GitBranchStatus | null> {
  const gitPaths = resolveGitPaths(cwd)
  if (!gitPaths) return null

  let branch = ""
  try {
    const head = (await Bun.file(`${gitPaths.gitDir}/HEAD`).text()).trim()
    if (head.startsWith("ref: refs/heads/")) {
      branch = head.slice("ref: refs/heads/".length)
    } else if (/^[a-f0-9]{7,40}$/i.test(head)) {
      branch = `detached@${head.slice(0, 7)}`
    }
  } catch {
    /* no branch */
  }
  if (!branch) return null

  let ahead = 0
  let behind = 0
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicts = 0
  let stash = 0
  let parsedStatus = false
  let changedFallback = 0

  try {
    const proc = Bun.spawnSync(["git", "status", "--porcelain=2", "--branch"], {
      cwd: gitPaths.workTree,
      stdout: "pipe",
      stderr: "ignore",
    })
    if (proc.exitCode === 0) {
      const out = new TextDecoder().decode(proc.stdout).trim()
      for (const line of out ? out.split("\n") : []) {
        if (line.startsWith("# branch.ab ")) {
          const match = line.match(/\+(\d+)\s+-(\d+)/)
          if (match) {
            ahead = Number(match[1] ?? "0")
            behind = Number(match[2] ?? "0")
          }
          continue
        }
        if (line.startsWith("1 ") || line.startsWith("2 ")) {
          const xy = line.split(" ")[1] ?? ".."
          if (xy[0] && xy[0] !== ".") staged++
          if (xy[1] && xy[1] !== ".") unstaged++
          continue
        }
        if (line.startsWith("u ")) {
          conflicts++
          continue
        }
        if (line.startsWith("? ")) untracked++
      }
      parsedStatus = true
    }
  } catch {
    /* parse fallback below */
  }

  if (!parsedStatus) {
    try {
      const proc = Bun.spawnSync(["git", "status", "--porcelain"], {
        cwd: gitPaths.workTree,
        stdout: "pipe",
        stderr: "ignore",
      })
      const out = new TextDecoder().decode(proc.stdout).trim()
      changedFallback = out ? out.split("\n").length : 0
    } catch {
      /* assume clean */
    }
  }

  try {
    const proc = Bun.spawnSync(["git", "stash", "list", "--format=%gd"], {
      cwd: gitPaths.workTree,
      stdout: "pipe",
      stderr: "ignore",
    })
    if (proc.exitCode === 0) {
      const out = new TextDecoder().decode(proc.stdout).trim()
      stash = out ? out.split("\n").length : 0
    }
  } catch {
    /* no stash info */
  }

  return { branch, ahead, behind, staged, unstaged, untracked, conflicts, stash, changedFallback }
}

// ─── Branch-policy classification helpers ────────────────────────────────────

/**
 * Matches files that are docs, config, or tooling — not production source code.
 * Used by push-gate scripts to distinguish docs-only commits from code changes.
 */
export const DOCS_CONFIG_RE =
  /\.(md|txt|json|ya?ml|toml)$|\.config\.[jt]s$|\.env\.example$|LICENSE|^\.github\/|^\.husky\//

/** Returns true when a file path matches the docs/config classification. */
export function isDocsOrConfig(filePath: string): boolean {
  return DOCS_CONFIG_RE.test(filePath)
}

/**
 * Extracts the conventional-commit type prefix from a commit message.
 * Returns the type string (e.g. "feat", "fix") or null if the message
 * does not follow the conventional-commit format.
 */
export function parseCommitType(message: string): string | null {
  const match = message.match(/^(\w+)(\(.+?\))?[!]?:/)
  return match?.[1] ?? null
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
