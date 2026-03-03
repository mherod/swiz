import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PROJECT_STATES,
  readProjectState,
  STATE_TRANSITIONS,
  TERMINAL_STATES,
  writeProjectState,
} from "../settings.ts"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await rm(dir, { recursive: true, force: true })
  }
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-state-test-"))
  tempDirs.push(dir)
  return dir
}

async function runSwiz(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const indexPath = join(process.cwd(), "index.ts")
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: cwd },
  })
  proc.stdin.end()
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return { stdout, stderr, exitCode: proc.exitCode }
}

describe("PROJECT_STATES constant", () => {
  test("has exactly 4 states", () => {
    expect(PROJECT_STATES).toHaveLength(4)
  })

  test("includes all expected lifecycle states", () => {
    expect(PROJECT_STATES).toContain("in-development")
    expect(PROJECT_STATES).toContain("awaiting-feedback")
    expect(PROJECT_STATES).toContain("released")
    expect(PROJECT_STATES).toContain("paused")
  })
})

describe("STATE_TRANSITIONS", () => {
  test("every state has a transitions entry", () => {
    for (const state of PROJECT_STATES) {
      expect(STATE_TRANSITIONS[state]).toBeDefined()
      expect(Array.isArray(STATE_TRANSITIONS[state])).toBe(true)
    }
  })

  test("all transition targets are valid states", () => {
    for (const [, targets] of Object.entries(STATE_TRANSITIONS)) {
      for (const target of targets) {
        expect(PROJECT_STATES).toContain(target)
      }
    }
  })

  test("in-development can transition to awaiting-feedback", () => {
    expect(STATE_TRANSITIONS["in-development"]).toContain("awaiting-feedback")
  })

  test("awaiting-feedback can transition back to in-development", () => {
    expect(STATE_TRANSITIONS["awaiting-feedback"]).toContain("in-development")
  })

  test("released is a terminal state with no outbound transitions", () => {
    expect(TERMINAL_STATES).toContain("released")
  })

  test("paused can return to in-development", () => {
    expect(STATE_TRANSITIONS["paused"]).toContain("in-development")
  })
})

describe("readProjectState / writeProjectState", () => {
  test("returns null when no .swiz/config.json exists", async () => {
    const dir = await createTempDir()
    const state = await readProjectState(dir)
    expect(state).toBeNull()
  })

  test("round-trips a valid state", async () => {
    const dir = await createTempDir()
    await writeProjectState(dir, "in-development")
    const state = await readProjectState(dir)
    expect(state).toBe("in-development")
  })

  test("overwrites an existing state", async () => {
    const dir = await createTempDir()
    await writeProjectState(dir, "in-development")
    await writeProjectState(dir, "awaiting-feedback")
    const state = await readProjectState(dir)
    expect(state).toBe("awaiting-feedback")
  })

  test("preserves other config fields when writing state", async () => {
    const dir = await createTempDir()
    const configPath = join(dir, ".swiz", "config.json")
    // Pre-populate with a profile field
    await Bun.write(configPath, JSON.stringify({ profile: "solo" }))
    await writeProjectState(dir, "paused")
    const config = await Bun.file(configPath).json()
    expect(config.profile).toBe("solo")
    expect(config.state).toBe("paused")
  })
})

describe("swiz state CLI", () => {
  test("state show reports no state when unset", async () => {
    const dir = await createTempDir()
    const result = await runSwiz(["state", "show"], dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("not set")
  })

  test("state list shows all lifecycle states", async () => {
    const dir = await createTempDir()
    const result = await runSwiz(["state", "list"], dir)
    expect(result.exitCode).toBe(0)
    for (const state of PROJECT_STATES) {
      expect(result.stdout).toContain(state)
    }
  })

  test("state set transitions to a valid state", async () => {
    const dir = await createTempDir()
    const result = await runSwiz(["state", "set", "in-development"], dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("in-development")

    const state = await readProjectState(dir)
    expect(state).toBe("in-development")
  })

  test("state set rejects an unknown state", async () => {
    const dir = await createTempDir()
    const result = await runSwiz(["state", "set", "unknown-state"], dir)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Unknown state")
  })

  test("state set rejects an invalid transition", async () => {
    const dir = await createTempDir()
    // First set to paused, then try to transition directly to released (not allowed)
    await writeProjectState(dir, "paused")
    const result = await runSwiz(["state", "set", "released"], dir)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Invalid transition")
  })

  test("state show displays current state and allowed transitions", async () => {
    const dir = await createTempDir()
    await writeProjectState(dir, "in-development")
    const result = await runSwiz(["state", "show"], dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("in-development")
    expect(result.stdout).toContain("awaiting-feedback")
  })
})
