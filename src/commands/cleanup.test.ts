import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decodeProjectPath, walkDecode } from "./cleanup.ts"

// ─── Fixture setup ────────────────────────────────────────────────────────────
//
// Creates a fake home directory tree used by both unit tests and the
// integration tests (the subprocess receives HOME=TMP_HOME so it reads
// the fake ~/.claude/projects directory rather than the real one, making
// the tests fully self-contained and CI-safe).
//
//   <tmp>/home/
//     Development/
//       my-project/           ← used as integration fixture project
//       cheapshot-auto/       ← literal hyphen in name
//       plugg-platform/       ← literal hyphen in name
//     .claude/
//       skills/
//       projects/
//         <encodedHome>-Development-my-project/
//           00000000-0000-0000-0000-000000000001/  ← valid session with content
//             session.jsonl
//         <encodedHome>-corrupted-project/         ← partial corruption fixture
//           README.md                              ← non-UUID file → skipped
//           memory/                                ← non-UUID dir → skipped
//           00000000-0000-0000-0000-000000000002   ← UUID-named FILE → skipped
//           00000000-0000-0000-0000-000000000003/  ← empty UUID dir → kept, 0B
//           00000000-0000-0000-0000-000000000004/  ← UUID dir with content → kept
//             data.json
//         <encodedHome>-only-noise/                ← project with no UUID session dirs
//           junk.txt
//           not-a-uuid/
//     ink-silly/              ← literal hyphen at top level

const TMP_HOME = join(tmpdir(), `swiz-cleanup-test-${process.pid}`)
// Claude Code encodes project paths by replacing '/' and '.' with '-'.
const ENCODED_HOME = TMP_HOME.replace(/[/.]/g, "-")
// Fake project directory name (represents TMP_HOME/Development/my-project).
const FIXTURE_PROJECT = `${ENCODED_HOME}-Development-my-project`
const FIXTURE_SESSION = join(
  TMP_HOME, ".claude", "projects", FIXTURE_PROJECT,
  "00000000-0000-0000-0000-000000000001",
)
// Corrupted project: mix of valid and invalid entries.
const CORRUPT_PROJECT = `${ENCODED_HOME}-corrupted-project`
const CORRUPT_PROJECT_DIR = join(TMP_HOME, ".claude", "projects", CORRUPT_PROJECT)
// Noise-only project: no UUID session directories at all.
const NOISE_PROJECT = `${ENCODED_HOME}-only-noise`

beforeAll(async () => {
  await mkdir(join(TMP_HOME, "Development", "my-project"), { recursive: true })
  await mkdir(join(TMP_HOME, "Development", "cheapshot-auto"), { recursive: true })
  await mkdir(join(TMP_HOME, "Development", "plugg-platform"), { recursive: true })
  await mkdir(join(TMP_HOME, ".claude", "skills"), { recursive: true })
  await mkdir(join(TMP_HOME, "ink-silly"), { recursive: true })
  // Integration fixture: a valid session.
  await mkdir(FIXTURE_SESSION, { recursive: true })
  await Bun.write(join(FIXTURE_SESSION, "session.jsonl"), '{"type":"system"}\n')

  // Corrupted project fixture ─────────────────────────────────────────────────
  // Create the real directory so stale-path detection doesn't trigger.
  // CORRUPT_PROJECT encodes TMP_HOME/corrupted/project — it must exist on disk.
  await mkdir(join(TMP_HOME, "corrupted", "project"), { recursive: true })
  // Non-UUID file in project root (should be ignored by UUID_RE).
  await Bun.write(join(CORRUPT_PROJECT_DIR, "README.md"), "docs\n")
  // Non-UUID directory in project root (should be ignored by UUID_RE).
  await mkdir(join(CORRUPT_PROJECT_DIR, "memory"), { recursive: true })
  // UUID-named FILE instead of directory (should be skipped by !isDirectory()).
  await Bun.write(
    join(CORRUPT_PROJECT_DIR, "00000000-0000-0000-0000-000000000002"),
    "not a dir\n",
  )
  // Empty UUID directory — valid session, but size 0B.
  await mkdir(join(CORRUPT_PROJECT_DIR, "00000000-0000-0000-0000-000000000003"), {
    recursive: true,
  })
  // UUID directory with content — valid session.
  await mkdir(
    join(CORRUPT_PROJECT_DIR, "00000000-0000-0000-0000-000000000004"),
    { recursive: true },
  )
  await Bun.write(
    join(CORRUPT_PROJECT_DIR, "00000000-0000-0000-0000-000000000004", "data.json"),
    '{"ok":true}\n',
  )

  // Noise-only project: non-UUID entries only — should produce 0 sessions
  // and be filtered from the output entirely (keep.length + old.length === 0).
  const noiseDir = join(TMP_HOME, ".claude", "projects", NOISE_PROJECT)
  await mkdir(join(noiseDir, "not-a-uuid"), { recursive: true })
  await Bun.write(join(noiseDir, "junk.txt"), "noise\n")
})

