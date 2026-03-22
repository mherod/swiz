import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import {
  extractCwd,
  hookCooldownPath,
  isWithinCooldown,
  markHookCooldown,
} from "../dispatch/index.ts"

// Each test uses a unique cwd derived from the test name and PID to avoid
// shared sentinel paths between tests or across test-process runs.
const TEST_HOOK = "stop-test-cooldown.ts"

function uniqueCwd(label: string): string {
  return `/tmp/swiz-cooldown-test-${process.pid}-${label.replace(/\s+/g, "-")}`
}

describe("hookCooldownPath", () => {
  test("returns a /tmp sentinel path", () => {
    const p = hookCooldownPath(TEST_HOOK, uniqueCwd("path"))
    expect(p).toMatch(/^\/tmp\/swiz-hook-cooldown-[0-9a-f]+\.timestamp$/)
  })

  test("same hook + cwd always produces same path", () => {
    const cwd = uniqueCwd("same")
    expect(hookCooldownPath(TEST_HOOK, cwd)).toBe(hookCooldownPath(TEST_HOOK, cwd))
  })

  test("different hook files produce different paths", () => {
    const cwd = uniqueCwd("diff-hook")
    expect(hookCooldownPath("hook-a.ts", cwd)).not.toBe(hookCooldownPath("hook-b.ts", cwd))
  })

  test("different cwds produce different paths for the same hook", () => {
    expect(hookCooldownPath(TEST_HOOK, "/repo/a")).not.toBe(hookCooldownPath(TEST_HOOK, "/repo/b"))
  })
})

describe("isWithinCooldown", () => {
  test("returns false when no sentinel file exists", async () => {
    expect(await isWithinCooldown(TEST_HOOK, 60, uniqueCwd("no-file"))).toBe(false)
  })

  test("returns true when sentinel is fresh", async () => {
    const cwd = uniqueCwd("fresh")
    const sentinelPath = hookCooldownPath(TEST_HOOK, cwd)
    await Bun.write(sentinelPath, String(Date.now()))
    expect(await isWithinCooldown(TEST_HOOK, 60, cwd)).toBe(true)
  })

  test("returns false when sentinel is older than the cooldown window", async () => {
    const cwd = uniqueCwd("older")
    const sentinelPath = hookCooldownPath(TEST_HOOK, cwd)
    const twoMinutesAgo = Date.now() - 2 * 60 * 1000
    await Bun.write(sentinelPath, String(twoMinutesAgo))
    // 60-second cooldown — sentinel is 2 minutes old, outside the window
    expect(await isWithinCooldown(TEST_HOOK, 60, cwd)).toBe(false)
  })

  test("returns true when sentinel is within the cooldown window", async () => {
    const cwd = uniqueCwd("within")
    const sentinelPath = hookCooldownPath(TEST_HOOK, cwd)
    const thirtySecondsAgo = Date.now() - 30 * 1000
    await Bun.write(sentinelPath, String(thirtySecondsAgo))
    // 60-second cooldown — sentinel is 30 seconds old, inside the window
    expect(await isWithinCooldown(TEST_HOOK, 60, cwd)).toBe(true)
  })

  test("returns false for corrupted sentinel content", async () => {
    const cwd = uniqueCwd("corrupt")
    const sentinelPath = hookCooldownPath(TEST_HOOK, cwd)
    await Bun.write(sentinelPath, "not-a-timestamp")
    expect(await isWithinCooldown(TEST_HOOK, 60, cwd)).toBe(false)
  })

  test("a 1-second cooldown expires immediately with a backdated sentinel", async () => {
    const cwd = uniqueCwd("expired")
    const sentinelPath = hookCooldownPath(TEST_HOOK, cwd)
    const twoSecondsAgo = Date.now() - 2000
    await Bun.write(sentinelPath, String(twoSecondsAgo))
    expect(await isWithinCooldown(TEST_HOOK, 1, cwd)).toBe(false)
  })
})

describe("markHookCooldown", () => {
  test("creates the sentinel file", async () => {
    const cwd = uniqueCwd("creates")
    const sentinelPath = hookCooldownPath(TEST_HOOK, cwd)
    expect(existsSync(sentinelPath)).toBe(false)
    await markHookCooldown(TEST_HOOK, cwd)
    expect(existsSync(sentinelPath)).toBe(true)
  })

  test("writes a recent epoch timestamp", async () => {
    const cwd = uniqueCwd("timestamp")
    const sentinelPath = hookCooldownPath(TEST_HOOK, cwd)
    const before = Date.now()
    await markHookCooldown(TEST_HOOK, cwd)
    const after = Date.now()
    const written = parseInt((await Bun.file(sentinelPath).text()).trim(), 10)
    expect(written).toBeGreaterThanOrEqual(before)
    expect(written).toBeLessThanOrEqual(after)
  })

  test("overwriting sentinel with a fresh timestamp brings hook back into cooldown", async () => {
    const cwd = uniqueCwd("overwrite")
    const sentinelPath = hookCooldownPath(TEST_HOOK, cwd)
    // Write old timestamp (outside cooldown)
    await Bun.write(sentinelPath, String(Date.now() - 2 * 60 * 1000))
    expect(await isWithinCooldown(TEST_HOOK, 60, cwd)).toBe(false)
    // Write fresh timestamp directly
    await Bun.write(sentinelPath, String(Date.now()))
    expect(await isWithinCooldown(TEST_HOOK, 60, cwd)).toBe(true)
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
