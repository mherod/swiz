// Shared utilities for Claude Code hook scripts.
// Import with: import { denyPreToolUse, denyPostToolUse } from "./hook-utils.ts";

/** Emit a PreToolUse denial and exit. */
export function denyPreToolUse(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

/** Emit a PostToolUse block decision and exit. */
export function denyPostToolUse(reason: string): never {
  console.log(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}
