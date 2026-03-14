import { afterAll, describe, expect, test } from "bun:test"
import { rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { isEmergencyBypassActive } from "./emergency-bypass.ts"

/** Absolute path to the CLI entry point, resolved once at import time. */
const INDEX_PATH = resolve(join(import.meta.dir, "..", "..", "index.ts"))

const KEYS_TO_CLEAN: string[] = []

function keyPath(key: string): string {
  return `/tmp/swiz-emergency-bypass-${key}.json`
}

async function writeBypassState(
  key: string,
  state: { activatedAt: number; expiresAt: number; repoKey: string }
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

describe("emergency-bypass command", () => {
  test("shows inactive status when no bypass exists", async () => {
    const { mkdtemp } = await import("node:fs/promises")
    const { tmpdir } = await import("node:os")
    const tempDir = await mkdtemp(join(tmpdir(), "swiz-bypass-test-"))
    const proc = Bun.spawn(["bun", INDEX_PATH, "emergency-bypass", "--status"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SWIZ_DIRECT: "1", AI_TEST_NO_BACKEND: "1" },
    })
    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    expect(stderr).toContain("inactive")
    await rm(tempDir, { recursive: true, force: true })
  })
})
