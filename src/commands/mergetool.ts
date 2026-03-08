import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { detectAgentCli, promptAgent } from "../agent.ts"
import type { Command } from "../types.ts"

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFLICT_MARKER_RE = /^<{7}\s|^={7}$|^>{7}\s/m
const CODE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "mts"])

// ─── Arg parsing ──────────────────────────────────────────────────────────────

export interface MergetoolArgs {
  base: string
  local: string
  remote: string
  merged: string
}

export function parseMergetoolArgs(args: string[]): MergetoolArgs {
  // Filter out flags (none supported yet, but future-proof)
  const positional = args.filter((a) => !a.startsWith("-"))

  if (positional.length < 4) {
    throw new Error(
      "Usage: swiz mergetool <base> <local> <remote> <merged>\n" +
        "All four file paths are required (BASE, LOCAL, REMOTE, MERGED)."
    )
  }

  const [base, local, remote, merged] = positional as [string, string, string, string]
  return { base, local, remote, merged }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validatePaths(args: MergetoolArgs): void {
  for (const [label, path] of [
    ["BASE", args.base],
    ["LOCAL", args.local],
    ["REMOTE", args.remote],
    ["MERGED", args.merged],
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(`${label} file does not exist: ${path}`)
    }
  }

  // Check MERGED is writable by attempting to open for append
  try {
    const file = Bun.file(args.merged)
    if (!file) throw new Error("Cannot open MERGED")
  } catch {
    throw new Error(`MERGED file is not writable: ${args.merged}`)
  }
}

// ─── Repo context ─────────────────────────────────────────────────────────────

async function getRepoRoot(cwd: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  if (proc.exitCode !== 0) return null
  return output.trim()
}

function getRepoRelativePath(repoRoot: string, path: string): string {
  const absolutePath = resolve(path)
  return absolutePath.startsWith(repoRoot) ? absolutePath.slice(repoRoot.length + 1) : absolutePath
}

async function listSiblingTrackedFiles(repoRoot: string, relativePath: string): Promise<string[]> {
  const dirProc = Bun.spawn(["git", "ls-files", "--", dirname(relativePath)], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const dirOutput = await new Response(dirProc.stdout).text()
  await dirProc.exited
  if (dirProc.exitCode !== 0) return []

  return dirOutput
    .trim()
    .split("\n")
    .filter((path) => path && path !== relativePath)
    .slice(0, 20)
}

function maybeCollectImports(filePath: string): string[] {
  const ext = basename(filePath).split(".").pop()?.toLowerCase()
  if (!ext || !CODE_EXTENSIONS.has(ext)) return []

  // This is best-effort context; failures are intentionally ignored.
  try {
    return readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => /^\s*import\s/.test(line))
      .slice(0, 15)
      .map((line) => line.trim())
  } catch {
    return []
  }
}

async function gatherRepoContext(mergedPath: string): Promise<string> {
  const dir = dirname(resolve(mergedPath))
  const repoRoot = await getRepoRoot(dir)
  if (!repoRoot) {
    throw new Error(
      "Cannot determine repository root. swiz mergetool requires a git repository for context."
    )
  }

  const lines: string[] = []
  lines.push(`Repository root: ${repoRoot}`)

  // Get the relative path of the merged file within the repo.
  const relPath = getRepoRelativePath(repoRoot, mergedPath)
  lines.push(`File being merged: ${relPath}`)

  const siblings = await listSiblingTrackedFiles(repoRoot, relPath)
  if (siblings.length > 0) {
    lines.push(`\nNearby files in the same directory:`)
    for (const sibling of siblings) lines.push(`  ${sibling}`)
  }

  const imports = maybeCollectImports(mergedPath)
  if (imports.length > 0) {
    lines.push(`\nImports in the file:`)
    for (const importLine of imports) lines.push(`  ${importLine}`)
  }

  return lines.join("\n")
}

// ─── AI resolution ────────────────────────────────────────────────────────────

export function buildPrompt(
  baseContent: string,
  localContent: string,
  remoteContent: string,
  mergedContent: string,
  repoContext: string
): string {
  return [
    "You are resolving a Git merge conflict. Your task is to produce the final merged file content.",
    "",
    "## Repository Context",
    repoContext,
    "",
    "## Resolution Strategies (choose the best per conflict region)",
    "1. Keep ours: preserve LOCAL changes, discard REMOTE changes in that region",
    "2. Keep theirs: preserve REMOTE changes, discard LOCAL changes in that region",
    "3. Keep both: include both sets of changes in logical order",
    "4. Create hybrid: combine parts of both into a coherent result",
    "",
    "## Instructions",
    "- Combine changes from LOCAL (ours) and REMOTE (theirs) relative to BASE (common ancestor).",
    "- Preserve the intent of both sides where possible.",
    "- Follow existing code conventions visible in the file.",
    "- Verify no duplicate imports, extra closing braces, or broken definitions remain.",
    "- Do NOT include any conflict markers (<<<<<<, =======, >>>>>>>).",
    "- Do NOT include any explanation, commentary, or markdown formatting.",
    "- Do NOT wrap the output in code fences.",
    "- Output ONLY the final merged file content, nothing else.",
    "",
    "## BASE (common ancestor)",
    "```",
    baseContent,
    "```",
    "",
    "## LOCAL (ours — current branch)",
    "```",
    localContent,
    "```",
    "",
    "## REMOTE (theirs — incoming branch)",
    "```",
    remoteContent,
    "```",
    "",
    "## MERGED (current state with conflict markers)",
    "```",
    mergedContent,
    "```",
    "",
    "Output the resolved file content now:",
  ].join("\n")
}

export async function resolveWithAI(prompt: string): Promise<string> {
  if (!detectAgentCli()) {
    throw new Error(
      "No AI backend found. Install the Cursor Agent CLI to use AI-powered merge resolution."
    )
  }

  // Use the agent CLI in read-only ask mode — no file modifications, just Q&A
  const result = await promptAgent(prompt, { timeout: 120_000 })

  if (!result) {
    throw new Error("AI returned empty response")
  }

  return result
}

// ─── Post-processing ──────────────────────────────────────────────────────────

/**
 * Strip markdown code fences if the AI wrapped its output in them.
 * Handles ```lang\n...\n``` and bare ```\n...\n```.
 */
export function stripCodeFences(content: string): string {
  const trimmed = content.trim()
  const match = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```\s*$/)
  if (match?.[1] != null) return match[1]
  return trimmed
}

export function hasConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_RE.test(content)
}

function validateResolvedContent(content: string): void {
  if (hasConflictMarkers(content)) {
    throw new Error("AI resolution still contains conflict markers. Manual resolution required.")
  }
  if (content.trim().length === 0) {
    throw new Error("AI produced an empty result. Manual resolution required.")
  }
}

async function writeResolvedContent(mergedPath: string, content: string): Promise<void> {
  const tmpPath = `${mergedPath}.swiz-tmp`

  try {
    await Bun.write(tmpPath, content)

    const writtenContent = readFileSync(tmpPath, "utf8")
    if (writtenContent !== content) {
      throw new Error("Temp file verification failed — content mismatch")
    }

    await Bun.write(mergedPath, writtenContent)
  } finally {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      // non-fatal cleanup
    }
  }
}

// ─── Command ──────────────────────────────────────────────────────────────────

export const mergetoolCommand: Command = {
  name: "mergetool",
  description: "AI-powered Git merge conflict resolver",
  usage:
    'swiz mergetool <base> <local> <remote> <merged>\n\n  Git config:\n    git config merge.tool swiz\n    git config mergetool.swiz.cmd \'swiz mergetool "$BASE" "$LOCAL" "$REMOTE" "$MERGED"\'\n    git config mergetool.swiz.trustExitCode true',
  async run(args) {
    const parsed = parseMergetoolArgs(args)
    validatePaths(parsed)

    // Read all input files
    const baseContent = readFileSync(parsed.base, "utf8")
    const localContent = readFileSync(parsed.local, "utf8")
    const remoteContent = readFileSync(parsed.remote, "utf8")
    const mergedContent = readFileSync(parsed.merged, "utf8")

    // Gather repository context
    console.error("→ Gathering repository context...")
    const repoContext = await gatherRepoContext(parsed.merged)

    // Build prompt and resolve
    console.error("→ Resolving conflict with AI...")
    const prompt = buildPrompt(baseContent, localContent, remoteContent, mergedContent, repoContext)
    const rawResult = await resolveWithAI(prompt)

    // Post-process: strip code fences if present
    const result = stripCodeFences(rawResult)

    validateResolvedContent(result)
    await writeResolvedContent(parsed.merged, result)

    console.error("✓ Conflict resolved successfully")
  },
}
