import { expect, test } from "bun:test"
import { collectProcessOutput, spawnWithTimeout } from "./process-utils.ts"

test("collects both full pipes and waits for the final exit code", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      'await Promise.all([Bun.write(Bun.stdout, "o".repeat(262144)), Bun.write(Bun.stderr, "e".repeat(262144))]); process.exit(7)',
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  )
  const result = await collectProcessOutput(proc)
  expect(result.stdout).toBe("o".repeat(262144))
  expect(result.stderr).toBe("e".repeat(262144))
  expect(result.exitCode).toBe(7)
})

test("timeout wrapper preserves output and exit status", async () => {
  const result = await spawnWithTimeout([
    process.execPath,
    "--eval",
    'console.log("out"); console.error("err"); process.exit(3)',
  ])
  expect(result).toEqual({ stdout: "out\n", stderr: "err\n", exitCode: 3, timedOut: false })
})
