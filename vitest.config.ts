import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Only include files that import from "vitest" — Bun-native suites (bun:test) are
    // run separately via `bun test` (see lefthook.yml pre-push and `bun:test` script).
    include: [
      "src/cli.test.ts",
      "src/commands/dispatch-unit.test.ts",
      "src/commands/help.test.ts",
      "src/commands/ci-wait.test.ts",
      "src/commands/tasks.test.ts",
      "src/commands/install.test.ts",
      "src/commands/sentiment.test.ts",
      "src/agent.test.ts",
      "src/detect.test.ts",
      "src/transcript-utils.test.ts",
      "src/transcript-utils-integration.test.ts",
      "src/manifest.test.ts",
    ],
  },
})
