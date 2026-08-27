import { describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { TMP_ROOT } from "../../temp-paths.ts"
import { projectKeyFromCwd } from "../../transcript-utils.ts"
import { sessionDataCache } from "./session-data.ts"

const TEST_DIR = join(TMP_ROOT, "swiz-session-data-tests")

async function createSession(name: string, timestamp: string) {
  const path = join(TEST_DIR, `${name}.jsonl`)
  await Bun.write(
    path,
    `${JSON.stringify({
      type: "assistant",
      timestamp,
      message: { content: [{ type: "text", text: name }] },
    })}\n`
  )
  return { path, format: "jsonl" as const }
}

describe("sessionDataCache", () => {
  test("assigns a stable fallback to malformed message timestamps", async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
    await mkdir(TEST_DIR, { recursive: true })
    const path = join(TEST_DIR, "malformed-timestamp.jsonl")
    await Bun.write(
      path,
      `${JSON.stringify({
        type: "assistant",
        timestamp: "not-a-timestamp",
        message: { content: [{ type: "text", text: "hello" }] },
      })}\n`
    )

    try {
      const result = await sessionDataCache.get({ path, format: "jsonl" })
      const assignedTimestamp = result?.messages[0]?.timestamp

      expect(result).not.toBeNull()
      expect(assignedTimestamp).not.toBe("not-a-timestamp")
      expect(Number.isFinite(Date.parse(assignedTimestamp ?? ""))).toBe(true)
      expect(Number.isFinite(result?.startedAt)).toBe(true)
      expect(Number.isFinite(result?.lastMessageAt)).toBe(true)
    } finally {
      sessionDataCache.invalidateAll()
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })

  test("stores an explicit project identity for nonstandard session paths", async () => {
    await mkdir(TEST_DIR, { recursive: true })
    const alphaCwd = join(TEST_DIR, "alpha")
    const betaCwd = join(TEST_DIR, "beta")

    try {
      const alpha = await sessionDataCache.get(
        await createSession("alpha-session", "2026-08-26T10:00:00.000Z"),
        alphaCwd
      )
      const beta = await sessionDataCache.get(
        await createSession("beta-session", "2026-08-26T10:01:00.000Z"),
        betaCwd
      )

      expect(alpha?.projectIdentity).toBe(projectKeyFromCwd(alphaCwd))
      expect(beta?.projectIdentity).toBe(projectKeyFromCwd(betaCwd))
      expect(alpha?.projectIdentity).not.toBe(beta?.projectIdentity)
      expect(alpha?.projectIdentity).not.toBe("unknown")
      expect(beta?.projectIdentity).not.toBe("unknown")
    } finally {
      sessionDataCache.invalidateAll()
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })

  test("invalidates only entries owned by the exact canonical project identity", async () => {
    await mkdir(TEST_DIR, { recursive: true })
    const alphaCwd = join(TEST_DIR, "project")
    const betaCwd = join(TEST_DIR, "project-extra")

    try {
      const alphaSession = await createSession("first-provider", "2026-08-26T10:00:00.000Z")
      const betaSession = await createSession("second-provider", "2026-08-26T10:01:00.000Z")
      const alpha = await sessionDataCache.get(alphaSession, alphaCwd)
      const beta = await sessionDataCache.get(betaSession, betaCwd)

      sessionDataCache.invalidateProject(alphaCwd)

      expect(await sessionDataCache.get(alphaSession, alphaCwd)).not.toBe(alpha)
      expect(await sessionDataCache.get(betaSession, betaCwd)).toBe(beta)
    } finally {
      sessionDataCache.invalidateAll()
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })

  test("prunes each explicitly owned project independently", async () => {
    await mkdir(TEST_DIR, { recursive: true })
    const alphaCwd = join(TEST_DIR, "alpha")
    const betaCwd = join(TEST_DIR, "beta")

    try {
      const alphaOlder = await createSession("alpha-older", "2026-08-26T10:00:00.000Z")
      const alphaNewer = await createSession("alpha-newer", "2026-08-26T10:01:00.000Z")
      const betaOnly = await createSession("beta-only", "2026-08-26T10:02:00.000Z")
      const older = await sessionDataCache.get(alphaOlder, alphaCwd)
      const newer = await sessionDataCache.get(alphaNewer, alphaCwd)
      const beta = await sessionDataCache.get(betaOnly, betaCwd)

      sessionDataCache.pruneSessionsPerProject(1)

      expect(await sessionDataCache.get(alphaNewer, alphaCwd)).toBe(newer)
      expect(await sessionDataCache.get(betaOnly, betaCwd)).toBe(beta)
      expect(await sessionDataCache.get(alphaOlder, alphaCwd)).not.toBe(older)
    } finally {
      sessionDataCache.invalidateAll()
      await rm(TEST_DIR, { recursive: true, force: true })
    }
  })
})