afterAll(async () => {
  const proc = Bun.spawn(["rm", "-rf", TMP_HOME], { stdout: "pipe", stderr: "pipe" })
  await proc.exited
})

// ─── walkDecode ───────────────────────────────────────────────────────────────

describe("walkDecode", () => {
  test("returns currentPath when remainingEncoded is empty", async () => {
    const result = await walkDecode(TMP_HOME, "")
    expect(result).toBe(TMP_HOME)
  })

  test("returns null when remainingEncoded does not start with -", async () => {
    const result = await walkDecode(TMP_HOME, "Development")
    expect(result).toBeNull()
  })

  test("decodes a simple directory segment", async () => {
    const result = await walkDecode(TMP_HOME, "-Development")
    expect(result).toBe(join(TMP_HOME, "Development"))
  })

  test("decodes a multi-segment path", async () => {
    const result = await walkDecode(TMP_HOME, "-Development-my-project")
    expect(result).toBe(join(TMP_HOME, "Development", "my-project"))
  })

  test("decodes a hidden directory (.claude → -claude)", async () => {
    // .claude encodes its '.' as '-', so the encoded segment is '-claude'
    // The leading '-' from the path separator gives '--claude'
    const result = await walkDecode(TMP_HOME, "--claude")
    expect(result).toBe(join(TMP_HOME, ".claude"))
  })

  test("decodes a hidden directory with a child (.claude/skills)", async () => {
    const result = await walkDecode(TMP_HOME, "--claude-skills")
    expect(result).toBe(join(TMP_HOME, ".claude", "skills"))
  })

  test("preserves literal hyphens in directory names (cheapshot-auto)", async () => {
    const result = await walkDecode(TMP_HOME, "-Development-cheapshot-auto")
    expect(result).toBe(join(TMP_HOME, "Development", "cheapshot-auto"))
  })

  test("preserves literal hyphens in directory names (plugg-platform)", async () => {
    const result = await walkDecode(TMP_HOME, "-Development-plugg-platform")
    expect(result).toBe(join(TMP_HOME, "Development", "plugg-platform"))
  })

  test("preserves literal hyphens at top level (ink-silly)", async () => {
    const result = await walkDecode(TMP_HOME, "-ink-silly")
    expect(result).toBe(join(TMP_HOME, "ink-silly"))
  })

  test("returns null when no matching directory exists", async () => {
    const result = await walkDecode(TMP_HOME, "-nonexistent-path")
    expect(result).toBeNull()
  })
})

// ─── decodeProjectPath ────────────────────────────────────────────────────────

