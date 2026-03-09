import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BUN_EXE = Bun.which("bun") ?? "bun"
const WORKSPACE_ROOT = process.cwd()

async function createRepo(remoteUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stop-pr-changes-requested-"))
  const run = (args: string[]) =>
    Bun.spawnSync(args, { cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env })

  run(["git", "init"])
  run(["git", "config", "user.email", "test@example.com"])
  run(["git", "config", "user.name", "Test User"])
  await writeFile(join(dir, "README.md"), "hello\n")
  run(["git", "add", "README.md"])
  run(["git", "commit", "-m", "init"])
  run(["git", "branch", "-M", "main"])
  run(["git", "checkout", "-b", "feat/awaiting-review"])
  run(["git", "remote", "add", "origin", remoteUrl])
  return dir
}

async function createFakeGhBin(
  mode: "awaiting" | "approved" | "changes-requested"
): Promise<string> {
  const fakeBin = await mkdtemp(join(tmpdir(), "stop-pr-changes-gh-"))
  const ghPath = join(fakeBin, "gh")
  const reviews =
    mode === "awaiting"
      ? "[]"
      : mode === "approved"
        ? '[{"state":"APPROVED","user":{"login":"reviewer1"},"submitted_at":"2026-03-01T00:00:00Z"}]'
        : '[{"state":"CHANGES_REQUESTED","user":{"login":"reviewer1"},"body":"needs updates","submitted_at":"2026-03-01T00:00:00Z"}]'

  await writeFile(
    ghPath,
    `#!/bin/sh
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo "mherod/swiz"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[{"number":222,"title":"Test PR"}]'
  exit 0
fi
if [ "$1" = "api" ]; then
  if echo "$*" | grep -q '/pulls/222/reviews'; then
    echo '${reviews}'
    exit 0
  fi
  if echo "$*" | grep -q '/pulls/222/comments'; then
    echo '[]'
    exit 0
  fi
  if echo "$*" | grep -q '/issues/222/comments'; then
    echo '[]'
    exit 0
  fi
  echo '[]'
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
  pathOverride?: string
): Promise<{ raw: string; parsed: Record<string, unknown> | null }> {
  const payload = JSON.stringify({ session_id: "test-session", cwd, transcript_path: "" })
  const env = {
    ...process.env,
    ...(pathOverride ? { PATH: `${pathOverride}:${process.env.PATH ?? ""}` } : {}),
  }
  const proc = Bun.spawn([BUN_EXE, "hooks/stop-pr-changes-requested.ts"], {
    cwd: WORKSPACE_ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  proc.stdin.write(payload)
  proc.stdin.end()
  const raw = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  if (!raw) return { raw, parsed: null }
  return { raw, parsed: JSON.parse(raw) as Record<string, unknown> }
}

describe("stop-pr-changes-requested", () => {
  test("blocks with awaiting-first-review message when PR has zero reviews", async () => {
    const repo = await createRepo("https://github.com/mherod/swiz.git")
    const fakeGh = await createFakeGhBin("awaiting")
    try {
      const result = await runHook(repo, fakeGh)
      expect(result.parsed?.decision).toBe("block")
      const reason = String(result.parsed?.reason ?? "")
      expect(reason).toContain("awaiting first review")
      expect(reason).toContain("PR #222")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeGh, { recursive: true, force: true }),
      ])
    }
  })

  test("allows stop when PR has an APPROVED review and no CHANGES_REQUESTED", async () => {
    const repo = await createRepo("https://github.com/mherod/swiz.git")
    const fakeGh = await createFakeGhBin("approved")
    try {
      const result = await runHook(repo, fakeGh)
      expect(result.raw).toBe("")
      expect(result.parsed).toBeNull()
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeGh, { recursive: true, force: true }),
      ])
    }
  })

  test("keeps existing CHANGES_REQUESTED blocking behaviour", async () => {
    const repo = await createRepo("https://github.com/mherod/swiz.git")
    const fakeGh = await createFakeGhBin("changes-requested")
    try {
      const result = await runHook(repo, fakeGh)
      expect(result.parsed?.decision).toBe("block")
      const reason = String(result.parsed?.reason ?? "")
      expect(reason).toContain("changes requested")
      expect(reason).toContain("reviewer1")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeGh, { recursive: true, force: true }),
      ])
    }
  })
})
