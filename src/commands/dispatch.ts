import { join, dirname } from "node:path";
import type { Command } from "../types.ts";
import { manifest, type HookGroup } from "../manifest.ts";
import {
  isShellTool,
  isEditTool,
  isWriteTool,
  isNotebookTool,
  isTaskTool,
  isTaskCreateTool,
} from "../../hooks/hook-utils.ts";

const SWIZ_ROOT = dirname(Bun.main);
const HOOKS_DIR = join(SWIZ_ROOT, "hooks");

// ─── Cross-agent matcher ─────────────────────────────────────────────────────
// Agents use different tool names (Bash/Shell/run_shell_command). Match using
// the same equivalence sets from hook-utils so dispatch is agent-agnostic.

function toolMatchesToken(toolName: string, token: string): boolean {
  if (toolName === token) return true;
  if (isShellTool(toolName) && isShellTool(token)) return true;
  if (isEditTool(toolName) && isEditTool(token)) return true;
  if (isWriteTool(toolName) && isWriteTool(token)) return true;
  if (isNotebookTool(toolName) && isNotebookTool(token)) return true;
  if (isTaskTool(toolName) && isTaskTool(token)) return true;
  if (isTaskCreateTool(toolName) && isTaskCreateTool(token)) return true;
  return false;
}

function groupMatches(
  group: HookGroup,
  toolName: string | undefined,
  trigger: string | undefined
): boolean {
  if (!group.matcher) return true;
  // SessionStart uses trigger types (startup/compact) not tool names
  if (trigger !== undefined) return group.matcher === trigger;
  if (!toolName) return false;
  return group.matcher.split("|").some((part) => toolMatchesToken(toolName, part.trim()));
}

// ─── Hook execution ──────────────────────────────────────────────────────────

async function runHook(
  file: string,
  payloadStr: string
): Promise<Record<string, unknown> | null> {
  const cmd = file.endsWith(".ts")
    ? ["bun", join(HOOKS_DIR, file)]
    : [join(HOOKS_DIR, file)];

  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  proc.stdin.write(payloadStr);
  proc.stdin.end();

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Response classification ─────────────────────────────────────────────────

function isDeny(resp: Record<string, unknown>): boolean {
  if (resp.decision === "deny") return true;
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined;
  return hso?.permissionDecision === "deny";
}

function isBlock(resp: Record<string, unknown>): boolean {
  return resp.decision === "block";
}

function extractContext(resp: Record<string, unknown>): string | null {
  const hso = resp.hookSpecificOutput as Record<string, unknown> | undefined;
  const ctx = hso?.additionalContext ?? resp.systemMessage;
  return typeof ctx === "string" ? ctx : null;
}

// ─── Dispatch strategies ─────────────────────────────────────────────────────

/** PreToolUse: short-circuit and forward the first deny. */
async function runPreToolUse(groups: HookGroup[], payloadStr: string): Promise<void> {
  for (const group of groups) {
    for (const hook of group.hooks) {
      const resp = await runHook(hook.file, payloadStr);
      if (resp && isDeny(resp)) {
        console.log(JSON.stringify(resp));
        return;
      }
    }
  }
}

/** Stop / PostToolUse: short-circuit and forward the first block.
 *  Hooks marked async are fire-and-forget (e.g. posttooluse-prettier-ts). */
async function runBlocking(groups: HookGroup[], payloadStr: string): Promise<void> {
  for (const group of groups) {
    for (const hook of group.hooks) {
      if (hook.async) {
        runHook(hook.file, payloadStr).catch(() => {});
        continue;
      }
      const resp = await runHook(hook.file, payloadStr);
      if (resp && isBlock(resp)) {
        console.log(JSON.stringify(resp));
        return;
      }
    }
  }
}

/** SessionStart / UserPromptSubmit: run all hooks, merge additionalContext. */
async function runContext(
  groups: HookGroup[],
  payloadStr: string,
  eventName: string
): Promise<void> {
  const contexts: string[] = [];
  for (const group of groups) {
    for (const hook of group.hooks) {
      const resp = await runHook(hook.file, payloadStr);
      if (!resp) continue;
      const ctx = extractContext(resp);
      if (ctx) contexts.push(ctx);
    }
  }
  if (contexts.length === 0) return;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: contexts.join("\n\n"),
      },
    })
  );
}

// ─── Command ────────────────────────────────────────────────────────────────

export const dispatchCommand: Command = {
  name: "dispatch",
  description: "Fan out a hook event to all matching scripts (used by agent configs)",
  usage: "swiz dispatch <event>",
  async run(args) {
    const canonicalEvent = args[0];
    if (!canonicalEvent) {
      console.error("Usage: swiz dispatch <event>");
      process.exit(1);
    }

    const payloadStr = await new Response(Bun.stdin).text();
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(payloadStr) as Record<string, unknown>;
    } catch {
      // Proceed with empty payload — individual hooks handle missing fields
    }

    const toolName = (payload.tool_name ?? payload.toolName) as string | undefined;
    // SessionStart sends a trigger type; only use it for that event
    const trigger = canonicalEvent === "sessionStart"
      ? (payload.trigger ?? payload.hook_event_name) as string | undefined
      : undefined;

    const matchingGroups = manifest.filter(
      (g) => g.event === canonicalEvent && groupMatches(g, toolName, trigger)
    );

    if (matchingGroups.length === 0) return;

    switch (canonicalEvent) {
      case "preToolUse":
        await runPreToolUse(matchingGroups, payloadStr);
        break;
      case "stop":
      case "postToolUse":
        await runBlocking(matchingGroups, payloadStr);
        break;
      case "sessionStart":
      case "userPromptSubmit":
        await runContext(matchingGroups, payloadStr, canonicalEvent);
        break;
      default:
        await runBlocking(matchingGroups, payloadStr);
    }
  },
};
