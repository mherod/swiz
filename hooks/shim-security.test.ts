import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { $ } from "bun"
import { useTempDir } from "../src/utils/test-utils.ts"

const SHIM_PATH = join(import.meta.dir, "shim.sh")
const tmp = useTempDir("swiz-shim-security-")

async function runShim(
  command: string,
  opts: { stagedFile?: string; matchesHome?: boolean } = {}
): Promise<{
  exitCode: number
  stderr: string
  stdout: string
  gitCalls: string
}> {
  const cwd = await tmp.create()
  const gitLog = join(cwd, "git-calls")
  await Bun.write(gitLog, "")
  const mocks = {
    git: `#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_CALL_LOG"
case "$*" in
  'rev-parse --is-inside-work-tree') [ -n "$STAGED_FILE" ] ;;
  'diff --cached --name-only --diff-filter=ACMR') printf '%s\\n' "$STAGED_FILE" ;;
  'diff --cached --name-only --diff-filter=ACMR -z') printf '%s\\0' "$STAGED_FILE" ;;
  "grep --cached -F -l -z -e $HOME -- $STAGED_FILE")
    [ "$MATCHES_HOME" = 1 ] || exit 1
    printf '%s\\0' "$STAGED_FILE" ;;
  *) echo "Unexpected Git invocation: $*" >&2; exit 97 ;;
esac
`,
    // Linux normally provides command only as a shell builtin.
    command: "#!/bin/sh\nexit 127\n",
    bun: "#!/bin/sh\nexit 0\n",
    swiz: "#!/bin/sh\nexit 0\n",
  }
  for (const [name, script] of Object.entries(mocks)) {
    await Bun.write(join(cwd, name), script)
    await $`chmod 755 ${join(cwd, name)}`
  }
  const script = [
    "git() { printf 'git:%s\\n' \"$*\"; }",
    "gh() { printf 'gh:%s\\n' \"$*\"; }",
    `source "${SHIM_PATH}"`,
    "SWIZ_SHIM=strict",
    command,
  ].join("\n")
  const proc = Bun.spawn(["/bin/bash", "-c", script], {
    cwd,
    env: {
      ...process.env,
      HOME: join(cwd, "home"),
      PATH: `${cwd}:/usr/bin:/bin`,
      GIT_CALL_LOG: gitLog,
      STAGED_FILE: opts.stagedFile ?? "",
      MATCHES_HOME: opts.matchesHome ? "1" : "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stderr, stdout, gitCalls: await Bun.file(gitLog).text() }
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

  test.each(["bad.txt", "bad file.txt"])("blocks staged home paths in %s", async (stagedFile) => {
    const result = await runShim("git commit -m 'test'", {
      stagedFile,
      matchesHome: true,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("staged file content contains your absolute home directory")
    expect(result.stderr).toContain(stagedFile)
    expect(result.gitCalls).toContain("grep --cached -F -l -z -e ")
  })

  test("allows git commit when staged files use relative home paths", async () => {
    const result = await runShim("git commit -m 'test'", {
      stagedFile: "good.txt",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("git:commit -m test")

    expect(result.gitCalls).toContain("grep --cached -F -l -z -e ")
  })
})
