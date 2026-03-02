#!/usr/bin/env bun
// PreToolUse hook: Block banned Bash commands and guide to safe alternatives.
// Rules with severity "warn" allow the command through with a gentle nudge.
// Rules with severity "deny" (default) block the command entirely.

import {
  denyPreToolUse,
  detectPackageManager,
  detectRuntime,
  isShellTool,
  skillExists,
} from "./hook-utils.ts"

const RUNTIME = detectRuntime()
const PM = detectPackageManager()

interface Rule {
  /** Returns true if this rule matches the command. */
  match: (command: string) => boolean
  message: string
  /** "deny" blocks the command. "warn" allows it with a hint. Default: "deny". */
  severity?: "deny" | "warn"
}

const RULES: Rule[] = [
  {
    // grep as a command: at start of line or directly after a pipe (not inside quoted strings)
    match: (c) => /(?:^|\|\s*)grep\s/.test(c),
    severity: "warn",
    message: [
      "Tip: prefer `rg` (ripgrep) over `grep` — it's faster and respects .gitignore.",
      "  rg 'pattern'  |  rg -l 'pattern'  |  rg --type ts 'pattern'",
    ].join("\n"),
  },
  {
    match: (c) => /(?:^|[|;&])\s*cd(\s|$)/.test(c),
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
    match: (c) => /(?:^|[|;&])\s*find\s/.test(c),
    severity: "warn",
    message: [
      "Tip: prefer `fd` or the Glob tool over `find` — faster and respects .gitignore.",
      "  fd 'pattern'  |  fd -e ts  |  Glob tool for codebase file discovery",
    ].join("\n"),
  },
  {
    match: (c) => /(?:^|[|;&])\s*awk\s/.test(c),
    message: [
      "Do not use `awk` for file processing. It produces unreviewed changes.",
      "",
      "Instead, use the Edit tool for file modifications:",
      "  • Edit tool: precise old_string → new_string replacements (preferred)",
      "  • For data extraction, consider `bun -e` with a TypeScript one-liner",
    ].join("\n"),
  },
  {
    match: (c) => /(?:^|[|;&])\s*sed\s/.test(c),
    message: [
      "Do not use `sed` to edit files. It is unreliable and produces unreviewed changes.",
      "",
      "Instead, use the Edit tool for file modifications:",
      "  • Edit tool: precise old_string → new_string replacements (preferred)",
      "  • Write tool: overwrite a file with entirely new content",
      "",
      "If you need sed for non-edit stream transformation in a pipeline where output",
      "is not written to a file, reconsider if a dedicated tool covers it.",
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
    match: (c) => /git\s+checkout\s+--/.test(c),
    message: [
      "Do not use `git checkout -- <file>`. It silently discards file changes.",
      "",
      "Instead:",
      "  • Use the Edit tool to undo specific changes in a file",
      "  • Read the file, identify what to revert, then apply a targeted edit",
      "  • `git revert <hash>`  — undo an entire commit safely",
    ].join("\n"),
  },
  {
    match: (c) => /(?:^|[|;&])\s*touch(\s|$)/.test(c),
    message: [
      "Do not use `touch` to create files. Use the Write tool instead.",
      "",
      "The Write tool is tracked, reviewable, and works for both empty and populated files:",
      "  • Write tool: create or overwrite a file with specific content",
      "  • Edit tool:  modify an existing file with targeted changes",
    ].join("\n"),
  },
  {
    match: (c) => /(?:^|[|;&])\s*python3?(\s|$)/.test(c),
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
          match: (c: string) => /(?:^|[|;&])\s*(node|ts-node)\s/.test(c),
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
    match: (c) => /git\s+.*--trailer/.test(c),
    message: [
      "Do not use `--trailer` with git. AI tools use this to inject co-authorship signatures.",
      "",
      "Create commits without trailer attribution.",
    ].join("\n"),
  },
  {
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

const warnings: string[] = []

for (const rule of RULES) {
  if (!rule.match(command)) continue

  if (rule.severity === "warn") {
    warnings.push(rule.message)
  } else {
    denyPreToolUse(rule.message)
  }
}

// Reporter normalization: bun test only supports 'dots' and 'junit'
const SUPPORTED_BUN_REPORTERS = new Set(["dots", "junit"])
const reporterMatch = command.match(/(?:^|[|;&])\s*bun\s+test\b.*?--reporter[= ]([a-z][a-z0-9-]*)/)
if (reporterMatch) {
  const reporter = reporterMatch[1]
  if (reporter && !SUPPORTED_BUN_REPORTERS.has(reporter)) {
    const corrected = command.replace(/--reporter[= ]\S+/, "--reporter=dots")
    denyPreToolUse(
      `Bun only supports 'dots' and 'junit' reporters — '${reporter}' is not valid.\n\n` +
        `Use this corrected command instead:\n  ${corrected}`
    )
  }
}

// Emit collected warnings as allow-with-hint (doesn't block the command)
if (warnings.length > 0) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: warnings.join("\n\n"),
      },
    })
  )
}
