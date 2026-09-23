import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { findGitWorkTree, type GitAttempt, gitAttempt } from "../git-helpers.ts"

const settingsPaths = [".swiz/config.json", ".swiz/config.json.bak"]

function settingsGitError(action: string, result: GitAttempt): Error {
  const diagnostic = result.stderr || `Git exited with status ${result.exitCode}`
  let remedy = "Resolve this Git error before retrying."
  if (/permission denied|operation not permitted|read-only file system/i.test(diagnostic)) {
    remedy = "Check repository permissions and filesystem access before retrying."
  } else if (/index\.lock.*(?:file exists|already exists)/is.test(diagnostic)) {
    remedy = "Wait for the Git operation holding the index lock to finish before retrying."
  } else if (/staged content/i.test(diagnostic)) {
    remedy = "Review the staged settings and preserve those changes before retrying."
  }
  /** Keep the cause intact without promoting Git's force-removal or lock-deletion hints. */
  const summary = diagnostic.split(/\r?\n\s*\r?\n|\r?\n\(use -f /)[0]
  return new Error(`${action}: ${summary}\n${remedy}`, { cause: new Error(diagnostic) })
}

async function appendRules(path: string, rules: string[]): Promise<void> {
  const file = Bun.file(path)
  const existing = (await file.exists()) ? await file.text() : ""
  const lines = existing.split(/\r?\n/)
  const missing = rules.filter((rule) => !lines.includes(rule))
  if (missing.length === 0) return
  await mkdir(dirname(path), { recursive: true })
  const separator = existing && !existing.endsWith("\n") ? "\n" : ""
  await Bun.write(path, `${existing}${separator}${missing.join("\n")}\n`)
}

/** Keep project settings and their backup out of shared and local Git additions. */
export async function ensureProjectSettingsIgnored(cwd: string): Promise<void> {
  const repository = await gitAttempt(["rev-parse", "--show-toplevel"], cwd)
  if (repository.exitCode !== 0) {
    if (/not a git repository/i.test(repository.stderr) && !findGitWorkTree(cwd)) return
    throw settingsGitError("Cannot inspect Git repository for project settings", repository)
  }
  const exclude = await gitAttempt(["rev-parse", "--git-path", "info/exclude"], cwd)
  if (exclude.exitCode !== 0 || !exclude.stdout) {
    throw settingsGitError("Cannot locate Git's exclude file for project settings", exclude)
  }
  const tracked = await gitAttempt(["ls-files", "--cached", "-z", "--", ...settingsPaths], cwd)
  if (tracked.exitCode !== 0) {
    throw settingsGitError("Cannot inspect tracked project settings", tracked)
  }
  await appendRules(resolve(cwd, exclude.stdout), settingsPaths)
  await appendRules(
    resolve(cwd, ".gitignore"),
    settingsPaths.map((path) => `/${path}`)
  )
  if (!tracked.stdout) return
  const result = await gitAttempt(
    ["rm", "--cached", "--ignore-unmatch", "--", ...settingsPaths],
    cwd
  )
  if (result.exitCode !== 0) {
    throw settingsGitError("Cannot untrack project settings", result)
  }
}
