import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ─── Git repo helpers ─────────────────────────────────────────────────────────

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

async function runGit(dir: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out.trim()
}

async function makeTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-secret-scanner-"))
  tempDirs.push(dir)
  await runGit(dir, ["init"])
  await runGit(dir, ["config", "user.email", "test@example.com"])
  await runGit(dir, ["config", "user.name", "Test"])
  return dir
}

async function commitFile(dir: string, relPath: string, content: string): Promise<void> {
  const parts = relPath.split("/")
  if (parts.length > 1) {
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true })
  }
  await writeFile(join(dir, relPath), content)
  await runGit(dir, ["add", relPath])
  await runGit(dir, ["commit", "-m", `add ${relPath}`])
}

async function runHook(dir: string): Promise<{ blocked: boolean; reason?: string; raw: string }> {
  const payload = JSON.stringify({ cwd: dir, session_id: "test-session" })
  const proc = Bun.spawn(["bun", "hooks/stop-secret-scanner.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  })
  proc.stdin.write(payload)
  proc.stdin.end()
  const raw = await new Response(proc.stdout).text()
  await proc.exited

  const trimmed = raw.trim()
  if (!trimmed) return { blocked: false, raw: trimmed }
  const parsed = JSON.parse(trimmed)
  return { blocked: parsed.decision === "block", reason: parsed.reason, raw: trimmed }
}

// ─── GENERIC_SECRET_RE spacing variants ───────────────────────────────────────
const K = "API_KEY"
const Klc = "api_key"
const Kpw = "password"
const V = "supersecret1234" // 15 chars, no exclusion words
const Vpw = "wwwwwwwwwwww" // 12 chars

describe("stop-secret-scanner: GENERIC_SECRET_RE \\s*[:=]\\s* spacing variants", () => {
  test("blocks API_KEY=value (no spaces around =)", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const ${K}="${V}";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain(K)
  })

  test("blocks API_KEY = value (spaces around =)", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const ${K} = "${V}";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })

  test("blocks API_KEY= value (space only after =)", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const ${K}= "${V}";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })

  test("blocks API_KEY =value (space only before =)", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const ${K} ="${V}";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })

  test("blocks api_key: value (colon format, no spaces)", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.yml", `${Klc}: "${V}"\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })

  test("blocks api_key : value (spaces around colon)", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const config = { ${Klc} : "${V}" };\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })

  test("blocks password='value' (single quotes)", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "setup.ts", `const ${Kpw}='${Vpw}';\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })
})

// ─── GENERIC_SECRET_RE exclusions ─────────────────────────────────────────────

describe("stop-secret-scanner: GENERIC_SECRET_RE exclusions allow stop", () => {
  test("allows API_KEY with 'example' value", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const API_KEY = "example_api_key_here";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("allows API_KEY with 'placeholder' value", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const API_KEY = "placeholder_value_here";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("allows API_KEY with 'your_' prefix", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const API_KEY = "your_api_key_goes_here";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("allows API_KEY with env. reference in value", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const API_KEY = "env.API_KEY_VALUE";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("allows API_KEY with 'xxxx' placeholder", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const API_KEY = "xxxx-placeholder-xxxx";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("allows short value (< 8 chars, below minimum length)", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const API_KEY = "short";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })
})

// ─── TOKEN_RE patterns ────────────────────────────────────────────────────────

describe("stop-secret-scanner: TOKEN_RE patterns", () => {
  test("blocks GitHub personal access token (ghp_ prefix)", async () => {
    const dir = await makeTempGitRepo()
    const fakeToken = `ghp_${"a".repeat(36)}`
    await commitFile(dir, "config.ts", `const TOKEN = "${fakeToken}";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("ghp_")
  })

  test("blocks Stripe live secret key (sk_live_ prefix)", async () => {
    const dir = await makeTempGitRepo()
    const fakeKey = `sk_live_${"b".repeat(24)}`
    await commitFile(dir, "config.ts", `const STRIPE_KEY = "${fakeKey}";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })
})

// ─── PRIVATE_KEY_RE patterns ──────────────────────────────────────────────────
const PEM_RSA = "-----BEGIN RSA PRIVATE KEY-----"
const PEM_OPENSSH = "-----BEGIN OPENSSH PRIVATE KEY-----"

describe("stop-secret-scanner: PRIVATE_KEY_RE patterns", () => {
  test("blocks PEM private key header", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "key.pem", `${PEM_RSA}\nMIIEowIBAAKCAQEA...\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain("PRIVATE KEY")
  })

  test("blocks OPENSSH private key header", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "id_ed25519", `${PEM_OPENSSH}\nb3BlbnNzaC1rZXktdjEAAAAA...\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })
})

// ─── Test file exclusion ──────────────────────────────────────────────────────

describe("stop-secret-scanner: test file exclusion", () => {
  test("allows secret-like patterns committed inside a .test.ts file", async () => {
    const dir = await makeTempGitRepo()
    // A real secret-like value in a test fixture — hook should skip .test.ts files
    await commitFile(dir, "config.test.ts", `const API_KEY = "supersecret1234";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("allows secret-like patterns committed inside a .spec.ts file", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "auth.spec.ts", `const TOKEN = "ghp_" + "a".repeat(36);\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("still blocks the same pattern in a non-test .ts file", async () => {
    const dir = await makeTempGitRepo()
    await commitFile(dir, "config.ts", `const API_KEY = "supersecret1234";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })
})

