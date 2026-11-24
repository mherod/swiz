import { existsSync } from "node:fs"
import { resolve } from "node:path"

const ZERO_SHA_RE = /^0+$/

function runGitLines(root: string, args: string[]): string[] {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
    })
    if (proc.exitCode !== 0) return []
    const text = new TextDecoder().decode(proc.stdout)
    return text.split("\0").filter(Boolean)
  } catch {
    return []
  }
}

function parsePorcelainZ(root: string): string[] {
  const entries = runGitLines(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  const paths: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const filePath = entry.slice(3)
    if (status[0] === "R" || status[0] === "C") {
      // In porcelain -z, renames emit the destination path first and original path second.
      i++
    }
    if (filePath) paths.push(resolve(root, filePath))
  }
  return paths
}

function diffRangePaths(root: string, range: string): string[] {
  return runGitLines(root, ["diff", "--name-only", "-z", "--diff-filter=ACMR", range]).map((p) =>
    resolve(root, p)
  )
}

/**
 * List existing changed files in `root` so typecheck and lint can check them first.
 * Prefers uncommitted working-tree changes; falls back to the CI/HEAD commit diff on clean trees.
 */
export function listChangedFiles(
  root: string,
  env: Record<string, string | undefined> = process.env
): string[] {
  const dirty = parsePorcelainZ(root)
  const candidates = dirty.length > 0 ? dirty : listCommittedDiffFiles(root, env)
  const seen = new Set<string>()
  const existing: string[] = []
  for (const filePath of candidates) {
    if (seen.has(filePath) || !existsSync(filePath)) continue
    seen.add(filePath)
    existing.push(filePath)
  }
  return existing
}

function listCommittedDiffFiles(root: string, env: Record<string, string | undefined>): string[] {
  const base = env.CI_BASE?.trim()
  if (base && !ZERO_SHA_RE.test(base)) {
    const fromBase = diffRangePaths(root, `${base}...HEAD`)
    if (fromBase.length > 0) return fromBase
  }
  return diffRangePaths(root, "HEAD~1..HEAD")
}
