import { join, dirname } from "node:path";
import type { Command } from "../types.ts";

const SWIZ_ROOT = dirname(Bun.main);
const HOOKS_DIR = join(SWIZ_ROOT, "hooks");
const HOME = process.env.HOME ?? "~";

const CLAUDE_SETTINGS = join(HOME, ".claude", "settings.json");
const CURSOR_HOOKS = join(HOME, ".cursor", "hooks.json");

// ─── Agent-agnostic hook manifest ───────────────────────────────────────────

interface HookDef {
  file: string;
  timeout?: number;
  async?: boolean;
}

interface HookGroup {
  event: string;
  matcher?: string;
  hooks: HookDef[];
}

const manifest: HookGroup[] = [
  // Stop hooks
  {
    event: "stop",
    hooks: [
      { file: "stop-secret-scanner.sh", timeout: 10 },
      { file: "stop-debug-statements.sh", timeout: 10 },
      { file: "stop-large-files.sh", timeout: 10 },
      { file: "stop-git-status.sh", timeout: 10 },
      { file: "stop-lockfile-drift.sh", timeout: 10 },
      { file: "stop-lint-staged.sh", timeout: 30 },
      { file: "stop-git-push.sh", timeout: 10 },
      { file: "stop-branch-conflicts.sh", timeout: 10 },
      { file: "stop-pr-description.sh", timeout: 10 },
      { file: "stop-pr-changes-requested.sh", timeout: 10 },
      { file: "stop-github-ci.sh", timeout: 15 },
      { file: "stop-todo-tracker.sh", timeout: 10 },
      { file: "stop-changelog-staleness.sh", timeout: 10 },
      { file: "stop-completion-auditor.sh", timeout: 10 },
      { file: "stop-personal-repo-issues.ts", timeout: 10 },
    ],
  },

  // PreToolUse hooks
  {
    event: "preToolUse",
    matcher: "Task",
    hooks: [{ file: "pretooluse-no-task-delegation.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "TaskCreate",
    hooks: [{ file: "pretooluse-task-subject-validation.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|Bash",
    hooks: [{ file: "pretooluse-require-tasks.ts", timeout: 5 }],
  },
  {
    event: "preToolUse",
    matcher: "Edit|Write|NotebookEdit",
    hooks: [
      { file: "pretooluse-json-validation.ts" },
      { file: "pretooluse-no-eslint-disable.ts", timeout: 5 },
      { file: "pretooluse-eslint-config-strength.ts", timeout: 5 },
      { file: "pretooluse-no-as-any.ts", timeout: 5 },
    ],
  },
  {
    event: "preToolUse",
    matcher: "Bash",
    hooks: [
      { file: "pretooluse-banned-commands.ts" },
      { file: "pretooluse-no-npm.ts" },
      { file: "pretooluse-long-sleep.ts", timeout: 5 },
    ],
  },

  // PostToolUse hooks
  {
    event: "postToolUse",
    hooks: [{ file: "posttooluse-git-status.sh", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "TaskCreate",
    hooks: [{ file: "posttooluse-task-subject-validation.ts", timeout: 5 }],
  },
  {
    event: "postToolUse",
    matcher: "Bash",
    hooks: [{ file: "posttooluse-pr-context.ts", timeout: 10 }],
  },
  {
    event: "postToolUse",
    matcher: "Edit|Write",
    hooks: [
      { file: "posttooluse-json-validation.sh" },
      { file: "posttooluse-test-pairing.sh", timeout: 5 },
      { file: "posttooluse-task-advisor.sh", timeout: 5 },
      { file: "posttooluse-prettier-ts.ts", timeout: 5, async: true },
    ],
  },

  // SessionStart
  {
    event: "sessionStart",
    matcher: "startup",
    hooks: [{ file: "sessionstart-health-snapshot.sh", timeout: 10 }],
  },

  // UserPromptSubmit / beforeSubmitPrompt
  {
    event: "userPromptSubmit",
    hooks: [
      { file: "userpromptsubmit-git-context.sh", timeout: 5 },
      { file: "userpromptsubmit-task-advisor.sh", timeout: 5 },
    ],
  },
];

// ─── Tool name mapping ──────────────────────────────────────────────────────

// Manifest uses Claude-style names as canonical; translate per-agent.
const TOOL_ALIASES: Record<string, Record<string, string>> = {
  claude: {},
  cursor: {
    Bash: "Shell",
    Edit: "StrReplace",
    NotebookEdit: "EditNotebook",
    Task: "TodoWrite",
    TaskCreate: "TodoWrite",
    TaskUpdate: "TodoWrite",
  },
};

function translateMatcher(
  matcher: string | undefined,
  agent: string
): string | undefined {
  if (!matcher) return undefined;
  const aliases = TOOL_ALIASES[agent] ?? {};
  return matcher.replace(/\b\w+\b/g, (tok) => aliases[tok] ?? tok);
}

// ─── Event name mapping ─────────────────────────────────────────────────────

const EVENT_MAP: Record<string, { claude: string; cursor: string }> = {
  stop: { claude: "Stop", cursor: "stop" },
  preToolUse: { claude: "PreToolUse", cursor: "preToolUse" },
  postToolUse: { claude: "PostToolUse", cursor: "postToolUse" },
  sessionStart: { claude: "SessionStart", cursor: "sessionStart" },
  sessionEnd: { claude: "SessionEnd", cursor: "sessionEnd" },
  userPromptSubmit: {
    claude: "UserPromptSubmit",
    cursor: "beforeSubmitPrompt",
  },
  preCompact: { claude: "PreCompact", cursor: "preCompact" },
  subagentStart: { claude: "SubagentStart", cursor: "subagentStart" },
  subagentStop: { claude: "SubagentStop", cursor: "subagentStop" },
};

// ─── Config generators ──────────────────────────────────────────────────────

function hookCommand(file: string): string {
  const prefix = file.endsWith(".ts") ? "bun " : "";
  return `${prefix}${HOOKS_DIR}/${file}`;
}

function buildClaudeConfig() {
  const config: Record<string, unknown[]> = {};

  for (const group of manifest) {
    const eventName = EVENT_MAP[group.event]?.claude ?? group.event;
    if (!config[eventName]) config[eventName] = [];

    const matcher = translateMatcher(group.matcher, "claude");
    const hooks = group.hooks.map((h) => {
      const entry: Record<string, unknown> = {
        type: "command",
        command: hookCommand(h.file),
      };
      if (h.timeout) entry.timeout = h.timeout;
      if (h.async) entry.async = true;
      return entry;
    });

    const entry: Record<string, unknown> = { hooks };
    if (matcher) entry.matcher = matcher;
    config[eventName].push(entry);
  }

  return config;
}

function buildCursorConfig() {
  const config: Record<string, unknown[]> = {};

  for (const group of manifest) {
    const eventName = EVENT_MAP[group.event]?.cursor ?? group.event;
    if (!config[eventName]) config[eventName] = [];

    const matcher = translateMatcher(group.matcher, "cursor");

    for (const h of group.hooks) {
      const entry: Record<string, unknown> = {
        command: hookCommand(h.file),
      };
      if (h.timeout) entry.timeout = h.timeout;
      if (matcher) entry.matcher = matcher;
      config[eventName].push(entry);
    }
  }

  return config;
}

// ─── Diff ────────────────────────────────────────────────────────────────────

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return dp;
}

type DiffOp = { type: "equal" | "delete" | "insert"; line: string };

function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const dp = computeLCS(a, b);
  const ops: DiffOp[] = [];

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "delete", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "insert", line: b[j]! });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ type: "delete", line: a[i]! });
    i++;
  }
  while (j < b.length) {
    ops.push({ type: "insert", line: b[j]! });
    j++;
  }
  return ops;
}

