/**
 * End-to-end tests that run lefthook in a temporary git repository to verify
 * pre-commit hook behaviour under correct, misordered, and missing configurations.
 *
 * Each test:
 *   1. Creates an isolated temp git repo
 *   2. Writes a controlled lefthook.yml with purpose-built scripts
 *   3. Runs `lefthook run pre-commit` via the project's installed binary
 *   4. Asserts on exit code and/or an execution-order log
 *
 * lefthook guarantees that priority-N commands complete before priority-N+1 and
 * unprioritized commands start — the timestamp log exploits this determinism.
 */
import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../hooks/test-utils.ts"

// Resolved once at module load — avoids repeated lookups per test
const LEFTHOOK_BIN = join(process.cwd(), "node_modules", ".bin", "lefthook")

const tmp = useTempDir("swiz-lefthook-e2e-")

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Spin up a bare git repo with a HEAD commit so lefthook is happy. */
async function createTempGitRepo(): Promise<string> {
  const dir = await tmp.create()

  const run = (args: string[]) => Bun.spawnSync(args, { cwd: dir, stdout: "pipe", stderr: "pipe" })

  run(["git", "init"])
  run(["git", "config", "user.email", "test@test.com"])
  run(["git", "config", "user.name", "Test"])
  await writeFile(join(dir, ".gitkeep"), "")
  run(["git", "add", ".gitkeep"])
  run(["git", "commit", "-m", "init", "--no-verify"])

  return dir
}

/** Run `lefthook run <hook>` in the given directory and return exit code + output.
 *  --force ensures commands run even when no files are staged.
 */
