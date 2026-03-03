import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { detectAgentCli, promptAgent } from "../agent.ts"
import type { Command } from "../types.ts"

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFLICT_MARKER_RE = /^<{7}\s|^={7}$|^>{7}\s/m

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
  const output = await new Response(proc.stdout).text()
  await proc.exited
  if (proc.exitCode !== 0) return null
  return output.trim()
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

  // Get the relative path of the merged file within the repo
  const absPath = resolve(mergedPath)
  const relPath = absPath.startsWith(repoRoot) ? absPath.slice(repoRoot.length + 1) : absPath
  lines.push(`File being merged: ${relPath}`)

  // Gather nearby file names for context
  const dirProc = Bun.spawn(["git", "ls-files", "--", dirname(relPath)], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const dirOutput = await new Response(dirProc.stdout).text()
  await dirProc.exited
  if (dirProc.exitCode === 0) {
    const siblings = dirOutput
      .trim()
      .split("\n")
      .filter((f) => f && f !== relPath)
      .slice(0, 20)
    if (siblings.length > 0) {
      lines.push(`\nNearby files in the same directory:`)
      for (const s of siblings) lines.push(`  ${s}`)
    }
  }

  // Try to gather import/dependency context from the merged file's current content
  const ext = basename(mergedPath).split(".").pop()?.toLowerCase()
  if (ext && ["ts", "tsx", "js", "jsx", "mjs", "mts"].includes(ext)) {
    // Read the LOCAL version for import analysis (it's the "ours" version)
    // This is a best-effort analysis; failures are non-fatal
    try {
      const localContent = readFileSync(mergedPath, "utf8")
      const imports = localContent
        .split("\n")
        .filter((l) => /^\s*import\s/.test(l))
        .slice(0, 15)
      if (imports.length > 0) {
        lines.push(`\nImports in the file:`)
        for (const imp of imports) lines.push(`  ${imp.trim()}`)
      }
    } catch {
      // non-fatal
    }
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

    // Safety: check for conflict markers in the result
    if (hasConflictMarkers(result)) {
      throw new Error("AI resolution still contains conflict markers. Manual resolution required.")
    }

    // Safety: check the result is not empty
    if (result.trim().length === 0) {
      throw new Error("AI produced an empty result. Manual resolution required.")
    }

    // Atomic write: temp file then replace
    const tmpPath = `${parsed.merged}.swiz-tmp`
    try {
      await Bun.write(tmpPath, result)

      // Verify the temp file was written correctly
      const written = readFileSync(tmpPath, "utf8")
      if (written !== result) {
        throw new Error("Temp file verification failed — content mismatch")
      }

      // Replace MERGED with the resolved content
      await Bun.write(parsed.merged, written)
    } finally {
      // Clean up temp file
      try {
        if (existsSync(tmpPath)) {
          const { unlinkSync } = await import("node:fs")
          unlinkSync(tmpPath)
        }
      } catch {
        // non-fatal cleanup
      }
    }

    console.error("✓ Conflict resolved successfully")
  },
}
