import { readdir } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { z } from "zod"
import { type ValidateMemoryWrite, validateMigrationWrite } from "./memory-migration-validation.ts"
import { isPathWithinRoot } from "./project-identity.ts"
import {
  assertMemoryPathWithinRoot,
  canonicalMemoryPath,
  PROJECT_MEMORY_GUIDANCE,
  type ProjectMemoryLocation,
  resolveProjectMemory,
} from "./project-memory.ts"

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const absolutePathSchema = z.string().refine(isAbsolute, "Use an absolute path")
const targetSchema = z.object({
  repository: absolutePathSchema,
  kind: z.enum(["rule", "note", "dated"]),
  content: z.string().trim().min(1),
  reviewed: z.boolean().default(false),
})
const recordSchema = z.object({
  source: absolutePathSchema,
  sha256: digestSchema,
  targets: z.array(targetSchema),
  copiedTargets: digestSchema.optional(),
})

export const memoryMigrationSchema = z.object({
  version: z.literal(1),
  hostPolicyResolved: z.boolean(),
  lookupVerified: z.boolean(),
  inventoryProblems: z.array(z.string()).default([]),
  records: z.array(recordSchema),
})
export type MemoryMigration = z.infer<typeof memoryMigrationSchema>
type MigrationRecord = MemoryMigration["records"][number]
type MigrationTarget = MigrationRecord["targets"][number]
export type MigrationStatus = "planned" | "copied" | "migrated" | "unresolved" | "failed"
export interface MigrationResult {
  record: number
  status: MigrationStatus
  detail: string
}
interface MemoryWrite {
  path: string
  content: string
  append: boolean
}

function toDigestInput(input: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input)
  if (input instanceof Uint8Array) return input
  return new Uint8Array(input)
}

export function memoryDigest(content: string | ArrayBuffer | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(toDigestInput(content)).digest("hex")
}

/** Inventory never guesses ownership or prints private source contents. */
export async function inventoryMemories(source: string): Promise<MemoryMigration> {
  const records: MigrationRecord[] = []
  const inventoryProblems: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink())
        inventoryProblems.push(`Symlink requires explicit inventory: ${path}`)
      if (entry.isDirectory()) await visit(path)
      if (!entry.isFile()) continue
      const file = Bun.file(path)
      if (file.size > 16 * 1024 * 1024) throw new Error(`Inventory file exceeds 16 MiB: ${path}`)
      records.push({
        source: path,
        sha256: memoryDigest(await file.arrayBuffer()),
        targets: [],
      })
    }
  }
  await visit(resolve(source))
  records.sort((a, b) => a.source.localeCompare(b.source))
  return {
    version: 1,
    hostPolicyResolved: false,
    lookupVerified: false,
    inventoryProblems,
    records,
  }
}

function targetContent(target: MigrationTarget): string {
  return target.content.replace(/\r\n/g, "\n").trim()
}

function targetKey(record: MigrationRecord): string {
  return memoryDigest(JSON.stringify(record.targets))
}

function relativeLink(from: string, to: string): string {
  return relative(from, to).split("/").map(encodeURIComponent).join("/")
}

function noteWrites(target: MigrationTarget, location: ProjectMemoryLocation): MemoryWrite[] {
  const content = targetContent(target)
  const id = memoryDigest(`${target.kind}\n${content}`)
  const path = join(location.directory, `${id}.md`)
  const heading = target.kind === "dated" ? "Dated context (verify before reuse)" : "Project note"
  return [
    { path, content: `# ${heading}\n\n${content}\n`, append: false },
    { path: location.index, content: `- [${heading}](${basename(path)})`, append: true },
  ]
}

