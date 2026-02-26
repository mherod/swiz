#!/usr/bin/env bun
// PostToolUse hook: Validate JSON files after writing

import type { ToolHookInput } from "./hook-utils.ts";

export {};

async function main(): Promise<void> {
  const input = (await Bun.stdin.json()) as ToolHookInput;
  const filePath = input.tool_input?.file_path as string | undefined;

  if (!filePath || !filePath.endsWith(".json")) return;

  try {
    const content = await Bun.file(filePath).text();
    JSON.parse(content);
  } catch {
    console.log(
      JSON.stringify({
        decision: "block",
        reason: "JSON validation failed — the file is not valid JSON. Fix the syntax errors.",
      })
    );
  }
}

main();
