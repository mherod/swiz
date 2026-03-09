import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { extractCwd, hookCooldownPath, isWithinCooldown, markHookCooldown } from "./dispatch.ts"

const TEST_HOOK = "stop-test-cooldown.ts"
const TEST_CWD = "/tmp/swiz-cooldown-test"

afterEach(() => {
  const sentinelPath = hookCooldownPath(TEST_HOOK, TEST_CWD)
  if (existsSync(sentinelPath)) rmSync(sentinelPath)
})

describe("hookCooldownPath", () => {
  test("returns a /tmp sentinel path", () => {
    const p = hookCooldownPath(TEST_HOOK, TEST_CWD)
    expect(p).toMatch(/^\/tmp\/swiz-hook-cooldown-[0-9a-f]+\.timestamp$/)
  })

  test("same hook + cwd always produces same path", () => {
    expect(hookCooldownPath(TEST_HOOK, TEST_CWD)).toBe(hookCooldownPath(TEST_HOOK, TEST_CWD))
  })

  test("different hook files produce different paths", () => {
    expect(hookCooldownPath("hook-a.ts", TEST_CWD)).not.toBe(
      hookCooldownPath("hook-b.ts", TEST_CWD)
    )
  })

  test("different cwds produce different paths for the same hook", () => {
    expect(hookCooldownPath(TEST_HOOK, "/repo/a")).not.toBe(hookCooldownPath(TEST_HOOK, "/repo/b"))
  })
})

describe("isWithinCooldown", () => {
  test("returns false when no sentinel file exists", async () => {
    expect(await isWithinCooldown(TEST_HOOK, 60, TEST_CWD)).toBe(false)
  })

  test("returns true when sentinel is fresh", async () => {
    const sentinelPath = hookCooldownPath(TEST_HOOK, TEST_CWD)
    writeFileSync(sentinelPath, String(Date.now()))
    expect(await isWithinCooldown(TEST_HOOK, 60, TEST_CWD)).toBe(true)
  })

  test("returns false when sentinel is older than the cooldown window", async () => {
    const sentinelPath = hookCooldownPath(TEST_HOOK, TEST_CWD)
    const twoMinutesAgo = Date.now() - 2 * 60 * 1000
    writeFileSync(sentinelPath, String(twoMinutesAgo))
    // 60-second cooldown — sentinel is 2 minutes old, outside the window
    expect(await isWithinCooldown(TEST_HOOK, 60, TEST_CWD)).toBe(false)
  })

  test("returns true when sentinel is within the cooldown window", async () => {
    const sentinelPath = hookCooldownPath(TEST_HOOK, TEST_CWD)
    const thirtySecondsAgo = Date.now() - 30 * 1000
    writeFileSync(sentinelPath, String(thirtySecondsAgo))
    // 60-second cooldown — sentinel is 30 seconds old, inside the window
    expect(await isWithinCooldown(TEST_HOOK, 60, TEST_CWD)).toBe(true)
  })

  test("returns false for corrupted sentinel content", async () => {
    const sentinelPath = hookCooldownPath(TEST_HOOK, TEST_CWD)
    writeFileSync(sentinelPath, "not-a-timestamp")
    expect(await isWithinCooldown(TEST_HOOK, 60, TEST_CWD)).toBe(false)
  })

  test("a 1-second cooldown expires immediately with a backdated sentinel", async () => {
    const sentinelPath = hookCooldownPath(TEST_HOOK, TEST_CWD)
    const twoSecondsAgo = Date.now() - 2000
    writeFileSync(sentinelPath, String(twoSecondsAgo))
    expect(await isWithinCooldown(TEST_HOOK, 1, TEST_CWD)).toBe(false)
  })
})

describe("markHookCooldown", () => {
  test("creates the sentinel file", () => {
    const sentinelPath = hookCooldownPath(TEST_HOOK, TEST_CWD)
    expect(existsSync(sentinelPath)).toBe(false)
    markHookCooldown(TEST_HOOK, TEST_CWD)
    expect(existsSync(sentinelPath)).toBe(true)
  })

  test("writes a recent epoch timestamp", () => {
    const before = Date.now()
    markHookCooldown(TEST_HOOK, TEST_CWD)
    const after = Date.now()
    const sentinelPath = hookCooldownPath(TEST_HOOK, TEST_CWD)
    const written = parseInt(readFileSync(sentinelPath, "utf8").trim(), 10)
    expect(written).toBeGreaterThanOrEqual(before)
    expect(written).toBeLessThanOrEqual(after)
  })

  test("overwriting sentinel with a fresh timestamp brings hook back into cooldown", async () => {
    const sentinelPath = hookCooldownPath(TEST_HOOK, TEST_CWD)
    // Write old timestamp (outside cooldown)
    writeFileSync(sentinelPath, String(Date.now() - 2 * 60 * 1000))
    expect(await isWithinCooldown(TEST_HOOK, 60, TEST_CWD)).toBe(false)
    // Write fresh timestamp directly (markHookCooldown is fire-and-forget)
    writeFileSync(sentinelPath, String(Date.now()))
    expect(await isWithinCooldown(TEST_HOOK, 60, TEST_CWD)).toBe(true)
  })
})

describe("extractCwd", () => {
  test("extracts cwd from a valid JSON payload", () => {
    const payload = JSON.stringify({ cwd: "/my/project", session_id: "abc" })
    expect(extractCwd(payload)).toBe("/my/project")
  })

  test("returns empty string when cwd key is absent", () => {
    const payload = JSON.stringify({ session_id: "abc" })
    expect(extractCwd(payload)).toBe("")
  })

  test("returns empty string for invalid JSON", () => {
    expect(extractCwd("not-json")).toBe("")
  })

  test("returns empty string for empty input", () => {
    expect(extractCwd("")).toBe("")
  })

  test("returns empty string when cwd is null", () => {
    const payload = JSON.stringify({ cwd: null })
    expect(extractCwd(payload)).toBe("")
  })
})
