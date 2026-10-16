import { expect, test } from "bun:test"
import { deriveSchemaShape, SETTINGS_REGISTRY, settingValueSchema } from "./registry.ts"

test.each([
  ["autoContinue", false, "false"],
  ["pushCooldownMinutes", 0, -1],
  ["memoryLineThreshold", 1, 0],
  ["narratorVoice", "voice", "x".repeat(201)],
  ["ambitionMode", "reflective", "unknown"],
  ["transcriptMonitorMaxConcurrentDispatches", 64, 65],
  ["narratorSpeed", 1.5, 601],
] as const)("validates %s strictly while file reads retain defaults", (key, valid, invalid) => {
  const def = SETTINGS_REGISTRY.find((entry) => entry.key === key)!
  const schema = settingValueSchema(def)
  expect(schema.parse(valid)).toBe(valid)
  expect(schema.safeParse(invalid).success).toBe(false)
  expect(deriveSchemaShape()[key]!.parse(invalid)).toBe(def.default)
})
