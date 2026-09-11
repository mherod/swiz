import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  canonicalizePath,
  isPathWithinRoot,
  resolveProjectIdentityResolution,
} from "./project-identity.ts"

export interface ProjectMemoryLocation {
  root: string
  rules: string
  directory: string
  index: string
}

export const PROJECT_MEMORY_GUIDANCE =
  "Keep durable project rules in the nearest applicable CLAUDE.md inside the repository. " +
  "Keep retained project notes and their index in .swiz/memory/. " +
  "If host policy requires external storage, report that conflict with swiz doctor; " +
  "do not bypass higher-priority instructions or claim a migration is complete."

/** Resolve existing ancestors too, so a not-yet-created file cannot escape via a symlink. */
export function canonicalMemoryPath(path: string): string {
  const absolute = resolve(path)
  if (existsSync(absolute)) return canonicalizePath(absolute)
  const parent = dirname(absolute)
  if (parent === absolute) return absolute
  return join(canonicalMemoryPath(parent), absolute.slice(parent.length))
}

export function assertMemoryPathWithinRoot(path: string, root: string): void {
  if (!isPathWithinRoot(canonicalMemoryPath(path), root)) {
    throw new Error("Memory destination escapes its owning repository")
  }
}

export async function resolveProjectMemory(cwd: string): Promise<ProjectMemoryLocation | null> {
  const scope = canonicalizePath(resolve(cwd))
  const identity = await resolveProjectIdentityResolution(scope)
  if (!identity.isGitRepo) return null
  const root = identity.canonicalRoot
  let directory = scope
  while (directory !== root && !existsSync(join(directory, "CLAUDE.md"))) {
    directory = dirname(directory)
  }
  const rules = join(directory, "CLAUDE.md")
  const memoryDir = join(root, ".swiz", "memory")
  assertMemoryPathWithinRoot(rules, root)
  assertMemoryPathWithinRoot(memoryDir, root)
  return { root, rules, directory: memoryDir, index: join(memoryDir, "MEMORY.md") }
}

export function isProjectMemoryPath(path: string, location: ProjectMemoryLocation): boolean {
  const target = canonicalMemoryPath(path)
  if (!isPathWithinRoot(target, location.root)) return false
  return (
    target === canonicalMemoryPath(location.rules) ||
    (isPathWithinRoot(target, location.directory) && target.endsWith(".md"))
  )
}

export async function projectMemorySources(
  location: ProjectMemoryLocation
): Promise<Array<{ label: string; path: string }>> {
  const sources = [
    { label: "Project rules", path: location.rules },
    { label: "Project memory", path: location.index },
  ]
  if (!existsSync(location.directory)) return sources
  for (const entry of await readdir(location.directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") continue
    sources.push({
      label: `Project memory (${entry.name})`,
      path: join(location.directory, entry.name),
    })
  }
  return sources
}
