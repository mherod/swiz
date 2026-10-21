import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  discoverTestFiles,
  runTestBatches,
  runTestFiles,
  runTestSuite,
} from "./run-test-batches.ts"

const homes: string[] = []
afterAll(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })))
})

test("discovers the complete working tree without dependencies or hidden files", async () => {
  const home = await mkdtemp(join(tmpdir(), "swiz-test-discovery-"))
  homes.push(home)
  const included = ["root.test.ts", "nested/new.spec.tsx", "nested/deep/example.test.js"]
  const excluded = [
    "node_modules/pkg/a.test.ts",
    "nested/node_modules/pkg/b.spec.ts",
    ".git/a.test.ts",
    "source.ts",
  ]
  await Promise.all([...included, ...excluded].map((path) => Bun.write(join(home, path), "")))
  expect(discoverTestFiles(home)).toEqual(included.sort().map((path) => join(home, path)))
})

test("rejects invalid runner options before starting tests", async () => {
  await expect(runTestSuite(["--timeout=0"])).rejects.toThrow("positive integer")
  await expect(runTestSuite(["--timeout=no"])).rejects.toThrow("positive integer")
  await expect(runTestSuite(["--unknown"])).rejects.toThrow("Unsupported")
})

test("runs every selected file once in bounded sequential batches", async () => {
  const files = Array.from({ length: 201 }, (_, i) => `fixture-${i}.test.ts`)
  const batches: string[][] = []
  let active = 0
  let maxActive = 0
  const result = await runTestBatches(files, async (batch) => {
    active++
    maxActive = Math.max(maxActive, active)
    await Promise.resolve()
    batches.push(batch)
    active--
    return 0
  })
  expect(result).toBe(0)
  expect(batches.map((batch) => batch.length)).toEqual([80, 80, 41])
  expect(batches.flat()).toEqual(files)
  expect(maxActive).toBe(1)
})

test("propagates a failed batch without starting later batches", async () => {
  let calls = 0
  const result = await runTestBatches(
    Array.from({ length: 161 }, (_, i) => `${i}.test.ts`),
    async () => {
      calls++
      return calls === 2 ? 7 : 0
    }
  )
  expect(result).toBe(7)
  expect(calls).toBe(2)
})

test("rejects an empty selection instead of reporting a false pass", async () => {
  await expect(runTestBatches([])).rejects.toThrow("No test files selected")
})

test("limits file execution to four active processes without dropping files", async () => {
  const files = Array.from({ length: 11 }, (_, i) => `${i}.test.ts`)
  const seen: string[] = []
  let active = 0
  let maximum = 0
  expect(
    await runTestFiles(files, async (file) => {
      seen.push(file)
      maximum = Math.max(maximum, ++active)
      await Promise.resolve()
      active--
      return 0
    })
  ).toBe(0)
  expect(seen).toEqual(files)
  expect(maximum).toBe(4)
  expect(active).toBe(0)
})

test.each([false, true])("drains active files after a failure (throw=%s)", async (throws) => {
  const started: string[] = []
  let drained = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const result = runTestFiles(["fail", "a", "b", "c", "not-started"], async (file) => {
    started.push(file)
    if (file === "fail") {
      if (throws) throw new Error("fixture spawn failed")
      return 7
    }
    await gate
    drained++
    return 0
  })
  await Promise.resolve()
  expect(started).toEqual(["fail", "a", "b", "c"])
  expect(drained).toBe(0)
  release()
  if (throws) await expect(result).rejects.toThrow("fixture spawn failed")
  else expect(await result).toBe(7)
  expect(drained).toBe(3)
  expect(started).not.toContain("not-started")
})

test("selected files run in distinct processes and retain the configured timeout", async () => {
  const home = await mkdtemp(join(tmpdir(), "swiz-test-processes-"))
  homes.push(home)
  const files = [join(home, "a.test.ts"), join(home, "b.test.ts")]
  for (const file of files) {
    await Bun.write(
      file,
      `import { test } from "bun:test"; test("pid", async () => { await Bun.write(${JSON.stringify(`${file}.pid`)}, String(process.pid)); });`
    )
  }
  expect(await runTestSuite(files)).toBe(0)
  const pids = await Promise.all(files.map((file) => Bun.file(`${file}.pid`).text()))
  expect(new Set(pids).size).toBe(2)
  expect(pids).not.toContain(String(process.pid))
  const slow = join(home, "slow.test.ts")
  await Bun.write(
    slow,
    'import { test } from "bun:test"; test("timeout fixture", async () => { await Bun.sleep(200); });'
  )
  expect(await runTestSuite(["--timeout=20", slow])).not.toBe(0)
})
