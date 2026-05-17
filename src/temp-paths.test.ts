import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import {
  PUBLIC_TMP_ROOT,
  SWIZ_INCOMING_ROOT,
  SWIZ_MCP_CHANNEL_DRAIN_INTERVAL_MS,
  SWIZ_MCP_CHANNEL_HEARTBEAT_FRESH_MS,
  stopIncompleteTasksLogPath,
  swizDispatchLogPath,
  swizMcpChannelStatusPath,
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

describe("PUBLIC_TMP_ROOT", () => {
  test("uses stable /tmp for human-inspected captures", () => {
    expect(PUBLIC_TMP_ROOT).toBe("/tmp")
    expect(SWIZ_INCOMING_ROOT).toBe("/tmp/swiz-incoming")
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

  test("MCP heartbeat freshness exceeds the drain interval", () => {
    expect(SWIZ_MCP_CHANNEL_HEARTBEAT_FRESH_MS).toBeGreaterThan(SWIZ_MCP_CHANNEL_DRAIN_INTERVAL_MS)
  })

  test("swizMcpChannelStatusPath starts with TMP_ROOT", () => {
    expect(swizMcpChannelStatusPath("project")).toStartWith(TMP_ROOT)
  })
})
