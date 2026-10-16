import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverTestFiles, runTestBatches, runTestSuite } from "./run-test-batches.ts"

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
