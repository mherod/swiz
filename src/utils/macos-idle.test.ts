import { expect, mock, test } from "bun:test"
import { parseMacOSIdleSeconds, readMacOSIdleSeconds } from "./macos-idle.ts"

test("parses HID nanoseconds and uses the most recent activity across services", () => {
  expect(parseMacOSIdleSeconds('  "HIDIdleTime" = 300000000000\n')).toBe(300)
  expect(parseMacOSIdleSeconds('"HIDIdleTime" = 1000000000\n"HIDIdleTime" = 0\n')).toBe(0)
  for (const output of [
    "",
    '"HIDIdleTime" = -1',
    '"HIDIdleTime" = nope',
    '"HIDIdleTime" = 12oops',
  ]) {
    expect(parseMacOSIdleSeconds(output)).toBeNull()
  }
})

test("unsupported systems do not spawn a probe", async () => {
  const run = mock(async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }))
  expect(await readMacOSIdleSeconds("linux", run)).toBeNull()
  expect(run).not.toHaveBeenCalled()
})

test("bounded read-only macOS probe fails open on command failures", async () => {
  const result = {
    stdout: '"HIDIdleTime" = 301000000000',
    stderr: "",
    exitCode: 0,
    timedOut: false,
  }
  const run = mock(async () => result)
  expect(await readMacOSIdleSeconds("darwin", run)).toBe(301)
  expect(run).toHaveBeenCalledWith(["/usr/sbin/ioreg", "-r", "-c", "IOHIDSystem", "-d", "1"], {
    timeoutMs: 1000,
  })
  for (const failed of [
    { ...result, exitCode: 1 },
    { ...result, timedOut: true },
    { ...result, aborted: true },
  ]) {
    expect(await readMacOSIdleSeconds("darwin", async () => failed)).toBeNull()
  }
  expect(
    await readMacOSIdleSeconds("darwin", async () => {
      throw new Error("unavailable")
    })
  ).toBeNull()
})
