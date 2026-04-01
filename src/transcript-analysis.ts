import { isToolResultSummaryBlock, summarizeToolCalls } from "./transcript-analysis-parse-part1.ts"
import { parseTranscriptEntries } from "./transcript-analysis-parse-part2.ts"
import { extractToolResultText, isHookFeedback } from "./transcript-extract.ts"
import type {
  ContentBlock,
  PlainTurn,
  Session,
  TextBlock,
  TranscriptData,
} from "./transcript-schemas.ts"
import { isTextBlockWithText, toolUseBlockSchema } from "./transcript-schemas.ts"
import { GIT_GLOBAL_OPTS } from "./utils/shell-patterns.ts"

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
}

function extractCommandMessage(text: string, sentinel: string): string | null {
  if (!text.startsWith("<command-message>") || !text.includes(sentinel)) return null
  return text
    .replace(/^<command-message>\s*/i, "")
    .replace(/<\/command-message>\s*$/i, "")
    .trim()
}

export function findHumanRequiredBlock(transcriptText: string, limit = 20): string | null {
  const entries: Array<{ type?: string; message?: { role?: string; content?: unknown } }> = []
  for (const entry of parseTranscriptEntries(transcriptText)) {
    entries.push(entry)
  }
  const recent = entries.slice(-limit)
  for (let i = recent.length - 1; i >= 0; i--) {
    const entry = recent[i]!
    if (entry.type === "assistant") return null
    if (entry.type === "user") {
      const text = extractContentText(entry.message?.content)
      const result = extractCommandMessage(text, "ACTION REQUIRED:")
      if (result) return result
    }
  }
  return null
}
function buildArrayContentText(content: unknown[], entryType: string): string {
  let text = content
    .filter(isTextBlockWithText)
    .map((b) => b.text)
    .join("\n")

  const toolSummary = summarizeToolCalls(content)
  if (toolSummary) text = text ? `${text}\n${toolSummary}` : toolSummary

  if (entryType === "user") {
    const resultTexts = content
      .filter(isToolResultSummaryBlock)
      .map((b) => extractToolResultText(b))
      .filter(Boolean)
    if (resultTexts.length > 0) {
      const resultSummary = resultTexts.map((t) => `[Result: ${t}]`).join("\n")
      text = text ? `${text}\n${resultSummary}` : resultSummary
    }
  }

  return text
}

function extractEntryText(content: unknown, entryType: string): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return buildArrayContentText(content, entryType)
  return ""
}

export function extractPlainTurns(transcriptText: string): PlainTurn[] {
  const turns: PlainTurn[] = []

  for (const entry of parseTranscriptEntries(transcriptText)) {
    const entryType = entry?.type
    if (entryType !== "user" && entryType !== "assistant") continue
    const content = entry.message?.content
    if (!content) continue
    if (entryType === "user" && isHookFeedback(content)) continue

    const text = extractEntryText(content, entryType).trim()
    if (text) turns.push({ role: entryType, text })
  }

  return turns
}

// ─── Tool call counting ──────────────────────────────────────────────────────

export function countToolCalls(jsonlText: string): number {
  let count = 0
  for (const entry of parseTranscriptEntries(jsonlText)) {
    if (entry?.type !== "assistant") continue
    const content = entry?.message?.content
    if (!Array.isArray(content)) continue
    count += content.filter((b: { type?: string }) => b?.type === "tool_use").length
  }
  return count
}

// ─── Edited file path extraction ─────────────────────────────────────────────

// Matches file-modifying shell commands and captures path arguments.
// Covers: trash <path>, rm <path>, mv <src> <dst>, cp <src> <dst>,
// ln [-s|-f] <src> <dst>, link <src> <dst>,
// git mv <src> <dst>, git rm <path>.
// Paths may be quoted (single or double) or unquoted.
const SHELL_FILE_MOD_RE =
  /(?:^|[|;&\s])(?:trash\s+|rm\s+(?:-[rfRF]+\s+)*|mv\s+|cp\s+|ln\s+(?:-\S+\s+)*|link\s+|git\s+(?:mv|rm)\s+)((?:"[^"]*"|'[^']*'|[^\s|;&"']+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"']+))*)/gm

