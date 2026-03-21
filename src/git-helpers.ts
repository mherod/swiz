// ─── Shared Git & GitHub CLI helpers ─────────────────────────────────────────
//
// Stable entry point for git/gh utilities used by both the core application
// layer (src/) and the hook layer (hooks/). Extracted from hooks/hook-utils.ts
// to remove the src-to-hooks coupling (issue #85).

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { resolveSpawnCwd } from "./cwd.ts"
import { acquireGhSlot } from "./gh-rate-limit.ts"
import { getHomeDirOrNull } from "./home.ts"

export const GIT_DIR_NAME = ".git"
export const GIT_INDEX_LOCK = "index.lock"

/** Join a path under `<repoRoot>/.git/...`. */
export function joinGitPath(repoRoot: string, ...segments: string[]): string {
  return join(repoRoot, GIT_DIR_NAME, ...segments)
}

/** Run a git command and return trimmed stdout. Returns "" on failure. */
export async function git(args: string[], cwd: string): Promise<string> {
  try {
    const effectiveCwd = resolveSpawnCwd(cwd)
    // Strip GIT_* env vars (GIT_DIR, GIT_QUARANTINE_PATH, etc.) set by
    // lefthook/git hooks so spawned git uses the provided cwd correctly.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))
    )
    const proc = Bun.spawn(["git", ...args], {
      cwd: effectiveCwd,
      stdout: "pipe",
      stderr: "pipe",
      env,
    })
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
const GH_FALLBACK_CACHE_TTL_MS = Number(process.env.GH_FALLBACK_CACHE_TTL_MS) || 300_000
const GH_FALLBACK_CACHE_DIR = process.env.SWIZ_GH_CACHE_DIR || "/tmp/swiz-gh-cache"

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
  await acquireGhSlot()
  const effectiveCwd = resolveSpawnCwd(cwd)
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

const DAEMON_PORT = Number(process.env.SWIZ_DAEMON_PORT) || 7943
const DAEMON_GH_TIMEOUT_MS = 3_000

interface GhFallbackCacheEntry {
  expiresAt: number
  value: unknown
}

export interface GhQueryOptions {
  ttlMs?: number
}

function ensureGhFallbackCacheDir(): void {
  try {
    mkdirSync(GH_FALLBACK_CACHE_DIR, { recursive: true })
  } catch {
    // Best-effort cache directory creation.
  }
}

function ghFallbackCachePath(args: string[], cwd: string): string {
  const key = Bun.hash(`${cwd}\x00${args.join("\x00")}`).toString(16)
  return join(GH_FALLBACK_CACHE_DIR, `${key}.json`)
}

async function readGhFallbackCache<T>(
  args: string[],
  cwd: string,
  includeStale = false
): Promise<{ value: T; stale: boolean } | null> {
  try {
    const parsed = (await Bun.file(ghFallbackCachePath(args, cwd)).json()) as GhFallbackCacheEntry
    if (typeof parsed !== "object" || parsed === null) return null
    const expiresAt = Number((parsed as { expiresAt?: unknown }).expiresAt)
    if (!Number.isFinite(expiresAt)) return null
    if (expiresAt > Date.now()) return { value: parsed.value as T, stale: false }
    if (includeStale) return { value: parsed.value as T, stale: true }
    return null
  } catch {
    return null
  }
}

async function writeGhFallbackCache(
  args: string[],
  cwd: string,
  ttlMs: number,
  value: unknown
): Promise<void> {
  try {
    ensureGhFallbackCacheDir()
    const payload: GhFallbackCacheEntry = {
      expiresAt: Date.now() + Math.max(0, ttlMs),
      value,
    }
    await Bun.write(ghFallbackCachePath(args, cwd), JSON.stringify(payload))
  } catch {
    // Best-effort file cache.
  }
}

/**
 * Try to resolve a gh JSON query via the daemon cache.
 * Falls back to direct ghJson when the daemon is unavailable.
 */
async function ghDirectWithFallbackCache<T>(
  args: string[],
  cwd: string,
  ttlMs: number
): Promise<T | null> {
  const direct = await ghJson<T>(args, cwd)
  if (direct !== null) {
    await writeGhFallbackCache(args, cwd, ttlMs, direct)
    return direct
  }
  return (await readGhFallbackCache<T>(args, cwd, true))?.value ?? null
}

function shouldBypassDaemon(): boolean {
  const ghPath = Bun.which("gh") ?? ""
  const mockedGhBinary = ghPath.startsWith(tmpdir()) || ghPath.includes("swiz-test")
  return (
    process.env.SWIZ_NO_DAEMON === "1" ||
    process.env.BUN_TEST === "1" ||
    process.env.GH_MOCK_ISSUES !== undefined ||
    process.env.GH_MOCK_PRS !== undefined ||
    process.env.GH_MOCK_USER !== undefined ||
    mockedGhBinary
  )
}

export async function ghJsonViaDaemon<T>(
  args: string[],
  cwd: string,
  options: GhQueryOptions = {}
): Promise<T | null> {
  const ttlMs = options.ttlMs ?? GH_FALLBACK_CACHE_TTL_MS
  if (shouldBypassDaemon()) return ghDirectWithFallbackCache<T>(args, cwd, ttlMs)

  try {
    const resp = await fetch(`http://127.0.0.1:${DAEMON_PORT}/gh-query`, {
      method: "POST",
      body: JSON.stringify({ args, cwd, ttlMs }),
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(DAEMON_GH_TIMEOUT_MS),
    })
    if (!resp.ok) return ghDirectWithFallbackCache<T>(args, cwd, ttlMs)
    const data = (await resp.json()) as { hit: boolean; value: T | null }
    if (data.value !== null) await writeGhFallbackCache(args, cwd, ttlMs, data.value)
    return data.value
  } catch {
    return ghDirectWithFallbackCache<T>(args, cwd, ttlMs)
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

export interface RemoteInfo {
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
const REMOTE_URL_PATTERNS: RegExp[] = [
  // HTTPS: https://host/owner/repo[.git][/]
  /^https?:\/\/([^/:]+)\/([^/\s]+\/[^/\s]+?)(?:\.git)?(?:\/)?$/,
  // SSH slash notation: [git+]ssh://[user@]host/owner/repo[.git]
  /^(?:git\+)?ssh:\/\/(?:[^@/]+@)?([^/]+)\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/,
  // SSH colon notation: [user@]host:owner/repo[.git]
  /^(?:[^@\s:]+@)?([^:/\s]+):([^/\s]+\/[^/\s]+?)(?:\.git)?$/,
]

export function parseRemoteUrl(url: string): RemoteInfo | null {
  if (!url) return null
  for (const pattern of REMOTE_URL_PATTERNS) {
    const m = url.match(pattern)
    if (m?.[1] && m?.[2]) return { host: m[1], slug: m[2] }
  }
  return null
}

/**
 * Returns true when host is github.com or a GitHub Enterprise Server instance
 * registered in the gh CLI config (~/.config/gh/hosts.yml).
 */
export async function isGitHubHost(host: string): Promise<boolean> {
  if (host === "github.com") return true
  const home = getHomeDirOrNull()
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
export async function resolveGitPaths(
  cwd: string
): Promise<{ gitDir: string; workTree: string } | null> {
  let dir = cwd
  while (true) {
    const candidate = joinGitPath(dir)
    if (existsSync(candidate)) {
      try {
        const st = statSync(candidate)
        if (st.isDirectory()) return { gitDir: candidate, workTree: dir }
        const content = (await Bun.file(candidate).text()).trim()
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

// ─── Local git exclude management ────────────────────────────────────────────

/**
 * Ensure that `entry` appears in the repo-local `.git/info/exclude` file for
 * the repository containing `cwd`. Idempotent — does not add duplicates.
 *
 * This is the correct mechanism for local-only excludes that should not be
 * committed or shared via `.gitignore`. Silently no-ops when `cwd` is not
 * inside a git repository or any I/O operation fails.
 */
export async function ensureGitExclude(cwd: string, entry: string): Promise<void> {
  try {
    const paths = await resolveGitPaths(cwd)
    if (!paths) return
    const infoDir = join(paths.gitDir, "info")
    const excludePath = join(infoDir, "exclude")
    mkdirSync(infoDir, { recursive: true })
    let existing = ""
    try {
      const file = Bun.file(excludePath)
      if (await file.exists()) {
        existing = await file.text()
      }
    } catch {
      // File does not exist yet or cannot be read — start with empty string
    }
    const lines = existing.split("\n")
    if (lines.some((l) => l.trim() === entry.trim())) return
    const appended = existing.endsWith("\n") || existing === "" ? existing : `${existing}\n`
    await Bun.write(excludePath, `${appended}${entry}\n`)
  } catch {
    // Non-fatal: silently ignore all failures
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
function readBranchFromHead(headContent: string): string {
  const head = headContent.trim()
  if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length)
  if (/^[a-f0-9]{7,40}$/i.test(head)) return `detached@${head.slice(0, 7)}`
  return ""
}

interface StatusCounts {
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
}

function parseBranchAbLine(line: string, counts: StatusCounts): void {
  const match = line.match(/\+(\d+)\s+-(\d+)/)
  if (match) {
    counts.ahead = Number(match[1] ?? "0")
    counts.behind = Number(match[2] ?? "0")
  }
}

function parseChangedEntry(line: string, counts: StatusCounts): void {
  const xy = line.split(" ")[1] ?? ".."
  if (xy[0] && xy[0] !== ".") counts.staged++
  if (xy[1] && xy[1] !== ".") counts.unstaged++
}

function parseStatusV2Lines(out: string): StatusCounts {
  const counts: StatusCounts = {
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
  }
  for (const line of out ? out.split("\n") : []) {
    if (line.startsWith("# branch.ab ")) parseBranchAbLine(line, counts)
    else if (line.startsWith("1 ") || line.startsWith("2 ")) parseChangedEntry(line, counts)
    else if (line.startsWith("u ")) counts.conflicts++
    else if (line.startsWith("? ")) counts.untracked++
  }
  return counts
}

function gitSpawnSyncLines(args: string[], workTree: string): string {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: workTree,
      stdout: "pipe",
      stderr: "ignore",
    })
    if (proc.exitCode !== 0) return ""
    return new TextDecoder().decode(proc.stdout).trim()
  } catch {
    return ""
  }
}

export async function getGitBranchStatus(cwd: string): Promise<GitBranchStatus | null> {
  const gitPaths = await resolveGitPaths(cwd)
  if (!gitPaths) return null

  let branch = ""
  try {
    branch = readBranchFromHead(await Bun.file(`${gitPaths.gitDir}/HEAD`).text())
  } catch {
    /* no branch */
  }
  if (!branch) return null

  const statusOut = gitSpawnSyncLines(["status", "--porcelain=2", "--branch"], gitPaths.workTree)
  let changedFallback = 0
  let counts: StatusCounts

  if (statusOut) {
    counts = parseStatusV2Lines(statusOut)
  } else {
    counts = { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
    const fallbackOut = gitSpawnSyncLines(["status", "--porcelain"], gitPaths.workTree)
    changedFallback = fallbackOut ? fallbackOut.split("\n").length : 0
  }

  const stashOut = gitSpawnSyncLines(["stash", "list", "--format=%gd"], gitPaths.workTree)
  const stash = stashOut ? stashOut.split("\n").length : 0

  return { branch, ...counts, stash, changedFallback }
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