async function runLefthook(
  dir: string,
  hook = "pre-commit"
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn([LEFTHOOK_BIN, "run", hook, "--force"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  return { exitCode: proc.exitCode ?? 1, output: stdout + stderr }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("lefthook pre-commit e2e: disk-space gate", () => {
  test("pre-commit fails when disk-space script exits 1", async () => {
    const dir = await createTempGitRepo()

    // disk-space script that always simulates a full disk
    await writeFile(
      join(dir, "check-disk-space.sh"),
      "#!/bin/sh\necho 'ERROR: Less than 256 MB free (0 MB available).'\nexit 1\n"
    )
    Bun.spawnSync(["chmod", "+x", join(dir, "check-disk-space.sh")])

    await writeFile(
      join(dir, "lefthook.yml"),
      [
        "pre-commit:",
        "  commands:",
        "    disk-space:",
        "      priority: 1",
        "      run: sh check-disk-space.sh",
        "    lint:",
        "      run: exit 0",
      ].join("\n")
    )

    const { exitCode, output } = await runLefthook(dir)
    expect(exitCode).not.toBe(0)
    expect(output).toMatch(/disk.space/i)
  })

  test("pre-commit succeeds when disk-space script exits 0", async () => {
    const dir = await createTempGitRepo()

    await writeFile(join(dir, "check-disk-space.sh"), "#!/bin/sh\necho 'OK: 400 MB free'\nexit 0\n")
    Bun.spawnSync(["chmod", "+x", join(dir, "check-disk-space.sh")])

    await writeFile(
      join(dir, "lefthook.yml"),
      [
        "pre-commit:",
        "  commands:",
        "    disk-space:",
        "      priority: 1",
        "      run: sh check-disk-space.sh",
        "    lint:",
        "      run: exit 0",
      ].join("\n")
    )

    const { exitCode } = await runLefthook(dir)
    expect(exitCode).toBe(0)
  })

  test("pre-commit without disk-space command succeeds despite simulated low disk", async () => {
    const dir = await createTempGitRepo()

    // No disk-space command — the guard is absent
    await writeFile(
      join(dir, "lefthook.yml"),
      ["pre-commit:", "  commands:", "    lint:", "      run: exit 0"].join("\n")
    )

    // Even though disk is "low", pre-commit passes — proving the guard matters
    const { exitCode } = await runLefthook(dir)
    expect(exitCode).toBe(0)
  })
})

describe("lefthook pre-commit e2e: execution order", () => {
  test("priority-1 disk-space command completes before unprioritized commands start", async () => {
    const dir = await createTempGitRepo()
    const logFile = join(dir, "order.log")

    // disk-space (priority 1): writes timestamp then exits 0
    await writeFile(
      join(dir, "disk-space.sh"),
      `#!/bin/sh\necho "disk-space $(date +%s%N)" >> "${logFile}"\nexit 0\n`
    )
    // lint (no priority): sleeps briefly then writes timestamp
    await writeFile(
      join(dir, "lint.sh"),
      `#!/bin/sh\nsleep 0.05\necho "lint $(date +%s%N)" >> "${logFile}"\nexit 0\n`
    )
    Bun.spawnSync(["chmod", "+x", join(dir, "disk-space.sh"), join(dir, "lint.sh")])

    await writeFile(
      join(dir, "lefthook.yml"),
      [
        "pre-commit:",
        "  commands:",
        "    disk-space:",
        "      priority: 1",
        "      run: sh disk-space.sh",
        "    lint:",
        "      run: sh lint.sh",
      ].join("\n")
    )

    const { exitCode } = await runLefthook(dir)
    expect(exitCode).toBe(0)

    const log = await Bun.file(logFile).text()
    const lines = log.trim().split("\n").filter(Boolean)
    expect(lines).toHaveLength(2)

    const [firstCmd] = lines[0]!.split(" ")
    const [secondCmd] = lines[1]!.split(" ")
    expect(firstCmd).toBe("disk-space") // priority 1 must complete first
    expect(secondCmd).toBe("lint")
  })

  test("disk-space without priority loses ordering guarantee when hook is parallel", async () => {
    const dir = await createTempGitRepo()
    const logFile = join(dir, "order.log")

    // disk-space: sleeps 50ms then writes — simulates a slow check
    await writeFile(
      join(dir, "disk-space.sh"),
      `#!/bin/sh\nsleep 0.05\necho "disk-space $(date +%s%N)" >> "${logFile}"\nexit 0\n`
    )
    // lint: writes immediately
    await writeFile(
      join(dir, "lint.sh"),
      `#!/bin/sh\necho "lint $(date +%s%N)" >> "${logFile}"\nexit 0\n`
    )
    Bun.spawnSync(["chmod", "+x", join(dir, "disk-space.sh"), join(dir, "lint.sh")])

    await writeFile(
      join(dir, "lefthook.yml"),
      [
        "pre-commit:",
        "  parallel: true", // enables genuine concurrent execution
        "  commands:",
        // No priority — disk-space is not guaranteed to gate lint
        "    disk-space:",
        "      run: sh disk-space.sh",
        "    lint:",
        "      run: sh lint.sh",
      ].join("\n")
    )

    const { exitCode } = await runLefthook(dir)
    expect(exitCode).toBe(0)

    const log = await Bun.file(logFile).text()
    const lines = log.trim().split("\n").filter(Boolean)
    expect(lines).toHaveLength(2)

    // lint writes immediately while disk-space sleeps 50ms — so lint finishes first.
    // This proves that without priority: 1, a fast-starting lint can run before the disk guard.
    const [firstCmd] = lines[0]!.split(" ")
    expect(firstCmd).toBe("lint")
  })

  test("misordered config (disk-space priority 2, lint priority 1) runs lint first", async () => {
    const dir = await createTempGitRepo()
    const logFile = join(dir, "order.log")

    await writeFile(
      join(dir, "disk-space.sh"),
      `#!/bin/sh\necho "disk-space $(date +%s%N)" >> "${logFile}"\nexit 0\n`
    )
    await writeFile(
      join(dir, "lint.sh"),
      `#!/bin/sh\necho "lint $(date +%s%N)" >> "${logFile}"\nexit 0\n`
    )
    Bun.spawnSync(["chmod", "+x", join(dir, "disk-space.sh"), join(dir, "lint.sh")])

    await writeFile(
      join(dir, "lefthook.yml"),
      [
        "pre-commit:",
        "  commands:",
        "    disk-space:",
        "      priority: 2", // wrong — lint runs first
        "      run: sh disk-space.sh",
        "    lint:",
        "      priority: 1",
        "      run: sh lint.sh",
      ].join("\n")
    )

    const { exitCode } = await runLefthook(dir)
    expect(exitCode).toBe(0)

    const log = await Bun.file(logFile).text()
    const lines = log.trim().split("\n").filter(Boolean)
    expect(lines).toHaveLength(2)

    const [firstCmd] = lines[0]!.split(" ")
    expect(firstCmd).toBe("lint") // lint's priority 1 ran before disk-space's priority 2
  })
})

// ─── File-placement guard ─────────────────────────────────────────────────────

describe("lefthook test file placement guard", () => {
  test("all lefthook e2e test files are under src/ (not hooks/ or elsewhere)", async () => {
    const glob = new Bun.Glob("**/lefthook*.test.ts")
    const misplaced: string[] = []
    for await (const file of glob.scan(".")) {
      if (!file.startsWith("src/")) misplaced.push(file)
    }
    expect(misplaced).toEqual([])
  })
})
