import { dirname } from "node:path"
import { transformWithEsbuild } from "vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    {
      name: "bun-import-meta",
      enforce: "pre",
      transform(code, id) {
        if (!/import\.meta\.(dir|path)\b/.test(code) || id.includes("/node_modules/")) return null
        return transformWithEsbuild(code, id, {
          define: {
            "import.meta.dir": JSON.stringify(dirname(id)),
            "import.meta.path": JSON.stringify(id),
          },
        })
      },
    },
  ],
  test: {
    // Bun uses JavaScriptCore, so coverage must use instrumentation rather than V8.
    coverage: { provider: "istanbul" },
    // Shared helpers and the task suite use the Bun-compatible lifecycle API.
    alias: { "bun:test": "vitest" },
    // Keep the focused Vitest suite alongside the full `bun test` suite.
    include: [
      "src/vitest-runtime.test.ts",
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
