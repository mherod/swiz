import { describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { writeProjectState } from "../src/settings.ts"
import { createTestRepo } from "../src/utils/test-utils.ts"

const BUN_EXE = Bun.which("bun") ?? "bun"
const WORKSPACE_ROOT = process.cwd()

async function enableTrunkMode(repo: string): Promise<void> {
  await mkdir(join(repo, ".swiz"), { recursive: true })
  await writeFile(join(repo, ".swiz", "config.json"), JSON.stringify({ trunkMode: true }))
}

async function runHook(
  cwd: string,
  command: string,
  toolName = "Bash",
  envOverrides: Record<string, string | undefined> = {}
): Promise<{ raw: string; parsed: Record<string, unknown> | null; decision?: string }> {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: { command, cwd },
    cwd,
  })

  const proc = Bun.spawn([BUN_EXE, "hooks/pretooluse-trunk-mode-branch-gate.ts"], {
    cwd: WORKSPACE_ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...envOverrides },
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

async function createMockGhBin(openPrCount: number): Promise<string> {
  const dir = await Bun.$`mktemp -d`.text()
  const binDir = dir.trim()
  const ghPath = join(binDir, "gh")
  await writeFile(
    ghPath,
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ "${openPrCount}" = "0" ]; then
    echo "[]"
  else
    echo '[{"number":42}]'
  fi
  exit 0
fi
echo "[]"
exit 0
`
  )
  await Bun.$`chmod +x ${ghPath}`
  return binDir
}

describe("pretooluse-trunk-mode-branch-gate", () => {
  test("allows branch creation when trunk mode is off", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    try {
      const result = await runHook(repo, "git checkout -b feat/off")
      expect(result.parsed).toBeNull()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("blocks git checkout -b to a feature branch when trunk mode is on", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "git checkout -b feat/trunk-block")
      expect(result.decision).toBe("deny")
      const hso = result.parsed?.hookSpecificOutput as Record<string, unknown>
      expect(String(hso?.permissionDecisionReason ?? "")).toContain("Trunk mode")
      expect(String(hso?.permissionDecisionReason ?? "")).toContain("feat/trunk-block")
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("allows git checkout main when trunk mode is on", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git", {
      featureBranch: "feat/side",
    })
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "git checkout main")
      expect(result.parsed).toBeNull()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("allows git checkout -b main when trunk mode is on", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git", {
      featureBranch: "feat/side",
    })
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "git checkout -b main")
      expect(result.parsed).toBeNull()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("blocks compound command that creates a non-default branch", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "git checkout main && git checkout -b feat/second")
      expect(result.decision).toBe("deny")
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("blocks gh pr checkout when trunk mode is on", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "gh pr checkout 42")
      expect(result.decision).toBe("deny")
      const hso = result.parsed?.hookSpecificOutput as Record<string, unknown>
      expect(String(hso?.permissionDecisionReason ?? "")).toMatch(/pull request|PR/i)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("allows gh pr checkout in reviewing state when open PRs exist", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    await writeProjectState(repo, "reviewing")
    const mockGhBin = await createMockGhBin(1)
    try {
      const result = await runHook(repo, "gh pr checkout 42", "Bash", {
        PATH: `${mockGhBin}:${process.env.PATH ?? ""}`,
        SWIZ_DAEMON_ORIGIN: "http://127.0.0.1:1",
      })
      expect(result.parsed).toBeNull()
    } finally {
      await rm(mockGhBin, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("blocks gh pr checkout in reviewing state when no open PRs exist", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    await writeProjectState(repo, "reviewing")
    const mockGhBin = await createMockGhBin(0)
    try {
      const result = await runHook(repo, "gh pr checkout 42", "Bash", {
        PATH: `${mockGhBin}:${process.env.PATH ?? ""}`,
        SWIZ_DAEMON_ORIGIN: "http://127.0.0.1:1",
      })
      expect(result.decision).toBe("deny")
    } finally {
      await rm(mockGhBin, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("blocks gh pr checkout in developing state even when open PRs exist", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    await writeProjectState(repo, "developing")
    const mockGhBin = await createMockGhBin(1)
    try {
      const result = await runHook(repo, "gh pr checkout 42", "Bash", {
        PATH: `${mockGhBin}:${process.env.PATH ?? ""}`,
        SWIZ_DAEMON_ORIGIN: "http://127.0.0.1:1",
      })
      expect(result.decision).toBe("deny")
      const hso = result.parsed?.hookSpecificOutput as Record<string, unknown>
      expect(String(hso?.permissionDecisionReason ?? "")).toContain("developing")
    } finally {
      await rm(mockGhBin, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("blocks gh pr create when trunk mode is on", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "gh pr create --fill")
      expect(result.decision).toBe("deny")
      const hso = result.parsed?.hookSpecificOutput as Record<string, unknown>
      expect(String(hso?.permissionDecisionReason ?? "")).toMatch(/pull request|PR/i)
      expect(String(hso?.permissionDecisionReason ?? "")).toMatch(/trunk mode/i)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("allows gh pr create when trunk mode is off", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    try {
      const result = await runHook(repo, "gh pr create --fill")
      expect(result.parsed).toBeNull()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("ignores non-shell tools", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "git checkout -b feat/x", "Read")
      expect(result.parsed).toBeNull()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("allows git status when trunk mode is on", async () => {
    const repo = await createTestRepo("https://github.com/mherod/repo.git")
    await enableTrunkMode(repo)
    try {
      const result = await runHook(repo, "git status")
      expect(result.parsed).toBeNull()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
