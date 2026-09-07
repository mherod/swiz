import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { projectSettingsSchema } from "../../settings/types.ts"
import { useTempDir } from "../../utils/test-utils.ts"
import { resolveDivergenceThresholds } from "./divergence.ts"

const tmp = useTempDir("swiz-divergence-settings-")

test("observation thresholds resolve independent project, user and default sources", async () => {
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

test("threshold schemas reject non-positive, fractional and infinite values", () => {
  for (const key of ["divergenceAdvisoryThreshold", "divergenceSteerThreshold"]) {
    for (const value of [0, -1, 1.5, Infinity]) {
      expect(projectSettingsSchema.safeParse({ [key]: value }).success).toBe(false)
    }
  }
})
