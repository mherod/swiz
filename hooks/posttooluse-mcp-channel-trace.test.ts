import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../src/project-key.ts"
import { swizMcpChannelHeartbeatPath, swizMcpChannelStatusPath } from "../src/temp-paths.ts"
import {
  buildMcpChannelTrace,
  evaluatePosttooluseMcpChannelTrace,
} from "./posttooluse-mcp-channel-trace.ts"

const cleanupPaths: string[] = []

async function makeCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "swiz-mcp-trace-test-"))
  cleanupPaths.push(cwd)
  return cwd
}

async function writeLiveStatus(cwd: string): Promise<void> {
  const projectKey = projectKeyFromCwd(cwd)
  const now = Date.now()
  const heartbeat = swizMcpChannelHeartbeatPath(projectKey)
  const status = swizMcpChannelStatusPath(projectKey)
  cleanupPaths.push(heartbeat, status)
  await Bun.write(heartbeat, "")
  await Bun.write(
    status,
    `${JSON.stringify({
      projectKey,
      cwd,
      pid: 1234,
      serverName: "swiz",
      serverVersion: "0.2.0",
      connected: true,
      watcherState: "active",
      startedAt: now - 1000,
      updatedAt: now,
      lastDrainCompletedAt: now - 50,
      deliveredCount: 2,
    })}\n`
  )
}

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true })
  }
})

describe("posttooluse-mcp-channel-trace", () => {
  test("reports AppleScript transport even when the channel is missing", () => {
    const trace = buildMcpChannelTrace({
      session_id: "session",
      cwd: "/no/channel",
      tool_name: "Bash",
      tool_input: {},
      _terminal: { app: "apple-terminal", name: "Terminal.app" },
    })

    expect(trace).toContain("transport=applescript")
    expect(trace).toContain("channel=unavailable")
    expect(trace).toContain("reason=heartbeat-missing")
  })

  test("reports MCP channel transport when live and no AppleScript terminal exists", async () => {
    const cwd = await makeCwd()
    await writeLiveStatus(cwd)

    const trace = buildMcpChannelTrace({
      session_id: "session",
      cwd,
      tool_name: "Read",
      tool_input: {},
      _terminal: { app: "cursor", name: "Cursor" },
    })

    expect(trace).toContain("transport=mcp-channel")
    expect(trace).toContain("channel=available")
    expect(trace).toContain("reason=available")
    expect(trace).toContain("connected=true")
    expect(trace).toContain("watcher=active")
    expect(trace).toContain("delivered=2")
  })

  test("emits PostToolUse additionalContext", () => {
    const output = evaluatePosttooluseMcpChannelTrace({
      session_id: "session",
      cwd: "/no/channel",
      tool_name: "Edit",
      tool_input: {},
      _terminal: { app: "unknown", name: "Unknown" },
    })

    expect("hookSpecificOutput" in output).toBe(true)
    if (!("hookSpecificOutput" in output)) return
    expect(output.hookSpecificOutput?.hookEventName).toBe("PostToolUse")
    expect(output.hookSpecificOutput?.additionalContext).toContain("[swiz context trace]")
  })
})
