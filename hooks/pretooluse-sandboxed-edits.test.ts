import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOOK = "hooks/pretooluse-sandboxed-edits.ts"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

/** Create a temp dir under tmpdir() — used for cwd and fakeHome fixtures. */
async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-sandboxed-"))
  tempDirs.push(dir)
  return dir
}

/**
 * Create a temp dir under the real HOME — used for "outside" repo fixtures.
 *
 * On Linux, tmpdir() returns /tmp which is hardcoded in allowedRoots. Using
 * HOME as the base ensures "outside" dirs are never inside any allowed root
 * on either macOS or Linux.
 */
async function createOutsideDir(): Promise<string> {
  const realHome = process.env.HOME ?? tmpdir()
  const dir = await mkdtemp(join(realHome, ".swiz-sandboxed-outside-"))
  tempDirs.push(dir)
  return dir
}

/** Initialise a bare git repo (no commits needed) with an optional remote. */
async function initGitRepo(dir: string, remoteUrl?: string): Promise<void> {
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    await proc.exited
  }
  await run("init")
  await run("config", "user.email", "test@example.com")
  await run("config", "user.name", "Test")
  if (remoteUrl) {
    await run("remote", "add", "origin", remoteUrl)
  }
}

interface HookResult {
  exitCode: number | null
  stdout: string
  json: Record<string, unknown> | null
}

async function runHook(
  cwd: string,
  toolName: string,
  filePath: string,
  {
    sandboxedEdits = true,
    fakeHomeOverride,
  }: { sandboxedEdits?: boolean; fakeHomeOverride?: string } = {}
): Promise<HookResult> {
  // Build an env with a fake HOME so we can control whether sandboxedEdits is on/off.
  // readSwizSettings() reads from HOME/.swiz/settings.json.
  const fakeHome = fakeHomeOverride ?? (await mkdtemp(join(tmpdir(), "swiz-sandboxed-home-")))
  if (!fakeHomeOverride) tempDirs.push(fakeHome)

  if (!sandboxedEdits) {
    await mkdir(join(fakeHome, ".swiz"), { recursive: true })
    await writeFile(
      join(fakeHome, ".swiz", "settings.json"),
      JSON.stringify({ sandboxedEdits: false, autoContinue: false, pushGate: false, sessions: {} })
    )
  }

  const payload = JSON.stringify({
    tool_name: toolName,
    cwd,
    tool_input: { file_path: filePath },
  })

  // Override TMPDIR so the hook's tmpdir() returns a path that test fixture dirs
  // are NOT inside — otherwise allowedRoots includes the real tmpdir and all
  // mkdtemp-created "outside" dirs would be silently allowed on macOS.
  // On Linux tmpdir() IS /tmp so TMPDIR alone is insufficient; createOutsideDir()
  // creates "outside" dirs under HOME to avoid the hardcoded /tmp entry.
  const fakeTmpDir = join(fakeHome, "tmp")
  await mkdir(fakeTmpDir, { recursive: true })

  const proc = Bun.spawn(["bun", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: fakeHome, TMPDIR: fakeTmpDir },
    // No cwd override — run from project root so the relative HOOK path resolves.
    // The agent's session cwd is passed via the stdin JSON payload instead.
  })
  proc.stdin.write(payload)
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  await proc.exited

  let json: Record<string, unknown> | null = null
  try {
    if (stdout.trim()) json = JSON.parse(stdout.trim())
  } catch {}

  return { exitCode: proc.exitCode, stdout: stdout.trim(), json }
}

describe("pretooluse-sandboxed-edits", () => {
  test("allows edits within cwd", async () => {
    const cwd = await createTempDir()
    const result = await runHook(cwd, "Edit", join(cwd, "src", "app.ts"))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("allows edits within /tmp", async () => {
    const cwd = await createTempDir()
    const result = await runHook(cwd, "Edit", "/tmp/scratch.ts")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("allows edits within ~/.claude/projects/ (auto-memory)", async () => {
    const cwd = await createTempDir()
    // Use a known fakeHome so we can construct the expected allowed path.
    const fakeHome = await createTempDir()
    const memoryPath = join(fakeHome, ".claude", "projects", "test-project", "memory", "MEMORY.md")
    const result = await runHook(cwd, "Write", memoryPath, { fakeHomeOverride: fakeHome })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })

  test("blocks edits outside cwd with generic message when no GitHub repo", async () => {
    const cwd = await createTempDir()
    const outside = await createOutsideDir()
    // outside is NOT a git repo — no cross-repo hint expected
    const result = await runHook(cwd, "Edit", join(outside, "file.ts"))
    expect(result.exitCode).toBe(0)
    const reason = result.json?.hookSpecificOutput as Record<string, unknown>
    expect(reason?.permissionDecision).toBe("deny")
    const msg = String(reason?.permissionDecisionReason)
    expect(msg).toContain("File edit blocked")
    expect(msg).not.toContain("different repository")
  })

  test("appends cross-repo hint when blocked path is inside a GitHub repo", async () => {
    const cwd = await createTempDir()
    const otherRepo = await createOutsideDir()
    await initGitRepo(otherRepo, "https://github.com/acme/widget.git")

    const result = await runHook(cwd, "Edit", join(otherRepo, "src", "widget.ts"))
    expect(result.exitCode).toBe(0)
    const reason = result.json?.hookSpecificOutput as Record<string, unknown>
    expect(reason?.permissionDecision).toBe("deny")
    const msg = String(reason?.permissionDecisionReason)
    expect(msg).toContain("File edit blocked")
    expect(msg).toContain("acme/widget")
    expect(msg).toContain("gh issue create --repo acme/widget")
  })

  test("appends cross-repo hint for SSH remote format", async () => {
    const cwd = await createTempDir()
    const otherRepo = await createOutsideDir()
    await initGitRepo(otherRepo, "git@github.com:acme/widget.git")

    const result = await runHook(cwd, "Edit", join(otherRepo, "src", "widget.ts"))
    const reason = result.json?.hookSpecificOutput as Record<string, unknown>
    const msg = String(reason?.permissionDecisionReason)
    expect(msg).toContain("acme/widget")
    expect(msg).toContain("gh issue create --repo acme/widget")
  })

  test("no cross-repo hint when other repo remote is not GitHub", async () => {
    const cwd = await createTempDir()
    const otherRepo = await createOutsideDir()
    await initGitRepo(otherRepo, "https://gitlab.com/acme/widget.git")

    const result = await runHook(cwd, "Edit", join(otherRepo, "src", "widget.ts"))
    const reason = result.json?.hookSpecificOutput as Record<string, unknown>
    const msg = String(reason?.permissionDecisionReason)
    expect(msg).toContain("File edit blocked")
    expect(msg).not.toContain("different repository")
  })

  test("no cross-repo hint when other repo has no remote", async () => {
    const cwd = await createTempDir()
    const otherRepo = await createOutsideDir()
    await initGitRepo(otherRepo) // no remote

    const result = await runHook(cwd, "Edit", join(otherRepo, "src", "widget.ts"))
    const reason = result.json?.hookSpecificOutput as Record<string, unknown>
    const msg = String(reason?.permissionDecisionReason)
    expect(msg).toContain("File edit blocked")
    expect(msg).not.toContain("different repository")
  })

  test("allows all tools when sandboxedEdits is disabled", async () => {
    const cwd = await createTempDir()
    const otherRepo = await createOutsideDir()
    await initGitRepo(otherRepo, "https://github.com/acme/widget.git")

    const result = await runHook(cwd, "Edit", join(otherRepo, "src", "widget.ts"), {
      sandboxedEdits: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("")
  })
})