function lookupWrites(location: ProjectMemoryLocation): MemoryWrite[] {
  return [
    {
      path: location.index,
      content: `# Project memory\n\n${PROJECT_MEMORY_GUIDANCE}`,
      append: true,
    },
    {
      path: join(location.root, "CLAUDE.md"),
      content: "Project memory: [.swiz/memory/MEMORY.md](.swiz/memory/MEMORY.md).",
      append: true,
    },
    {
      path: join(location.root, "AGENTS.md"),
      content:
        "Read [CLAUDE.md](CLAUDE.md) and [project memory](.swiz/memory/MEMORY.md) for repository guidance.",
      append: true,
    },
    {
      path: join(location.root, ".cursorrules"),
      content: "Read [project memory](.swiz/memory/MEMORY.md) for repository guidance.",
      append: true,
    },
    {
      path: join(location.root, "GEMINI.md"),
      content: "Read [project memory](.swiz/memory/MEMORY.md) for repository guidance.",
      append: true,
    },
    {
      path: join(location.root, ".gemini", "GEMINI.md"),
      content: "Read [project memory](../.swiz/memory/MEMORY.md) for repository guidance.",
      append: true,
    },
  ]
}

async function prepareTarget(
  target: MigrationTarget,
  record: MigrationRecord
): Promise<MemoryWrite[]> {
  const location = await resolveProjectMemory(target.repository)
  if (!location) throw new Error("Mapped destination is not an existing Git repository")
  if (isPathWithinRoot(canonicalMemoryPath(record.source), location.root)) {
    throw new Error(
      "Inventory source is already inside a mapped repository; do not migrate it onto itself"
    )
  }
  const writes = lookupWrites(location)
  const notes = target.kind === "rule" ? [] : noteWrites(target, location)
  const destination = notes[0]?.path ?? location.rules
  await verifyReferences(targetContent(target), destination, location.root)
  if (target.kind === "rule") {
    writes.push({ path: location.rules, content: targetContent(target), append: true })
  } else {
    writes.push(...notes)
  }
  // Only a digest enters the repository; the private manifest retains the source path.
  writes.push({
    path: location.index,
    content: `- Source SHA-256 \`${record.sha256}\`: [${target.kind}](${relativeLink(location.directory, destination)})`,
    append: true,
  })
  for (const write of writes) assertMemoryPathWithinRoot(write.path, location.root)
  return writes
}

