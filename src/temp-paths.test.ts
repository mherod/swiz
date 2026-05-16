import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import {
  stopIncompleteTasksLogPath,
  swizDispatchLogPath,
  swizPseudoHookLogPath,
  TMP_ROOT,
} from "./temp-paths.ts"

describe("TMP_ROOT", () => {
  test("equals os.tmpdir() — honours TMPDIR environment variable", () => {
    expect(TMP_ROOT).toBe(tmpdir())
  })

  test("is a non-empty string", () => {
    expect(typeof TMP_ROOT).toBe("string")
    expect(TMP_ROOT.length).toBeGreaterThan(0)
  })
})

describe("path builder functions use TMP_ROOT", () => {
  test("stopIncompleteTasksLogPath starts with TMP_ROOT", () => {
    expect(stopIncompleteTasksLogPath()).toStartWith(TMP_ROOT)
  })

  test("stopIncompleteTasksLogPath ends with swiz-logging.log", () => {
    expect(stopIncompleteTasksLogPath()).toEndWith("swiz-logging.log")
  })

  test("swizDispatchLogPath starts with TMP_ROOT", () => {
    expect(swizDispatchLogPath()).toStartWith(TMP_ROOT)
  })

  test("swizPseudoHookLogPath starts with TMP_ROOT", () => {
    expect(swizPseudoHookLogPath()).toStartWith(TMP_ROOT)
  })
})
