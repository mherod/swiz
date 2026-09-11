import { afterEach, expect, mock, spyOn, test } from "bun:test"
import * as childProcess from "node:child_process"
import * as fs from "node:fs"

const originalArgv = process.argv

afterEach(() => {
  process.argv = originalArgv
  mock.restore()
})

test("omits deleted tests while retaining existing changed tests", async () => {
  const git = spyOn(childProcess, "spawnSync").mockReturnValue({
    pid: 0,
    output: [],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 1,
    signal: null,
  })
  spyOn(fs, "existsSync").mockImplementation((path) => path === "src/live.test.ts")
  const output: string[] = []
  spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk))
    return true
  })
  process.argv = [process.execPath, "get-test-scope.ts", "src/removed.test.ts", "src/live.test.ts"]

  await import("./get-test-scope.ts")

  expect(output.join("")).toBe("src/live.test.ts")
  expect(git).toHaveBeenCalled()
})
