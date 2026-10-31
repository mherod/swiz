import { lstat, mkdtemp, readdir, readlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { AGENTS, type AgentDef } from "../agents.ts"
import { getGitClient } from "../git/client.ts"
import { convertSkillContent } from "./skill-conversion.ts"
import { gitBlobId, type SkillFileVersion, type SkillHistory } from "./skill-git-history.ts"

// ─── Skill sync conflict resolution ──────────────────────────────────────────
//
// A byte diff cannot tell a stale copy from a newer one, and every skill that
// was copied with tool-name conversion differs from its origin on every line
// that names a tool. Each file pair is therefore classified from evidence:
// conversion equivalence, git history of either root, and modification times.
// Only edits that cannot be ordered or merged are reported as conflicts.

export type SkillTreeEntryKind = "directory" | "file" | "symlink"

export async function collectSkillTreeEntries(
  rootDir: string,
  relativeDir = "",
  entries = new Map<string, SkillTreeEntryKind>()
): Promise<Map<string, SkillTreeEntryKind>> {
  const children = await readdir(join(rootDir, relativeDir), { withFileTypes: true })
  for (const child of children) {
    const relativePath = relativeDir ? join(relativeDir, child.name) : child.name
    const kind: SkillTreeEntryKind = child.isDirectory()
      ? "directory"
      : child.isSymbolicLink()
        ? "symlink"
        : "file"
    entries.set(relativePath, kind)
    if (kind === "directory") {
      await collectSkillTreeEntries(rootDir, relativePath, entries)
    }
  }
  return entries
}

/** Larger files are left out of a baseline snapshot; they resolve from git history alone. */
const MAX_BASELINE_FILE_BYTES = 2 * 1024 * 1024

/** In-memory "last sync" version of every file in a skill, for `SkillResolutionContext.baseline`. */
export async function snapshotSkillBaseline(skillDir: string): Promise<SkillHistory> {
  const versions = new Map<string, SkillFileVersion[]>()
  const texts = new Map<string, string>()
  const date = Date.now()
  for (const [path, kind] of await collectSkillTreeEntries(skillDir)) {
    if (kind !== "file") continue
    const bytes = await Bun.file(join(skillDir, path)).bytes()
    if (bytes.byteLength > MAX_BASELINE_FILE_BYTES) continue
    const blob = gitBlobId(bytes)
    versions.set(path, [{ sha: "last sync", date, blob }])
    texts.set(blob, decode(bytes))
  }
  return {
    versions: (path) => Promise.resolve(versions.get(path) ?? []),
    removal: () => Promise.resolve(null),
    readBlob: (blob) => Promise.resolve(texts.get(blob) ?? ""),
  }
}

export interface SkillVocabulary {
  /** True when source and target use the same tool names. */
  identity: boolean
  toSource(text: string): string
  toTarget(text: string): string
}

const IDENTITY_VOCABULARY: SkillVocabulary = {
  identity: true,
  toSource: (text) => text,
  toTarget: (text) => text,
}

export function createSkillVocabulary(source: AgentDef, target: AgentDef): SkillVocabulary {
  if (source.id === target.id) return IDENTITY_VOCABULARY
  return {
    identity: false,
    toSource: (text) => convertSkillContent(text, target, source, AGENTS).content,
    toTarget: (text) => convertSkillContent(text, source, target, AGENTS).content,
  }
}

/** Reference history kept in `reference` agent vocabulary, converted for each side. */
export function createSkillReferenceHistory(
  history: SkillHistory,
  reference: AgentDef,
  sides: { source: AgentDef; target: AgentDef }
): SkillReferenceHistory {
  const converterTo = (side: AgentDef): TextConverter | null =>
    side.id === reference.id
      ? null
      : (text) => convertSkillContent(text, reference, side, AGENTS).content
  return { history, toSource: converterTo(sides.source), toTarget: converterTo(sides.target) }
}

export type SkillFileWrite = { copyFrom: string } | { content: string }

export type SkillFileResolutionKind =
  | "same"
  | "equivalent"
  | "target-only"
  | "target-newer"
  | "source-newer"
  | "added"
  | "merged"
  | "diverged"

export interface SkillFileResolution {
  kind: SkillFileResolutionKind
  path: string
  /** Evidence behind the verdict, for anything other than same/equivalent/target-only. */
  reason?: string
  /** Content to place in the target; present for source-newer, added, and merged. */
  write?: SkillFileWrite
  /** The verdict relied on tool-name conversion between source and target. */
  converted?: boolean
}

type TextConverter = (text: string) => string

/**
 * A checkout trusted as the record of skill history even when it is neither
 * side of the sync. A side's own history can be misleading — a stale clone whose
 * files were copied in rather than pulled has commits describing old content.
 * Converters map the reference's vocabulary to each side; null means the same.
 */
export interface SkillReferenceHistory {
  history: SkillHistory
  toSource: TextConverter | null
  toTarget: TextConverter | null
}

export interface SkillResolutionContext {
  sourceDir: string
  targetDir: string
  sourceHistory: SkillHistory
  targetHistory: SkillHistory
  vocabulary: SkillVocabulary
  reference?: SkillReferenceHistory
  /**
   * Source content as of the last sync, in source vocabulary (kept by --sync-watch).
   * A target that still matches it holds no edits of its own, and it is the merge base
   * when both sides changed — which makes edits resolvable between roots without git.
   */
  baseline?: SkillHistory
}

export interface SkillResolutionPlan {
  files: SkillFileResolution[]
  /** unchanged: target already current; update: apply writes; conflict: unresolved edits. */
  outcome: "unchanged" | "update" | "conflict"
}

interface FileSide {
  path: string
  bytes: Uint8Array
  mtimeMs: number
  mode: number
}

interface HistoryMatch {
  version: SkillFileVersion
  /** The matching version was recorded in the target root's history. */
  inTarget: boolean
  converted: boolean
}

/** A history to search, and how to bring its content into the vocabulary being matched. */
interface HistoryCandidate {
  history: SkillHistory
  inTarget: boolean
  convert: TextConverter | null
}

/** Supplementary markdown is converted between agents just like SKILL.md. */
function isConvertible(path: string): boolean {
  return path.endsWith(".md")
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/

function describeVersion(version: { sha: string; date: number }): string {
  const id = COMMIT_SHA_RE.test(version.sha) ? version.sha.slice(0, 7) : version.sha
  return `${id} (${describeDay(version.date)})`
}

function describeDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

async function readSide(path: string): Promise<FileSide> {
  const [stats, bytes] = await Promise.all([lstat(path), Bun.file(path).bytes()])
  return { path, bytes, mtimeMs: stats.mtimeMs, mode: stats.mode & 0o777 }
}

function isConvertedCopy(
  context: SkillResolutionContext,
  path: string,
  source: FileSide,
  target: FileSide
): boolean {
  if (context.vocabulary.identity || !isConvertible(path)) return false
  const sourceText = decode(source.bytes)
  const targetText = decode(target.bytes)
  return (
    context.vocabulary.toTarget(sourceText) === targetText ||
    context.vocabulary.toSource(targetText) === sourceText
  )
}

function newerMatch(a: HistoryMatch | null, b: HistoryMatch | null): HistoryMatch | null {
  if (!a || !b) return a ?? b
  return b.version.date > a.version.date ? b : a
}

/** Converters only apply to markdown; other files are copied verbatim between agents. */
function effectiveConverter(path: string, convert: TextConverter | null): TextConverter | null {
  return convert && isConvertible(path) ? convert : null
}

/** Histories that can record source content, in source vocabulary. */
function sourceCandidates(context: SkillResolutionContext): HistoryCandidate[] {
  const { vocabulary, reference } = context
  const candidates: HistoryCandidate[] = [
    { history: context.sourceHistory, inTarget: false, convert: null },
    {
      history: context.targetHistory,
      inTarget: true,
      convert: vocabulary.identity ? null : vocabulary.toSource,
    },
  ]
  if (reference) {
    candidates.push({ history: reference.history, inTarget: false, convert: reference.toSource })
  }
  if (context.baseline) {
    candidates.push({ history: context.baseline, inTarget: false, convert: null })
  }
  return candidates
}

/** Histories that can record target content, in target vocabulary. */
function targetCandidates(context: SkillResolutionContext): HistoryCandidate[] {
  const { vocabulary, reference } = context
  const candidates: HistoryCandidate[] = [
    { history: context.targetHistory, inTarget: true, convert: null },
    {
      history: context.sourceHistory,
      inTarget: false,
      convert: vocabulary.identity ? null : vocabulary.toTarget,
    },
  ]
  if (reference) {
    candidates.push({ history: reference.history, inTarget: false, convert: reference.toTarget })
  }
  if (context.baseline) {
    candidates.push({
      history: context.baseline,
      inTarget: false,
      convert: vocabulary.identity ? null : vocabulary.toTarget,
    })
  }
  return candidates
}

/**
 * Find the commit that recorded `bytes`: the newest blob-id match across the
 * candidate histories, or failing that, a converted match for markdown kept in
 * another agent's vocabulary.
 */
async function findRecordedVersion(
  path: string,
  bytes: Uint8Array,
  candidates: HistoryCandidate[]
): Promise<HistoryMatch | null> {
  const blob = gitBlobId(bytes)
  let match: HistoryMatch | null = null
  for (const { history, inTarget, convert } of candidates) {
    if (effectiveConverter(path, convert)) continue
    const version = (await history.versions(path)).find((v) => v.blob === blob)
    if (version) match = newerMatch(match, { version, inTarget, converted: false })
  }
  if (match) return match
  const text = decode(bytes)
  for (const { history, inTarget, convert } of candidates) {
    const toMatched = effectiveConverter(path, convert)
    if (!toMatched) continue
    for (const version of await history.versions(path)) {
      if (toMatched(await history.readBlob(version.blob)) === text) {
        return { version, inTarget, converted: true }
      }
    }
  }
  return null
}

/** Text already in target vocabulary whose tool names would convert for the source side. */
function isTargetVocabularyText(context: SkillResolutionContext, text: string): boolean {
  return context.vocabulary.toTarget(text) === text && context.vocabulary.toSource(text) !== text
}

/**
 * Carry a source edit into a target kept in its own vocabulary. Three-way merge with
 * the target round-tripped through both conversions as base: only the edited lines
 * change, and lines whose conversion is lossy (several task tools share one name in
 * some agents) keep the target's original wording. Null when the two overlap.
 */
async function convertSourceEdit(
  context: SkillResolutionContext,
  source: FileSide,
  target: FileSide
): Promise<SkillFileWrite | null> {
  const ours = decode(target.bytes)
  const base = context.vocabulary.toTarget(context.vocabulary.toSource(ours))
  const theirs = context.vocabulary.toTarget(decode(source.bytes))
  const merged = await mergeText(ours, base, theirs)
  return merged === null ? null : { content: merged }
}

/** Content that brings a newer source into the target; null when it cannot be done cleanly. */
async function sourceNewerWrite(
  context: SkillResolutionContext,
  path: string,
  sides: { source: FileSide; target: FileSide },
  recordedSource: HistoryMatch | null
): Promise<SkillFileWrite | null> {
  const { source, target } = sides
  // The source is a converted copy of a recorded target version: restore those exact bytes.
  if (recordedSource?.inTarget && recordedSource.converted) {
    return { content: await context.targetHistory.readBlob(recordedSource.version.blob) }
  }
  if (
    !context.vocabulary.identity &&
    isConvertible(path) &&
    isTargetVocabularyText(context, decode(target.bytes))
  ) {
    return await convertSourceEdit(context, source, target)
  }
  return { copyFrom: source.path }
}

const CONVERSION_OVERLAP_REASON =
  "source edits overlap lines that differ between agents only by tool names"

/** Order the two sides by recorded commits, falling back to mtimes for unrecorded edits. */
async function resolveByRecordedVersions(
  context: SkillResolutionContext,
  path: string,
  source: FileSide,
  target: FileSide
): Promise<SkillFileResolution | null> {
  const sourceMatch = await findRecordedVersion(path, source.bytes, sourceCandidates(context))
  const targetMatch = await findRecordedVersion(path, target.bytes, targetCandidates(context))
  const converted = Boolean(sourceMatch?.converted || targetMatch?.converted)
  const verdict = orderRecordedVersions(sourceMatch, targetMatch, source, target)
  if (!verdict) return null
  if (verdict.newer === "target") {
    return { kind: "target-newer", path, reason: verdict.reason, converted }
  }
  const write = await sourceNewerWrite(context, path, { source, target }, sourceMatch)
  if (!write) return { kind: "diverged", path, reason: CONVERSION_OVERLAP_REASON }
  return { kind: "source-newer", path, reason: verdict.reason, write, converted }
}

function orderRecordedVersions(
  sourceMatch: HistoryMatch | null,
  targetMatch: HistoryMatch | null,
  source: FileSide,
  target: FileSide
): { newer: "source" | "target"; reason: string } | null {
  if (sourceMatch && targetMatch) {
    const s = describeVersion(sourceMatch.version)
    const t = describeVersion(targetMatch.version)
    if (targetMatch.version.date > sourceMatch.version.date) {
      return { newer: "target", reason: `source matches older ${s}; target matches ${t}` }
    }
    if (sourceMatch.version.date > targetMatch.version.date) {
      return { newer: "source", reason: `target matches older ${t}; source matches ${s}` }
    }
    return null
  }
  if (sourceMatch && target.mtimeMs >= sourceMatch.version.date) {
    const s = describeVersion(sourceMatch.version)
    return { newer: "target", reason: `source matches ${s}; target has later unrecorded edits` }
  }
  if (targetMatch && source.mtimeMs >= targetMatch.version.date) {
    const t = describeVersion(targetMatch.version)
    return { newer: "source", reason: `target matches ${t}; source has later unrecorded edits` }
  }
  return null
}

/** A side last modified before the other side's history began cannot hold later edits. */
async function resolveByHistoryStart(
  context: SkillResolutionContext,
  path: string,
  source: FileSide,
  target: FileSide
): Promise<SkillFileResolution | null> {
  const targetStart = (await context.targetHistory.versions(path)).at(-1)
  if (targetStart && source.mtimeMs < targetStart.date) {
    const reason = `source last changed ${describeDay(source.mtimeMs)}, before target history began at ${describeVersion(targetStart)}`
    return { kind: "target-newer", path, reason }
  }
  const sourceStart = (await context.sourceHistory.versions(path)).at(-1)
  if (sourceStart && target.mtimeMs < sourceStart.date) {
    const reason = `target last changed ${describeDay(target.mtimeMs)}, before source history began at ${describeVersion(sourceStart)}`
    const write = await sourceNewerWrite(context, path, { source, target }, null)
    if (!write) return { kind: "diverged", path, reason: CONVERSION_OVERLAP_REASON }
    return { kind: "source-newer", path, reason, write }
  }
  return null
}

/** Newest recorded version older than both sides — the base both edits started from. */
async function findMergeBase(
  context: SkillResolutionContext,
  path: string,
  before: number
): Promise<{ version: SkillFileVersion; text: string } | null> {
  for (const { history, convert } of targetCandidates(context)) {
    const version = (await history.versions(path)).find((v) => v.date <= before)
    if (!version) continue
    const text = await history.readBlob(version.blob)
    const toTarget = effectiveConverter(path, convert)
    return { version, text: toTarget ? toTarget(text) : text }
  }
  return null
}

async function mergeText(ours: string, base: string, theirs: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-skill-merge-"))
  try {
    const [oursPath, basePath, theirsPath] = ["target", "base", "source"].map((n) => join(dir, n))
    await Promise.all([
      Bun.write(oursPath!, ours),
      Bun.write(basePath!, base),
      Bun.write(theirsPath!, theirs),
    ])
    const result = await getGitClient().run(
      ["merge-file", "-p", oursPath!, basePath!, theirsPath!],
      {
        cwd: dir,
      }
    )
    return result.exitCode === 0 ? result.stdout : null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Source text in target vocabulary, or null when conversion would lose information. */
function sourceTextForTarget(context: SkillResolutionContext, path: string, source: FileSide) {
  if (source.bytes.includes(0)) return null
  const sourceText = decode(source.bytes)
  if (context.vocabulary.identity || !isConvertible(path)) return sourceText
  const converted = context.vocabulary.toTarget(sourceText)
  return context.vocabulary.toSource(converted) === sourceText ? converted : null
}

/** Three-way merge both sides against their shared base from history. */
async function resolveByMerge(
  context: SkillResolutionContext,
  path: string,
  source: FileSide,
  target: FileSide
): Promise<SkillFileResolution | null> {
  const theirs = sourceTextForTarget(context, path, source)
  if (theirs === null || target.bytes.includes(0)) return null
  const base = await findMergeBase(context, path, Math.min(source.mtimeMs, target.mtimeMs))
  if (!base) return null
  const ours = decode(target.bytes)
  const since = describeVersion(base.version)
  const merged = await mergeText(ours, base.text, theirs)
  if (merged === null) {
    return { kind: "diverged", path, reason: `both sides edited the same lines since ${since}` }
  }
  if (merged === ours) {
    return {
      kind: "target-newer",
      path,
      reason: `target already contains source edits since ${since}`,
    }
  }
  if (merged === theirs) {
    return {
      kind: "source-newer",
      path,
      reason: `source extends target since ${since}`,
      write: { content: theirs },
    }
  }
  return {
    kind: "merged",
    path,
    reason: `merged edits from both sides since ${since}`,
    write: { content: merged },
  }
}

async function resolveSharedFile(
  context: SkillResolutionContext,
  path: string
): Promise<SkillFileResolution> {
  const [source, target] = await Promise.all([
    readSide(join(context.sourceDir, path)),
    readSide(join(context.targetDir, path)),
  ])
  if (Buffer.from(source.bytes).equals(target.bytes)) {
    return source.mode === target.mode
      ? { kind: "same", path }
      : { kind: "diverged", path, reason: "permissions differ" }
  }
  if (isConvertedCopy(context, path, source, target)) {
    return { kind: "equivalent", path, converted: true }
  }
  return (
    (await resolveByRecordedVersions(context, path, source, target)) ??
    (await resolveByHistoryStart(context, path, source, target)) ??
    (await resolveByMerge(context, path, source, target)) ?? {
      kind: "diverged",
      path,
      reason: "no shared history to tell which side is newer",
    }
  )
}

async function resolveSourceOnly(
  context: SkillResolutionContext,
  path: string
): Promise<SkillFileResolution> {
  // Only a committed deletion counts: a stale or copied-into checkout can be missing
  // files that nobody deliberately removed.
  const removal = await context.targetHistory.removal(path)
  if (removal) {
    const reason = `removed from target in ${describeVersion(removal)}`
    return { kind: "target-newer", path, reason }
  }
  return {
    kind: "added",
    path,
    reason: "new in source",
    write: { copyFrom: join(context.sourceDir, path) },
  }
}

async function resolveLink(
  context: SkillResolutionContext,
  path: string
): Promise<SkillFileResolution> {
  const [sourceLink, targetLink] = await Promise.all([
    readlink(join(context.sourceDir, path)),
    readlink(join(context.targetDir, path)),
  ])
  return sourceLink === targetLink
    ? { kind: "same", path }
    : { kind: "diverged", path, reason: "link targets differ" }
}

/** Desktop metadata that is never part of a skill and must not be propagated. */
const IGNORED_FILE_NAMES = new Set([".DS_Store"])

async function resolveEntry(
  context: SkillResolutionContext,
  path: string,
  sourceKind: SkillTreeEntryKind | undefined,
  targetKind: SkillTreeEntryKind | undefined
): Promise<SkillFileResolution | null> {
  if (IGNORED_FILE_NAMES.has(basename(path))) return null
  if (sourceKind && targetKind && sourceKind !== targetKind) {
    return {
      kind: "diverged",
      path,
      reason: `source is a ${sourceKind}, target is a ${targetKind}`,
    }
  }
  // Directories are implied by the files inside them.
  if (sourceKind === "directory" || targetKind === "directory") return null
  if (!targetKind) return await resolveSourceOnly(context, path)
  if (!sourceKind) return { kind: "target-only", path }
  if (sourceKind === "symlink") return await resolveLink(context, path)
  return await resolveSharedFile(context, path)
}

/** New markdown in a skill that is kept as a converted copy must be converted too. */
async function convertAddedMarkdown(
  context: SkillResolutionContext,
  files: SkillFileResolution[]
): Promise<void> {
  if (context.vocabulary.identity || !files.some((file) => file.converted)) return
  for (const file of files) {
    if (file.kind !== "added" || !isConvertible(file.path) || !file.write) continue
    if (!("copyFrom" in file.write)) continue
    const text = await Bun.file(file.write.copyFrom).text()
    file.write = { content: context.vocabulary.toTarget(text) }
    file.converted = true
  }
}

function planOutcome(files: SkillFileResolution[]): SkillResolutionPlan["outcome"] {
  if (files.some((file) => file.kind === "diverged")) return "conflict"
  if (files.some((file) => file.write)) return "update"
  return "unchanged"
}

export async function planSkillResolution(
  context: SkillResolutionContext
): Promise<SkillResolutionPlan> {
  const [sourceEntries, targetEntries] = await Promise.all([
    collectSkillTreeEntries(context.sourceDir),
    collectSkillTreeEntries(context.targetDir),
  ])
  const paths = [...new Set([...sourceEntries.keys(), ...targetEntries.keys()])].sort()
  const files: SkillFileResolution[] = []
  for (const path of paths) {
    const file = await resolveEntry(context, path, sourceEntries.get(path), targetEntries.get(path))
    if (file) files.push(file)
  }
  await convertAddedMarkdown(context, files)
  return { files, outcome: planOutcome(files) }
}

const RESOLUTION_LABELS: Record<SkillFileResolutionKind, string> = {
  same: "identical",
  equivalent: "equivalent after tool-name conversion",
  "target-only": "only in target",
  "target-newer": "newer in target",
  "source-newer": "updated",
  added: "added",
  merged: "merged",
  diverged: "conflicting",
}

/** e.g. "2 updated, 1 added" for the given kinds, in label order. */
export function describeSkillResolution(
  files: SkillFileResolution[],
  kinds: SkillFileResolutionKind[]
): string {
  return kinds
    .map((kind) => [kind, files.filter((file) => file.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${RESOLUTION_LABELS[kind]}`)
    .join(", ")
}
