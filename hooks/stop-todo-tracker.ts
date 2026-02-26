#!/usr/bin/env bun
// Stop hook: Block stop if new TODO/FIXME/HACK lines were introduced in commits

import { git, isGitRepo, blockStop, SOURCE_EXT_RE, skillAdvice, type StopHookInput } from "./hook-utils.ts";

export {};

const EXCLUDE_PATH_RE = /node_modules|\.claude\/hooks\/|^hooks\/|__tests__|\.test\.|\.spec\./;
const TODO_RE = /\b(TODO|FIXME|HACK|XXX|WORKAROUND)\b/i;
const COMMENT_RE = /(\/[/*]|#\s)/;
const REGEX_LITERAL_RE = /^\s*\/[^/]/; // line content starts with regex literal

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as StopHookInput;
  const cwd = input.cwd;

  if (!(await isGitRepo(cwd))) return;

  // Only scan recognised source code files
  const changedRaw = await git(["diff", "--name-only", "HEAD~10..HEAD"], cwd);
  if (!changedRaw) return;

  const sourceFiles = changedRaw
    .split("\n")
    .filter((f) => SOURCE_EXT_RE.test(f) && !EXCLUDE_PATH_RE.test(f));

  if (sourceFiles.length === 0) return;

  const diff = await git(["diff", "HEAD~10..HEAD", "--", ...sourceFiles], cwd);
  if (!diff) return;

  const todos: string[] = [];

  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const content = line.slice(1); // strip leading +

    if (!TODO_RE.test(content)) continue;

    // Exclude regex literals (pattern strings in hook implementations)
    if (REGEX_LITERAL_RE.test(content)) continue;

    // Require the keyword to appear inside a comment context (// /* or # )
    if (!COMMENT_RE.test(content)) continue;

    todos.push(line.slice(0, 150));
    if (todos.length >= 15) break;
  }

  if (todos.length === 0) return;

  let reason = `${todos.length} new TODO/FIXME/HACK comment(s) introduced in recent commits.\n\n`;
  reason += "Items:\n";
  for (const t of todos) reason += `  ${t}\n`;
  reason += "\n" + skillAdvice(
    "farm-out-issues",
    "Either resolve these now, or use the /farm-out-issues skill to file them as GitHub issues before stopping.",
    "Either resolve these now, or file them as GitHub issues before stopping:\n  gh issue create --title \"<title>\" --body \"<description>\""
  );

  blockStop(reason);
}

main();
