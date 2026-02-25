#!/usr/bin/env bun
// PreToolUse hook: Block banned Bash commands and guide to safe alternatives.

import { denyPreToolUse } from "./hook-utils.ts";

interface Rule {
  /** Returns true if this rule matches the command. */
  match: (command: string) => boolean;
  message: string;
}

const RULES: Rule[] = [
  {
    // grep as a command: at start of line or directly after a pipe (not inside quoted strings)
    match: (c) => /(?:^|\|\s*)grep\s/.test(c),
    message: [
      "Use `rg` (ripgrep) instead of `grep`. This is a project convention.",
      "",
      "rg is faster, respects .gitignore, and has better defaults:",
      "  • rg 'pattern'              — search recursively in current directory",
      "  • rg 'pattern' path/        — search in specific path",
      "  • rg -l 'pattern'           — list matching files only",
      "  • rg --type ts 'pattern'    — filter by file type",
      "  • Use the Grep tool         — preferred for codebase searches in Claude",
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
      const first = c.trimStart().split(/\s+/)[0];
      if (first === "rm" || first === "rmdir" || first === "unlink" || first === "shred") return true;
      if (/(?:\|\s*xargs\s+rm|&&\s*rm\b|;\s*rm\b)/.test(c)) return true;
      if (/find\s.*-delete/.test(c)) return true;
      if (/find\s.*-exec\s+rm\s/.test(c)) return true;
      return false;
    },
    message: [
      "Do not use destructive deletion commands. Files cannot be recovered.",
      "",
      "Use safe deletion instead:",
      "  • trash <path>         — moves to macOS Trash (recoverable)",
      "  • mv <path> ~/.Trash/  — manual fallback if trash unavailable",
      "",
      "See: /delete-safely skill for details.",
    ].join("\n"),
  },
  {
    match: (c) => /git\s+stash(\s|$)/.test(c),
    message: [
      "Do not use `git stash`. Stashed changes are easy to lose and add hidden state.",
      "",
      "Instead:",
      "  • Commit work-in-progress: `git commit -m \"wip: ...\"`",
      "  • Use the /commit skill to preserve your current state",
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
      "Do not use `python` or `python3`. Python is banned due to system compatibility",
      "concerns — the system Python version is unreliable across environments.",
      "",
      "Use `bun` instead — it is faster, ships a consistent runtime, and supports",
      "TypeScript natively without any setup:",
      "  • bun script.ts       — run a TypeScript or JavaScript file",
      "  • bun -e 'code here'  — evaluate an inline expression",
      "  • bun run <script>    — run a package.json script",
    ].join("\n"),
  },
];

const input = await Bun.stdin.json();
if (input?.tool_name !== "Bash") process.exit(0);

const command: string = input?.tool_input?.command ?? "";

for (const rule of RULES) {
  if (rule.match(command)) {
    denyPreToolUse(rule.message);
  }
}
