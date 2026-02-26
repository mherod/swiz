import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface HookResult {
  decision?: string;
  reason?: string;
}

async function runHook(
  {
    homeDir,
    toolName = "Bash",
    sessionId = "session-123",
  }: { homeDir: string; toolName?: string; sessionId?: string }
): Promise<HookResult> {
  const payload = JSON.stringify({
    tool_name: toolName,
    session_id: sessionId,
  });
  const proc = Bun.spawn(["bun", "hooks/pretooluse-require-tasks.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: homeDir },
  });
  proc.stdin.write(payload);
  proc.stdin.end();

  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (!out.trim()) return {};

  const parsed = JSON.parse(out.trim());
  const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined;
  return {
    decision: (hso?.permissionDecision ?? parsed.decision) as string | undefined,
    reason: (hso?.permissionDecisionReason ?? parsed.reason) as string | undefined,
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-require-tasks-"));
  tempDirs.push(dir);
  return dir;
}

async function writeTask(
  homeDir: string,
  sessionId: string,
  {
    id,
    subject,
    status,
  }: {
    id: string;
    subject: string;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }
) {
  const dir = join(homeDir, ".claude", "tasks", sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify(
      {
        id,
        subject,
        description: "",
        status,
        blocks: [],
        blockedBy: [],
      },
      null,
      2
    )
  );
}

describe("pretooluse-require-tasks", () => {
  test("denies Bash when session has no tasks", async () => {
    const homeDir = await createTempHome();
    const result = await runHook({ homeDir, toolName: "Bash" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("no incomplete tasks");
  });

  test("denies Edit when only completed/cancelled tasks exist", async () => {
    const homeDir = await createTempHome();
    const sessionId = "session-abc";
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Done task",
      status: "completed",
    });
    await writeTask(homeDir, sessionId, {
      id: "2",
      subject: "Cancelled task",
      status: "cancelled",
    });

    const result = await runHook({ homeDir, toolName: "Edit", sessionId });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("no incomplete tasks");
  });

  test("allows Shell when at least one pending task exists", async () => {
    const homeDir = await createTempHome();
    const sessionId = "session-pending";
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Next step",
      status: "pending",
    });

    const result = await runHook({ homeDir, toolName: "Shell", sessionId });
    expect(result.decision).toBeUndefined();
  });

  test("allows Edit when at least one in_progress task exists", async () => {
    const homeDir = await createTempHome();
    const sessionId = "session-active";
    await writeTask(homeDir, sessionId, {
      id: "1",
      subject: "Current work",
      status: "in_progress",
    });

    const result = await runHook({ homeDir, toolName: "Edit", sessionId });
    expect(result.decision).toBeUndefined();
  });
});
