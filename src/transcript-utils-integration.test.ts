import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

describe("transcript-utils integration", () => {
  describe("findSessions", () => {
    let testDir: string

    beforeEach(async () => {
      // Create a temporary directory for testing
      testDir = join(tmpdir(), `transcript-test-${Date.now()}`)
      await mkdir(testDir, { recursive: true })
    })

    afterEach(async () => {
      // Clean up test directory
      try {
        await rm(testDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup errors
      }
    })

    it("returns empty array for non-existent directory", async () => {
      const { findSessions } = await import("./transcript-utils.ts")
      const nonExistentDir = join(tmpdir(), `nonexistent-${Date.now()}`)
      const result = await findSessions(nonExistentDir)
      expect(result).toEqual([])
    })

    it("finds session files in directory", async () => {
      const { findSessions } = await import("./transcript-utils.ts")

      // Create test session files
      const session1 = join(testDir, "session1.jsonl")
      const session2 = join(testDir, "session2.jsonl")

      await writeFile(session1, '{"type":"user","message":{"content":"test"}}\n')
      await writeFile(session2, '{"type":"user","message":{"content":"test"}}\n')

      const result = await findSessions(testDir)

      expect(result).toHaveLength(2)
      expect(result.map((s) => s.id)).toContain("session1")
      expect(result.map((s) => s.id)).toContain("session2")
    })

    it("ignores non-.jsonl files", async () => {
      const { findSessions } = await import("./transcript-utils.ts")

      // Create various files
      await writeFile(join(testDir, "session.jsonl"), "{}\n")
      await writeFile(join(testDir, "readme.txt"), "test")
      await writeFile(join(testDir, "config.json"), "{}")

      const result = await findSessions(testDir)

      expect(result).toHaveLength(1)
      expect(result[0]?.id).toBe("session")
    })

    it("extracts session id from filename", async () => {
      const { findSessions } = await import("./transcript-utils.ts")

      const sessionFile = join(testDir, "my-session-123.jsonl")
      await writeFile(sessionFile, "")

      const result = await findSessions(testDir)

      expect(result.length).toBe(1)
      expect(result[0]?.id).toBe("my-session-123")
    })

    it("records file path and mtime", async () => {
      const { findSessions } = await import("./transcript-utils.ts")

      const sessionFile = join(testDir, "timed-session.jsonl")
      await writeFile(sessionFile, "")

      const result = await findSessions(testDir)

      expect(result.length).toBe(1)
      expect(result[0]?.path).toBe(sessionFile)
      expect(typeof result[0]?.mtime).toBe("number")
      expect(result[0]?.mtime).toBeGreaterThan(0)
    })

    it("sorts sessions by mtime descending", async () => {
      const { findSessions } = await import("./transcript-utils.ts")

      // Create files with slight delays to ensure different mtimes
      const session1 = join(testDir, "old-session.jsonl")
      const session2 = join(testDir, "new-session.jsonl")

      await writeFile(session1, "")
      await new Promise((r) => setTimeout(r, 50))
      await writeFile(session2, "")

      const result = await findSessions(testDir)

      expect(result.length).toBe(2)
      // Newest should be first (descending order)
      expect(result[0]?.id).toBe("new-session")
      expect(result[1]?.id).toBe("old-session")
      expect(result[0]!.mtime).toBeGreaterThanOrEqual(result[1]!.mtime)
    })

    it("handles directories with no session files", async () => {
      const { findSessions } = await import("./transcript-utils.ts")

      await writeFile(join(testDir, "readme.txt"), "Not a session")

      const result = await findSessions(testDir)

      expect(result).toHaveLength(0)
    })

    it("handles errors gracefully for stat failures", async () => {
      const { findSessions } = await import("./transcript-utils.ts")

      // Create a file
      const goodFile = join(testDir, "good.jsonl")
      await writeFile(goodFile, "")

      // Create another file and immediately delete it to cause stat error
      const badFile = join(testDir, "bad.jsonl")
      await writeFile(badFile, "")
      await rm(badFile)

      const result = await findSessions(testDir)

      // Should only return the file that can be stat'd
      expect(result.length).toBe(1)
      expect(result[0]?.id).toBe("good")
    })

    it("returns session with all required properties", async () => {
      const { findSessions } = await import("./transcript-utils.ts")

      const sessionFile = join(testDir, "complete-session.jsonl")
      await writeFile(sessionFile, "")

      const result = await findSessions(testDir)

      expect(result.length).toBe(1)
      const session = result[0]!

      expect(session).toHaveProperty("id")
      expect(session).toHaveProperty("path")
      expect(session).toHaveProperty("mtime")
      expect(typeof session.id).toBe("string")
      expect(typeof session.path).toBe("string")
      expect(typeof session.mtime).toBe("number")
    })

    it("handles empty directory", async () => {
      const { findSessions } = await import("./transcript-utils.ts")

      const result = await findSessions(testDir)

      expect(result).toHaveLength(0)
      expect(Array.isArray(result)).toBe(true)
    })
  })

  describe("toolCallLabel helper", () => {
    it("handles path input correctly", async () => {
      // This tests the private toolCallLabel function indirectly through extractPlainTurns
      const { extractPlainTurns } = await import("./transcript-utils.ts")

      const jsonl = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { path: "/home/user/file.txt" },
            },
          ],
        },
      })

      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(1)
      expect(result[0]?.text).toContain("Read")
      expect(result[0]?.text).toContain("/home/user/file.txt")
    })

    it("returns just name when no input provided", async () => {
      const { extractPlainTurns } = await import("./transcript-utils.ts")

      const jsonl = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Help",
              input: undefined,
            },
          ],
        },
      })

      const result = extractPlainTurns(jsonl)
      expect(result.length).toBe(1)
      expect(result[0]?.text).toContain("Help")
    })

    it("prioritizes path over other inputs", async () => {
      const { extractPlainTurns } = await import("./transcript-utils.ts")

      const jsonl = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              input: {
                path: "/file.ts",
                command: "should not appear",
                query: "should not appear",
              },
            },
          ],
        },
      })

      const result = extractPlainTurns(jsonl)
      expect(result[0]?.text).toContain("/file.ts")
      expect(result[0]?.text).not.toContain("should not appear")
    })
  })

  describe("findAllProviderSessions (Gemini support)", () => {
    let testDir: string
    let previousHome: string | undefined

    beforeEach(async () => {
      testDir = join(tmpdir(), `transcript-all-providers-${Date.now()}`)
      await mkdir(testDir, { recursive: true })
      previousHome = process.env.HOME
      process.env.HOME = testDir
    })

    afterEach(async () => {
      process.env.HOME = previousHome
      try {
        await rm(testDir, { recursive: true, force: true })
      } catch {}
    })

    it("discovers Gemini sessions for project-name tmp directories", async () => {
      const projectDir = join(testDir, "workspace", "demo-proj")
      await mkdir(projectDir, { recursive: true })

      const geminiBucket = join(testDir, ".gemini", "tmp", "demo-proj")
      await mkdir(join(geminiBucket, "chats"), { recursive: true })
      await writeFile(join(geminiBucket, ".project_root"), `${projectDir}\n`)
      await writeFile(
        join(geminiBucket, "chats", "session-2026-03-05T10-00-abc12345.json"),
        JSON.stringify({
          sessionId: "abc12345-1111-2222-3333-444444444444",
          messages: [
            { type: "user", content: [{ text: "hello" }], timestamp: "2026-03-05T10:00:00.000Z" },
            { type: "gemini", content: "hi", timestamp: "2026-03-05T10:00:01.000Z" },
          ],
        })
      )

      const { findAllProviderSessions } = await import("./transcript-utils.ts")
      const sessions = await findAllProviderSessions(projectDir)
      expect(sessions.some((s) => s.provider === "gemini")).toBe(true)
      expect(sessions.some((s) => s.id.startsWith("abc12345"))).toBe(true)
    })

    it("discovers Gemini sessions for hashed tmp directories via history/.project_root", async () => {
      const projectDir = join(testDir, "workspace", "hash-proj")
      await mkdir(projectDir, { recursive: true })

      const hash = "bd68b11f6bd5d16593c34c0f3e535b78559ad33d2ce3f3f3411254616508c819"
      const geminiBucket = join(testDir, ".gemini", "tmp", hash)
      await mkdir(join(geminiBucket, "chats"), { recursive: true })
      await mkdir(join(testDir, ".gemini", "history", hash), { recursive: true })
      await writeFile(join(testDir, ".gemini", "history", hash, ".project_root"), `${projectDir}\n`)
      await writeFile(
        join(geminiBucket, "chats", "session-2026-03-05T10-01-def67890.json"),
        JSON.stringify({
          sessionId: "def67890-1111-2222-3333-444444444444",
          messages: [{ type: "user", content: [{ text: "from hash bucket" }] }],
        })
      )

      const { findAllProviderSessions } = await import("./transcript-utils.ts")
      const sessions = await findAllProviderSessions(projectDir)
      const match = sessions.find((s) => s.id.startsWith("def67890"))
      expect(match).toBeDefined()
      expect(match?.provider).toBe("gemini")
      expect(match?.format).toBe("gemini-json")
    })
  })
})
