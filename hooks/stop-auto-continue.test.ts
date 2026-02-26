import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface HookResult {
  decision?: string;
  reason?: string;
  rawOutput: string;
}

const BUN_EXE = Bun.which("bun") ?? "bun";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-auto-continue-"));
  tempDirs.push(dir);
  return dir;
}

/** Creates a fake `claude` binary that prints `output` and exits with `exitCode`. */
async function createFakeClaude(
  binDir: string,
  output: string,
  exitCode = 0
): Promise<void> {
  const script = `#!/bin/sh\nprintf '%s' '${output.replace(/'/g, "'\\''")}'\nexit ${exitCode}\n`;
  const path = join(binDir, "claude");
  await writeFile(path, script);
  await chmod(path, 0o755);
}

/** Creates a fake `claude` binary that fails the first `failCount` times, then succeeds. */
async function createFlakyFakeClaude(
  binDir: string,
  successOutput: string,
  failCount: number
): Promise<void> {
  const counterFile = join(binDir, ".call-count");
  const script =
    `#!/bin/sh\n` +
    `COUNT=0\n` +
    `if [ -f '${counterFile}' ]; then read COUNT < '${counterFile}'; fi\n` +
    `COUNT=$((COUNT + 1))\n` +
    `printf '%d' $COUNT > '${counterFile}'\n` +
    `if [ "$COUNT" -le ${failCount} ]; then exit 1; fi\n` +
    `printf '%s' '${successOutput.replace(/'/g, "'\\''")}'\nexit 0\n`;
  const path = join(binDir, "claude");
  await writeFile(path, script);
  await chmod(path, 0o755);
}

/** Builds a minimal JSONL transcript with the given number of tool calls and a user turn. */
function buildTranscript(toolCallCount: number, userMessage = "What is the status?"): string {
  const lines: string[] = [];
  // One user turn
  lines.push(JSON.stringify({ type: "user", message: { content: userMessage } }));
  // Assistant turns with tool_use blocks
  for (let i = 0; i < toolCallCount; i++) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", id: `t${i}`, input: {} }],
        },
      })
    );
  }
  return lines.join("\n") + "\n";
}

async function runHook({
  transcriptContent,
  binDir,
  stopHookActive = false,
}: {
  transcriptContent: string;
  binDir: string;
  stopHookActive?: boolean;
}): Promise<HookResult> {
  const workDir = await createTempDir();
  const transcriptPath = join(workDir, "transcript.jsonl");
  await writeFile(transcriptPath, transcriptContent);

  const payload = JSON.stringify({
    transcript_path: transcriptPath,
    stop_hook_active: stopHookActive,
    session_id: "test-session",
    cwd: workDir,
  });

  const proc = Bun.spawn([BUN_EXE, "hooks/stop-auto-continue.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: binDir,
    },
  });
  proc.stdin.write(payload);
  proc.stdin.end();

  const rawOutput = await new Response(proc.stdout).text();
  await proc.exited;

  if (!rawOutput.trim()) return { rawOutput };

  try {
    const parsed = JSON.parse(rawOutput.trim());
    return {
      decision: parsed.decision,
      reason: parsed.reason,
      rawOutput,
    };
  } catch {
    return { rawOutput };
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("stop-auto-continue", () => {
  test("blocks with AI suggestion for a substantive session", async () => {
    const binDir = await createTempDir();
    await createFakeClaude(binDir, "Commit the changes to main");

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("Commit the changes to main");
  });

  test("fires even when stop_hook_active is true", async () => {
    const binDir = await createTempDir();
    await createFakeClaude(binDir, "Run the test suite");

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      stopHookActive: true,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("Run the test suite");
  });

  test("allows stop for trivial sessions (< 5 tool calls)", async () => {
    const binDir = await createTempDir();
    await createFakeClaude(binDir, "Should not appear");

    const result = await runHook({
      transcriptContent: buildTranscript(3),
      binDir,
    });

    expect(result.decision).toBeUndefined();
  });

  test("retries on backend failure and succeeds on later attempt", async () => {
    const binDir = await createTempDir();
    // Fails first 2 times, succeeds on 3rd
    await createFlakyFakeClaude(binDir, "Push to origin main", 2);

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("Push to origin main");
  });

  test("falls back to generic message when all retries exhausted", async () => {
    const binDir = await createTempDir();
    // Always fails
    await createFakeClaude(binDir, "", 1);

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("identify the most critical incomplete task");
  });

  test("blocks with fallback guidance when no AI backend is available", async () => {
    // binDir has no claude/agent/gemini
    const binDir = await createTempDir();

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("identify the most critical incomplete task");
  });
});
