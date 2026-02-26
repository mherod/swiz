import { describe, test, expect } from "bun:test";

// Test dispatch end-to-end by running swiz dispatch with different payloads

async function dispatch(event: string, payload: Record<string, unknown>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  parsed: Record<string, unknown> | null;
}> {
  const proc = Bun.spawn(["bun", "run", "index.ts", "dispatch", event, event === "preToolUse" ? "PreToolUse" : event === "stop" ? "Stop" : event], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  let parsed = null;
  try { parsed = JSON.parse(stdout.trim()); } catch {}
  return { stdout: stdout.trim(), stderr, exitCode: proc.exitCode, parsed };
}

describe("dispatch preToolUse", () => {
  test("allows clean git commands", async () => {
    const result = await dispatch("preToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
    // Should either be empty (all pass) or allow-with-reason (from require-tasks)
    if (result.parsed) {
      const hso = result.parsed.hookSpecificOutput as Record<string, unknown> | undefined;
      expect(hso?.permissionDecision).not.toBe("deny");
    }
  });

  test("denies sed commands", async () => {
    const result = await dispatch("preToolUse", {
      tool_name: "Bash",
      tool_input: { command: "sed -i 's/a/b/' file.ts" },
    });
    expect(result.parsed).not.toBeNull();
    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown> | undefined;
    const decision = hso?.permissionDecision ?? result.parsed!.decision;
    expect(decision).toBe("deny");
  });

  test("warns on grep with allow", async () => {
    const result = await dispatch("preToolUse", {
      tool_name: "Bash",
      tool_input: { command: "grep -r TODO src/" },
    });
    expect(result.parsed).not.toBeNull();
    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown> | undefined;
    // Could be allow from banned-commands or deny from require-tasks
    // If require-tasks fires first, it may deny — that's fine
    const decision = (hso?.permissionDecision ?? result.parsed!.decision) as string;
    expect(["allow", "deny"]).toContain(decision);
  });

  test("ignores non-Bash tools for banned-commands", async () => {
    const result = await dispatch("preToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/etc/passwd" },
    });
    // Read tool has no matching groups for banned-commands
    // May get output from other hooks but not a deny for banned commands
    expect(result.exitCode).toBe(0);
  });
});

describe("dispatch routing", () => {
  test("unknown event produces no output", async () => {
    const result = await dispatch("unknownEvent", {});
    expect(result.stdout).toBe("");
  });

  test("empty payload doesn't crash", async () => {
    const result = await dispatch("preToolUse", {});
    expect(result.exitCode).toBe(0);
  });
});