describe("decodeProjectPath", () => {
  // Build the encoded home prefix: replace '/' and '.' with '-'
  const encodedHome = TMP_HOME.replace(/[/.]/g, "-")

  test("decodes home directory itself to ~", async () => {
    const result = await decodeProjectPath(encodedHome, TMP_HOME)
    expect(result).toBe("~")
  })

  test("decodes a simple child path", async () => {
    const result = await decodeProjectPath(`${encodedHome}-Development-my-project`, TMP_HOME)
    expect(result).toBe("~/Development/my-project")
  })

  test("decodes a hidden child directory (.claude)", async () => {
    const result = await decodeProjectPath(`${encodedHome}--claude`, TMP_HOME)
    expect(result).toBe("~/.claude")
  })

  test("decodes a nested hidden path (.claude/skills)", async () => {
    const result = await decodeProjectPath(`${encodedHome}--claude-skills`, TMP_HOME)
    expect(result).toBe("~/.claude/skills")
  })

  test("preserves literal hyphen in project name (cheapshot-auto)", async () => {
    const result = await decodeProjectPath(
      `${encodedHome}-Development-cheapshot-auto`,
      TMP_HOME
    )
    expect(result).toBe("~/Development/cheapshot-auto")
  })

  test("preserves literal hyphen in project name (plugg-platform)", async () => {
    const result = await decodeProjectPath(
      `${encodedHome}-Development-plugg-platform`,
      TMP_HOME
    )
    expect(result).toBe("~/Development/plugg-platform")
  })

  test("falls back to simple replacement for unresolvable paths", async () => {
    // A path that doesn't exist on disk falls back to naive '-' → '/' replacement
    const result = await decodeProjectPath(`${encodedHome}-ghostdir-subdir`, TMP_HOME)
    expect(result).toBe("~/ghostdir/subdir")
  })

  test("returns the encoded name unchanged if prefix does not match", async () => {
    const result = await decodeProjectPath("-some-other-prefix-path", TMP_HOME)
    expect(result).toBe("-some-other-prefix-path")
  })
})

// ─── Integration: CLI output format ──────────────────────────────────────────
//
// Spawns the real cleanup CLI with HOME=TMP_HOME so it reads the fake
// ~/.claude/projects directory. This makes the tests self-contained and
// CI-safe regardless of whether the runner has real Claude sessions.

describe("cleanup --dry-run output", () => {
  const SWIZ_ROOT = join(import.meta.dir, "../..")
  const env = { ...process.env, HOME: TMP_HOME }

  async function runCleanup(extraArgs: string[] = []): Promise<string> {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "cleanup", "--dry-run", ...extraArgs],
      { cwd: SWIZ_ROOT, env, stdout: "pipe", stderr: "pipe" },
    )
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return output
  }

  test("shows kept sizes in output", async () => {
    const output = await runCleanup()
    expect(output).toMatch(/\d+ kept \(\d+/)
  })

  test("shows decoded ~/... paths (not raw encoded names)", async () => {
    const output = await runCleanup()
    expect(output).toMatch(/~\/Development\/my-project/)
    // Raw encoded form should not appear
    expect(output).not.toMatch(ENCODED_HOME)
  })

  test("--older-than 48h label appears in no-sessions-old message", async () => {
    // Our fixture session was just created, so with a 48h window it is "kept",
    // not trashable. The "No sessions older than 48 hours found" message confirms
    // the label is wired through correctly.
    const output = await runCleanup(["--older-than", "48h"])
    expect(output).toMatch(/48 hours/)
  })
})

// ─── Regression: absent ~/.claude/projects ───────────────────────────────────
//
// When running in CI-like environments where no Claude sessions have ever been
// created, ~/.claude/projects does not exist. The command must exit cleanly
// with an informative message rather than crashing.