// Matches output redirections that write to a file: > file or >> file.
// Excludes: >& (fd dup), >( (process substitution), >&- (close fd).
// Captures the target path (quoted or unquoted).
const REDIRECT_WRITE_RE = />>?(?![&(])\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s|;&"'>]+)/gm

// Matches sed -i (in-place edit): sed -i[.suffix] 's/.../.../' <file> ...
// Handles: -i (GNU), -i.bak (attached suffix), -i '' (BSD empty suffix).
// Captures all path tokens after the script argument.
const SED_INPLACE_RE =
  /(?:^|[|;&\s])sed\s+(?:-[a-zA-Z]*i(?:\.[^\s]*)?\s+(?:''|"")?\s?|--in-place(?:=\S+)?\s+)(?:'[^']*'|"[^"]*"|\S+)\s+((?:"[^"]*"|'[^']*'|[^\s|;&"']+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"']+))*)/gm

// Matches tee command file targets: tee [-a] [--] <file> [file2 ...]
// Excludes process substitution targets >(cmd).
const TEE_RE =
  /(?:^|[|;&\s])tee\s+(?:-a\s+|--\s+)?((?:"[^"]*"|'[^']*'|[^\s|;&"'>(][^\s|;&"']*)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"'>(][^\s|;&"']*))*)/gm

// Matches touch, truncate, mkdir, and rmdir file/directory targets.
// touch [-t] <file> [file2 ...], truncate [-s size] <file>,
// mkdir [-p] [-m mode] <dir> [dir2 ...], rmdir [-p] <dir> [dir2 ...].
const TOUCH_TRUNCATE_INSTALL_RE =
  /(?:^|[|;&\s])(?:touch|truncate|mkdir|rmdir)\s+(?:-\S+\s+)*((?:"[^"]*"|'[^']*'|[^\s|;&"']+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"']+))*)/gm

// Matches chmod and chown file targets: chmod [-R] <mode> <file> [file2 ...]
// and chown [-R] <owner>[:<group>] <file> [file2 ...].
// The first non-flag argument (mode or owner spec) is NOT a path — captured in group 1.
// Path arguments follow in group 2 (one or more, quoted or unquoted).
const CHMOD_CHOWN_RE =
  /(?:^|[|;&\s])(?:chmod|chown)\s+(?:-\S+\s+)*(?:"[^"]*"|'[^']*'|[^\s|;&"']+)\s+((?:"[^"]*"|'[^']*'|[^\s|;&"']+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"']+))*)/gm

// Matches install command positional file targets: install [-m mode] [-o owner] [-g group] src... dest
// Flags with values (-m 755, -o root, -g wheel, -S suffix) are consumed by the prefix;
// remaining tokens include source and destination paths.
// Note: -t / --target-directory destination is handled separately by INSTALL_TARGET_DIR_RE.
const INSTALL_CMD_RE =
  /(?:^|[|;&\s])install\s+(?:(?:-[mogtS]\s+\S+|-\S+)\s+)*((?:"[^"]*"|'[^']*'|[^\s|;&"']+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"']+))*)/gm

// Extracts the destination directory from install -t <dir> or install --target-directory=<dir>.
// Group 1 captures the -t value; group 2 captures the --target-directory= value.
const INSTALL_TARGET_DIR_RE =
  /(?:^|[|;&\s])install\b[^|;&]*?(?:-t\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s|;&"']+)|--target-directory=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s|;&"']+))/gm

// Extracts the destination directory from cp/mv -t <dir> or cp/mv --target-directory=<dir>.
// Both cp and mv support this GNU long-form flag. Group 1 = -t value; group 2 = --target-directory= value.
const CP_MV_TARGET_DIR_RE =
  /(?:^|[|;&\s])(?:cp|mv)\b[^|;&]*?(?:-t\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s|;&"']+)|--target-directory=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s|;&"']+))/gm

// Matches git [opts] checkout <tree-ish> -- <file> [file2 ...] patterns that overwrite working-tree files.
// The -- separator is required; everything after it is a path.
// Captures all tokens after the -- in group 1.
// Supports git global options like -C <dir> between git and checkout.
const GIT_CHECKOUT_FILES_RE = new RegExp(
  `(?:^|[|;&\\s])git\\s+${GIT_GLOBAL_OPTS}checkout\\b[^|;&]*?--\\s+((?:"[^"]*"|'[^']*'|[^\\s|;&"']+)(?:\\s+(?:"[^"]*"|'[^']*'|[^\\s|;&"']+))*)`,
  "gm"
)

// Matches git [opts] restore <file> [file2 ...] patterns that restore working-tree or staged files.
// Skips --source=<tree>, --staged, --worktree, and other flags; captures remaining path tokens.
// Supports git global options like -C <dir> between git and restore.
const GIT_RESTORE_RE = new RegExp(
  `(?:^|[|;&\\s])git\\s+${GIT_GLOBAL_OPTS}restore\\s+(?:(?:--source=\\S+|--staged|--worktree|-\\S+)\\s+)*((?:"[^"]*"|'[^']*'|[^\\s|;&"']+)(?:\\s+(?:"[^"]*"|'[^']*'|[^\\s|;&"']+))*)`,
  "gm"
)

// Matches patch <file> positional target: patch [-p<n>] [--dry-run] [flags] <file>
// Also handles patch -i <patchfile> <file> where -i consumes the patchfile argument.
// Captures the trailing path arguments (the files being patched) in group 1.
// Note: `patch < patchfile` rewrites paths embedded in the patch — not capturable here.
const PATCH_CMD_RE =
  /(?:^|[|;&\s])patch\s+(?:(?:-i\s+(?:"[^"]*"|'[^']*'|\S+)|--input=(?:"[^"]*"|'[^']*'|\S+)|-\S+)\s+)*((?:"[^"]*"|'[^']*'|[^\s|;&"'<>]+)(?:\s+(?:"[^"]*"|'[^']*'|[^\s|;&"'<>]+))*)/gm

// Tokenizes a shell argument string respecting single and double quoting.
// "my file.ts" and 'my file.ts' are returned as single tokens (quotes stripped).
// Unquoted whitespace is the delimiter. Flag tokens starting with '-' are excluded.
const SHELL_TOKEN_RE = /"([^"]*)"|'([^']*)'|([^\s]+)/g

