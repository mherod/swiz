#!/usr/bin/env bun
// PreToolUse hook: Block banned Bash commands and guide to safe alternatives.
// Rules with severity "warn" allow the command through with a gentle nudge.
// Rules with severity "deny" (default) block the command entirely.

import {
  allowPreToolUse,
  denyPreToolUse,
  detectPackageManager,
  isShellTool,
  skillExists,
} from "./hook-utils.ts"
import {
  SHELL_BRACE_EXPANSION_WRITE_RE,
  SHELL_HERESTRING_REDIRECT_RE,
  SHELL_PROC_SUB_WRITE_RE,
  SHELL_PROCESS_SUBSTITUTION_INPUT_RE,
  SHELL_SEGMENT_BOUNDARY,
  SHELL_TEE_PIPE_WRITE_RE,
  shellSegmentCommandRe,
} from "./utils/shell-patterns.ts"

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
// Only block awk when it writes output to a file (redirect or tee -i).
// Read-only awk (stdout extraction, --help, pipelines) is permitted.
const AWK_REDIRECT_RE = shellSegmentCommandRe("awk\\s[^|;&]*>\\s*\\S")
const AWK_TEE_INPLACE_RE = /awk\b.*\|\s*tee\s+-i\b/
// Only block sed when it writes files in-place (-i flag) or redirects output to a file.
// Read-only sed (e.g. sed -n '...' file, sed '...' file | ...) is permitted.
const SED_INPLACE_RE = shellSegmentCommandRe("sed\\s+(?:[^-]|-[^-])*-[a-zA-Z]*i")
const SED_REDIRECT_RE = shellSegmentCommandRe("sed\\s[^|;&]*>\\s*\\S")
const TOUCH_CMD_RE = shellSegmentCommandRe("touch(?:\\s|$)")
const PYTHON_CMD_RE = shellSegmentCommandRe("python3?(?:\\s|$)")
const NODE_TS_NODE_CMD_RE = shellSegmentCommandRe("(node|ts-node)\\s")

