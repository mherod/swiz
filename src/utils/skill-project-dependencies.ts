import { join } from "node:path"
import { parse } from "yaml"

export interface ProjectSkillSource {
  name: string
  sourceDir: string
  shadowedDirs: string[]
}

/** Only explicit replacement metadata adds dependencies; prose links are not instructions. */
export function skillReplacement(text: string): string | null {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]
  if (!frontmatter) return null
  const data = parse(frontmatter)
  if (data?.metadata?.deprecated !== true) return null
  const replacement = data.metadata.replacement
  if (typeof replacement !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(replacement)) {
    throw new Error("Deprecated skill requires a safe metadata.replacement skill name.")
  }
  return replacement
}

/** Dependency-first groups. Missing or cyclic replacements fail before any project writes. */
export async function projectSkillGroups(
  selected: ProjectSkillSource[],
  available: ProjectSkillSource[],
  targetRoot: string
): Promise<ProjectSkillSource[][]> {
  const sources = new Map(available.map((source) => [source.name, source]))
  const selectedNames = new Set(selected.map((source) => source.name))
  const groups: ProjectSkillSource[][] = []
  for (const source of selected) {
    const group = new Map<string, ProjectSkillSource>()
    await visitReplacement(source.name, {
      sources,
      selectedNames,
      targetRoot,
      group,
      visiting: new Set(),
    })
    mergeDependencyGroup(groups, [...group.values()])
  }
  return groups
}

function mergeDependencyGroup(groups: ProjectSkillSource[][], group: ProjectSkillSource[]): void {
  const names = new Set(group.map((source) => source.name))
  const overlapping = groups.filter((existing) => existing.some((source) => names.has(source.name)))
  const merged = new Map<string, ProjectSkillSource>()
  for (const existing of overlapping) {
    groups.splice(groups.indexOf(existing), 1)
    for (const source of existing) merged.set(source.name, source)
  }
  for (const source of group) merged.set(source.name, source)
  groups.push([...merged.values()])
}

interface DependencyVisit {
  sources: Map<string, ProjectSkillSource>
  selectedNames: Set<string>
  targetRoot: string
  group: Map<string, ProjectSkillSource>
  visiting: Set<string>
}

async function visitReplacement(name: string, state: DependencyVisit): Promise<void> {
  if (state.visiting.has(name)) {
    throw new Error(`Cyclic skill replacement: ${[...state.visiting, name].join(" -> ")}`)
  }
  if (state.group.has(name)) return
  state.visiting.add(name)
  const installed = Bun.file(join(state.targetRoot, name, "SKILL.md"))
  const useInstalled = !state.selectedNames.has(name) && (await installed.exists())
  const source = state.sources.get(name)
  if (!useInstalled && !source) throw new Error(`Missing replacement skill: ${name}`)
  const text = useInstalled
    ? await installed.text()
    : await Bun.file(join(source!.sourceDir, name, "SKILL.md")).text()
  const replacement = skillReplacement(text)
  if (replacement) await visitReplacement(replacement, state)
  if (!useInstalled) state.group.set(name, source!)
  state.visiting.delete(name)
}
