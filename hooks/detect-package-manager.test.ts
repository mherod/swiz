import { describe, test, expect, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Use absolute path so the script is found regardless of spawn CWD.
const HOOK_PATH = resolve(process.cwd(), "hooks/pretooluse-no-npm.ts");

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(suffix = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `swiz-detect-pm${suffix}-`));
  tempDirs.push(dir);
  return dir;
}

/**
 * Spawn the no-npm hook from a given CWD and check whether `npm install`
 * is blocked or passes through. This exercises detectPackageManager() end-to-end
 * because the hook calls it at module load using process.cwd().
 */
async function npmDecisionInDir(dir: string): Promise<{ decision: string | undefined; reason: string | undefined }> {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install" } });
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: dir,
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (!out.trim()) return { decision: undefined, reason: undefined };
  const parsed = JSON.parse(out.trim());
  const hso = parsed.hookSpecificOutput;
  return {
    decision: hso?.permissionDecision ?? parsed.decision,
    reason: hso?.permissionDecisionReason ?? parsed.reason,
  };
}

/** Same but for `pnpm install` — used to confirm PM detection without relying on deny message text. */
async function pnpmDecisionInDir(dir: string): Promise<string | undefined> {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm install" } });
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: dir,
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (!out.trim()) return undefined;
  const parsed = JSON.parse(out.trim());
  return parsed.hookSpecificOutput?.permissionDecision ?? parsed.decision;
}

// ─── No lockfile ─────────────────────────────────────────────────────────────

describe("detectPackageManager — no lockfile", () => {
  test("returns null → hook allows everything", async () => {
    const dir = await makeTempDir("-empty");
    // npm install should pass through (can't enforce without knowing the PM)
    const result = await npmDecisionInDir(dir);
    expect(result.decision).toBeUndefined();
  });
});

// ─── bun lockfile variants ───────────────────────────────────────────────────

describe("detectPackageManager — bun lockfiles", () => {
  test("bun.lock → detects bun, npm is blocked", async () => {
    const dir = await makeTempDir("-bunlock");
    await writeFile(join(dir, "bun.lock"), "");
    const result = await npmDecisionInDir(dir);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("bun");
  });

  test("bun.lockb → detects bun, npm is blocked", async () => {
    const dir = await makeTempDir("-bunlockb");
    await writeFile(join(dir, "bun.lockb"), "");
    const result = await npmDecisionInDir(dir);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("bun");
  });

  test("bun.lock → pnpm install is blocked", async () => {
    const dir = await makeTempDir("-bunlock-pnpm");
    await writeFile(join(dir, "bun.lock"), "");
    const decision = await pnpmDecisionInDir(dir);
    expect(decision).toBe("deny");
  });
});

// ─── Other package managers ───────────────────────────────────────────────────

describe("detectPackageManager — pnpm / yarn / npm", () => {
  test("pnpm-lock.yaml → pnpm detected, npm blocked", async () => {
    const dir = await makeTempDir("-pnpm");
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
    const result = await npmDecisionInDir(dir);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("pnpm");
  });

  test("yarn.lock → yarn detected, npm blocked", async () => {
    const dir = await makeTempDir("-yarn");
    await writeFile(join(dir, "yarn.lock"), "");
    const result = await npmDecisionInDir(dir);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("yarn");
  });

  test("package-lock.json → npm detected, npm install is allowed", async () => {
    const dir = await makeTempDir("-npm");
    await writeFile(join(dir, "package-lock.json"), "{}");
    // npm is the project PM → hook should pass npm through
    const result = await npmDecisionInDir(dir);
    expect(result.decision).toBeUndefined(); // allowed = no output
  });
});

// ─── Nested lockfile (walk-up) ────────────────────────────────────────────────

describe("detectPackageManager — lockfile in parent directory", () => {
  test("bun.lock in parent is found when CWD is a subdirectory", async () => {
    const parent = await makeTempDir("-parent");
    const child = join(parent, "packages", "app");
    await mkdir(child, { recursive: true });
    await writeFile(join(parent, "bun.lock"), "");
    // CWD has no lockfile; parent does → should walk up and detect bun
    const result = await npmDecisionInDir(child);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("bun");
  });

  test("pnpm-lock.yaml two levels up is still found", async () => {
    const root = await makeTempDir("-root");
    const deep = join(root, "a", "b", "c");
    await mkdir(deep, { recursive: true });
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
    const result = await npmDecisionInDir(deep);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("pnpm");
  });

  test("child lockfile takes precedence over parent lockfile", async () => {
    const parent = await makeTempDir("-precedence");
    const child = join(parent, "child");
    await mkdir(child);
    // Parent has pnpm, child has bun → child wins
    await writeFile(join(parent, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
    await writeFile(join(child, "bun.lock"), "");
    const result = await npmDecisionInDir(child);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("bun"); // bun wins, not pnpm
  });
});

// ─── Conflicting lockfiles (priority order) ───────────────────────────────────

describe("detectPackageManager — conflicting lockfiles in same directory", () => {
  test("bun.lock + pnpm-lock.yaml → bun wins (checked first)", async () => {
    const dir = await makeTempDir("-conflict-bun-pnpm");
    await writeFile(join(dir, "bun.lock"), "");
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
    const result = await npmDecisionInDir(dir);
    expect(result.reason).toContain("bun");
    // pnpm install should also be blocked (bun is PM, not pnpm)
    const pnpmDecision = await pnpmDecisionInDir(dir);
    expect(pnpmDecision).toBe("deny");
  });

  test("pnpm-lock.yaml + yarn.lock → pnpm wins", async () => {
    const dir = await makeTempDir("-conflict-pnpm-yarn");
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
    await writeFile(join(dir, "yarn.lock"), "");
    const result = await npmDecisionInDir(dir);
    expect(result.reason).toContain("pnpm");
  });

  test("yarn.lock + package-lock.json → yarn wins", async () => {
    const dir = await makeTempDir("-conflict-yarn-npm");
    await writeFile(join(dir, "yarn.lock"), "");
    await writeFile(join(dir, "package-lock.json"), "{}");
    const result = await npmDecisionInDir(dir);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("yarn");
  });

  test("bun.lockb + bun.lock → both detect bun (either file is sufficient)", async () => {
    const dir = await makeTempDir("-both-bun");
    await writeFile(join(dir, "bun.lockb"), "");
    await writeFile(join(dir, "bun.lock"), "");
    const result = await npmDecisionInDir(dir);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("bun");
  });
});
