import { expect, test } from "bun:test"
import { runTestBatches } from "./run-test-batches.ts"

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
