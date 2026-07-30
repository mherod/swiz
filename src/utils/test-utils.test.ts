import { expect, test } from "bun:test"
import { acquireEnvLock, neutralAgentEnv, releaseEnvLockFn } from "./test-utils.ts"

test("missing HOME subprocesses disable Bun's relative transpiler cache", () => {
  const env = neutralAgentEnv({ HOME: undefined })

  expect(env.HOME).toBe("")
  expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe("0")
})

test("environment lock releases queued callers in acquisition order", async () => {
  const order: string[] = []
  let markFirstAcquired!: () => void
  const firstAcquired = new Promise<void>((resolve) => {
    markFirstAcquired = resolve
  })
  let allowFirstToRelease!: () => void
  const firstReleaseGate = new Promise<void>((resolve) => {
    allowFirstToRelease = resolve
  })

  const first = (async () => {
    await acquireEnvLock()
    order.push("first")
    markFirstAcquired()
    await firstReleaseGate
    releaseEnvLockFn()
  })()

  await firstAcquired

  const second = (async () => {
    await acquireEnvLock()
    order.push("second")
    releaseEnvLockFn()
  })()

  expect(order).toEqual(["first"])
  allowFirstToRelease()
  await Promise.all([first, second])
  expect(order).toEqual(["first", "second"])
})
