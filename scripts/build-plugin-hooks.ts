import { join } from "node:path"
import { buildPluginHooks, PLUGIN_AGENTS } from "../src/plugin-package.ts"

const root = join(import.meta.dir, "..", "plugins", "swiz-core")
const check = process.argv.includes("--check")
for (const agent of PLUGIN_AGENTS) {
  const path = join(root, "hooks", `${agent}.json`)
  const expected = `${JSON.stringify(buildPluginHooks(agent), null, 2)}\n`
  if (check) {
    const actual = await Bun.file(path)
      .text()
      .catch(() => "")
    if (actual !== expected) {
      console.error(`${path} is stale. Run bun run scripts/build-plugin-hooks.ts`)
      process.exitCode = 1
    }
  } else {
    await Bun.write(path, expected)
  }
}
