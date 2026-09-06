import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import * as transcripts from "../../transcript-utils.ts"
import { useTempDir } from "../../utils/test-utils.ts"
import { getSessionData, resolveSession, sessionDataCache } from "./session-data.ts"

const tmp = useTempDir("swiz-session-resolution-")
const discovery = spyOn(transcripts, "findAllProviderSessions")
afterAll(() => discovery.mockRestore())
afterEach(() => {
  discovery.mockReset()
  sessionDataCache.invalidateAll()
})

async function seedSessions() {
  const cwd = await tmp.create()
  const sessions = await Promise.all(
    ["alpha-session", "beta-session"].map(async (id) => {
      const path = join(cwd, `${id}.jsonl`)
      await Bun.write(
        path,
        `${JSON.stringify({
          type: "assistant",
          timestamp: "2026-09-06T10:00:00.000Z",
          message: { content: [{ type: "text", text: `Message from ${id}` }] },
        })}\n`
      )
      return { id, path, mtime: 1_000, format: "jsonl" as const, provider: "claude" as const }
    })
  )
  discovery.mockResolvedValue(sessions)
  return { cwd, sessions }
}

describe("transcript session resolution", () => {
  for (const sessionId of ["", " ", "\t\n", "\u00a0\u2003"]) {
    test(`rejects blank ID ${JSON.stringify(sessionId)} before discovery`, async () => {
      const { cwd } = await seedSessions()
      expect(await resolveSession(cwd, sessionId)).toBeNull()
      expect(await getSessionData(cwd, sessionId)).toEqual({ messages: [], toolStats: [] })
      expect(discovery).not.toHaveBeenCalled()
      const control = await resolveSession(cwd, "beta")
      expect(control?.session.id).toBe("beta-session")
      expect(control?.cached.messages[0]?.text).toBe("Message from beta-session")
    })
  }

  for (const sessionId of ["beta-session", "beta", "b"]) {
    test(`preserves exact and prefix resolution for ${sessionId}`, async () => {
      const { cwd, sessions } = await seedSessions()
      expect((await resolveSession(cwd, sessionId))?.session).toEqual(sessions[1])
      const data = await getSessionData(cwd, sessionId)
      expect(data.messages.map((message) => message.text)).toEqual(["Message from beta-session"])
      expect(data.revision).toBeString()
    })
  }

  test("keeps unknown and space-padded nonempty IDs unresolved", async () => {
    const { cwd } = await seedSessions()
    expect(await resolveSession(cwd, "unknown")).toBeNull()
    expect(await resolveSession(cwd, " beta ")).toBeNull()
  })
})