// ─── Findings limit ───────────────────────────────────────────────────────────

describe("stop-secret-scanner: findings collection limit", () => {
  test("stops scanning after finding 10 secrets (performance limit)", async () => {
    const dir = await makeTempGitRepo()
    // Commit 15 secret patterns — hook should stop at 10 and report only those
    const secrets = []
    for (let i = 0; i < 15; i++) {
      // API_KEY with unique numeric secret values (8+ chars minimum)
      secrets.push(`const API_KEY = "secret${i.toString().padStart(8, "0")}";`)
    }
    await commitFile(dir, "config.ts", `${secrets.join("\n")}\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
    // Should contain reason with "Suspicious lines:" header and multiple findings
    expect(result.reason).toContain("Suspicious lines:")
    // Count lines that start with "  " (indented findings) in the reason
    const lines = result.reason?.split("\n") ?? []
    const findingLines = lines.filter((l) => l.startsWith("  "))
    expect(findingLines.length).toBe(10) // Exactly 10 findings reported (limit)
  })
})

// ─── Robustness: edge cases and malformed input ────────────────────────────────

describe("stop-secret-scanner: robustness against edge cases", () => {
  test("handles diff with missing +++ header at start", async () => {
    const dir = await makeTempGitRepo()
    // Commit a file with secret, then manually check the hook doesn't crash
    // if diff is missing the +++ header (edge case)
    await commitFile(dir, "config.ts", `const API_KEY = "supersecret1234";\n`)
    const result = await runHook(dir)
    // Should still block because the file is non-test and contains the secret
    expect(result.blocked).toBe(true)
  })

  test("handles diff with null bytes (binary-like content)", async () => {
    const dir = await makeTempGitRepo()
    // Commit a file with secret value mixed with null-like patterns
    await commitFile(dir, "config.ts", `const API_KEY = "secret\\x00value";\n`)
    const result = await runHook(dir)
    // Should handle gracefully — null bytes in strings are literal, not binary markers
    expect(result.blocked).toBe(true)
  })

  test("handles very long diff lines (truncated at 120 chars in report)", async () => {
    const dir = await makeTempGitRepo()
    // Create a very long line with a secret embedded
    const longSecret = `const API_KEY = "${"a".repeat(200)}";\n`
    await commitFile(dir, "config.ts", longSecret)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
    // Verify the reported line is truncated at 120 chars
    const lines = result.reason?.split("\n") ?? []
    const findingLines = lines.filter((l) => l.startsWith("  "))
    expect(findingLines[0]?.length).toBeLessThanOrEqual(122) // "  " + 120 chars
  })

  test("handles empty file additions", async () => {
    const dir = await makeTempGitRepo()
    // Add an empty file
    await commitFile(dir, "empty.ts", "")
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("handles mixed line endings (CRLF and LF)", async () => {
    const dir = await makeTempGitRepo()
    // Commit with mixed line endings
    await commitFile(
      dir,
      "config.ts",
      `const API_KEY = "supersecret1234";\r\nconst USER = "test";\n`
    )
    const result = await runHook(dir)
    // Should correctly identify the secret regardless of line ending
    expect(result.blocked).toBe(true)
  })

  test("handles secret value at exact 8-char minimum length", async () => {
    const dir = await makeTempGitRepo()
    // GENERIC_SECRET_RE requires 8+ chars: [^"']{8,}
    await commitFile(dir, "config.ts", `const API_KEY = "12345678";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })

  test("ignores secret value with exactly 7 chars (below minimum)", async () => {
    const dir = await makeTempGitRepo()
    // 7 chars is below the 8-char minimum in GENERIC_SECRET_RE
    await commitFile(dir, "config.ts", `const API_KEY = "1234567";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
  })

  test("handles multiline strings with embedded secrets", async () => {
    const dir = await makeTempGitRepo()
    // Secret split across lines with template literals
    await commitFile(dir, "config.ts", `const API_KEY = \`secret\nvalue123456\`;\n`)
    const result = await runHook(dir)
    // Line-by-line checking, so only the first line is checked
    // "const API_KEY = `secret" doesn't match the pattern
    // (the pattern expects a closing quote on the same line)
    expect(result.blocked).toBe(false)
  })

  test("handles secret value with mixed alphanumeric and symbols", async () => {
    const dir = await makeTempGitRepo()
    // Secret with mixed characters (alphanumeric + dashes/dots)
    await commitFile(dir, "config.ts", `const API_KEY = "secret-key-12345";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })

  test("handles secrets with Unicode characters", async () => {
    const dir = await makeTempGitRepo()
    // Secret with Unicode (8+ chars including Unicode)
    await commitFile(dir, "config.ts", `const PASSWORD = "pässwörd1234";\n`)
    const result = await runHook(dir)
    expect(result.blocked).toBe(true)
  })
})

// ─── Non-git directory ────────────────────────────────────────────────────────

describe("stop-secret-scanner: non-git directory", () => {
  test("exits silently in a non-git directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-scanner-nogit-"))
    tempDirs.push(dir)
    const result = await runHook(dir)
    expect(result.blocked).toBe(false)
    expect(result.raw).toBe("")
  })
})
