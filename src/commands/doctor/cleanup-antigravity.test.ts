import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findAntigravityCleanupGroups } from "./cleanup-antigravity.ts"

const TMP_HOME = join(tmpdir(), `swiz-antigravity-cleanup-${process.pid}`)
const CLI_ROOT = join(TMP_HOME, ".gemini", "antigravity-cli")
const LEGACY_ROOT = join(TMP_HOME, ".gemini", "antigravity")

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.now()
const CUTOFF_MS = NOW - 7 * DAY_MS

const OLD_ID = "00000000-0000-0000-0000-0000000000a1"
const RECENT_ID = "00000000-0000-0000-0000-0000000000a2"
const LEGACY_ID = "00000000-0000-0000-0000-0000000000b1"
const ORPHAN_CONVERSATION_ID = "00000000-0000-0000-0000-0000000000c1"

async function setMtime(path: string, ms: number): Promise<void> {
  const seconds = ms / 1000
  await utimes(path, seconds, seconds)
}

/** Write a file then backdate it and every directory above it up to `root`. */
async function writeAged(
  root: string,
  relativeParts: string[],
  content: string,
  ageMs: number
): Promise<void> {
  const filePath = join(root, ...relativeParts)
  await mkdir(join(filePath, ".."), { recursive: true })
  await Bun.write(filePath, content)
  await setMtime(filePath, ageMs)
  for (let depth = relativeParts.length - 1; depth >= 1; depth--) {
    await setMtime(join(root, ...relativeParts.slice(0, depth)), ageMs)
  }
}

beforeAll(async () => {
  // CLI layout: one old session, one recent session.
  await writeAged(
    CLI_ROOT,
    ["brain", OLD_ID, ".system_generated", "logs", "transcript.jsonl"],
    '{"step_index":0}\n',
    NOW - 30 * DAY_MS
  )
  await writeAged(
    CLI_ROOT,
    ["brain", OLD_ID, "task.md"],
    "# Task\nold session\n",
    NOW - 30 * DAY_MS
  )
  await writeAged(
    CLI_ROOT,
    ["conversations", `${OLD_ID}.pb`],
    "old-conversation",
    NOW - 30 * DAY_MS
  )

  await writeAged(
    CLI_ROOT,
    ["brain", RECENT_ID, ".system_generated", "logs", "transcript.jsonl"],
    '{"step_index":0}\n',
    NOW - 1 * DAY_MS
  )

  // Legacy layout: one old session with a .pb conversation.
  await writeAged(
    LEGACY_ROOT,
    ["brain", LEGACY_ID, "task.md"],
    "# Task\nlegacy\n",
    NOW - 60 * DAY_MS
  )
  await writeAged(
    LEGACY_ROOT,
    ["conversations", `${LEGACY_ID}.pb`],
    "legacy-conversation",
    NOW - 60 * DAY_MS
  )
  // A conversation with no matching brain directory.
  await writeAged(
    LEGACY_ROOT,
    ["conversations", `${ORPHAN_CONVERSATION_ID}.pb`],
    "orphan",
    NOW - 60 * DAY_MS
  )
})

afterAll(async () => {
  await rm(TMP_HOME, { recursive: true, force: true })
})

describe("findAntigravityCleanupGroups", () => {
  test("splits CLI sessions by mtime cutoff", async () => {
    const groups = await findAntigravityCleanupGroups(TMP_HOME, CUTOFF_MS)
    const cli = groups.find((g) => g.name === "(antigravity sessions)")

    expect(cli).toBeDefined()
    expect(cli?.old.map((s) => s.sessionId)).toEqual([OLD_ID])
    expect(cli?.keep.map((s) => s.sessionId)).toEqual([RECENT_ID])
  })

  test("pairs a brain directory with its conversation artifact", async () => {
    const groups = await findAntigravityCleanupGroups(TMP_HOME, CUTOFF_MS)
    const old = groups
      .find((g) => g.name === "(antigravity sessions)")
      ?.old.find((s) => s.sessionId === OLD_ID)

    expect(old?.paths).toContain(join(CLI_ROOT, "brain", OLD_ID))
    expect(old?.paths).toContain(join(CLI_ROOT, "conversations", `${OLD_ID}.pb`))
    // Size covers the nested transcript, not just top-level entries.
    expect(old?.sizeBytes ?? 0).toBeGreaterThan(0)
    expect(old?.taskDirPath).toBeNull()
  })

  test("uses the newest nested mtime so active sessions are retained", async () => {
    const groups = await findAntigravityCleanupGroups(TMP_HOME, CUTOFF_MS)
    const kept = groups
      .find((g) => g.name === "(antigravity sessions)")
      ?.keep.find((s) => s.sessionId === RECENT_ID)

    expect(kept?.mtimeMs ?? 0).toBeGreaterThan(CUTOFF_MS)
  })

  test("discovers the legacy layout as a separate group", async () => {
    const groups = await findAntigravityCleanupGroups(TMP_HOME, CUTOFF_MS)
    const legacy = groups.find((g) => g.name === "(antigravity legacy sessions)")

    expect(legacy).toBeDefined()
    expect(legacy?.keep).toEqual([])
    expect(legacy?.old.map((s) => s.sessionId).sort()).toEqual(
      [LEGACY_ID, ORPHAN_CONVERSATION_ID].sort()
    )
  })

  test("includes conversations that have no brain directory", async () => {
    const groups = await findAntigravityCleanupGroups(TMP_HOME, CUTOFF_MS)
    const orphan = groups
      .find((g) => g.name === "(antigravity legacy sessions)")
      ?.old.find((s) => s.sessionId === ORPHAN_CONVERSATION_ID)

    expect(orphan?.paths).toEqual([
      join(LEGACY_ROOT, "conversations", `${ORPHAN_CONVERSATION_ID}.pb`),
    ])
  })

  test("returns no groups when Antigravity is not installed", async () => {
    const emptyHome = join(tmpdir(), `swiz-antigravity-empty-${process.pid}`)
    await mkdir(emptyHome, { recursive: true })
    try {
      expect(await findAntigravityCleanupGroups(emptyHome, CUTOFF_MS)).toEqual([])
    } finally {
      await rm(emptyHome, { recursive: true, force: true })
    }
  })
})