async function verifyReferences(content: string, destination: string, root: string): Promise<void> {
  const references = [
    ...content.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g),
    ...content.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))/gm),
  ]
  for (const match of references) {
    const href = match[1] ?? match[2] ?? ""
    if (/^(?:https?:\/\/|#)/i.test(href)) continue
    if (/^(?:[a-z]+:|\/|~)/i.test(href))
      throw new Error("Rewrite external file references to portable repository links")
    const path = resolve(dirname(destination), decodeURIComponent(href.split(/[?#]/)[0]!))
    assertMemoryPathWithinRoot(path, root)
    if (!(await Bun.file(path).exists()))
      throw new Error(
        "Referenced repository file is missing; migrate or update the reference first"
      )
  }
}

async function readOptional(path: string): Promise<string> {
  const file = Bun.file(path)
  return (await file.exists()) ? file.text() : ""
}

function containsWrite(text: string, write: MemoryWrite): boolean {
  if (!write.append) return text === write.content
  return `\n${text.trim()}\n`.includes(`\n${write.content.trim()}\n`)
}

/** Build every write first, preserving existing files and detecting conflicting notes. */
async function stageWrites(writes: MemoryWrite[]): Promise<Map<string, string>> {
  const staged = new Map<string, string>()
  for (const write of writes) {
    const current = staged.get(write.path) ?? (await readOptional(write.path))
    if (containsWrite(current, write)) continue
    if (!write.append && current)
      throw new Error(
        "Destination differs from the expected note; resolve the conflict before retrying"
      )
    staged.set(
      write.path,
      write.append ? `${current.trimEnd()}\n\n${write.content}\n` : write.content
    )
  }
  return staged
}

async function verifyWrites(writes: MemoryWrite[]): Promise<void> {
  for (const write of writes) {
    if (!containsWrite(await readOptional(write.path), write)) {
      throw new Error("Destination content or repository lookup is missing or changed")
    }
  }
}

function unresolvedReason(record: MigrationRecord, plan: MemoryMigration): string | null {
  if (!plan.hostPolicyResolved)
    return "Resolve host storage policy in a fresh session first; run swiz doctor"
  if (record.targets.length === 0)
    return "Map ownership explicitly; split mixed-project records into separate reviewed targets"
  if (record.targets.some((target) => !target.reviewed))
    return "Review each target for ownership, useful content, references, dates and publication suitability"
  return null
}

async function copyWrites(
  writes: MemoryWrite[],
  mode: "plan" | "apply",
  validate: ValidateMemoryWrite
) {
  const staged = await stageWrites(writes)
  for (const [path, content] of staged) await validate(path, content)
  if (mode === "apply") {
    for (const [path, content] of staged) await Bun.write(path, content)
    await verifyWrites(writes)
  }
  return staged.size
}

async function resolveSourceState(record: MigrationRecord): Promise<{
  sourceExists: boolean
  digestMatches: boolean
}> {
  const sourceFile = Bun.file(record.source)
  const sourceExists = await sourceFile.exists()
  if (!sourceExists) return { sourceExists: false, digestMatches: false }
  return {
    sourceExists: true,
    digestMatches: memoryDigest(await sourceFile.arrayBuffer()) === record.sha256,
  }
}

function ensureSourceCopyable(
  sourceExists: boolean,
  copiedTargets: string | undefined,
  expected: string
): void {
  if (!sourceExists && copiedTargets !== expected) {
    throw new Error("Source missing without a matching verified copy receipt")
  }
}

function plannedResult(changed: number): Omit<MigrationResult, "record"> {
  return {
    status: "planned",
    detail: `${changed} destination file(s) would change; source retained`,
  }
}

function copiedOrMigratedResult(
  sourceExists: boolean,
  plan: MemoryMigration
): Omit<MigrationResult, "record"> {
  if (!sourceExists && plan.lookupVerified) {
    return {
      status: "migrated",
      detail: "Verified repository content and lookup; previously copied source has been retired",
    }
  }
  return {
    status: "copied",
    detail:
      "Verified repository content and lookup; fresh-session readback and source retirement are separate steps",
  }
}

function migrationOutcomeByMode(
  sourceExists: boolean,
  plan: MemoryMigration
): Omit<MigrationResult, "record"> {
  return copiedOrMigratedResult(sourceExists, plan)
}

async function migrateRecord(
  record: MigrationRecord,
  plan: MemoryMigration,
  mode: "plan" | "apply" | "verify",
  validate: ValidateMemoryWrite
): Promise<{ status: MigrationStatus; detail: string }> {
  const unresolved = unresolvedReason(record, plan)
  if (unresolved) return { status: "unresolved", detail: unresolved }

  const { sourceExists, digestMatches } = await resolveSourceState(record)
  if (sourceExists && !digestMatches) {
    throw new Error("Source changed since inventory; review it and refresh the manifest")
  }

  ensureSourceCopyable(sourceExists, record.copiedTargets, targetKey(record))

  const writes = (
    await Promise.all(record.targets.map((target) => prepareTarget(target, record)))
  ).flat()

  if (mode === "verify" || !sourceExists) {
    await verifyWrites(writes)
    return copiedOrMigratedResult(sourceExists, plan)
  }

  const changed = await copyWrites(writes, mode, validate)
  if (mode === "plan") {
    return plannedResult(changed)
  }
  if (mode !== "apply") {
    throw new Error("Unexpected migration mode")
  }
  record.copiedTargets = targetKey(record)
  return migrationOutcomeByMode(sourceExists, plan)
}

/** Never retires sources, commits files, or changes host configuration. */
export async function migrateMemories(
  plan: MemoryMigration,
  mode: "plan" | "apply" | "verify",
  validate: ValidateMemoryWrite = validateMigrationWrite
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = []
  for (const [record, entry] of plan.records.entries()) {
    try {
      results.push({ record, ...(await migrateRecord(entry, plan, mode, validate)) })
    } catch (error) {
      results.push({
        record,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  for (const [index, detail] of plan.inventoryProblems.entries()) {
    results.push({ record: plan.records.length + index, status: "unresolved", detail })
  }
  return results
}
