import { randomBytes } from "node:crypto"
import { mkdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createCodexSession } from "./test-fixtures.ts"

/** Create a unique temp directory (concurrent-safe). */
async function makeTmpDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}`)
  await mkdir(dir, { recursive: true })
  return dir
}

describe("transcript-utils integration", () => {
  describe("findSessions", () => {
    it("returns empty array for non-existent directory", async () => {
      const { findSessions } = await import("./transcript-utils.ts")
      const nonExistentDir = join(tmpdir(), `nonexistent-${randomBytes(8).toString("hex")}`)
      const result = await findSessions(nonExistentDir)
      expect(result).toEqual([])
    })

    it("finds session files in directory", async () => {
      const { findSessions } = await import("./transcript-utils.ts")
      const testDir = await makeTmpDir("transcript-test")

      const session1 = join(testDir, "session1.jsonl")
      const session2 = join(testDir, "session2.jsonl")
      await writeFile(session1, '{"type":"user","message":{"content":"test"}}\n')
      await writeFile(session2, '{"type":"user","message":{"content":"test"}}\n')

      const result = await findSessions(testDir)
      expect(result).toHaveLength(2)
      expect(result.map((s) => s.id)).toContain("session1")
      expect(result.map((s) => s.id)).toContain("session2")
      await rm(testDir, { recursive: true, force: true })
    })

    it("ignores non-.jsonl files", async () => {
      const { findSessions } = await import("./transcript-utils.ts")
      const testDir = await makeTmpDir("transcript-test")

      await writeFile(join(testDir, "session.jsonl"), "{}\n")
      await writeFile(join(testDir, "readme.txt"), "test")
      await writeFile(join(testDir, "config.json"), "{}")

      const result = await findSessions(testDir)
      expect(result).toHaveLength(1)
      expect(result[0]?.id).toBe("session")
      await rm(testDir, { recursive: true, force: true })
    })

    it("extracts session id from filename", async () => {
      const { findSessions } = await import("./transcript-utils.ts")
      const testDir = await makeTmpDir("transcript-test")

      await writeFile(join(testDir, "my-session-123.jsonl"), "")
      const result = await findSessions(testDir)
      expect(result.length).toBe(1)
      expect(result[0]?.id).toBe("my-session-123")
      await rm(testDir, { recursive: true, force: true })
    })

    it("records file path and mtime", async () => {
      const { findSessions } = await import("./transcript-utils.ts")
      const testDir = await makeTmpDir("transcript-test")

      const sessionFile = join(testDir, "timed-session.jsonl")
      await writeFile(sessionFile, "")
      const result = await findSessions(testDir)
      expect(result.length).toBe(1)
      expect(result[0]?.path).toBe(sessionFile)
      expect(typeof result[0]?.mtime).toBe("number")
      expect(result[0]?.mtime).toBeGreaterThan(0)
      await rm(testDir, { recursive: true, force: true })
    })

    it("sorts sessions by mtime descending", async () => {
      const { findSessions } = await import("./transcript-utils.ts")
      const testDir = await makeTmpDir("transcript-test")

      const session1 = join(testDir, "old-session.jsonl")
      const session2 = join(testDir, "new-session.jsonl")

      // Use explicit utimes to guarantee different mtimes without sleep
      await writeFile(session1, "")
      await writeFile(session2, "")
      const oldTime = new Date("2026-01-01T00:00:00.000Z")
      const newTime = new Date("2026-01-02T00:00:00.000Z")
      await utimes(session1, oldTime, oldTime)
      await utimes(session2, newTime, newTime)

      const result = await findSessions(testDir)
      expect(result.length).toBe(2)
      expect(result[0]?.id).toBe("new-session")
      expect(result[1]?.id).toBe("old-session")
      expect(result[0]!.mtime).toBeGreaterThanOrEqual(result[1]!.mtime)
      await rm(testDir, { recursive: true, force: true })
    })

    it("handles directories with no session files", async () => {
      const { findSessions } = await import("./transcript-utils.ts")
      const testDir = await makeTmpDir("transcript-test")

      await writeFile(join(testDir, "readme.txt"), "Not a session")
      const result = await findSessions(testDir)
      expect(result).toHaveLength(0)
      await rm(testDir, { recursive: true, force: true })
    })

    it("handles errors gracefully for stat failures", async () => {
      const { findSessions } = await import("./transcript-utils.ts")
      const testDir = await makeTmpDir("transcript-test")

      const goodFile = join(testDir, "good.jsonl")
      await writeFile(goodFile, "")
      const badFile = join(testDir, "bad.jsonl")
      await writeFile(badFile, "")
      await rm(badFile)

      const result = await findSessions(testDir)
      expect(result.length).toBe(1)
      expect(result[0]?.id).toBe("good")
      await rm(testDir, { recursive: true, force: true })
    })

    it("returns session with all required properties", async () => {
      const { findSessions } = await import("./transcript-utils.ts")
      const testDir = await makeTmpDir("transcript-test")

      await writeFile(join(testDir, "complete-session.jsonl"), "")
      const result = await findSessions(testDir)
      expect(result.length).toBe(1)
      const session = result[0]!
      expect(session).toHaveProperty("id")
      expect(session).toHaveProperty("path")
      expect(session).toHaveProperty("mtime")
      expect(typeof session.id).toBe("string")
      expect(typeof session.path).toBe("string")
      expect(typeof session.mtime).toBe("number")
      await rm(testDir, { recursive: true, force: true })
    })

    it("handles empty directory", async () => {
      const { findSessions } = await import("./transcript-utils.ts")
      const testDir = await makeTmpDir("transcript-test")

      const result = await findSessions(testDir)
      expect(result).toHaveLength(0)
      expect(Array.isArray(result)).toBe(true)
      await rm(testDir, { recursive: true, force: true })
    })
  })

  describe("toolCallLabel helper", () => {
    it("handles path input correctly", async () => {
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
    it("discovers Gemini sessions for project-name tmp directories", async () => {
      const home = await makeTmpDir("transcript-all-providers")
      const projectDir = join(home, "workspace", "demo-proj")
      await mkdir(projectDir, { recursive: true })

      const geminiBucket = join(home, ".gemini", "tmp", "demo-proj")
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
      const sessions = await findAllProviderSessions(projectDir, home)
      expect(sessions.some((s) => s.provider === "gemini")).toBe(true)
      expect(sessions.some((s) => s.id.startsWith("abc12345"))).toBe(true)
      await rm(home, { recursive: true, force: true }).catch(() => {})
    })

    it("discovers Gemini sessions for hashed tmp directories via history/.project_root", async () => {
      const home = await makeTmpDir("transcript-all-providers")
      const projectDir = join(home, "workspace", "hash-proj")
      await mkdir(projectDir, { recursive: true })

      const hash = "bd68b11f6bd5d16593c34c0f3e535b78559ad33d2ce3f3f3411254616508c819"
      const geminiBucket = join(home, ".gemini", "tmp", hash)
      await mkdir(join(geminiBucket, "chats"), { recursive: true })
      await mkdir(join(home, ".gemini", "history", hash), { recursive: true })
      await writeFile(join(home, ".gemini", "history", hash, ".project_root"), `${projectDir}\n`)
      await writeFile(
        join(geminiBucket, "chats", "session-2026-03-05T10-01-def67890.json"),
        JSON.stringify({
          sessionId: "def67890-1111-2222-3333-444444444444",
          messages: [{ type: "user", content: [{ text: "from hash bucket" }] }],
        })
      )

      const { findAllProviderSessions } = await import("./transcript-utils.ts")
      const sessions = await findAllProviderSessions(projectDir, home)
      const match = sessions.find((s) => s.id.startsWith("def67890"))
      expect(match).toBeDefined()
      expect(match?.provider).toBe("gemini")
      expect(match?.format).toBe("gemini-json")
      await rm(home, { recursive: true, force: true }).catch(() => {})
    })
  })

  describe("findAllProviderSessions (Antigravity support)", () => {
    it("discovers Antigravity .pb sessions mapped to the target project", async () => {
      const home = await makeTmpDir("transcript-antigravity")
      const projectDir = join(home, "workspace", "antigravity-proj")
      await mkdir(projectDir, { recursive: true })

      const id = "9dce7305-1ba7-49aa-b52b-2e5f3a9e8c77"
      const conversationsDir = join(home, ".gemini", "antigravity", "conversations")
      const brainDir = join(home, ".gemini", "antigravity", "brain", id)
      await mkdir(conversationsDir, { recursive: true })
      await mkdir(brainDir, { recursive: true })

      await writeFile(join(conversationsDir, `${id}.pb`), Buffer.from([0x0a, 0x01, 0x00]))
      await writeFile(
        join(brainDir, "task.md"),
        `# Task\nWork in file://${projectDir}\nand continue migration.\n`
      )

      const { findAllProviderSessions } = await import("./transcript-utils.ts")
      const sessions = await findAllProviderSessions(projectDir, home)
      const match = sessions.find((s) => s.id === id)
      expect(match).toBeDefined()
      expect(match?.provider).toBe("antigravity")
      expect(match?.format).toBe("antigravity-pb")
      await rm(home, { recursive: true, force: true }).catch(() => {})
    })

    it("filters out Antigravity sessions whose brain metadata points to another project", async () => {
      const home = await makeTmpDir("transcript-antigravity")
      const projectDir = join(home, "workspace", "primary-project")
      const otherProjectDir = join(home, "workspace", "other-project")
      await mkdir(projectDir, { recursive: true })
      await mkdir(otherProjectDir, { recursive: true })

      const id = "4f230af4-7a7b-4f1b-a12d-6a5146434f9a"
      const conversationsDir = join(home, ".gemini", "antigravity", "conversations")
      const brainDir = join(home, ".gemini", "antigravity", "brain", id)
      await mkdir(conversationsDir, { recursive: true })
      await mkdir(brainDir, { recursive: true })

      await writeFile(join(conversationsDir, `${id}.pb`), Buffer.from([0x0a, 0x01, 0x00]))
      await writeFile(
        join(brainDir, "task.md"),
        `# Task\nWork in file://${otherProjectDir}\nnot the target project.\n`
      )

      const { findAllProviderSessions } = await import("./transcript-utils.ts")
      const sessions = await findAllProviderSessions(projectDir, home)
      expect(sessions.some((s) => s.id === id)).toBe(false)
      await rm(home, { recursive: true, force: true }).catch(() => {})
    })
  })

  describe("findAllProviderSessions (Codex support)", () => {
    it("discovers Codex sessions mapped by session_meta cwd", async () => {
      const home = await makeTmpDir("transcript-codex")
      const projectDir = join(home, "workspace", "codex-proj")
      await mkdir(projectDir, { recursive: true })

      const id = "019cbccf-2e0f-7f22-a111-111111111111"
      await createCodexSession(home, projectDir, id)

      const { findAllProviderSessions } = await import("./transcript-utils.ts")
      const sessions = await findAllProviderSessions(projectDir, home)
      const match = sessions.find((s) => s.id === id)
      expect(match).toBeDefined()
      expect(match?.provider).toBe("codex")
      expect(match?.format).toBe("codex-jsonl")
      await rm(home, { recursive: true, force: true }).catch(() => {})
    })

    it("filters out Codex sessions from other projects", async () => {
      const home = await makeTmpDir("transcript-codex")
      const projectDir = join(home, "workspace", "primary-project")
      const otherProjectDir = join(home, "workspace", "other-project")
      await mkdir(projectDir, { recursive: true })
      await mkdir(otherProjectDir, { recursive: true })

      const id = "019cbccf-2e0f-7f22-a111-222222222222"
      await createCodexSession(home, otherProjectDir, id)

      const { findAllProviderSessions } = await import("./transcript-utils.ts")
      const sessions = await findAllProviderSessions(projectDir, home)
      expect(sessions.some((s) => s.id === id)).toBe(false)
      await rm(home, { recursive: true, force: true }).catch(() => {})
    })
  })

  describe("findAllProviderSessions deterministic ordering", () => {
    it("uses provider precedence as deterministic tie-breaker when mtimes are equal", async () => {
      const home = await makeTmpDir("transcript-provider-order")
      const projectDir = join(home, "workspace", "shared-proj")
      await mkdir(projectDir, { recursive: true })

      const claudeId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
      const geminiId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
      const antigravityId = "cccccccc-cccc-cccc-cccc-cccccccccccc"
      const codexId = "019cbccf-2e0f-7f22-a111-333333333333"

      const projectKey = projectDir.replace(/[/.\\:]/g, "-")
      const claudeDir = join(home, ".claude", "projects", projectKey)
      await mkdir(claudeDir, { recursive: true })
      const claudePath = join(claudeDir, `${claudeId}.jsonl`)
      await writeFile(claudePath, '{"type":"user","message":{"content":"claude"}}\n')

      const geminiBucket = join(home, ".gemini", "tmp", "shared-proj")
      await mkdir(join(geminiBucket, "chats"), { recursive: true })
      await writeFile(join(geminiBucket, ".project_root"), `${projectDir}\n`)
      const geminiPath = join(geminiBucket, "chats", "session-2026-03-05T10-00-abcdef12.json")
      await writeFile(
        geminiPath,
        JSON.stringify({
          sessionId: geminiId,
          messages: [{ type: "user", content: [{ text: "gemini" }] }],
        })
      )

      const antigravityConversations = join(home, ".gemini", "antigravity", "conversations")
      const antigravityBrain = join(home, ".gemini", "antigravity", "brain", antigravityId)
      await mkdir(antigravityConversations, { recursive: true })
      await mkdir(antigravityBrain, { recursive: true })
      const antigravityPath = join(antigravityConversations, `${antigravityId}.pb`)
      await writeFile(antigravityPath, Buffer.from([0x0a, 0x01, 0x00]))
      await writeFile(join(antigravityBrain, "task.md"), `file://${projectDir}\n`)

      const codexPath = await createCodexSession(home, projectDir, codexId)

      const sameTime = new Date("2026-03-05T12:00:00.000Z")
      await Promise.all([
        utimes(claudePath, sameTime, sameTime),
        utimes(geminiPath, sameTime, sameTime),
        utimes(antigravityPath, sameTime, sameTime),
        utimes(codexPath, sameTime, sameTime),
      ])

      const { findAllProviderSessions } = await import("./transcript-utils.ts")
      const sessions = await findAllProviderSessions(projectDir, home)
      const tied = sessions.filter((s) =>
        [claudeId, geminiId, antigravityId, codexId].includes(s.id)
      )
      expect(tied.map((s) => s.provider)).toEqual(["claude", "gemini", "antigravity", "codex"])
      await rm(home, { recursive: true, force: true }).catch(() => {})
    })
  })
})
