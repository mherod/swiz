#!/usr/bin/env bun
// PreToolUse hook: Block banned Bash commands and guide to safe alternatives.
// Rules with severity "warn" allow the command through with a gentle nudge.
// Rules with severity "deny" (default) block the command entirely.

import {
  allowPreToolUse,
  denyPreToolUse,
  detectPackageManager,
  detectRuntime,
  isShellTool,
  skillExists,
} from "./hook-utils.ts"
import { SHELL_SEGMENT_BOUNDARY, shellSegmentCommandRe } from "./utils/shell-patterns.ts"

const RUNTIME = detectRuntime()
const PM = detectPackageManager()

interface Rule {
  /** Returns true if this rule matches the command. */
  match: (command: string) => boolean
  message: string
  /** "deny" blocks the command. "warn" allows it with a hint. Default: "deny". */
  severity?: "deny" | "warn"
  /**
   * Set to true for rules that must inspect argument *content* (e.g. commit
   * message body) rather than command structure.  These rules receive the
   * original, unstripped command so quoted-string content is still visible.
   * All other rules receive the quote-stripped command to prevent false
   * positives when banned tokens appear inside string literals.
   */
  useRawCommand?: true
}

/**
 * Remove quoted string contents from a shell command so that git subcommand
 * patterns (e.g. `git restore`) don't match text embedded inside commit
 * messages (-m "..."), evidence args, or other flag values.
 *
 * Handles double-quoted and single-quoted spans.  Escape sequences inside
 * double-quoted strings are respected (\") so we don't prematurely end a span.
 * The replacement keeps an empty pair of quotes so spacing is preserved and
 * the remaining tokens stay at roughly the right positions.
 */
function stripQuotedStrings(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''")
}

const GREP_CMD_RE = /(?:^|\|\s*)grep\s/
const CD_CMD_RE = shellSegmentCommandRe("cd(?:\\s|$)")
const FIND_CMD_RE = shellSegmentCommandRe("find\\s")
const AWK_CMD_RE = shellSegmentCommandRe("awk\\s")
// Only block sed when it writes files in-place (-i flag) or redirects output to a file.
// Read-only sed (e.g. sed -n '...' file, sed '...' file | ...) is permitted.
const SED_INPLACE_RE = shellSegmentCommandRe("sed\\s+(?:[^-]|-[^-])*-[a-zA-Z]*i")
const SED_REDIRECT_RE = shellSegmentCommandRe("sed\\s[^|;&]*>\\s*\\S")
const TOUCH_CMD_RE = shellSegmentCommandRe("touch(?:\\s|$)")
const PYTHON_CMD_RE = shellSegmentCommandRe("python3?(?:\\s|$)")
const NODE_TS_NODE_CMD_RE = shellSegmentCommandRe("(node|ts-node)\\s")

