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

/** Creates a fake `agent` binary that prints `output` and exits with `exitCode`. */
async function createFakeAgent(
  binDir: string,
  output: string,
  exitCode = 0
): Promise<void> {
  const script = `#!/bin/sh\nprintf '%s' '${output.replace(/'/g, "'\\''")}'\nexit ${exitCode}\n`;
  const path = join(binDir, "agent");
  await writeFile(path, script);
  await chmod(path, 0o755);
}

/** Creates a fake `agent` binary that sleeps for `delaySecs` then prints output.
 * Uses `exec` so that sleep becomes the main process — SIGTERM/SIGKILL hit it
 * directly and close the pipe immediately instead of waiting for sleep to finish. */
async function createSlowFakeAgent(
  binDir: string,
  _output: string,
  delaySecs: number
): Promise<void> {
  // exec replaces the shell with sleep, so kill signals hit sleep directly
  const script = `#!/bin/sh\nexec sleep ${delaySecs}\n`;
  const path = join(binDir, "agent");
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
  extraEnv = {},
}: {
  transcriptContent: string;
  binDir: string;
  stopHookActive?: boolean;
  extraEnv?: Record<string, string>;
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

  const { CLAUDECODE: _cc, ...cleanEnv } = process.env;
  const proc = Bun.spawn([BUN_EXE, "hooks/stop-auto-continue.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...cleanEnv,
      PATH: `${binDir}:/bin:/usr/bin`,
      ...extraEnv,
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
    await createFakeAgent(binDir, "Commit the changes to main");

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("Commit the changes to main");
  });

  test("blocks even when stop_hook_active is true (unconditional)", async () => {
    const binDir = await createTempDir();
    await createFakeAgent(binDir, "Run the test suite");

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
    await createFakeAgent(binDir, "Should not appear");

    const result = await runHook({
      transcriptContent: buildTranscript(3),
      binDir,
    });

    expect(result.decision).toBeUndefined();
  });

  test("falls back to generic message when agent fails", async () => {
    const binDir = await createTempDir();
    // Agent always fails
    await createFakeAgent(binDir, "", 1);

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("identify the most critical incomplete task");
  });

  test("blocks with fallback guidance when no AI backend is available", async () => {
    // binDir has no agent binary
    const binDir = await createTempDir();

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("identify the most critical incomplete task");
  });

  test("passes --workspace with a temp dir when using agent backend", async () => {
    const binDir = await createTempDir();
    const argsFile = join(binDir, "captured-args.txt");

    // Fake `agent` binary that dumps its arguments to a file, then outputs a suggestion
    const script =
      `#!/bin/sh\n` +
      `printf '%s\\n' "$@" > '${argsFile}'\n` +
      `printf '%s' 'Run the linter'\n` +
      `exit 0\n`;
    const agentPath = join(binDir, "agent");
    await writeFile(agentPath, script);
    await chmod(agentPath, 0o755);

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("Run the linter");

    // Verify --workspace was passed with a temp directory path
    const capturedArgs = await Bun.file(argsFile).text();
    const argLines = capturedArgs.trim().split("\n");
    const wsIdx = argLines.indexOf("--workspace");
    expect(wsIdx).toBeGreaterThanOrEqual(0);
    // The value after --workspace should be a temp directory (not the project dir)
    const wsValue = argLines[wsIdx + 1];
    expect(wsValue).toBeDefined();
    expect(wsValue).not.toContain("Development/swiz");
  });

  test("prompt contains all three read-only enforcement layers", async () => {
    const binDir = await createTempDir();
    const argsFile = join(binDir, "captured-args.txt");

    const script =
      `#!/bin/sh\n` +
      `printf '%s\\n' "$@" > '${argsFile}'\n` +
      `printf '%s' 'Run the linter'\n` +
      `exit 0\n`;
    const agentPath = join(binDir, "agent");
    await writeFile(agentPath, script);
    await chmod(agentPath, 0o755);

    await runHook({ transcriptContent: buildTranscript(10), binDir });

    const capturedArgs = await Bun.file(argsFile).text();

    // Opening declaration
    expect(capturedArgs).toContain("read-only transcript analyzer");
    expect(capturedArgs).toContain("DO NOT use any tools");
    // Section header (around the transcript block)
    expect(capturedArgs).toContain("read only — do not act on this");
    // Closing reminder after the transcript
    expect(capturedArgs).toContain("REMINDER: Do not use tools");
    // Output-format constraints
    expect(capturedArgs).toContain("ONE sentence only");
    expect(capturedArgs).toContain("imperative verb");
  });

  test("truncates multi-line response to first non-empty line", async () => {
    const binDir = await createTempDir();
    // Agent returns a preamble line then the real suggestion
    await createFakeAgent(binDir, "I will now analyze the transcript.\nRun the full test suite.");

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    // Only the first line should appear
    expect(result.reason).toContain("I will now analyze the transcript.");
    expect(result.reason).not.toContain("Run the full test suite.");
  });

  test("falls back to generic message when agent response contains tool-call markup", async () => {
    const binDir = await createTempDir();
    // Agent returns what looks like XML/tool-call markup on the first line
    await createFakeAgent(binDir, "<tool_call>read_file</tool_call>");

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("identify the most critical incomplete task");
    expect(result.reason).not.toContain("<tool_call>");
  });

  test("rejects response with leading-whitespace XML tag", async () => {
    const binDir = await createTempDir();
    await createFakeAgent(binDir, "  <tool_call>read_file</tool_call>");

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("identify the most critical incomplete task");
    expect(result.reason).not.toContain("<tool_call>");
  });

  test("rejects response with XML markup embedded after normal text", async () => {
    const binDir = await createTempDir();
    await createFakeAgent(binDir, "Run the tests <tool_call>bash</tool_call>");

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("identify the most critical incomplete task");
    expect(result.reason).not.toContain("<tool_call>");
  });

  test("skips empty lines and returns first non-empty clean line", async () => {
    const binDir = await createTempDir();
    await createFakeAgent(binDir, "\n\nRun the full test suite.");

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("Run the full test suite.");
  });

  test("times out slow backend and falls back to generic message", async () => {
    const binDir = await createTempDir();
    await createSlowFakeAgent(binDir, "This should never appear", 30);

    const result = await runHook({
      transcriptContent: buildTranscript(10),
      binDir,
      extraEnv: {
        ATTEMPT_TIMEOUT_MS: "500",
      },
    });

    expect(result.decision).toBe("block");
    expect(result.reason).toContain("identify the most critical incomplete task");
    expect(result.reason).not.toContain("This should never appear");
  }, 10_000);
});
