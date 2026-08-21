import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyHookSettingFilters } from "../dispatch/filters.ts"
import { getCanonicalPathHash } from "../git-helpers.ts"
import type { HookGroup } from "../manifest.ts"
import { swizEmergencyBypassPath } from "../temp-paths.ts"
import { runCommandInProcess } from "../utils/test-utils.ts"
import {
  emergencyBypassCommand,
  isEmergencyBypassActive,
  resolveEmergencyBypassForSession,
} from "./emergency-bypass.ts"

const KEYS_TO_CLEAN: string[] = []

function keyPath(key: string): string {
  return swizEmergencyBypassPath(key)
}

async function writeBypassState(
  key: string,
  state: { activatedAt: number; expiresAt: number; repoKey: string; sessionId?: string }
) {
  KEYS_TO_CLEAN.push(key)
  await writeFile(keyPath(key), JSON.stringify(state, null, 2))
}

afterAll(async () => {
  for (const key of KEYS_TO_CLEAN) {
    try {
      await rm(keyPath(key))
    } catch {}
  }
})

describe("isEmergencyBypassActive", () => {
  test("returns false when no sentinel exists", async () => {
    expect(await isEmergencyBypassActive("nonexistent-key")).toBe(false)
  })

  test("returns true when bypass is active", async () => {
    const key = `test-active-${Date.now()}`
    const now = Date.now()
    await writeBypassState(key, {
      activatedAt: now,
      expiresAt: now + 120_000,
      repoKey: key,
    })
    expect(await isEmergencyBypassActive(key)).toBe(true)
  })

  test("returns false when bypass has expired", async () => {
    const key = `test-expired-${Date.now()}`
    const now = Date.now()
    await writeBypassState(key, {
      activatedAt: now - 300_000,
      expiresAt: now - 1000,
      repoKey: key,
    })
    expect(await isEmergencyBypassActive(key)).toBe(false)
  })

  test("returns false for malformed sentinel", async () => {
    const key = `test-malformed-${Date.now()}`
    KEYS_TO_CLEAN.push(key)
    await writeFile(keyPath(key), "not json")
    expect(await isEmergencyBypassActive(key)).toBe(false)
  })
})

describe("resolveEmergencyBypassForSession (issue #840)", () => {
  test("an unattributable dispatch never bypasses, even while active", async () => {
    const key = `test-scope-anon-${Date.now()}`
    const now = Date.now()
    await writeBypassState(key, { activatedAt: now, expiresAt: now + 120_000, repoKey: key })
    expect(await resolveEmergencyBypassForSession(key, null)).toBe(false)
  })

  test("honours the bound session and blocks every other session", async () => {
    const key = `test-scope-bound-${Date.now()}`
    const now = Date.now()
    await writeBypassState(key, {
      activatedAt: now,
      expiresAt: now + 120_000,
      repoKey: key,
      sessionId: "sess-a",
    })
    expect(await resolveEmergencyBypassForSession(key, "sess-a")).toBe(true)
    expect(await resolveEmergencyBypassForSession(key, "sess-b")).toBe(false)
  })

  test("first attributable dispatch claims an unbound bypass and locks peers out", async () => {
    const key = `test-scope-claim-${Date.now()}`
    const now = Date.now()
    await writeBypassState(key, { activatedAt: now, expiresAt: now + 120_000, repoKey: key })

    expect(await resolveEmergencyBypassForSession(key, "sess-a")).toBe(true)
    const persisted = JSON.parse(await readFile(keyPath(key), "utf8")) as { sessionId?: string }
    expect(persisted.sessionId).toBe("sess-a")
    expect(await resolveEmergencyBypassForSession(key, "sess-b")).toBe(false)
    expect(await resolveEmergencyBypassForSession(key, "sess-a")).toBe(true)
  })

  test("expiry still wins over a session match", async () => {
    const key = `test-scope-expired-${Date.now()}`
    const now = Date.now()
    await writeBypassState(key, {
      activatedAt: now - 300_000,
      expiresAt: now - 1000,
      repoKey: key,
      sessionId: "sess-a",
    })
    expect(await resolveEmergencyBypassForSession(key, "sess-a")).toBe(false)
  })
})

describe("applyHookSettingFilters bypass scoping", () => {
  function bypassGroups(): HookGroup[] {
    return [
      { event: "preToolUse", matcher: "Bash", hooks: [{ file: "pretooluse-fake.ts" }] },
      { event: "stop", hooks: [{ file: "stop-fake.ts" }] },
    ]
  }

  test("session A claims via a preToolUse dispatch; session B stays guarded", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swiz-bypass-filter-"))
    const key = getCanonicalPathHash(cwd)
    const now = Date.now()
    await writeBypassState(key, { activatedAt: now, expiresAt: now + 120_000, repoKey: key })

    // A stop-only dispatch from a peer must not steal the claim.
    const stopOnly = await applyHookSettingFilters(
      [{ event: "stop", hooks: [{ file: "stop-fake.ts" }] }],
      { cwd, session_id: "sess-b" }
    )
    expect(stopOnly.some((g) => g.event === "stop")).toBe(true)
    const unclaimed = JSON.parse(await readFile(keyPath(key), "utf8")) as { sessionId?: string }
    expect(unclaimed.sessionId).toBeUndefined()

    const forA = await applyHookSettingFilters(bypassGroups(), { cwd, session_id: "sess-a" })
    expect(forA.some((g) => g.event === "preToolUse")).toBe(false)
    expect(forA.some((g) => g.event === "stop")).toBe(true)

    const forB = await applyHookSettingFilters(bypassGroups(), { cwd, session_id: "sess-b" })
    expect(forB.some((g) => g.event === "preToolUse")).toBe(true)

    await rm(cwd, { recursive: true, force: true })
  })
})

describe("emergency-bypass command", () => {
  test("shows inactive status when no bypass exists", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "swiz-bypass-test-"))
    const result = await runCommandInProcess(emergencyBypassCommand, ["--status"], {
      cwd: tempDir,
      env: { ...process.env, SWIZ_DIRECT: "1", AI_TEST_NO_BACKEND: "1" },
    })
    expect(result.stderr).toContain("inactive")
    await rm(tempDir, { recursive: true, force: true })
  })

  test("--session binds the bypass to the named session at activation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "swiz-bypass-session-"))
    const key = getCanonicalPathHash(tempDir)
    KEYS_TO_CLEAN.push(key)
    const result = await runCommandInProcess(
      emergencyBypassCommand,
      ["--duration", "5", "--session", "sess-cli"],
      { cwd: tempDir, env: { ...process.env, SWIZ_DIRECT: "1", AI_TEST_NO_BACKEND: "1" } }
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("session sess-cli only")
    const state = JSON.parse(await readFile(keyPath(key), "utf8")) as { sessionId?: string }
    expect(state.sessionId).toBe("sess-cli")
    expect(await resolveEmergencyBypassForSession(key, "sess-other")).toBe(false)
    await rm(tempDir, { recursive: true, force: true })
  })
})
