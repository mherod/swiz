#!/usr/bin/env bun

import { spawn } from "bun";

interface HookInput {
  tool_name: string;
  tool_output?: {
    status?: string;
    file_path?: string;
  };
  tool_input?: {
    file_path?: string;
  };
}

async function main() {
  const input: HookInput = await Bun.stdin.json();

  const toolName = input.tool_name ?? "";
  // Only run on Edit and Write tools
  if (toolName !== "Edit" && toolName !== "Write") {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path ?? "";
  if (!filePath) {
    process.exit(0);
  }

  // Only format TypeScript files
  if (!/\.(ts|tsx)$/.test(filePath)) {
    process.exit(0);
  }

  // Run prettier asynchronously in the background
  // This is non-blocking and provides feedback via additionalContext
  try {
    const proc = spawn(["bun", "prettier", "--write", filePath]);

    // Wait for exit code to determine success
    const exitCode = await proc.exited;

    const feedback =
      exitCode === 0
        ? `Prettier formatted: ${filePath}`
        : `Prettier skipped: ${filePath}`;

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: feedback,
        },
      })
    );
  } catch (error) {
    // Silently fail if prettier is not available or errors occur
    // This is a quality-of-life enhancement, not a blocker
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `Prettier unavailable for ${filePath}`,
        },
      })
    );
  }
}

main().catch((e) => {
  console.error("Hook error:", e);
  // Don't exit non-zero; this is non-blocking
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
      },
    })
  );
});