function formatUnifiedDiff(
  path: string,
  oldText: string,
  newText: string,
  contextLines = 3
): string {
  if (oldText === newText) return `  ${DIM}${path}: no changes${RESET}\n`;

  const ops = diffLines(oldText, newText);
  const hunks: DiffHunk[] = [];

  let oldLine = 0;
  let newLine = 0;

  const tagged = ops.map((op) => {
    const entry = { ...op, oldLine: 0, newLine: 0 };
    if (op.type === "equal") {
      entry.oldLine = ++oldLine;
      entry.newLine = ++newLine;
    } else if (op.type === "delete") {
      entry.oldLine = ++oldLine;
    } else {
      entry.newLine = ++newLine;
    }
    return entry;
  });

  const changeIndices = tagged
    .map((t, i) => (t.type !== "equal" ? i : -1))
    .filter((i) => i >= 0);

  if (changeIndices.length === 0) return `  ${DIM}${path}: no changes${RESET}\n`;

  let hunkStart = -1;
  let hunkEnd = -1;

  for (const ci of changeIndices) {
    const lo = Math.max(0, ci - contextLines);
    const hi = Math.min(tagged.length - 1, ci + contextLines);

    if (hunkStart === -1) {
      hunkStart = lo;
      hunkEnd = hi;
    } else if (lo <= hunkEnd + 1) {
      hunkEnd = hi;
    } else {
      hunks.push(buildHunk(tagged, hunkStart, hunkEnd));
      hunkStart = lo;
      hunkEnd = hi;
    }
  }
  if (hunkStart !== -1) hunks.push(buildHunk(tagged, hunkStart, hunkEnd));

  const lines: string[] = [];
  lines.push(`  ${BOLD}--- ${path}${RESET}`);
  lines.push(`  ${BOLD}+++ ${path} (proposed)${RESET}`);

  for (const hunk of hunks) {
    lines.push(
      `  ${CYAN}@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${RESET}`
    );
    lines.push(...hunk.lines);
  }

  return lines.join("\n") + "\n";
}

