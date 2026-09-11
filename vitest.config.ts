import { dirname } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    {
      name: "bun-import-meta",
      enforce: "pre",
      async transform(code, id) {
        if (!/import\.meta\.(dir|path)\b/.test(code) || id.includes("/node_modules/")) return null
        const result = await Bun.build({
          entrypoints: [id],
          root: dirname(id),
          target: "bun",
          external: ["*"],
          sourcemap: "external",
          define: {
            "import.meta.dir": JSON.stringify(dirname(id)),
            "import.meta.path": JSON.stringify(id),
          },
          plugins: [
            {
              name: "vitest-module-source",
              setup(build) {
                build.onLoad({ filter: /.*/ }, () => ({ contents: code, loader: "tsx" }))
              },
            },
          ],
        })
        const output = result.outputs.find((artifact) => artifact.kind === "entry-point")
        if (!output) throw new Error(`Bun metadata transform produced no module for ${id}`)
        const map = output.sourcemap ? JSON.parse(await output.sourcemap.text()) : null
        // The transform has one source; anchor coverage to its original absolute path.
        if (map) map.sources = [id]
        return {
          code: await output.text(),
          map: map ? JSON.stringify(map) : null,
        }
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