describe("cleanup with no .claude/projects directory", () => {
  // A completely empty home — no .claude directory at all.
  const EMPTY_HOME = join(tmpdir(), `swiz-cleanup-empty-${process.pid}`)

  beforeAll(async () => {
    await mkdir(EMPTY_HOME, { recursive: true })
  })

  afterAll(async () => {
    const proc = Bun.spawn(["rm", "-rf", EMPTY_HOME], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
  })

  test("exits without error and prints informative message", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "cleanup", "--dry-run"],
      {
        cwd: join(import.meta.dir, "../.."),
        env: { ...process.env, HOME: EMPTY_HOME },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const output = await new Response(proc.stdout).text()
    await proc.exited

    expect(proc.exitCode).toBe(0)
    expect(output).toMatch(/No projects directory found/)
  })

  test("--project flag with missing projects dir exits without error", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "cleanup", "--dry-run", "--project", "anything"],
      {
        cwd: join(import.meta.dir, "../.."),
        env: { ...process.env, HOME: EMPTY_HOME },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    await new Response(proc.stdout).text()
    await proc.exited

    // Should exit non-zero because --project was specified but not found,
    // but must NOT throw an unhandled exception.
    expect(proc.exitCode).not.toBeNull()
  })
})

// ─── Regression: partially corrupted .claude/projects ────────────────────────
//
// A real ~/.claude/projects directory can contain non-UUID entries (memory/,
// README.md), UUID-named plain files, empty session dirs, and projects that
// have no UUID session subdirectories at all. The command must tolerate all of
// these without crashing and must count only genuine UUID session directories.

describe("cleanup with partially corrupted project directory", () => {
  const SWIZ_ROOT = join(import.meta.dir, "../..")
  const env = { ...process.env, HOME: TMP_HOME }

  async function runCleanup(...extraArgs: string[]): Promise<{ output: string; exitCode: number | null }> {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "cleanup", "--dry-run", ...extraArgs],
      { cwd: SWIZ_ROOT, env, stdout: "pipe", stderr: "pipe" },
    )
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return { output, exitCode: proc.exitCode }
  }

  test("exits cleanly despite corrupted entries", async () => {
    const { exitCode } = await runCleanup()
    expect(exitCode).toBe(0)
  })

  test("counts only UUID session directories, not UUID-named files", async () => {
    const { output } = await runCleanup()
    // Corrupted project has 2 valid UUID dirs (003 + 004) and 1 UUID-named file
    // (002) which must be excluded. Expect "2 sessions", never "3 sessions".
    expect(output).toMatch(/2 sessions/)
    expect(output).not.toMatch(/3 sessions/)
  })

  test("ignores non-UUID entries (README.md, memory/) in session count", async () => {
    const { output } = await runCleanup()
    // The decoded path for CORRUPT_PROJECT falls back to ~/corrupted/project.
    // Non-UUID entries must not inflate the count; the line must show 2 sessions.
    const projectLine = output.split("\n").find((l) => l.includes("corrupted"))
    expect(projectLine).toBeDefined()
    expect(projectLine).toMatch(/\b2 sessions\b/)
  })

  test("project with only non-UUID entries is omitted from output", async () => {
    const { output } = await runCleanup()
    // The noise-only project has keep.length + old.length === 0, so it must
    // not appear in the output table at all.
    expect(output).not.toContain(NOISE_PROJECT)
  })

  test("empty session directory is counted but reported with 0B size", async () => {
    const { output } = await runCleanup()
    // Empty session dir is valid; its size is 0B. The 2-session line for the
    // corrupted project must appear with a size (may be > 0 due to 004's content).
    expect(output).toMatch(/2 kept \(/)
  })

  test("no stderr output on corrupted input", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "cleanup", "--dry-run"],
      { cwd: SWIZ_ROOT, env, stdout: "pipe", stderr: "pipe" },
    )
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    expect(stderr.trim()).toBe("")
  })
})

// ─── Regression: stale-project detection and literal-hyphen ambiguity ─────────
//
// walkDecode uses longest-match-first, so "Development/cheapshot-auto" (literal
// hyphen) wins over "Development/cheapshot/auto" (two path segments) when both
// are conceivable encodings of "-Development-cheapshot-auto".  If the real
// directory exists the project must NOT be flagged stale.
//
// Conversely, a project whose encoded name resolves to no plausible path must
// be flagged stale and all of its sessions moved to the trashable bucket,
// regardless of session age.
//
// Uses its own STALE_HOME so these fixtures don't perturb the shared TMP_HOME
// tree (which other suites scan without --project filtering).

