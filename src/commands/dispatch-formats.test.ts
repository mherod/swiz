import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface DispatchResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  parsed: Record<string, unknown> | null;
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runGit(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  }
}

async function dispatch(
  {
    event,
    hookEventName,
    payload,
    homeDir,
  }: {
    event: string;
    hookEventName: string;
    payload: Record<string, unknown>;
    homeDir: string;
  }
): Promise<DispatchResult> {
  const proc = Bun.spawn(
    ["bun", "run", "index.ts", "dispatch", event, hookEventName],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: homeDir },
    }
  );

  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  let parsed: Record<string, unknown> | null = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }

  return { stdout, stderr, exitCode: proc.exitCode, parsed };
}

async function writeTask(
  homeDir: string,
  sessionId: string,
  status: "pending" | "in_progress" | "completed" | "cancelled"
): Promise<void> {
  const tasksDir = join(homeDir, ".claude", "tasks", sessionId);
  await mkdir(tasksDir, { recursive: true });
  await writeFile(
    join(tasksDir, "1.json"),
    JSON.stringify(
      {
        id: "1",
        subject: "Dispatch contract task",
        description: "Task for dispatch contract tests",
        status,
        blocks: [],
        blockedBy: [],
      },
      null,
      2
    )
  );
}

describe("dispatch output formats", () => {
  test("preToolUse deny uses hookSpecificOutput.permissionDecision", async () => {
    const homeDir = await createTempDir("swiz-dispatch-home-");
    const cwd = await createTempDir("swiz-dispatch-cwd-");
    const result = await dispatch({
      event: "preToolUse",
      hookEventName: "PreToolUse",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        session_id: "session-deny",
        cwd,
      },
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed).not.toBeNull();

    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown>;
    expect(hso.hookEventName).toBe("PreToolUse");
    expect(hso.permissionDecision).toBe("deny");
    expect(typeof hso.permissionDecisionReason).toBe("string");
  });

  test("preToolUse allow-with-reason uses hookSpecificOutput envelope", async () => {
    const homeDir = await createTempDir("swiz-dispatch-home-");
    const cwd = await createTempDir("swiz-dispatch-cwd-");
    const sessionId = "session-allow";
    await writeTask(homeDir, sessionId, "pending");

    const result = await dispatch({
      event: "preToolUse",
      hookEventName: "PreToolUse",
      payload: {
        tool_name: "Bash",
        tool_input: { command: "grep -r TODO src/" },
        session_id: sessionId,
        cwd,
      },
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed).not.toBeNull();

    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown>;
    expect(hso.hookEventName).toBe("PreToolUse");
    expect(hso.permissionDecision).toBe("allow");
    expect(typeof hso.permissionDecisionReason).toBe("string");
    expect((hso.permissionDecisionReason as string).toLowerCase()).toContain("rg");
  });

  test("stop block uses top-level decision + reason", async () => {
    const homeDir = await createTempDir("swiz-dispatch-home-");
    const repoDir = await createTempDir("swiz-dispatch-repo-");
    const transcriptPath = join(repoDir, "transcript.jsonl");
    await writeFile(transcriptPath, JSON.stringify({ type: "user", message: { content: "done?" } }) + "\n");

    runGit(repoDir, ["init"]);
    runGit(repoDir, ["config", "user.email", "swiz-tests@example.com"]);
    runGit(repoDir, ["config", "user.name", "Swiz Tests"]);
    await writeFile(join(repoDir, "app.ts"), "export const value = 1;\n");
    runGit(repoDir, ["add", "app.ts"]);
    runGit(repoDir, ["commit", "-m", "test: init"]);
    await writeFile(join(repoDir, "app.ts"), "export const value = 2;\n");

    const result = await dispatch({
      event: "stop",
      hookEventName: "Stop",
      payload: {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: repoDir,
        stop_hook_active: false,
      },
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed).not.toBeNull();
    expect(result.parsed!.decision).toBe("block");
    expect(typeof result.parsed!.reason).toBe("string");
    expect(result.parsed!.reason as string).toContain("Uncommitted changes detected");
  });

  test("sessionStart context uses hookSpecificOutput.additionalContext", async () => {
    const homeDir = await createTempDir("swiz-dispatch-home-");
    const cwd = await createTempDir("swiz-dispatch-cwd-");
    const result = await dispatch({
      event: "sessionStart",
      hookEventName: "SessionStart",
      payload: {
        session_id: "session-start",
        cwd,
        trigger: "compact",
        matcher: "compact",
      },
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed).not.toBeNull();

    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown>;
    expect(hso.hookEventName).toBe("SessionStart");
    expect(typeof hso.additionalContext).toBe("string");
    expect(hso.additionalContext as string).toContain("Post-compaction context");
  });

  test("userPromptSubmit context uses hookSpecificOutput.additionalContext", async () => {
    const homeDir = await createTempDir("swiz-dispatch-home-");
    const cwd = await createTempDir("swiz-dispatch-cwd-");
    const result = await dispatch({
      event: "userPromptSubmit",
      hookEventName: "UserPromptSubmit",
      payload: {
        session_id: "session-user-prompt",
        cwd,
        prompt: "continue",
      },
      homeDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.parsed).not.toBeNull();

    const hso = result.parsed!.hookSpecificOutput as Record<string, unknown>;
    expect(hso.hookEventName).toBe("UserPromptSubmit");
    expect(typeof hso.additionalContext).toBe("string");
    expect((hso.additionalContext as string).length).toBeGreaterThan(0);
  });
});