function shellTokens(args: string): string[] {
  const tokens: string[] = []
  SHELL_TOKEN_RE.lastIndex = 0
  for (const m of args.matchAll(SHELL_TOKEN_RE)) {
    // Group 1 = double-quoted content, 2 = single-quoted content, 3 = unquoted token
    const token = m[1] ?? m[2] ?? m[3] ?? ""
    if (token && !token.startsWith("-")) tokens.push(token)
  }
  return tokens
}

// Regexes that extract file paths from group 1
const SINGLE_GROUP_PATH_REGEXES: RegExp[] = [
  SHELL_FILE_MOD_RE,
  REDIRECT_WRITE_RE,
  SED_INPLACE_RE,
  TEE_RE,
  TOUCH_TRUNCATE_INSTALL_RE,
  CHMOD_CHOWN_RE,
  INSTALL_CMD_RE,
  GIT_CHECKOUT_FILES_RE,
  GIT_RESTORE_RE,
  PATCH_CMD_RE,
]

// Regexes that extract file paths from group 1 or group 2 (whichever matched)
const DUAL_GROUP_PATH_REGEXES: RegExp[] = [INSTALL_TARGET_DIR_RE, CP_MV_TARGET_DIR_RE]

function collectRegexPaths(
  results: string[],
  command: string,
  regex: RegExp,
  useDualGroup: boolean
): void {
  regex.lastIndex = 0
  for (const m of command.matchAll(regex)) {
    const raw = useDualGroup ? (m[1] ?? m[2])?.trim() : m[1]?.trim()
    if (raw) for (const t of shellTokens(raw)) results.push(t)
  }
}

function extractPathsFromCommand(command: string): string[] {
  const results: string[] = []
  for (const regex of SINGLE_GROUP_PATH_REGEXES) {
    collectRegexPaths(results, command, regex, false)
  }
  for (const regex of DUAL_GROUP_PATH_REGEXES) {
    collectRegexPaths(results, command, regex, true)
  }
  return results
}

/**
 * Returns the set of file paths that were written, edited, deleted, or renamed
 * in the transcript. Covers:
 *   - Edit / Write / MultiEdit tool_use blocks (file_path / path input)
 *   - Bash tool_use blocks with file-modifying shell commands:
 *       trash, rm, mv, cp, ln, link, git mv/rm (deletions/renames/links)
 *       output redirections: > file, >> file (echo, cat, heredoc, etc.)
 *       sed -i in-place edits: sed -i 's/.../.../' file
 *       tee file targets: cmd | tee [-a] file [file2 ...]
 *       touch / truncate / mkdir / rmdir targets
 *       chmod / chown file targets: chmod [-R] <mode> <file>, chown [-R] <owner> <file>
 *       install command targets: install [-m mode] src... dest, install -t destdir src...,
 *         install --target-directory=destdir src...
 *       cp / mv -t / --target-directory destination directory
 *       git checkout <tree-ish> -- <file>: overwrites working-tree files
 *       git restore [--source=<tree>] <file>: restores working-tree/staged files
 *       patch [flags] <file>: applies a patch to a target file
 *
 * Used to detect docs-only sessions before invoking the LLM so the analysis
 * can be scoped correctly.
 */
