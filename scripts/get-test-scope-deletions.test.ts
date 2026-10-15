import { expect, test } from "bun:test"
import { join } from "node:path"
import { useTempDir } from "../src/utils/test-utils.ts"

const tmp = useTempDir("swiz-scope-deletions-")
const scopeScript = join(import.meta.dir, "get-test-scope.ts")

test("omits deleted tests while retaining existing changed tests", async () => {
  const cwd = await tmp.create()
  await Bun.write(join(cwd, "src/live.test.ts"), "// existing test\n")

  // Execute the CLI afresh: importing it here caches its top-level execution
  // and requires mocks of globals shared with the rest of the suite.
  const proc = Bun.spawn(
    [process.execPath, scopeScript, "src/removed.test.ts", "src/live.test.ts"],
    {
      cwd,
      env: { ...process.env, HOME: cwd, CI_BASE: "", AI_TEST_NO_BACKEND: "1" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
    }
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  expect(proc.exitCode).toBe(0)
  expect(stderr).toBe("")
  expect(stdout).toBe("src/live.test.ts")
})
