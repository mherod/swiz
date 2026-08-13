import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const SHIM_PATH = join(import.meta.dir, "shim.sh")

async function runShim(command: string): Promise<{
  exitCode: number
  stderr: string
  stdout: string
}> {
  const script = [
    "git() { printf 'git:%s\\n' \"$*\"; }",
    "gh() { printf 'gh:%s\\n' \"$*\"; }",
    `source "${SHIM_PATH}"`,
    "SWIZ_SHIM=strict",
    command,
  ].join("\n")
  const proc = Bun.spawn(["bash", "-c", script], {
    cwd: import.meta.dir,
    env: { ...process.env, HOME: "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stderr, stdout }
}

describe("shell shim Git and GitHub security", () => {
  test("blocks unsafe force pushes after Git global options", async () => {
    const result = await runShim("git -C /tmp/repo push -f origin main")

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("git push --force is blocked")
  })

  test("allows force-with-lease", async () => {
    const result = await runShim("git push --force-with-lease origin main")

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("git:push --force-with-lease origin main")
  })

  test("strips trailer arguments before delegating", async () => {
    const result = await runShim(
      "git commit -m 'fix: message' --trailer 'Co-authored-by: Bot <bot@example.com>'"
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("git:commit -m fix: message\n")
  })

  test("blocks --no-verify after Git global options", async () => {
    const result = await runShim("git -C /tmp/repo commit --no-verify -m test")

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("--no-verify is blocked")
  })

  test("blocks Co-authored-by in long-form commit messages", async () => {
    const result = await runShim(
      "git commit --message='fix: bug\n\nCo-authored-by: Bot <bot@example.com>'"
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("Co-authored commits are blocked")
  })

  test("blocks Claude Code signatures in combined short flags", async () => {
    const result = await runShim("git commit -am 'Generated with Claude Code'")

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("AI-generation signatures")
  })

  test("blocks both GitHub status bypass flags", async () => {
    const admin = await runShim("gh pr merge 123 --admin")
    const skipStatus = await runShim("gh pr merge 123 --skip-status-check")

    expect(admin.exitCode).toBe(1)
    expect(admin.stderr).toContain("gh --admin is blocked")
    expect(skipStatus.exitCode).toBe(1)
    expect(skipStatus.stderr).toContain("gh --skip-status-check is blocked")
  })

  test("directs stash drops to OID-bound retirement", async () => {
    const result = await runShim("git stash drop stash@{2}")

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("recovery entry")
    expect(result.stderr).toContain("swiz stash retire <full-oid>")
  })

  test("continues blocking worktree-mutating stash commands", async () => {
    const result = await runShim("git stash push -u")

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("shared checkout")
  })
})