function buildHunk(
  tagged: Array<DiffOp & { oldLine: number; newLine: number }>,
  start: number,
  end: number
): DiffHunk {
  const lines: string[] = [];
  let oldStart = 0;
  let oldCount = 0;
  let newStart = 0;
  let newCount = 0;

  for (let i = start; i <= end; i++) {
    const t = tagged[i]!;
    if (t.type === "equal") {
      if (!oldStart) oldStart = t.oldLine;
      if (!newStart) newStart = t.newLine;
      oldCount++;
      newCount++;
      lines.push(`  ${DIM} ${t.line}${RESET}`);
    } else if (t.type === "delete") {
      if (!oldStart) oldStart = t.oldLine;
      oldCount++;
      lines.push(`  ${RED}-${t.line}${RESET}`);
    } else {
      if (!newStart) newStart = t.newLine;
      newCount++;
      lines.push(`  ${GREEN}+${t.line}${RESET}`);
    }
  }

  return {
    oldStart: oldStart || 1,
    oldCount,
    newStart: newStart || 1,
    newCount,
    lines,
  };
}

// ─── File I/O ───────────────────────────────────────────────────────────────

async function readFileText(path: string): Promise<string> {
  const f = Bun.file(path);
  return (await f.exists()) ? await f.text() : "";
}

async function backup(path: string) {
  const file = Bun.file(path);
  if (await file.exists()) {
    await Bun.write(path + ".bak", await file.text());
    return true;
  }
  return false;
}

async function installClaude(dryRun: boolean) {
  const config = buildClaudeConfig();

  console.log(`  ${BOLD}Claude Code${RESET} → ${CLAUDE_SETTINGS}\n`);

  const file = Bun.file(CLAUDE_SETTINGS);
  const settings = (await file.exists()) ? await file.json() : {};
  const oldText = (await readFileText(CLAUDE_SETTINGS)).trimEnd();

  const proposed = { ...settings, hooks: config };
  const newText = JSON.stringify(proposed, null, 2);

  if (dryRun) {
    printDiffReport(CLAUDE_SETTINGS, oldText, newText, settings.hooks, config);
    return;
  }

  await backup(CLAUDE_SETTINGS);
  await Bun.write(CLAUDE_SETTINGS, newText + "\n");
  console.log(`    ✓ written (backup at ${CLAUDE_SETTINGS}.bak)\n`);
}

