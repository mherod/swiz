import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-agent-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Creates a fake binary that dumps its arguments to a file, then prints output. */
async function createFakeBinary(
  binDir: string,
  name: string,
  output: string,
  exitCode = 0
): Promise<string> {
  const argsFile = join(binDir, `${name}-captured-args.txt`);
  const script =
    `#!/bin/sh\n` +
    `printf '%s\\n' "$@" > '${argsFile}'\n` +
    `printf '%s' '${output.replace(/'/g, "'\\''")}'\n` +
    `exit ${exitCode}\n`;
  const path = join(binDir, name);
  await writeFile(path, script);
  await chmod(path, 0o755);
  return argsFile;
}

async function readCapturedArgs(argsFile: string): Promise<string[]> {
  const text = await Bun.file(argsFile).text();
  return text.trim().split("\n");
}

/**
 * Spawn a tiny Bun script that imports agent.ts and calls promptAgent / detectAgentCli
 * with a controlled PATH so only the desired fake binary is visible.
 */
async function runAgentCall(
  binDir: string,
  prompt: string,
  promptOnly: boolean
): Promise<{ stdout: string; exitCode: number | null }> {
  const script = `
    import { promptAgent } from "./src/agent.ts";
    try {
      const result = await promptAgent(${JSON.stringify(prompt)}, { promptOnly: ${promptOnly} });
      console.log(result);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  `;
  const scriptPath = join(binDir, "test-runner.ts");
  await writeFile(scriptPath, script);

  const proc = Bun.spawn(["bun", scriptPath], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: binDir },
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { stdout: stdout.trim(), exitCode: proc.exitCode };
}

async function runDetect(binDir: string): Promise<string> {
  const script = `
    import { detectAgentCli } from "./src/agent.ts";
    console.log(detectAgentCli() ?? "null");
  `;
  const scriptPath = join(binDir, "test-detect.ts");
  await writeFile(scriptPath, script);

  const proc = Bun.spawn(["bun", scriptPath], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: binDir },
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim();
}

// ─── detectAgentCli ──────────────────────────────────────────────────────────

describe("detectAgentCli", () => {
  test("returns 'agent' when agent binary is present", async () => {
    const binDir = await createTempDir();
    await createFakeBinary(binDir, "agent", "");
    expect(await runDetect(binDir)).toBe("agent");
  });

  test("returns 'claude' when only claude binary is present", async () => {
    const binDir = await createTempDir();
    await createFakeBinary(binDir, "claude", "");
    expect(await runDetect(binDir)).toBe("claude");
  });

  test("returns 'gemini' when only gemini binary is present", async () => {
    const binDir = await createTempDir();
    await createFakeBinary(binDir, "gemini", "");
    expect(await runDetect(binDir)).toBe("gemini");
  });

  test("prefers agent over claude and gemini", async () => {
    const binDir = await createTempDir();
    await createFakeBinary(binDir, "agent", "");
    await createFakeBinary(binDir, "claude", "");
    await createFakeBinary(binDir, "gemini", "");
    expect(await runDetect(binDir)).toBe("agent");
  });

  test("returns null when no backend is available", async () => {
    const binDir = await createTempDir();
    expect(await runDetect(binDir)).toBe("null");
  });
});

// ─── promptAgent: agent backend ──────────────────────────────────────────────

describe("promptAgent with agent backend", () => {
  test("passes correct flags without promptOnly", async () => {
    const binDir = await createTempDir();
    const argsFile = await createFakeBinary(binDir, "agent", "response text");

    const result = await runAgentCall(binDir, "test prompt", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("response text");

    const args = await readCapturedArgs(argsFile);
    expect(args).toContain("--print");
    expect(args).toContain("--mode");
    expect(args).toContain("ask");
    expect(args).toContain("--trust");
    expect(args).not.toContain("--workspace");
  });

  test("passes --workspace with a temp path when promptOnly is true", async () => {
    const binDir = await createTempDir();
    const argsFile = await createFakeBinary(binDir, "agent", "prompt-only response");

    const result = await runAgentCall(binDir, "test prompt", true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("prompt-only response");

    const args = await readCapturedArgs(argsFile);
    const wsIdx = args.indexOf("--workspace");
    expect(wsIdx).toBeGreaterThanOrEqual(0);
    const wsValue = args[wsIdx + 1];
    expect(wsValue).toBeDefined();
    expect(wsValue).toMatch(/^\/tmp|^\/var/);
  });
});

// ─── promptAgent: claude backend ─────────────────────────────────────────────

describe("promptAgent with claude backend", () => {
  test("passes correct flags without promptOnly", async () => {
    const binDir = await createTempDir();
    const argsFile = await createFakeBinary(binDir, "claude", "claude response");

    const result = await runAgentCall(binDir, "test prompt", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("claude response");

    const args = await readCapturedArgs(argsFile);
    expect(args).toContain("--print");
    expect(args).not.toContain("--tools");
  });

  test("passes --tools '' when promptOnly is true", async () => {
    const binDir = await createTempDir();
    const argsFile = await createFakeBinary(binDir, "claude", "claude prompt-only");

    const result = await runAgentCall(binDir, "test prompt", true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("claude prompt-only");

    const args = await readCapturedArgs(argsFile);
    const toolsIdx = args.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    // The value after --tools should be empty string
    const toolsValue = args[toolsIdx + 1];
    expect(toolsValue).toBe("");
  });
});

// ─── promptAgent: gemini backend ─────────────────────────────────────────────

describe("promptAgent with gemini backend", () => {
  test("passes correct flags without promptOnly", async () => {
    const binDir = await createTempDir();
    const argsFile = await createFakeBinary(binDir, "gemini", "gemini response");

    const result = await runAgentCall(binDir, "test prompt", false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("gemini response");

    const args = await readCapturedArgs(argsFile);
    expect(args).toContain("--prompt");
    expect(args).not.toContain("--approval-mode");
  });

  test("passes --approval-mode plan when promptOnly is true", async () => {
    const binDir = await createTempDir();
    const argsFile = await createFakeBinary(binDir, "gemini", "gemini prompt-only");

    const result = await runAgentCall(binDir, "test prompt", true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("gemini prompt-only");

    const args = await readCapturedArgs(argsFile);
    const modeIdx = args.indexOf("--approval-mode");
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(args[modeIdx + 1]).toBe("plan");
  });
});

// ─── promptAgent: error handling ─────────────────────────────────────────────

describe("promptAgent error handling", () => {
  test("throws when no backend is available", async () => {
    const binDir = await createTempDir();

    const result = await runAgentCall(binDir, "test prompt", false);
    expect(result.exitCode).toBe(1);
  });

  test("throws when backend exits non-zero", async () => {
    const binDir = await createTempDir();
    await createFakeBinary(binDir, "claude", "error output", 1);

    const result = await runAgentCall(binDir, "test prompt", false);
    expect(result.exitCode).toBe(1);
  });
});
