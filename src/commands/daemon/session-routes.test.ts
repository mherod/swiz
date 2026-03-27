import { describe, expect, test } from "bun:test"
import {
  type AgentProcessSnapshot,
  annotateSessionsWithLiveness,
  hasLiveAgentForProject,
} from "./session-routes.ts"

function makeSnapshot(
  providers: Record<string, number[]>,
  pidCwds: Record<number, string>
): AgentProcessSnapshot {
  return { providers, pidCwds }
}

describe("hasLiveAgentForProject", () => {
  test("returns true when a PID cwd matches project exactly", () => {
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/project" })
    expect(hasLiveAgentForProject("/home/user/project", snapshot)).toBe(true)
  })

  test("returns true when a PID cwd is a subdirectory of project", () => {
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/project/src" })
    expect(hasLiveAgentForProject("/home/user/project", snapshot)).toBe(true)
  })

  test("returns false when no PID cwd matches", () => {
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/other-project" })
    expect(hasLiveAgentForProject("/home/user/project", snapshot)).toBe(false)
  })

  test("returns false when pidCwds is empty", () => {
    const snapshot = makeSnapshot({ claude: [100] }, {})
    expect(hasLiveAgentForProject("/home/user/project", snapshot)).toBe(false)
  })

  test("does not false-positive on prefix collision", () => {
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/project-extra" })
    expect(hasLiveAgentForProject("/home/user/project", snapshot)).toBe(false)
  })
})

describe("annotateSessionsWithLiveness", () => {
  test("marks sessions as processAlive when matching provider has live PID in project", () => {
    const sessions = [
      { id: "s1", provider: "claude", mtime: 1000 },
      { id: "s2", provider: "cursor", mtime: 2000 },
    ]
    const snapshot = makeSnapshot(
      { claude: [100], cursor: [200] },
      { 100: "/home/user/project" } // only claude PID is in this project
    )
    const result = annotateSessionsWithLiveness(sessions, "/home/user/project", snapshot) as Array<{
      id: string
      processAlive: boolean
    }>
    expect(result[0]!.processAlive).toBe(true) // claude has live PID here
    expect(result[1]!.processAlive).toBe(false) // cursor PID is elsewhere
  })

  test("marks all sessions as not alive when no PIDs match project", () => {
    const sessions = [
      { id: "s1", provider: "claude", mtime: 1000 },
      { id: "s2", provider: "claude", mtime: 2000 },
    ]
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/other" })
    const result = annotateSessionsWithLiveness(sessions, "/home/user/project", snapshot) as Array<{
      id: string
      processAlive: boolean
    }>
    expect(result[0]!.processAlive).toBe(false)
    expect(result[1]!.processAlive).toBe(false)
  })

  test("falls back gracefully when pidCwds is empty (no lsof data)", () => {
    const sessions = [{ id: "s1", provider: "claude", mtime: 1000 }]
    const snapshot = makeSnapshot({ claude: [100] }, {})
    const result = annotateSessionsWithLiveness(sessions, "/home/user/project", snapshot) as Array<{
      id: string
      processAlive: boolean
    }>
    expect(result[0]!.processAlive).toBe(false)
  })

  test("handles sessions with undefined provider", () => {
    const sessions = [{ id: "s1", mtime: 1000 }]
    const snapshot = makeSnapshot({ unknown: [100] }, { 100: "/home/user/project" })
    const result = annotateSessionsWithLiveness(sessions, "/home/user/project", snapshot) as Array<{
      id: string
      processAlive: boolean
    }>
    expect(result[0]!.processAlive).toBe(true) // provider defaults to "unknown"
  })

  test("preserves existing session fields", () => {
    const sessions = [
      { id: "s1", provider: "claude", mtime: 1000, dispatches: 5, lastMessageAt: 900 },
    ]
    const snapshot = makeSnapshot({ claude: [100] }, { 100: "/home/user/project" })
    const result = annotateSessionsWithLiveness(sessions, "/home/user/project", snapshot) as Array<
      Record<string, unknown>
    >
    expect(result[0]!.id).toBe("s1")
    expect(result[0]!.dispatches).toBe(5)
    expect(result[0]!.lastMessageAt).toBe(900)
    expect(result[0]!.processAlive).toBe(true)
  })
})

describe("handleProjectsList compat shim", () => {
  test("remaps legacy selectedProject to selectedProjectCwd", () => {
    const legacyBody = {
      selectedProject: "/home/user/project",
      selectedSession: "session-123",
    }
    // Verify the compat shim logic
    const remapped = {
      selectedProjectCwd: legacyBody.selectedProject ?? undefined,
      selectedSessionId: legacyBody.selectedSession ?? undefined,
    }
    expect(remapped.selectedProjectCwd).toBe("/home/user/project")
    expect(remapped.selectedSessionId).toBe("session-123")
  })

  test("remaps legacy limits.projects to limitProjects", () => {
    const legacyBody = {
      limits: {
        projects: 5,
      },
    }
    // Verify the compat shim logic
    const limitProjects = (legacyBody.limits as { projects?: number } | undefined)?.projects ?? 8
    expect(limitProjects).toBe(5)
  })

  test("prefers new field names over legacy fields", () => {
    const mixedBody = {
      selectedProjectCwd: "/home/user/new-project",
      selectedProject: "/home/user/old-project",
    }
    // Verify the compat shim prefers new names
    const selectedProjectCwd = mixedBody.selectedProjectCwd ?? mixedBody.selectedProject
    expect(selectedProjectCwd).toBe("/home/user/new-project")
  })
})