export function extractEditedFilePaths(jsonlText: string): Set<string> {
  const paths = new Set<string>()

  for (const entry of parseTranscriptEntries(jsonlText)) {
    if (entry?.type !== "assistant") continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      const result = toolUseBlockSchema.safeParse(block)
      if (!result.success) continue
      collectEditedPath(result.data, paths)
    }
  }

  return paths
}

/**
 * Returns true when every file edited in the transcript is a documentation
 * or configuration file — meaning no source code was modified this session.
 * An empty set (no file edits at all) returns false (not "docs-only").
 */
export function isDocsOnlySession(editedPaths: Set<string>): boolean {
  if (editedPaths.size === 0) return false
  const DOC_EXT_RE = /\.(md|mdx|txt|rst|adoc|asciidoc|json|yaml|yml|toml|ini|env|cfg|conf)$/i
  const DOC_NAME_RE = /^(changelog|readme|contributing|license|authors|notice|todo)$/i
  for (const p of editedPaths) {
    const base = p.split("/").pop() ?? p
    const nameNoExt = base.replace(/\.[^.]+$/, "")
    if (!DOC_EXT_RE.test(base) && !DOC_NAME_RE.test(nameNoExt)) return false
  }
  return true
}

// ─── Combined single-pass extraction ─────────────────────────────────────────
// Performs one `parseTranscriptEntries` call and populates all three derived
// views: plain turns (for AI context), edited file paths (for docs-only check),
// and tool-call count (for the min-calls gate).
//
// Use this in stop hooks instead of calling extractPlainTurns + extractEditedFilePaths
// + countToolCalls separately to avoid three redundant full parses on large transcripts.

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"])
const SHELL_TOOLS = new Set(["Bash", "Shell"])

function collectEditToolPath(
  input: Record<string, any> | undefined,
  editedPaths: Set<string>
): void {
  const pathVal = input?.file_path ?? input?.path
  if (typeof pathVal === "string" && pathVal) editedPaths.add(pathVal)
}

function collectShellToolPaths(
  input: Record<string, any> | undefined,
  editedPaths: Set<string>
): void {
  const cmd = input?.command
  if (typeof cmd === "string" && cmd) {
    for (const p of extractPathsFromCommand(cmd)) editedPaths.add(p)
  }
}

function collectEditedPath(
  b: { name?: string; input?: Record<string, any> },
  editedPaths: Set<string>
): void {
  if (!b.name) return
  if (EDIT_TOOLS.has(b.name)) collectEditToolPath(b.input, editedPaths)
  else if (SHELL_TOOLS.has(b.name)) collectShellToolPaths(b.input, editedPaths)
}

function countAndCollectToolBlocks(content: unknown[], editedPaths: Set<string>): number {
  let count = 0
  for (const block of content) {
    const parseResult = toolUseBlockSchema.safeParse(block)
    if (!parseResult.success) continue
    count++
    collectEditedPath(parseResult.data, editedPaths)
  }
  return count
}

function isValidEntryType(type: string): type is "user" | "assistant" {
  return type === "user" || type === "assistant"
}

function processTranscriptEntry(
  entry: unknown,
  turns: PlainTurn[],
  editedPaths: Set<string>
): number {
  if (!entry) return 0
  const typed = entry as { type: string; message?: { content: unknown } }
  if (!isValidEntryType(typed.type)) return 0

  const content = typed.message?.content as string | ContentBlock[] | undefined
  const toolCount =
    typed.type === "assistant" && Array.isArray(content)
      ? countAndCollectToolBlocks(content, editedPaths)
      : 0

  if (!content || (typed.type === "user" && isHookFeedback(content))) return toolCount

  const text = extractEntryText(content, typed.type).trim()
  if (text) turns.push({ role: typed.type, text })
  return toolCount
}

export function extractTranscriptData(
  jsonlText: string,
  formatHint?: Session["format"]
): TranscriptData {
  const turns: PlainTurn[] = []
  const editedPaths = new Set<string>()
  let toolCallCount = 0

  for (const entry of parseTranscriptEntries(jsonlText, formatHint)) {
    toolCallCount += processTranscriptEntry(entry, turns, editedPaths)
  }

  return { turns, editedPaths, toolCallCount }
}

// ─── Context formatting ──────────────────────────────────────────────────────
// Formats plain turns into a labeled conversation string for LLM prompts.

export function formatTurnsAsContext(turns: PlainTurn[]): string {
  return turns
    .map(({ role, text }) => `${role === "user" ? "User" : "Assistant"}: ${text}`)
    .join("\n\n")
}
