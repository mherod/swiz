import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  isSessionstartSelfHealPaused,
  pauseSessionstartSelfHeal,
  resumeSessionstartSelfHeal,
} from "./sessionstart-self-heal-state.ts"

describe("sessionstart-self-heal-state", () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(async () => {
    prevHome = process.env.HOME
    tempHome = await mkdtemp(join(tmpdir(), "swiz-self-heal-"))
    process.env.HOME = tempHome
  })

  afterEach(async () => {
    process.env.HOME = prevHome
    await rm(tempHome, { recursive: true, force: true })
  })

  it("pauses after full removal and resumes after hook reinstall signal", async () => {
    expect(await isSessionstartSelfHealPaused()).toBe(false)
    await pauseSessionstartSelfHeal()
    expect(await isSessionstartSelfHealPaused()).toBe(true)
    await resumeSessionstartSelfHeal()
    expect(await isSessionstartSelfHealPaused()).toBe(false)
  })

  it("resume is idempotent when marker is absent", async () => {
    await resumeSessionstartSelfHeal()
    expect(await isSessionstartSelfHealPaused()).toBe(false)
  })
})