// Generic shell output redirects to files — excludes fd-to-fd (2>&1) and /dev/ paths.
// Matches: plain > / >>, &> / &>>, numbered N> / N>>, and noclobber-bypass >|.
// Safe fd-to-fd forms (2>&1, >&2) are excluded via lookbehind/lookahead guards.
// Lookaheads exclude: fd-to-fd (&), /dev/ paths, process-substitution `>(cmd)` and `> >(cmd)`.
const SHELL_REDIRECT_PLAIN_RE = /(?<![0-9&])>>?(?!\s*\/dev\/)(?!\s*[&])(?!\s*>\()(?!\s*\()/
const SHELL_REDIRECT_BOTH_RE = /&>>?(?!\s*\/dev\/)(?!\s*[&>])/
const SHELL_REDIRECT_NUMBERED_RE = /\d>>?(?!\s*\/dev\/)(?!\s*[&>])/
// Matches tee writing to a named file (not /dev/ special paths).
const SHELL_TEE_WRITE_RE = /\btee\s+(?!\/dev\/)/
// Matches heredoc writes: `cat <<EOF > file` or `tee file <<EOF` patterns.
// Detects <<, <<-, or <<<  combined with a redirect to a named file (not /dev/).
const SHELL_HEREDOC_WRITE_RE = /<<-?\s*['"]?\w+['"]?[^|&;]*>(?!\s*[&>])(?!\s*\/dev\/)/

const DESTRUCTIVE_FIRST_CMDS = new Set(["rm", "rmdir", "unlink", "shred"])
const DESTRUCTIVE_CHAIN_RE = /(?:\|\s*xargs\s+rm|&&\s*rm\b|;\s*rm\b)/
const FIND_DELETE_RE = /find\s.*-delete/
const FIND_EXEC_RM_RE = /find\s.*-exec\s+rm\s/

function isDestructiveDelete(c: string): boolean {
  const first = c.trimStart().split(/\s+/)[0]
  if (DESTRUCTIVE_FIRST_CMDS.has(first ?? "")) return true
  return DESTRUCTIVE_CHAIN_RE.test(c) || FIND_DELETE_RE.test(c) || FIND_EXEC_RM_RE.test(c)
}

function isShellFileWrite(c: string): boolean {
  return (
    SHELL_REDIRECT_PLAIN_RE.test(c) ||
    SHELL_REDIRECT_BOTH_RE.test(c) ||
    SHELL_REDIRECT_NUMBERED_RE.test(c) ||
    SHELL_TEE_WRITE_RE.test(c) ||
    SHELL_TEE_PIPE_WRITE_RE.test(c) ||
    SHELL_PROC_SUB_WRITE_RE.test(c) ||
    SHELL_PROCESS_SUBSTITUTION_INPUT_RE.test(c) ||
    SHELL_HERESTRING_REDIRECT_RE.test(c) ||
    SHELL_HEREDOC_WRITE_RE.test(c) ||
    SHELL_BRACE_EXPANSION_WRITE_RE.test(c)
  )
}

function buildShellToolRules(): Rule[] {
  return [
    {
      match: (c) => GREP_CMD_RE.test(c),
      severity: "warn",
      message:
        "Tip: prefer `rg` (ripgrep) over `grep` — it's faster and respects .gitignore.\n  rg 'pattern'  |  rg -l 'pattern'  |  rg --type ts 'pattern'",
    },
    {
      match: (c) => CD_CMD_RE.test(c),
      message:
        "Do not use `cd`. Changing directory loses workspace context.\n\nInstead, use one of these approaches:\n  • Absolute paths: `git status /path/to/repo`\n  • Tool directory flags: `git -C /repo status`, `pnpm --prefix /path test`\n  • Workspace filters: `pnpm --filter @scope/app test` (for monorepos)\n  • Read tool: Use Read or Glob tools for file operations (no cd needed)",
    },
    {
      match: (c) => FIND_CMD_RE.test(c),
      severity: "warn",
      message:
        "Tip: prefer `fd` or the Glob tool over `find` — faster and respects .gitignore.\n  fd 'pattern'  |  fd -e ts  |  Glob tool for codebase file discovery",
    },
    {
      match: (c) => AWK_REDIRECT_RE.test(c) || AWK_TEE_INPLACE_RE.test(c),
      message:
        "Do not use `awk` to write files. It produces unreviewed changes.\n\nInstead, use the Edit tool for file modifications:\n  • Edit tool: precise old_string → new_string replacements (preferred)\n  • For data extraction, `awk '{print $1}' file` and `awk --help` are allowed.",
    },
    {
      match: (c) => SED_INPLACE_RE.test(c) || SED_REDIRECT_RE.test(c),
      message:
        "Do not use `sed` to write or edit files. It is unreliable and produces unreviewed changes.\n\nInstead, use the Edit tool for file modifications:\n  • Edit tool: precise old_string → new_string replacements (preferred)\n  • Write tool: overwrite a file with entirely new content\n\nRead-only sed usage (e.g. `sed -n '...' file` in a pipeline) is allowed.",
    },
    {
      match: isShellFileWrite,
      message:
        "Do not use shell redirects (`>`, `>>`, `>|`, `&>`, `&>>`, `N>`, `N>>`) or `tee` to write files. These produce unreviewed, out-of-band changes.\n\nUse the Edit or Write tools instead:\n  • Write tool: create or overwrite a file with specific content\n  • Edit tool:  modify an existing file with targeted changes\n\nSafe fd-to-fd redirects (`2>&1`, `>&2`) and output to `/dev/null` are still allowed.",
    },
    {
      match: isDestructiveDelete,
      message: [
        "Do not use destructive deletion commands. Files cannot be recovered.",
        "\nUse safe deletion instead:\n  • trash <path>         — moves to macOS Trash (recoverable)\n  • mv <path> ~/.Trash/  — manual fallback if trash unavailable",
        ...(skillExists("delete-safely") ? ["\nSee the /delete-safely skill for details."] : []),
      ].join(""),
    },
    {
      match: (c) => TOUCH_CMD_RE.test(c),
      message:
        "Do not use `touch` to create files. Use the Write tool instead.\n\nThe Write tool is tracked, reviewable, and works for both empty and populated files:\n  • Write tool: create or overwrite a file with specific content\n  • Edit tool:  modify an existing file with targeted changes",
    },
  ]
}

function buildGitRules(): Rule[] {
  return [
    {
      match: (c) => /git\s+stash(\s|$)/.test(c),
      message: [
        "Do not use `git stash`. Stashed changes are easy to lose and add hidden state.",
        '\nInstead:\n  • Commit work-in-progress: `git commit -m "wip: ..."`',
        ...(skillExists("commit")
          ? ["  • Use the /commit skill to preserve your current state"]
          : []),
        "  • If you need a clean slate, commit first, then revert in a new commit",
      ].join("\n"),
    },
    {
      match: (c) => /git\s+restore(\s|$)/.test(c),
      message:
        "Do not use `git restore`. It silently discards uncommitted changes.\n\nInstead:\n  • Use the Edit tool to undo specific changes in a file\n  • Read the file first, then apply targeted corrections\n  • If you want to revert a commit, use `git revert <hash>` (preserves history)",
    },
    {
      match: (c) => /git\s+reset\s+--hard/.test(c),
      message:
        "Do not use `git reset --hard`. It permanently destroys uncommitted changes.\n\nInstead:\n  • `git revert <hash>`  — undo a commit by adding a new inverse commit\n  • `git reset HEAD~1`   — soft reset: keeps changes staged (recoverable)\n  • Edit tool            — undo specific file changes manually",
    },
    {
      match: (c) => /git\s+clean(\s|$)/.test(c),
      message:
        "Do not use `git clean`. It permanently deletes untracked files.\n\nInstead:\n  • `git clean -n`  — dry run: see what would be deleted first\n  • trash <file>    — move specific files to Trash (recoverable)\n  • Review untracked files with `git status` before deleting anything",
    },
    {
      match: (c) => /git\s+checkout\s+(?:\S+\s+)?--\s+\S+/.test(c),
      message:
        "Do not use `git checkout -- <file-or-glob>` or `git checkout <ref-or-hash> -- <file-or-glob>`. They silently discard file changes.\n\nInstead:\n  • Use the Edit tool to undo specific changes in a file\n  • Read the file, identify what to revert, then apply a targeted edit\n  • `git revert <hash>`  — undo an entire commit safely",
    },
    {
      match: (c) => /git\s+commit\b.*--no-verify/.test(c) || /git\s+push\b.*--no-verify/.test(c),
      message:
        "Do not use `--no-verify`. It bypasses pre-commit hooks and safety mechanisms.\n\nAddress the underlying issue flagged by the hooks instead of circumventing them.",
    },
    {
      match: (c) => /git\s+.*--trailer/.test(c),
      message:
        "Do not use `--trailer` with git. AI tools use this to inject co-authorship signatures.\n\nCreate commits without trailer attribution.",
    },
    {
      useRawCommand: true,
      match: (c) => {
        const mMatch = c.match(/git\s+commit\s.*-m\s+["']([^"']*)/)
        return mMatch ? /Co-authored-by:/i.test(mMatch[1] ?? "") : false
      },
      message:
        "Do not include `Co-authored-by:` in commit messages.\n\nCreate commits without co-author attribution.",
    },
    {
      match: (c) => /gh\s+.*--admin/.test(c),
      message:
        "Do not use `gh --admin`. It bypasses repository protection rules and required checks.\n\nEnsure PRs pass all required checks and obtain proper approvals.",
    },
  ]
}

function buildRuntimeRules(pm: string | null, runtime: "bun" | "node"): Rule[] {
  const rules: Rule[] = [
    {
      match: (c) => PYTHON_CMD_RE.test(c),
      message:
        `Do not use \`python\` or \`python3\`. The system Python version is unreliable across environments.\n\nUse \`${runtime}\` instead — it ships a consistent runtime:\n` +
        (runtime === "bun"
          ? "  • bun script.ts       — run a TypeScript or JavaScript file\n  • bun -e 'code here'  — evaluate an inline expression"
          : "  • node script.js      — run a JavaScript file\n  • npx ts-node file.ts — run TypeScript (with ts-node)"),
    },
  ]
  if (pm === "bun") {
    rules.push({
      match: (c: string) => NODE_TS_NODE_CMD_RE.test(c),
      message:
        "Do not use `node` or `ts-node`. This project uses bun.\n\nbun is the project-standard runtime — native TypeScript, faster startup:\n  • bun script.ts       — run a TypeScript or JavaScript file\n  • bun -e 'code here'  — evaluate an inline expression\n  • bun run <script>    — run a package.json script\n  • bun test            — run tests",
    })
  }
  return rules
}

function buildRules(pm: string | null, runtime: "bun" | "node"): Rule[] {
  return [...buildShellToolRules(), ...buildGitRules(), ...buildRuntimeRules(pm, runtime)]
}

const SUPPORTED_BUN_REPORTERS = new Set(["dots", "junit"])
const BUN_TEST_SEGMENT_RE = new RegExp(`${SHELL_SEGMENT_BOUNDARY}\\s*bun\\s+test\\b([^|;&]*)`, "g")
const REPORTER_FLAG_RE = /(?:--reporter|-r)(?:=|\s+)(\\?['"]?)([a-z][a-z0-9-]*)\1/g

function checkBunTestReporter(command: string): void {
  for (const segMatch of command.matchAll(BUN_TEST_SEGMENT_RE)) {
    const segment = segMatch[1] ?? ""
    const reporterMatches = [...segment.matchAll(REPORTER_FLAG_RE)]
    if (reporterMatches.length === 0) continue
    const reporter = reporterMatches[reporterMatches.length - 1]?.[2]
    if (reporter && !SUPPORTED_BUN_REPORTERS.has(reporter)) {
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
}

function evaluateRules(rules: Rule[], command: string, strippedCommand: string): string[] {
  const warnings: string[] = []
  for (const rule of rules) {
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
  return warnings
}

async function main() {
  const PM = await detectPackageManager()
  const RUNTIME: "bun" | "node" = PM === "bun" ? "bun" : "node"
  const RULES = buildRules(PM, RUNTIME)

  const input = await Bun.stdin.json()
  if (!isShellTool(input?.tool_name ?? "")) process.exit(0)

  const command: string = input?.tool_input?.command ?? ""

  // Strip quoted string contents once before any rule matching so that banned
  // patterns embedded inside commit messages, evidence args, or other quoted
  // flag values never trigger a false positive.  The original `command` is kept
  // for reporter correction output which must reference the real command text.
  const strippedCommand = stripQuotedStrings(command)

  const warnings = evaluateRules(RULES, command, strippedCommand)

  checkBunTestReporter(command)

  if (warnings.length > 0) {
    allowPreToolUse(warnings.join("\n\n"))
  }
}

if (import.meta.main) {
  void main()
}