describe("cleanup stale-project detection", () => {
  const STALE_HOME = join(tmpdir(), `swiz-cleanup-stale-${process.pid}`)
  const STALE_ENCODED_HOME = STALE_HOME.replace(/[/.]/g, "-")
  const SWIZ_ROOT = join(import.meta.dir, "../..")
  const env = { ...process.env, HOME: STALE_HOME }

  // Project with a literal hyphen: encoded name is ambiguous but walkDecode
  // must resolve it to the real directory via longest-match.
  const LITERAL_PROJECT = `${STALE_ENCODED_HOME}-Development-cheapshot-auto`
  const LITERAL_SESSION = join(
    STALE_HOME, ".claude", "projects", LITERAL_PROJECT,
    "00000000-0000-0000-0000-000000000005",
  )

  // Project whose real path does not exist — walkDecode returns null → stale.
  const GONE_PROJECT = `${STALE_ENCODED_HOME}-gone-project`
  const GONE_SESSION = join(
    STALE_HOME, ".claude", "projects", GONE_PROJECT,
    "00000000-0000-0000-0000-000000000006",
  )

  beforeAll(async () => {
    // Real directory for the literal-hyphen project.
    await mkdir(join(STALE_HOME, "Development", "cheapshot-auto"), { recursive: true })
    await mkdir(LITERAL_SESSION, { recursive: true })
    await Bun.write(join(LITERAL_SESSION, "session.jsonl"), '{"type":"system"}\n')
    // Gone project: session data exists but no real directory was ever created.
    await mkdir(GONE_SESSION, { recursive: true })
    await Bun.write(join(GONE_SESSION, "session.jsonl"), '{"type":"system"}\n')
  })

  afterAll(async () => {
    const proc = Bun.spawn(["rm", "-rf", STALE_HOME], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
  })

  async function runCleanup(...extraArgs: string[]): Promise<string> {
    const proc = Bun.spawn(
      ["bun", "run", "index.ts", "cleanup", "--dry-run", ...extraArgs],
      { cwd: SWIZ_ROOT, env, stdout: "pipe", stderr: "pipe" },
    )
    const output = await new Response(proc.stdout).text()
    await proc.exited
    return output
  }

  test("literal-hyphen project is not flagged stale when real directory exists", async () => {
    const output = await runCleanup("--project", LITERAL_PROJECT)
    expect(output).not.toMatch(/path gone/)
    expect(output).toMatch(/1 kept/)
    expect(output).toMatch(/0 trashable/)
  })

  test("gone project is flagged stale and sessions become trashable", async () => {
    const output = await runCleanup("--project", GONE_PROJECT)
    expect(output).toMatch(/path gone/)
    expect(output).toMatch(/1 trashable/)
    expect(output).not.toMatch(/1 kept/)
  })

  test("stale sessions are trashable even within the --older-than window", async () => {
    // Sessions were just created so they are within any reasonable age window.
    // The gone project must still report them as trashable due to staleness.
    const output = await runCleanup("--project", GONE_PROJECT, "--older-than", "30")
    expect(output).toMatch(/path gone/)
    expect(output).toMatch(/1 trashable/)
  })

  test("full output: literal-hyphen kept, gone project trashable", async () => {
    const output = await runCleanup()
    const lines = output.split("\n")
    const cheapLine = lines.find((l) => l.includes("cheapshot-auto"))
    expect(cheapLine).toBeDefined()
    expect(cheapLine).not.toMatch(/path gone/)
    expect(cheapLine).toMatch(/1 kept/)
    const goneLine = lines.find((l) => l.includes("gone"))
    expect(goneLine).toBeDefined()
    expect(goneLine).toMatch(/path gone/)
    expect(goneLine).toMatch(/1 trashable/)
  })
})
