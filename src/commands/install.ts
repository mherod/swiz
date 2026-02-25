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
    matcher: "Edit|Write|Shell",
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
    matcher: "Shell",
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
    matcher: "Shell",
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

// Claude uses "Bash", Cursor uses "Shell" — normalize manifest to "Shell"
// and translate per-agent at config generation time.
const TOOL_ALIASES: Record<string, Record<string, string>> = {
  claude: { Shell: "Bash" },
  cursor: {},
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

// ─── File I/O ───────────────────────────────────────────────────────────────

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
  const hookCount = manifest.reduce((n, g) => n + g.hooks.length, 0);

  console.log(`  Claude Code → ${CLAUDE_SETTINGS}`);
  printEventSummary(config);

  if (dryRun) return;

  const file = Bun.file(CLAUDE_SETTINGS);
  const settings = (await file.exists()) ? await file.json() : {};
  settings.hooks = config;

  await backup(CLAUDE_SETTINGS);
  await Bun.write(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  console.log(`    ✓ written (backup at ${CLAUDE_SETTINGS}.bak)\n`);
}

async function installCursor(dryRun: boolean) {
  const config = buildCursorConfig();

  console.log(`  Cursor      → ${CURSOR_HOOKS}`);
  printEventSummary(config);

  if (dryRun) return;

  const output = { version: 1, hooks: config };

  await backup(CURSOR_HOOKS);
  await Bun.write(CURSOR_HOOKS, JSON.stringify(output, null, 2) + "\n");
  console.log(`    ✓ written (backup at ${CURSOR_HOOKS}.bak)\n`);
}

function countHooks(entries: unknown[]): number {
  return entries.reduce((n: number, e) => {
    const inner = (e as Record<string, unknown>).hooks;
    return n + (Array.isArray(inner) ? inner.length : 1);
  }, 0);
}

function printEventSummary(config: Record<string, unknown[]>) {
  let total = 0;
  for (const [event, entries] of Object.entries(config)) {
    const count = countHooks(entries);
    total += count;
    console.log(`    ${event.padEnd(24)} ${count} hook(s)`);
  }
  console.log(`    ${"".padEnd(24)} ── ${total} total\n`);
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
