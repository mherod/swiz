import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { projectSettingsSchema } from "../../settings/types.ts"
import { useTempDir } from "../../utils/test-utils.ts"
import {
  divergenceEvidence,
  readSessionDivergenceSnapshot,
  recordDivergenceToolCall,
  resolveDivergenceThresholds,
  type SessionDivergenceState,
} from "./divergence.ts"
import { persistSessionToolCall } from "./utils.ts"

const tmp = useTempDir("swiz-divergence-settings-")

test("advisory thresholds resolve independent project, user and default sources", async () => {
  const home = await tmp.create()
  const project = await tmp.create()
  expect(await resolveDivergenceThresholds(project, home)).toEqual({
    advisoryThreshold: 15,
    steerThreshold: 30,
    advisoryThresholdSource: "default",
    steerThresholdSource: "default",
  })
  const configuredHome = await tmp.create()
  await mkdir(join(configuredHome, ".swiz"), { recursive: true })
  await Bun.write(
    join(configuredHome, ".swiz", "settings.json"),
    JSON.stringify({ divergenceSteerThreshold: 40 })
  )
  const configuredProject = await tmp.create()
  await mkdir(join(configuredProject, ".swiz"), { recursive: true })
  await Bun.write(
    join(configuredProject, ".swiz", "config.json"),
    JSON.stringify({ divergenceAdvisoryThreshold: 15 })
  )
  expect(await resolveDivergenceThresholds(configuredProject, configuredHome)).toEqual({
    advisoryThreshold: 15,
    steerThreshold: 40,
    advisoryThresholdSource: "project",
    steerThresholdSource: "user",
  })
})

test("recovery preserves weighted evidence, pending outcomes, settings and session isolation", async () => {
  const home = await tmp.create()
  const cwd = await tmp.create()
  await mkdir(join(cwd, ".swiz"), { recursive: true })
  await Bun.write(
    join(cwd, ".swiz/config.json"),
    JSON.stringify({ divergenceAdvisoryThreshold: 7 })
  )
  const states = new Map<string, SessionDivergenceState>()
  const nowMs = Date.now()
  recordDivergenceToolCall(states, {
    sessionId: "a",
    toolName: "TaskCreate",
    nowMs,
    movement: "task-create",
  })
  const state = recordDivergenceToolCall(states, {
    sessionId: "a",
    toolName: "Bash",
    toolInput: { command: "git push origin main" },
    nowMs,
    movement: null,
  })
  await persistSessionToolCall(
    cwd,
    "a",
    "Bash",
    {},
    nowMs,
    home,
    divergenceEvidence(state, "call", "unknown", 2)
  )
  const recovered = await readSessionDivergenceSnapshot(cwd, "a", new Map(), home)
  expect(recovered).toMatchObject({
    weightedSum: 2,
    complete: true,
    provenance: "recovered",
    advisoryThreshold: 7,
    advisoryThresholdSource: "project",
  })
  expect(await readSessionDivergenceSnapshot(cwd, "b", new Map(), home)).toBeNull()
  for (let i = 0; i < 2; i++) {
    recordDivergenceToolCall(states, {
      sessionId: "a",
      toolName: "TaskUpdate",
      nowMs,
      movement: null,
      taskMutation: "started",
    })
  }
  const pending = divergenceEvidence(state, "call", "unknown", 0)
  await persistSessionToolCall(cwd, "a", "TaskUpdate", {}, nowMs + 1, home, pending)
  const restoredStates = new Map<string, SessionDivergenceState>()
  expect(await readSessionDivergenceSnapshot(cwd, "a", restoredStates, home)).toMatchObject({
    complete: false,
    weightedSum: 2,
  })
  recordDivergenceToolCall(restoredStates, {
    sessionId: "a",
    toolName: "TaskUpdate",
    nowMs,
    movement: null,
    countCall: false,
    taskMutation: "resolved",
  })
  expect(await readSessionDivergenceSnapshot(cwd, "a", restoredStates, home)).toMatchObject({
    complete: false,
    weightedSum: 2,
  })
  recordDivergenceToolCall(restoredStates, {
    sessionId: "a",
    toolName: "TaskUpdate",
    nowMs,
    movement: null,
    countCall: false,
    taskMutation: "resolved",
  })
  expect(await readSessionDivergenceSnapshot(cwd, "a", restoredStates, home)).toMatchObject({
    complete: true,
    weightedSum: 2,
  })
  await persistSessionToolCall(cwd, "legacy", "TaskCreate", {}, nowMs, home)
  expect(await readSessionDivergenceSnapshot(cwd, "legacy", new Map(), home)).toMatchObject({
    complete: false,
    lastMovementAt: null,
  })
})

test("threshold schemas reject non-positive, fractional and infinite values", () => {
  for (const key of ["divergenceAdvisoryThreshold", "divergenceSteerThreshold"]) {
    for (const value of [0, -1, 1.5, Infinity]) {
      expect(projectSettingsSchema.safeParse({ [key]: value }).success).toBe(false)
    }
  }
})
