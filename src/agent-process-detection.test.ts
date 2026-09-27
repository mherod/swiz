import { describe, expect, test } from "bun:test"
import { getAgent } from "./agents.ts"

describe("Antigravity parent process recognition", () => {
  const pattern = getAgent("antigravity")!.processPattern!

  test.each([
    "agy",
    "/usr/local/bin/agy --resume session",
    "/opt/bin/antigravity --session lane",
    "node /opt/tools/agy.js --resume session",
    "/opt/bin/bun /opt/tools/antigravity.mjs",
  ])("recognises the actual launcher: %s", (command) => {
    expect(pattern.test(command)).toBe(true)
  })

  test.each([
    "bun test src/tasks/task-store-migration.test.ts src/transcript-antigravity.test.ts",
    "/opt/bin/bun test src/commands/doctor/cleanup-antigravity.test.ts",
    "bun test agy.test.ts",
    "git show docs/antigravity.md",
    "sh -c echo antigravity",
    "node /opt/antigravity-tests/runner.js",
    "agy-helper --version",
  ])("ignores an incidental name: %s", (command) => {
    expect(pattern.test(command)).toBe(false)
  })
})