const RULES: Rule[] = [
  {
    // grep as a command: at start of line or directly after a pipe (not inside quoted strings)
    match: (c) => GREP_CMD_RE.test(c),
    severity: "warn",
    message: [
      "Tip: prefer `rg` (ripgrep) over `grep` — it's faster and respects .gitignore.",
      "  rg 'pattern'  |  rg -l 'pattern'  |  rg --type ts 'pattern'",
    ].join("\n"),
  },
  {
    match: (c) => CD_CMD_RE.test(c),
    message: [
      "Do not use `cd`. Changing directory loses workspace context.",
      "",
      "Instead, use one of these approaches:",
      "  • Absolute paths: `git status /path/to/repo`",
      "  • Tool directory flags: `git -C /repo status`, `pnpm --prefix /path test`",
      "  • Workspace filters: `pnpm --filter @scope/app test` (for monorepos)",
      "  • Read tool: Use Read or Glob tools for file operations (no cd needed)",
    ].join("\n"),
  },
  {
    match: (c) => FIND_CMD_RE.test(c),
    severity: "warn",
    message: [
      "Tip: prefer `fd` or the Glob tool over `find` — faster and respects .gitignore.",
      "  fd 'pattern'  |  fd -e ts  |  Glob tool for codebase file discovery",
    ].join("\n"),
  },
  {
    match: (c) => AWK_CMD_RE.test(c),
    message: [
      "Do not use `awk` for file processing. It produces unreviewed changes.",
      "",
      "Instead, use the Edit tool for file modifications:",
      "  • Edit tool: precise old_string → new_string replacements (preferred)",
      "  • For data extraction, consider `bun -e` with a TypeScript one-liner",
    ].join("\n"),
  },
  {
    match: (c) => SED_INPLACE_RE.test(c) || SED_REDIRECT_RE.test(c),
    message: [
      "Do not use `sed` to write or edit files. It is unreliable and produces unreviewed changes.",
      "",
      "Instead, use the Edit tool for file modifications:",
      "  • Edit tool: precise old_string → new_string replacements (preferred)",
      "  • Write tool: overwrite a file with entirely new content",
      "",
      "Read-only sed usage (e.g. `sed -n '...' file` in a pipeline) is allowed.",
    ].join("\n"),
  },
  {
    // rm as standalone command (not git rm, cargo rm, etc.) or in pipe chains,
    // plus find -delete, find -exec rm, unlink, shred, rmdir
    match: (c) => {
      const first = c.trimStart().split(/\s+/)[0]
      if (first === "rm" || first === "rmdir" || first === "unlink" || first === "shred")
        return true
      if (/(?:\|\s*xargs\s+rm|&&\s*rm\b|;\s*rm\b)/.test(c)) return true
      if (/find\s.*-delete/.test(c)) return true
      if (/find\s.*-exec\s+rm\s/.test(c)) return true
      return false
    },
    message: [
      "Do not use destructive deletion commands. Files cannot be recovered.",
      "",
      "Use safe deletion instead:",
      "  • trash <path>         — moves to macOS Trash (recoverable)",
      "  • mv <path> ~/.Trash/  — manual fallback if trash unavailable",
      ...(skillExists("delete-safely") ? ["", "See the /delete-safely skill for details."] : []),
    ].join("\n"),
  },
  {
    match: (c) => /git\s+stash(\s|$)/.test(c),
    message: [
      "Do not use `git stash`. Stashed changes are easy to lose and add hidden state.",
      "",
      "Instead:",
      '  • Commit work-in-progress: `git commit -m "wip: ..."`',
      ...(skillExists("commit")
        ? ["  • Use the /commit skill to preserve your current state"]
        : []),
      "  • If you need a clean slate, commit first, then revert in a new commit",
    ].join("\n"),
  },
  {
    match: (c) => /git\s+restore(\s|$)/.test(c),
    message: [
      "Do not use `git restore`. It silently discards uncommitted changes.",
      "",
      "Instead:",
      "  • Use the Edit tool to undo specific changes in a file",
      "  • Read the file first, then apply targeted corrections",
      "  • If you want to revert a commit, use `git revert <hash>` (preserves history)",
    ].join("\n"),
  },
  {
    match: (c) => /git\s+reset\s+--hard/.test(c),
    message: [
      "Do not use `git reset --hard`. It permanently destroys uncommitted changes.",
      "",
      "Instead:",
      "  • `git revert <hash>`  — undo a commit by adding a new inverse commit",
      "  • `git reset HEAD~1`   — soft reset: keeps changes staged (recoverable)",
      "  • Edit tool            — undo specific file changes manually",
    ].join("\n"),
  },
  {
    match: (c) => /git\s+clean(\s|$)/.test(c),
    message: [
      "Do not use `git clean`. It permanently deletes untracked files.",
      "",
      "Instead:",
      "  • `git clean -n`  — dry run: see what would be deleted first",
      "  • trash <file>    — move specific files to Trash (recoverable)",
      "  • Review untracked files with `git status` before deleting anything",
    ].join("\n"),
  },
  {
    match: (c) => /git\s+checkout\s+(?:\S+\s+)?--\s+\S+/.test(c),
    message: [
      "Do not use `git checkout -- <file-or-glob>` or `git checkout <ref-or-hash> -- <file-or-glob>`. They silently discard file changes.",
      "",
      "Instead:",
      "  • Use the Edit tool to undo specific changes in a file",
      "  • Read the file, identify what to revert, then apply a targeted edit",
      "  • `git revert <hash>`  — undo an entire commit safely",
    ].join("\n"),
  },
  {
    match: (c) => TOUCH_CMD_RE.test(c),
    message: [
      "Do not use `touch` to create files. Use the Write tool instead.",
      "",
      "The Write tool is tracked, reviewable, and works for both empty and populated files:",
      "  • Write tool: create or overwrite a file with specific content",
      "  • Edit tool:  modify an existing file with targeted changes",
    ].join("\n"),
  },
  {
    match: (c) => PYTHON_CMD_RE.test(c),
    message: [
      "Do not use `python` or `python3`. The system Python version is unreliable",
      "across environments.",
      "",
      `Use \`${RUNTIME}\` instead — it ships a consistent runtime:`,
      ...(RUNTIME === "bun"
        ? [
            "  • bun script.ts       — run a TypeScript or JavaScript file",
            "  • bun -e 'code here'  — evaluate an inline expression",
          ]
        : [
            "  • node script.js      — run a JavaScript file",
            "  • npx ts-node file.ts — run TypeScript (with ts-node)",
          ]),
    ].join("\n"),
  },
  ...((PM === "bun"
    ? [
        {
          match: (c: string) => NODE_TS_NODE_CMD_RE.test(c),
          message: [
            "Do not use `node` or `ts-node`. This project uses bun.",
            "",
            "bun is the project-standard runtime — native TypeScript, faster startup:",
            "  • bun script.ts       — run a TypeScript or JavaScript file",
            "  • bun -e 'code here'  — evaluate an inline expression",
            "  • bun run <script>    — run a package.json script",
            "  • bun test            — run tests",
          ].join("\n"),
        },
      ]
    : []) as Rule[]),
  {
    match: (c) => /git\s+commit\b.*--no-verify/.test(c) || /git\s+push\b.*--no-verify/.test(c),
    message: [
      "Do not use `--no-verify`. It bypasses pre-commit hooks and safety mechanisms.",
      "",
      "Address the underlying issue flagged by the hooks instead of circumventing them.",
    ].join("\n"),
  },
  {
    // --trailer is a flag on the git command itself, not inside a quoted string.
    match: (c) => /git\s+.*--trailer/.test(c),
    message: [
      "Do not use `--trailer` with git. AI tools use this to inject co-authorship signatures.",
      "",
      "Create commits without trailer attribution.",
    ].join("\n"),
  },
  {
    // Co-authored-by appears *inside* the quoted commit message, so this rule
    // needs the raw (unstripped) command to see the message body.
    useRawCommand: true,
    match: (c) => {
      const mMatch = c.match(/git\s+commit\s.*-m\s+["']([^"']*)/)
      if (!mMatch) return false
      return /Co-authored-by:/i.test(mMatch[1] ?? "")
    },
    message: [
      "Do not include `Co-authored-by:` in commit messages.",
      "",
      "Create commits without co-author attribution.",
    ].join("\n"),
  },
  {
    match: (c) => /gh\s+.*--admin/.test(c),
    message: [
      "Do not use `gh --admin`. It bypasses repository protection rules and required checks.",
      "",
      "Ensure PRs pass all required checks and obtain proper approvals.",
    ].join("\n"),
  },
]

const input = await Bun.stdin.json()
if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

const command: string = input?.tool_input?.command ?? ""

// Strip quoted string contents once before any rule matching so that banned
// patterns embedded inside commit messages, evidence args, or other quoted
// flag values never trigger a false positive.  The original `command` is kept
// for reporter correction output which must reference the real command text.
const strippedCommand = stripQuotedStrings(command)

const warnings: string[] = []

for (const rule of RULES) {
  // Content-inspection rules (useRawCommand) see the original command so they
  // can read quoted argument bodies.  All other rules see the stripped command
  // to avoid false positives on banned tokens embedded in string literals.
  if (!rule.match(rule.useRawCommand ? command : strippedCommand)) continue

  if (rule.severity === "warn") {
    warnings.push(rule.message)
  } else {
    denyPreToolUse(rule.message)
  }
}

// Reporter normalization: bun test only supports 'dots' and 'junit'.
// Split the command into per-invocation segments at chain operators (|, &, ;)
// so we never match --reporter flags outside a bun test invocation.
const SUPPORTED_BUN_REPORTERS = new Set(["dots", "junit"])
const BUN_TEST_SEGMENT_RE = new RegExp(`${SHELL_SEGMENT_BOUNDARY}\\s*bun\\s+test\\b([^|;&]*)`, "g")
for (const segMatch of command.matchAll(BUN_TEST_SEGMENT_RE)) {
  const segment = segMatch[1] ?? ""
  // Collect ALL --reporter/-r occurrences in this segment so we can apply
  // Bun's last-flag-wins semantics: only the final value matters.
  // Matches --reporter and its short alias -r, with optional escaped or unescaped
  // surrounding quotes: --reporter=value, --reporter value, --reporter='v', -r="v",
  // --reporter=\'v\', -r verbose, etc.
  const REPORTER_FLAG_RE = /(?:--reporter|-r)(?:=|\s+)(\\?['"]?)([a-z][a-z0-9-]*)\1/g
  const reporterMatches = [...segment.matchAll(REPORTER_FLAG_RE)]
  if (reporterMatches.length === 0) continue
  // Last match wins — earlier flags are overridden by later ones.
  const reporter = reporterMatches[reporterMatches.length - 1]?.[2]
  if (reporter && !SUPPORTED_BUN_REPORTERS.has(reporter)) {
    // Replace every unsupported --reporter/-r occurrence across the full command.
    // Closing group is \\?['"]? (backslash-then-quote) to mirror the opening sequence.
    const corrected = command.replace(
      /(?:--reporter|-r)(?:=|\s+)\\?['"]?[a-z][a-z0-9-]*\\?['"]?/g,
      "--reporter=dots"
    )
    denyPreToolUse(
      `Bun only supports 'dots' and 'junit' reporters — '${reporter}' is not valid.\n\n` +
        `Use this corrected command instead:\n  ${corrected}`
    )
  }
}

// Emit collected warnings as allow-with-hint (doesn't block the command)
if (warnings.length > 0) {
  allowPreToolUse(warnings.join("\n\n"))
}
