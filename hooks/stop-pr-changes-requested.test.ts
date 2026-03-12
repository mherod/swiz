import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BUN_EXE = Bun.which("bun") ?? "bun"
const WORKSPACE_ROOT = process.cwd()

async function setTeamMode(repoDir: string): Promise<void> {
  await mkdir(join(repoDir, ".swiz"), { recursive: true })
  await writeFile(
    join(repoDir, ".swiz", "config.json"),
    JSON.stringify({ collaborationMode: "team" })
  )
}

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
  mode:
    | "awaiting"
    | "awaiting-self-authored"
    | "awaiting-self-authored-with-reviewer"
    | "approved"
    | "changes-requested"
): Promise<string> {
  const fakeBin = await mkdtemp(join(tmpdir(), "stop-pr-changes-gh-"))
  const ghPath = join(fakeBin, "gh")
  const isAwaiting =
    mode === "awaiting" ||
    mode === "awaiting-self-authored" ||
    mode === "awaiting-self-authored-with-reviewer"
  const reviews = isAwaiting
    ? "[]"
    : mode === "approved"
      ? '[{"state":"APPROVED","user":{"login":"reviewer1"},"submitted_at":"2026-03-01T00:00:00Z"}]'
      : '[{"state":"CHANGES_REQUESTED","user":{"login":"reviewer1"},"body":"needs updates","submitted_at":"2026-03-01T00:00:00Z"}]'
  const isSelfAuthored =
    mode === "awaiting-self-authored" || mode === "awaiting-self-authored-with-reviewer"
  const hasRequestedReviewer = mode === "awaiting-self-authored-with-reviewer"

  await writeFile(
    ghPath,
    `#!/bin/sh
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo "mherod/swiz"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ "${isSelfAuthored}" = "true" ]; then
    echo '[{"number":222,"title":"Test PR","author":{"login":"mherod"}}]'
    exit 0
  fi
  echo '[{"number":222,"title":"Test PR","author":{"login":"teammate"}}]'
  exit 0
fi
if [ "$1" = "api" ]; then
  if echo "$*" | grep -q ' user '; then
    echo 'mherod'
    exit 0
  fi
  if echo "$*" | grep -q '/pulls/222/reviews'; then
    echo '${reviews}'
    exit 0
  fi
  if echo "$*" | grep -q '/pulls/222$'; then
    if [ "${hasRequestedReviewer}" = "true" ]; then
      echo '{"requested_reviewers":[{"login":"reviewer1"}],"requested_teams":[]}'
      exit 0
    fi
    echo '{"requested_reviewers":[],"requested_teams":[]}'
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
  await proc.stdin.write(payload)
  await proc.stdin.end()
  const raw = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  if (!raw) return { raw, parsed: null }
  return { raw, parsed: JSON.parse(raw) as Record<string, unknown> }
}

describe("stop-pr-changes-requested", () => {
  test("blocks with awaiting-first-review message when PR has zero reviews", async () => {
    const repo = await createRepo("https://github.com/mherod/swiz.git")
    await setTeamMode(repo)
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

  test("allows stop in relaxed-collab mode even with CHANGES_REQUESTED (no peer review required)", async () => {
    const repo = await createRepo("https://github.com/mherod/swiz.git")
    await mkdir(join(repo, ".swiz"), { recursive: true })
    await writeFile(
      join(repo, ".swiz", "config.json"),
      JSON.stringify({ collaborationMode: "relaxed-collab" })
    )
    const fakeGh = await createFakeGhBin("changes-requested")
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
    await setTeamMode(repo)
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

  test("blocks self-authored awaiting-review PR with valid actionable guidance", async () => {
    const repo = await createRepo("https://github.com/mherod/swiz.git")
    await setTeamMode(repo)
    const fakeGh = await createFakeGhBin("awaiting-self-authored")
    try {
      const result = await runHook(repo, fakeGh)
      expect(result.parsed?.decision).toBe("block")
      const reason = String(result.parsed?.reason ?? "")
      expect(reason).toContain("self-authored PR")
      expect(reason).toContain("gh pr edit 222 --add-reviewer")
      expect(reason).not.toContain("/pr-request-changes")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeGh, { recursive: true, force: true }),
      ])
    }
  })

  test("allows self-authored awaiting-review PR when reviewer is already requested", async () => {
    const repo = await createRepo("https://github.com/mherod/swiz.git")
    const fakeGh = await createFakeGhBin("awaiting-self-authored-with-reviewer")
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
})
