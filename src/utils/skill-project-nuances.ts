import { realpathSync } from "node:fs"
import { basename, join, relative, resolve, sep } from "node:path"
import type { SkillFileResolution, SkillResolutionContext } from "./skill-sync-resolution.ts"

interface Section {
  heading: string
  text: string
}

/** Keep fenced examples intact; headings inside examples are not document boundaries. */
function sections(text: string): Section[] {
  const result: Section[] = []
  let current: Section = { heading: "", text: "" }
  let fence = ""
  for (const line of text.split(/(?<=\n)/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""
    }
    const heading = !fence ? line.match(/^##\s+(.+?)\s*\n?$/)?.[1] : undefined
    if (heading) {
      result.push(current)
      current = { heading, text: "" }
    }
    current.text += line
  }
  result.push(current)
  return result
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function namesProject(text: string, root: string): boolean {
  const name = basename(root).toLowerCase()
  const shortName = name.split("-")[0]!
  const words: string[] = text.toLowerCase().match(/[a-z0-9_-]+/g) ?? []
  return words.includes(name) || (shortName.length >= 4 && words.includes(shortName))
}

/** Concrete repository-relative paths only; never execute commands embedded in skills. */
function repositoryPaths(text: string): string[] {
  const candidates =
    text.match(/(?<![\w@/.-])(?:apps|packages|scripts|src|lib|tests|hooks)\/[\w./()[\]-]+/g) ?? []
  return [...new Set(candidates.map((path) => path.replace(/[.,:;]+$/, "")))].filter(
    (path) => !/[[\]]/.test(path) && !path.includes("..") && !/^[^/]+\/SKILL\.md$/.test(path)
  )
}

function pathExistsInProject(projectRoot: string, path: string): boolean {
  try {
    const physical = realpathSync(resolve(projectRoot, path))
    const within = relative(realpathSync(projectRoot), physical)
    return within !== ".." && !within.startsWith(`..${sep}`)
  } catch {
    return false
  }
}

function evidence(projectRoot: string, text: string, skillRoot?: string) {
  const paths = repositoryPaths(text).filter(
    (path) => !skillRoot || !pathExistsInProject(skillRoot, path)
  )
  return {
    verified: paths.filter((path) => pathExistsInProject(projectRoot, path)),
    missing: paths.filter((path) => !pathExistsInProject(projectRoot, path)),
  }
}

function held(file: SkillFileResolution, reason: string): SkillFileResolution {
  return { path: file.path, kind: "project-kept", reason }
}

async function proposedText(file: SkillFileResolution, context: SkillResolutionContext) {
  if (file.write && "content" in file.write) return file.write.content
  const path =
    file.write && "copyFrom" in file.write
      ? file.write.copyFrom
      : join(context.sourceDir, file.path)
  return context.vocabulary.toTarget(await Bun.file(path).text())
}

/**
 * Existence is evidence of a local anchor, not proof that its surrounding prose is true.
 * Conflicting sections and missing anchors are held for review, even with --overwrite.
 */
async function protectProjectFile(
  file: SkillFileResolution,
  context: SkillResolutionContext,
  corpus: string
): Promise<SkillFileResolution> {
  const root = context.projectRoot!
  const incoming = await proposedText(file, context)
  const incomingEvidence = evidence(root, incoming, context.sourceDir)
  if (incomingEvidence.missing.length > 0) {
    return held(
      file,
      `needs review: incoming repository paths are absent: ${incomingEvidence.missing.join(", ")}`
    )
  }
  const targetFile = Bun.file(join(context.targetDir, file.path))
  if (!(await targetFile.exists())) return file
  const local = await targetFile.text()
  const localIsProjectSpecific =
    evidence(root, local).verified.length > 0 || namesProject(local, root)
  const protectedSections = sections(local).filter((section) => {
    const paths = repositoryPaths(section.text)
    const hasLocalConstraint =
      localIsProjectSpecific &&
      /\b(?:must|never|only|do not|refuses?|requires?|preserve)\b/i.test(section.text)
    const projectSpecific =
      paths.length > 0 || hasLocalConstraint || namesProject(section.text, root)
    return projectSpecific && !corpus.includes(normalized(section.text))
  })
  if (protectedSections.length === 0) return file
  return mergeProtectedSections(file, incoming, protectedSections, root)
}

function mergeProtectedSections(
  file: SkillFileResolution,
  incoming: string,
  protectedSections: Section[],
  root: string
): SkillFileResolution {
  const incomingSections = sections(incoming)
  const anchors = new Set<string>()
  for (const section of protectedSections) {
    const checked = evidence(root, section.text)
    if (checked.verified.length === 0 && checked.missing.length === 0) {
      return held(
        file,
        `needs review: project constraint changed (${section.heading || "preamble"})`
      )
    }
    if (checked.missing.length > 0) {
      return held(
        file,
        `needs review: retained project guidance has stale paths: ${checked.missing.join(", ")}`
      )
    }
    // The preamble includes identity/frontmatter; never transplant it into another skill.
    if (!section.heading || incomingSections.some((other) => other.heading === section.heading)) {
      return held(
        file,
        `needs review: global edits overlap project guidance (${section.heading || "preamble"}); anchors: ${checked.verified.join(", ")}`
      )
    }
    for (const path of checked.verified) anchors.add(path)
  }
  const content = `${[incoming.trimEnd(), ...protectedSections.map((s) => s.text.trim())].join("\n\n")}\n`
  return {
    path: file.path,
    kind: "merged",
    reason: `preserved project sections with existing repository anchors: ${[...anchors].join(", ")}`,
    write: { content },
  }
}

/** Guard proposed writes using the complete proposed Markdown tree (including moved references). */
export async function protectProjectGuidance(
  files: SkillFileResolution[],
  context: SkillResolutionContext
): Promise<void> {
  if (!context.projectRoot) return
  const markdown = files.filter((file) => file.path.endsWith(".md"))
  const proposed = new Map<string, string>()
  for (const file of markdown) {
    if (!file.write && file.kind !== "diverged") continue
    proposed.set(file.path, await proposedText(file, context))
  }
  // Include unchanged project references in relocation checks, too.
  for (const file of markdown) {
    if (proposed.has(file.path)) continue
    const target = Bun.file(join(context.targetDir, file.path))
    if (await target.exists()) proposed.set(file.path, await target.text())
  }
  let heldCount = -1
  while (heldCount !== files.filter((file) => file.kind === "project-kept").length) {
    heldCount = files.filter((file) => file.kind === "project-kept").length
    await protectPass(files, context, proposed)
  }
  protectConflictReplacement(files)
}

function protectConflictReplacement(files: SkillFileResolution[]): void {
  if (!files.some((file) => file.kind === "diverged")) return
  // Whole-tree replacement must not discard a successful merge or a retained local file.
  const retained = new Set(["target-only", "target-newer", "merged"])
  for (let index = 0; index < files.length; index++) {
    if (!retained.has(files[index]!.kind)) continue
    files[index] = held(
      files[index]!,
      "needs review: conflict replacement would discard retained project content"
    )
  }
}

async function protectPass(
  files: SkillFileResolution[],
  context: SkillResolutionContext,
  proposed: Map<string, string>
): Promise<void> {
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!
    if (!file.path.endsWith(".md") || (!file.write && file.kind !== "diverged")) continue
    const corpus = [...proposed.values()].map(normalized).join("\n")
    files[index] = await protectProjectFile(file, context, corpus)
    // A held incoming reference cannot serve as proof that content was relocated.
    if (files[index]!.kind === "project-kept") {
      const target = Bun.file(join(context.targetDir, file.path))
      if (await target.exists()) proposed.set(file.path, await target.text())
      else proposed.delete(file.path)
    } else if (files[index]!.write) {
      proposed.set(file.path, await proposedText(files[index]!, context))
    }
  }
}
