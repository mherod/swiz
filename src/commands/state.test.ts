import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "../../hooks/test-utils.ts"
import {
  PROJECT_STATES,
  readProjectState,
  readStateData,
  STATE_TRANSITIONS,
  TERMINAL_STATES,
  writeProjectState,
} from "../settings.ts"

const { create: createTempDir } = useTempDir("swiz-state-test-")

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
    expect(PROJECT_STATES).toContain("planning")
    expect(PROJECT_STATES).toContain("developing")
    expect(PROJECT_STATES).toContain("reviewing")
    expect(PROJECT_STATES).toContain("addressing-feedback")
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

  test("developing can transition to reviewing", () => {
    expect(STATE_TRANSITIONS["developing"]).toContain("reviewing")
  })

  test("reviewing can transition back to developing", () => {
    expect(STATE_TRANSITIONS["reviewing"]).toContain("developing")
  })

  test("no terminal states exist — all states are active work phases", () => {
    expect(TERMINAL_STATES).toHaveLength(0)
  })

  test("addressing-feedback can return to reviewing or developing", () => {
    expect(STATE_TRANSITIONS["addressing-feedback"]).toContain("reviewing")
    expect(STATE_TRANSITIONS["addressing-feedback"]).toContain("developing")
  })
})

describe("readProjectState / writeProjectState", () => {
  test("returns null when no .swiz/state.json exists", async () => {
    const dir = await createTempDir()
    const state = await readProjectState(dir)
    expect(state).toBeNull()
  })

  test("round-trips a valid state", async () => {
    const dir = await createTempDir()
    await writeProjectState(dir, "developing")
    const state = await readProjectState(dir)
    expect(state).toBe("developing")
  })

  test("overwrites an existing state", async () => {
    const dir = await createTempDir()
    await writeProjectState(dir, "developing")
    await writeProjectState(dir, "reviewing")
    const state = await readProjectState(dir)
    expect(state).toBe("reviewing")
  })

  test("writes state to state.json, not config.json", async () => {
    const dir = await createTempDir()
    const configPath = join(dir, ".swiz", "config.json")
    const statePath = join(dir, ".swiz", "state.json")
    // Pre-populate config with a profile field
    await Bun.write(configPath, JSON.stringify({ profile: "solo" }))
    await writeProjectState(dir, "planning")
    // Config should be untouched
    const config = await Bun.file(configPath).json()
    expect(config.profile).toBe("solo")
    expect(config.state).toBeUndefined()
    // State should be in separate file
    const stateData = await Bun.file(statePath).json()
    expect(stateData.state).toBe("planning")
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
    const result = await runSwiz(["state", "set", "developing"], dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("developing")

    const state = await readProjectState(dir)
    expect(state).toBe("developing")
  })

  test("state set rejects an unknown state", async () => {
    const dir = await createTempDir()
    const result = await runSwiz(["state", "set", "unknown-state"], dir)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Unknown state")
  })

  test("state set rejects an invalid transition", async () => {
    const dir = await createTempDir()
    // planning can only go to developing — addressing-feedback is not allowed
    await writeProjectState(dir, "planning")
    const result = await runSwiz(["state", "set", "addressing-feedback"], dir)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Invalid transition")
  })

  test("state show displays current state and allowed transitions", async () => {
    const dir = await createTempDir()
    await writeProjectState(dir, "developing")
    const result = await runSwiz(["state", "show"], dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("developing")
    expect(result.stdout).toContain("reviewing")
  })

  test("state show displays current state age", async () => {
    const dir = await createTempDir()
    await writeProjectState(dir, "developing")
    const result = await runSwiz(["state", "show"], dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("current state age:")
  })
})

describe("state transition history", () => {
  test("writeProjectState appends history entries", async () => {
    const dir = await createTempDir()
    await writeProjectState(dir, "developing")
    await writeProjectState(dir, "reviewing")

    const settings = await readStateData(dir)
    expect(settings?.stateHistory).toHaveLength(2)
    expect(settings?.stateHistory?.[0]?.from).toBeNull()
    expect(settings?.stateHistory?.[0]?.to).toBe("developing")
    expect(settings?.stateHistory?.[1]?.from).toBe("developing")
    expect(settings?.stateHistory?.[1]?.to).toBe("reviewing")
  })

  test("history survives multiple state loops", async () => {
    const dir = await createTempDir()
    await writeProjectState(dir, "developing")
    await writeProjectState(dir, "reviewing")
    await writeProjectState(dir, "developing")
    await writeProjectState(dir, "reviewing")

    const settings = await readStateData(dir)
    expect(settings?.stateHistory).toHaveLength(4)
    expect(settings?.stateHistory?.[2]?.from).toBe("reviewing")
    expect(settings?.stateHistory?.[2]?.to).toBe("developing")
    expect(settings?.stateHistory?.[3]?.from).toBe("developing")
    expect(settings?.stateHistory?.[3]?.to).toBe("reviewing")
  })

  test("all history entries have timestamps", async () => {
    const dir = await createTempDir()
    await writeProjectState(dir, "developing")
    await writeProjectState(dir, "reviewing")

    const settings = await readStateData(dir)
    for (const entry of settings?.stateHistory ?? []) {
      expect(entry.timestamp).toBeTruthy()
      expect(() => new Date(entry.timestamp)).not.toThrow()
    }
  })

  test("state show displays time per state for multi-transition history", async () => {
    const dir = await createTempDir()
    await writeProjectState(dir, "developing")
    await writeProjectState(dir, "reviewing")
    await writeProjectState(dir, "developing")

    const result = await runSwiz(["state", "show"], dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("time per state:")
  })
})
