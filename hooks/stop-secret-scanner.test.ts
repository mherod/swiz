import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── Git repo helpers ─────────────────────────────────────────────────────────

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function runGit(dir: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function makeTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-secret-scanner-"));
  tempDirs.push(dir);
  await runGit(dir, ["init"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await runGit(dir, ["config", "user.name", "Test"]);
  return dir;
}

async function commitFile(dir: string, relPath: string, content: string): Promise<void> {
  const parts = relPath.split("/");
  if (parts.length > 1) {
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
  }
  await writeFile(join(dir, relPath), content);
  await runGit(dir, ["add", relPath]);
  await runGit(dir, ["commit", "-m", `add ${relPath}`]);
}

async function runHook(dir: string): Promise<{ blocked: boolean; reason?: string; raw: string }> {
  const payload = JSON.stringify({ cwd: dir, session_id: "test-session" });
  const proc = Bun.spawn(["bun", "hooks/stop-secret-scanner.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const raw = await new Response(proc.stdout).text();
  await proc.exited;

  const trimmed = raw.trim();
  if (!trimmed) return { blocked: false, raw: trimmed };
  const parsed = JSON.parse(trimmed);
  return { blocked: parsed.decision === "block", reason: parsed.reason, raw: trimmed };
}

// ─── GENERIC_SECRET_RE spacing variants ───────────────────────────────────────

describe("stop-secret-scanner: GENERIC_SECRET_RE \\s*[:=]\\s* spacing variants", () => {
  test("blocks API_KEY=value (no spaces around =)", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.ts", `const API_KEY="supersecretvalue123";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("API_KEY");
  });

  test("blocks API_KEY = value (spaces around =)", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.ts", `const API_KEY = "supersecretvalue123";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(true);
  });

  test("blocks API_KEY= value (space only after =)", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.ts", `const API_KEY= "supersecretvalue123";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(true);
  });

  test("blocks API_KEY =value (space only before =)", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.ts", `const API_KEY ="supersecretvalue123";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(true);
  });

  test("blocks api_key: value (colon format, no spaces)", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.yml", `api_key: "supersecretvalue123"\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(true);
  });

  test("blocks api_key : value (spaces around colon)", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.ts", `const config = { api_key : "supersecretvalue123" };\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(true);
  });

  test("blocks password='value' (single quotes)", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "setup.ts", `const password='mysecretpassword123';\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(true);
  });
});

// ─── GENERIC_SECRET_RE exclusions ─────────────────────────────────────────────

describe("stop-secret-scanner: GENERIC_SECRET_RE exclusions allow stop", () => {
  test("allows API_KEY with 'example' value", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.ts", `const API_KEY = "example_api_key_here";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(false);
  });

  test("allows API_KEY with 'placeholder' value", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.ts", `const API_KEY = "placeholder_value_here";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(false);
  });

  test("allows API_KEY with 'your_' prefix", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.ts", `const API_KEY = "your_api_key_goes_here";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(false);
  });

  test("allows API_KEY with env. reference in value", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.ts", `const API_KEY = "env.API_KEY_VALUE";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(false);
  });

  test("allows API_KEY with 'xxxx' placeholder", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.ts", `const API_KEY = "xxxx-placeholder-xxxx";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(false);
  });

  test("allows short value (< 8 chars, below minimum length)", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "config.ts", `const API_KEY = "short";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(false);
  });
});

// ─── TOKEN_RE patterns ────────────────────────────────────────────────────────

describe("stop-secret-scanner: TOKEN_RE patterns", () => {
  test("blocks GitHub personal access token (ghp_ prefix)", async () => {
    const dir = await makeTempGitRepo();
    const fakeToken = "ghp_" + "a".repeat(36);
    await commitFile(dir, "config.ts", `const TOKEN = "${fakeToken}";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("ghp_");
  });

  test("blocks Stripe live secret key (sk_live_ prefix)", async () => {
    const dir = await makeTempGitRepo();
    const fakeKey = "sk_live_" + "b".repeat(24);
    await commitFile(dir, "config.ts", `const STRIPE_KEY = "${fakeKey}";\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(true);
  });
});

// ─── PRIVATE_KEY_RE patterns ──────────────────────────────────────────────────

describe("stop-secret-scanner: PRIVATE_KEY_RE patterns", () => {
  test("blocks PEM private key header", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "key.pem", `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("PRIVATE KEY");
  });

  test("blocks OPENSSH private key header", async () => {
    const dir = await makeTempGitRepo();
    await commitFile(dir, "id_ed25519", `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA...\n-----END OPENSSH PRIVATE KEY-----\n`);
    const result = await runHook(dir);
    expect(result.blocked).toBe(true);
  });
});

// ─── Non-git directory ────────────────────────────────────────────────────────

describe("stop-secret-scanner: non-git directory", () => {
  test("exits silently in a non-git directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-scanner-nogit-"));
    tempDirs.push(dir);
    const result = await runHook(dir);
    expect(result.blocked).toBe(false);
    expect(result.raw).toBe("");
  });
});
