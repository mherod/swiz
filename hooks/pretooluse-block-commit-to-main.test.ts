import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRepo } from "./utils/test-utils.ts"

const BUN_EXE = Bun.which("bun") ?? "bun"
const WORKSPACE_ROOT = process.cwd()

async function createFakeGhBin(currentUser: string): Promise<string> {
  const fakeBin = await mkdtemp(join(tmpdir(), "pretooluse-block-commit-gh-"))
  const ghPath = join(fakeBin, "gh")
  await writeFile(
    ghPath,
    `#!/bin/sh
if [ "$1" = "api" ] && echo " $* " | grep -q ' user '; then
  echo "${currentUser}"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo "[]"
  exit 0
fi
if [ "$1" = "api" ]; then
  echo "[]"
  exit 0
fi
echo ""
exit 0
`
  )
  await chmod(ghPath, 0o755)
  return fakeBin
}

async function runHook(
  cwd: string,
  command: string,
  pathOverride?: string
): Promise<{ raw: string; parsed: Record<string, unknown> | null; decision?: string }> {
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command, cwd },
    cwd,
  })

  const env = {
    ...process.env,
    ...(pathOverride ? { PATH: `${pathOverride}:${process.env.PATH ?? ""}` } : {}),
  }
  const proc = Bun.spawn([BUN_EXE, "hooks/pretooluse-block-commit-to-main.ts"], {
    cwd: WORKSPACE_ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()
  const raw = (await new Response(proc.stdout).text()).trim()
  const stderr = (await new Response(proc.stderr).text()).trim()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`hook exited with ${exitCode}: ${stderr || "(no stderr)"}`)
  }
  if (!raw) return { raw, parsed: null }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined
  const decision = (hso?.permissionDecision as string) ?? (parsed.decision as string) ?? undefined
  return { raw, parsed, decision }
}

describe("pretooluse-block-commit-to-main", () => {
  test("blocks git commit on default branch in collaborative repo", async () => {
    const repo = await createTestRepo("https://github.com/acme/repo.git")
    const fakeBin = await createFakeGhBin("mherod")
    try {
      const result = await runHook(repo, 'git commit -m "test"', fakeBin)
      expect(result.parsed).not.toBeNull()
      const hso = result.parsed?.hookSpecificOutput as Record<string, unknown>
      expect(hso.permissionDecision).toBe("deny")
      expect(String(hso.permissionDecisionReason ?? "")).toContain(
        "Committing directly to 'main' is blocked"
      )
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })

  test("allows git commit on default branch in solo repo", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    const fakeBin = await createFakeGhBin("mherod")
    try {
      const result = await runHook(repo, 'git commit -m "test"', fakeBin)
      expect(result.decision).toBe("allow")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })

  test("allows git commit on feature branch in collaborative repo", async () => {
    const repo = await createTestRepo("https://github.com/acme/repo.git")
    const fakeBin = await createFakeGhBin("mherod")
    await Bun.spawn(["git", "checkout", "-b", "feat/test"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    }).exited
    try {
      const result = await runHook(repo, 'git commit -m "test"', fakeBin)
      expect(result.decision).toBe("allow")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })
})
