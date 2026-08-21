import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AgentMessageEdge,
  buildProjectLinks,
  parseRecipient,
  readAgentMessages,
  recordAgentMessage,
  relatedProjects,
  resolveRecipient,
} from "./agent-message-graph.ts"

const SWIZ = "/Users/dev/Development/swiz"
const DASH = "/Users/dev/Development/openai-sba-dashboard"
const KNOWN = [SWIZ, DASH]

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

function edge(over: Partial<AgentMessageEdge> = {}): AgentMessageEdge {
  return {
    at: "2026-08-21T05:00:00.000Z",
    fromSessionId: "sess-a",
    fromCwd: SWIZ,
    toAddress: "openai-sba-dashboard-c6",
    messageBytes: 100,
    ...over,
  }
}

describe("parseRecipient", () => {
  test("reads the peer pid out of a uds socket address", () => {
    expect(parseRecipient("uds:/tmp/cc-socks/33626.sock")).toEqual({
      kind: "socket",
      raw: "uds:/tmp/cc-socks/33626.sock",
      pid: 33626,
    })
  })

  test("accepts a bare socket path without the uds scheme", () => {
    const parsed = parseRecipient("/tmp/cc-socks/82149.sock")
    expect(parsed.kind).toBe("socket")
    expect(parsed).toMatchObject({ pid: 82149 })
  })

  test("treats a peer name as a name", () => {
    expect(parseRecipient("openai-sba-dashboard-c6")).toEqual({
      kind: "name",
      raw: "openai-sba-dashboard-c6",
      name: "openai-sba-dashboard-c6",
    })
  })

  test("an empty address is unknown, so the hook records nothing", () => {
    expect(parseRecipient("   ").kind).toBe("unknown")
  })
})

describe("resolveRecipient", () => {
  test("maps a socket pid to the peer's cwd", () => {
    const resolved = resolveRecipient(parseRecipient("uds:/tmp/cc-socks/33626.sock"), {
      knownProjectCwds: KNOWN,
      pidCwds: { 33626: DASH },
    })
    expect(resolved).toMatchObject({ cwd: DASH, via: "pid" })
  })

  test('a pid whose cwd is "/" is unresolved rather than rooted', () => {
    // The process table reports "/" when it has no useful answer; treating that as a project
    // would attach every such peer to the filesystem root.
    const resolved = resolveRecipient(parseRecipient("uds:/tmp/cc-socks/1.sock"), {
      knownProjectCwds: KNOWN,
      pidCwds: { 1: "/" },
    })
    expect(resolved).toMatchObject({ cwd: null, via: "unresolved" })
  })

  test("matches a peer name against a real project basename", () => {
    const resolved = resolveRecipient(parseRecipient("openai-sba-dashboard-c6"), {
      knownProjectCwds: KNOWN,
    })
    expect(resolved).toMatchObject({ cwd: DASH, via: "name-prefix" })
  })

  test("longest matching basename wins, so a hyphenated project is not truncated", () => {
    // Splitting "openai-sba-dashboard-c6" on hyphens cannot know where the project name ends.
    const resolved = resolveRecipient(parseRecipient("openai-sba-dashboard-c6"), {
      knownProjectCwds: ["/Users/dev/Development/openai", DASH],
    })
    expect(resolved.cwd).toBe(DASH)
  })

  test("control: an unrecognised name resolves to nothing rather than guessing", () => {
    const resolved = resolveRecipient(parseRecipient("some-other-agent"), {
      knownProjectCwds: KNOWN,
    })
    expect(resolved).toMatchObject({ cwd: null, via: "unresolved" })
  })
})

