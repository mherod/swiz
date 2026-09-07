import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { git, gitAttempt } from "../git-helpers.ts"

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
  if (!(await git(["rev-parse", "--show-toplevel"], cwd))) return
  const exclude = await git(["rev-parse", "--git-path", "info/exclude"], cwd)
  if (!exclude) throw new Error("Cannot locate Git's exclude file for project settings")
  await appendRules(resolve(cwd, exclude), [".swiz/config.json", ".swiz/config.json.bak"])
  await appendRules(resolve(cwd, ".gitignore"), ["/.swiz/config.json", "/.swiz/config.json.bak"])
  const result = await gitAttempt(
    ["rm", "--cached", "--ignore-unmatch", "--", ".swiz/config.json", ".swiz/config.json.bak"],
    cwd
  )
  if (result.exitCode !== 0) {
    throw new Error("Cannot untrack project settings; resolve staged changes before retrying")
  }
}
