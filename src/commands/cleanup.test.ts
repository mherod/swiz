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
//           00000000-0000-0000-0000-000000000001/  ← fake session
//             session.jsonl
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

beforeAll(async () => {
  await mkdir(join(TMP_HOME, "Development", "my-project"), { recursive: true })
  await mkdir(join(TMP_HOME, "Development", "cheapshot-auto"), { recursive: true })
  await mkdir(join(TMP_HOME, "Development", "plugg-platform"), { recursive: true })
  await mkdir(join(TMP_HOME, ".claude", "skills"), { recursive: true })
  await mkdir(join(TMP_HOME, "ink-silly"), { recursive: true })
  // Integration fixture: a fake Claude session so cleanup has something to list.
  await mkdir(FIXTURE_SESSION, { recursive: true })
  await Bun.write(join(FIXTURE_SESSION, "session.jsonl"), '{"type":"system"}\n')
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