async function installCursor(dryRun: boolean) {
  const config = buildCursorConfig();

  console.log(`  ${BOLD}Cursor${RESET} → ${CURSOR_HOOKS}\n`);

  const oldText = (await readFileText(CURSOR_HOOKS)).trimEnd();
  const oldParsed = oldText ? JSON.parse(oldText) : {};

  const proposed = { version: 1, hooks: config };
  const newText = JSON.stringify(proposed, null, 2);

  if (dryRun) {
    printDiffReport(
      CURSOR_HOOKS,
      oldText,
      newText,
      oldParsed.hooks ?? {},
      config
    );
    return;
  }

  await backup(CURSOR_HOOKS);
  await Bun.write(CURSOR_HOOKS, newText + "\n");
  console.log(`    ✓ written (backup at ${CURSOR_HOOKS}.bak)\n`);
}

// ─── Dry-run report ─────────────────────────────────────────────────────────

function collectCommands(hooks: Record<string, unknown>): Set<string> {
  const cmds = new Set<string>();
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const e = entry as Record<string, unknown>;
      if (e.command) cmds.add(String(e.command));
      if (Array.isArray(e.hooks)) {
        for (const h of e.hooks) {
          const hh = h as Record<string, unknown>;
          if (hh.command) cmds.add(String(hh.command));
        }
      }
    }
  }
  return cmds;
}

function printDiffReport(
  path: string,
  oldText: string,
  newText: string,
  oldHooks: Record<string, unknown> | undefined,
  newHooks: Record<string, unknown>
) {
  const oldCmds = oldHooks ? collectCommands(oldHooks) : new Set<string>();
  const newCmds = collectCommands(newHooks);

  const added = [...newCmds].filter((c) => !oldCmds.has(c));
  const removed = [...oldCmds].filter((c) => !newCmds.has(c));
  const kept = [...newCmds].filter((c) => oldCmds.has(c));

  if (added.length) {
    console.log(`    ${GREEN}+ ${added.length} hook(s) added:${RESET}`);
    for (const c of added) console.log(`      ${GREEN}+ ${c}${RESET}`);
    console.log();
  }
  if (removed.length) {
    console.log(`    ${RED}- ${removed.length} hook(s) removed:${RESET}`);
    for (const c of removed) console.log(`      ${RED}- ${c}${RESET}`);
    console.log();
  }
  if (kept.length) {
    console.log(`    ${DIM}  ${kept.length} hook(s) unchanged${RESET}\n`);
  }
  if (!oldText && newText) {
    console.log(`    ${GREEN}+ new file (${newText.split("\n").length} lines)${RESET}\n`);
  }

  console.log(formatUnifiedDiff(path, oldText, newText));
}

// ─── Command ────────────────────────────────────────────────────────────────

export const installCommand: Command = {
  name: "install",
  description: "Install swiz hooks into agent settings",
  usage: "swiz install [--claude] [--cursor] [--dry-run]",
  async run(args) {
    const dryRun = args.includes("--dry-run");
    const claudeOnly = args.includes("--claude");
    const cursorOnly = args.includes("--cursor");
    const both = !claudeOnly && !cursorOnly;

    console.log(`\n  swiz install${dryRun ? " (dry run)" : ""}\n`);
    console.log(`  Hooks: ${HOOKS_DIR}\n`);

    if (both || claudeOnly) await installClaude(dryRun);
    if (both || cursorOnly) await installCursor(dryRun);

    if (dryRun) {
      console.log("  No changes written.\n");
    }
  },
};
