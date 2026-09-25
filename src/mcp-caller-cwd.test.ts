import { describe, expect, it } from "bun:test"
import { resolveMcpRequestCwd } from "./commands/daemon/mcp-tool-routes.ts"
import {
  McpCallerCwdRegistry,
  mcpCallerCwdRegistry,
  mcpInputKey,
  swizMcpToolFromHookName,
} from "./mcp-caller-cwd.ts"

describe("swizMcpToolFromHookName", () => {
  it("maps swiz MCP hook names to tool names and ignores everything else", () => {
    expect(swizMcpToolFromHookName("mcp__swiz__TaskCreate")).toBe("TaskCreate")
    expect(swizMcpToolFromHookName("mcp__plugin_swiz_swiz__TaskList")).toBe("TaskList")
    expect(swizMcpToolFromHookName("mcp__github__TaskCreate")).toBeNull()
    expect(swizMcpToolFromHookName("mcp__swiz__NotATool")).toBeNull()
    expect(swizMcpToolFromHookName("TaskCreate")).toBeNull()
  })
})

describe("mcpInputKey", () => {
  it("ignores key order and undefined members", () => {
    expect(mcpInputKey({ subject: "a", description: "b" })).toBe(
      mcpInputKey({ description: "b", subject: "a", activeForm: undefined })
    )
    expect(mcpInputKey(undefined)).toBe(mcpInputKey({}))
    expect(mcpInputKey({ taskId: "1" })).not.toBe(mcpInputKey({ taskId: "2" }))
  })
})

describe("McpCallerCwdRegistry", () => {
  it("returns the hook's cwd once for the matching call", () => {
    const registry = new McpCallerCwdRegistry(1_000)
    registry.record("mcp__swiz__TaskUpdate", { taskId: "7", status: "completed" }, "/repo/a", 0)
    expect(registry.claim("TaskUpdate", { status: "completed", taskId: "7" }, 10)).toBe("/repo/a")
    expect(registry.claim("TaskUpdate", { status: "completed", taskId: "7" }, 20)).toBeNull()
  })

  it("pairs concurrent identical calls first in, first out", () => {
    const registry = new McpCallerCwdRegistry(1_000)
    registry.record("mcp__swiz__TaskList", {}, "/repo/a", 0)
    registry.record("mcp__swiz__TaskList", {}, "/repo/b", 1)
    expect(registry.claim("TaskList", {}, 2)).toBe("/repo/a")
    expect(registry.claim("TaskList", {}, 3)).toBe("/repo/b")
  })

  it("never matches a different tool, different input, stale hook or rootless cwd", () => {
    const registry = new McpCallerCwdRegistry(1_000)
    registry.record("mcp__swiz__TaskCreate", { subject: "x" }, "/repo/a", 0)
    registry.record("mcp__swiz__TaskList", {}, "/", 0)
    registry.record("Bash", { command: "ls" }, "/repo/a", 0)
    expect(registry.claim("TaskList", {}, 5)).toBeNull()
    expect(registry.claim("TaskCreate", { subject: "y" }, 5)).toBeNull()
    expect(registry.claim("TaskCreate", { subject: "x" }, 5_000)).toBeNull()
  })
})

describe("resolveMcpRequestCwd", () => {
  it("keeps a real cwd, recovers '/' from the hook, and refuses task tools without one", () => {
    const now = Date.now()
    expect(resolveMcpRequestCwd("TaskList", {}, "/repo/real", now)).toBe("/repo/real")

    mcpCallerCwdRegistry.record("mcp__swiz__TaskList", { probe: "route" }, "/repo/hooked", now)
    expect(resolveMcpRequestCwd("TaskList", { probe: "route" }, "/", now)).toBe("/repo/hooked")

    // Control: the claim was consumed, so an unmatched task tool is refused, not sent to "-".
    expect(resolveMcpRequestCwd("TaskList", { probe: "route" }, "/", now)).toBeNull()
    expect(resolveMcpRequestCwd("reply", { content: "hi" }, "/", now)).toBe("/")
  })
})