describe("buildProjectLinks", () => {
  test("aggregates repeated sends into one link with counts and a time span", () => {
    const links = buildProjectLinks(
      [
        edge({ at: "2026-08-21T05:00:00.000Z", messageBytes: 100 }),
        edge({ at: "2026-08-21T05:10:00.000Z", messageBytes: 250, fromSessionId: "sess-b" }),
      ],
      { knownProjectCwds: KNOWN }
    )
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      fromCwd: SWIZ,
      toCwd: DASH,
      messageCount: 2,
      totalBytes: 350,
      firstAt: "2026-08-21T05:00:00.000Z",
      lastAt: "2026-08-21T05:10:00.000Z",
    })
    expect(links[0]?.fromSessionIds).toEqual(["sess-a", "sess-b"])
  })

  test("keeps unresolved recipients distinct rather than merging them into one blob", () => {
    const links = buildProjectLinks(
      [edge({ toAddress: "mystery-one" }), edge({ toAddress: "mystery-two" })],
      { knownProjectCwds: KNOWN }
    )
    expect(links).toHaveLength(2)
    expect(links.every((l) => l.toCwd === null)).toBe(true)
  })

  test("a project messaging itself is a real link and is kept", () => {
    const links = buildProjectLinks([edge({ toAddress: "swiz-b" })], { knownProjectCwds: KNOWN })
    expect(links[0]).toMatchObject({ fromCwd: SWIZ, toCwd: SWIZ })
  })

  test("orders by message count so the busiest collaboration reads first", () => {
    const links = buildProjectLinks(
      [
        edge({ toAddress: "mystery-one" }),
        edge({ toAddress: "openai-sba-dashboard-c6" }),
        edge({ toAddress: "openai-sba-dashboard-c6" }),
      ],
      { knownProjectCwds: KNOWN }
    )
    expect(links[0]?.messageCount).toBe(2)
  })
})

describe("relatedProjects", () => {
  test("finds peers in both directions and excludes self-links", () => {
    const links = buildProjectLinks(
      [
        edge({ fromCwd: SWIZ, toAddress: "openai-sba-dashboard-c6" }),
        edge({ fromCwd: DASH, toAddress: "swiz-a" }),
        edge({ fromCwd: SWIZ, toAddress: "swiz-b" }),
      ],
      { knownProjectCwds: KNOWN }
    )
    expect(relatedProjects(links, SWIZ)).toEqual([DASH])
    expect(relatedProjects(links, DASH)).toEqual([SWIZ])
  })

  test("control: a project with no messages has no relations", () => {
    const links = buildProjectLinks([edge()], { knownProjectCwds: KNOWN })
    expect(relatedProjects(links, "/Users/dev/Development/unrelated")).toEqual([])
  })
})

describe("the log round-trips", () => {
  test("appended edges read back in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-msg-graph-"))
    dirs.push(dir)
    const logPath = join(dir, "nested", "agent-messages.jsonl")

    await recordAgentMessage(edge({ fromSessionId: "one" }), logPath)
    await recordAgentMessage(edge({ fromSessionId: "two" }), logPath)

    const read = await readAgentMessages(logPath)
    expect(read.map((e) => e.fromSessionId)).toEqual(["one", "two"])
    // Only the fields of an edge reach disk — there is no field that could carry a body.
    const written = await readFile(logPath, "utf-8")
    for (const line of written.trim().split("\n")) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual([
        "at",
        "fromCwd",
        "fromSessionId",
        "messageBytes",
        "toAddress",
      ])
    }
  })

  test("a missing log is empty, not an error", async () => {
    expect(await readAgentMessages(join(tmpdir(), "swiz-absent-graph.jsonl"))).toEqual([])
  })

  test("a torn final line is skipped and the good lines survive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-msg-graph-torn-"))
    dirs.push(dir)
    const logPath = join(dir, "agent-messages.jsonl")
    await recordAgentMessage(edge({ fromSessionId: "intact" }), logPath)
    await Bun.write(logPath, `${await readFile(logPath, "utf-8")}{"at":"broken`)

    const read = await readAgentMessages(logPath)
    expect(read.map((e) => e.fromSessionId)).toEqual(["intact"])
  })
})
