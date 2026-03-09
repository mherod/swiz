import { randomBytes } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  extractPlainTurns,
  findAllProviderSessions,
  parseTranscriptEntries,
} from "./transcript-utils.ts"

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}`)
  await mkdir(dir, { recursive: true })
  return dir
}

describe("Cursor transcript support", () => {
  it("parses cursor sqlite payloads from binary-ish text", () => {
    const payload = [
      "SQLite format 3\u0000",
      '{"role":"user","content":"Hello from Cursor"}',
      "\u0000",
      '{"role":"assistant","content":[{"type":"text","text":"Hi from assistant"}]}',
      "\u0000",
    ].join("")

    const entries = parseTranscriptEntries(payload, "cursor-sqlite")
    expect(entries.length).toBe(2)
    expect(entries[0]?.type).toBe("user")
    expect(entries[1]?.type).toBe("assistant")

    const turns = extractPlainTurns(payload)
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"])
    expect(turns[0]?.text).toContain("Hello from Cursor")
    expect(turns[1]?.text).toContain("Hi from assistant")
  })

  it("discovers cursor store.db sessions and filters by project path", async () => {
    const home = await makeTmpDir("cursor-transcript-home")
    const targetProject = join(home, "workspace", "target-project")
    const otherProject = join(home, "workspace", "other-project")
    await Promise.all([
      mkdir(targetProject, { recursive: true }),
      mkdir(otherProject, { recursive: true }),
    ])

    const targetSessionDb = join(
      home,
      ".cursor",
      "chats",
      "workspace-hash",
      "target-session",
      "store.db"
    )
    const otherSessionDb = join(
      home,
      ".cursor",
      "chats",
      "workspace-hash",
      "other-session",
      "store.db"
    )
    await Promise.all([
      mkdir(dirname(targetSessionDb), { recursive: true }),
      mkdir(dirname(otherSessionDb), { recursive: true }),
    ])
    await writeFile(
      targetSessionDb,
      `SQLite format 3\u0000{"role":"user","content":"cwd:${targetProject}"}\u0000`
    )
    await writeFile(
      otherSessionDb,
      `SQLite format 3\u0000{"role":"user","content":"cwd:${otherProject}"}\u0000`
    )

    try {
      const sessions = await findAllProviderSessions(targetProject, home)
      const cursorSessions = sessions.filter((session) => session.provider === "cursor")
      expect(cursorSessions.length).toBe(1)
      expect(cursorSessions[0]?.id).toBe("target-session")
      expect(cursorSessions[0]?.format).toBe("cursor-sqlite")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
