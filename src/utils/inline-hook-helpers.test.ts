import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  classifyToolSearchTaskEvidence,
  isNativeTaskToolName,
  readNativeTaskToolAvailability,
  readNativeTaskToolAvailabilityFromTranscript,
  resetNativeTaskToolAvailabilityCache,
  resolveNativeTaskToolAvailability,
  shouldEnforceTaskGovernance,
  toolSearchQueryTargetsTaskTools,
} from "./inline-hook-helpers.ts"

describe("isNativeTaskToolName", () => {
  test("accepts bare native task tools", () => {
    expect(isNativeTaskToolName("TaskCreate")).toBe(true)
    expect(isNativeTaskToolName("TaskUpdate")).toBe(true)
    expect(isNativeTaskToolName("TaskList")).toBe(true)
    expect(isNativeTaskToolName("TaskGet")).toBe(true)
  })

  test("rejects MCP task tools that merely contain the native name", () => {
    expect(isNativeTaskToolName("mcp__swiz__TaskCreate")).toBe(false)
    expect(isNativeTaskToolName("mcp__swiz__TaskUpdate")).toBe(false)
    expect(isNativeTaskToolName("mcp__swiz__TaskList")).toBe(false)
  })

  test("rejects unrelated tools", () => {
    expect(isNativeTaskToolName("TaskOutput")).toBe(false)
    expect(isNativeTaskToolName("TaskStop")).toBe(false)
    expect(isNativeTaskToolName("Bash")).toBe(false)
  })
})

describe("toolSearchQueryTargetsTaskTools", () => {
  test("recognizes select: queries naming native task tools", () => {
    expect(toolSearchQueryTargetsTaskTools("select:TaskCreate,TaskUpdate,TaskList")).toBe(true)
    expect(toolSearchQueryTargetsTaskTools("select:TaskCreate")).toBe(true)
  })

  test("ignores select: queries naming only unrelated tools", () => {
    expect(toolSearchQueryTargetsTaskTools("select:Read,Edit,Grep")).toBe(false)
  })

  test("recognizes select: queries naming provider-prefixed task tools", () => {
    // Asking for the MCP task tools by name is still a search that would have surfaced the native
    // ones. Treating it as off-target left MCP-only sessions permanently `unknown`, so governance
    // enforced against a store they never write to (#825). The names remain non-native — only the
    // question "was this query about task tools?" changes.
    expect(toolSearchQueryTargetsTaskTools("select:mcp__swiz__TaskCreate")).toBe(true)
    expect(
      toolSearchQueryTargetsTaskTools(
        "select:mcp__swiz__TaskCreate,mcp__swiz__TaskUpdate,mcp__swiz__TaskList"
      )
    ).toBe(true)
    expect(toolSearchQueryTargetsTaskTools("select:Read,mcp__swiz__TaskList")).toBe(true)
  })

  test("ignores select: queries naming non-task MCP tools", () => {
    expect(toolSearchQueryTargetsTaskTools("select:mcp__swiz__reply")).toBe(false)
    expect(toolSearchQueryTargetsTaskTools("select:mcp__resect__analyze")).toBe(false)
  })

  test("recognizes keyword queries mentioning tasks", () => {
    expect(toolSearchQueryTargetsTaskTools("task list tasks todo")).toBe(true)
    expect(toolSearchQueryTargetsTaskTools("+task governance")).toBe(true)
  })

  test("ignores unrelated and empty queries", () => {
    expect(toolSearchQueryTargetsTaskTools("notebook jupyter")).toBe(false)
    expect(toolSearchQueryTargetsTaskTools("   ")).toBe(false)
  })
})

describe("classifyToolSearchTaskEvidence", () => {
  test("reports present when a bare native task tool matched", () => {
    expect(
      classifyToolSearchTaskEvidence({
        query: "select:TaskCreate,TaskUpdate,TaskList",
        matches: ["TaskCreate", "TaskUpdate", "TaskList"],
      })
    ).toBe("present")
  })

  test("reports absent when a targeted search returned only MCP equivalents", () => {
    expect(
      classifyToolSearchTaskEvidence({
        query: "task list tasks todo",
        matches: ["mcp__swiz__TaskList", "mcp__swiz__TaskCreate", "mcp__swiz__TaskUpdate"],
      })
    ).toBe("absent")
  })

  test("reports absent when a select: query for native tools matched nothing", () => {
    expect(classifyToolSearchTaskEvidence({ query: "select:TaskCreate", matches: [] })).toBe(
      "absent"
    )
  })

  test("reports absent for an MCP-only select: query returning only MCP tools", () => {
    // The shape an MCP-only session actually produces. It used to classify `unknown`, which left
    // governance enforcing against an unreachable remedy for the whole session (#825).
    expect(
      classifyToolSearchTaskEvidence({
        query: "select:mcp__swiz__TaskCreate,mcp__swiz__TaskUpdate,mcp__swiz__TaskList",
        matches: ["mcp__swiz__TaskCreate", "mcp__swiz__TaskUpdate", "mcp__swiz__TaskList"],
      })
    ).toBe("absent")
  })

  test("still reports present when a native tool matched an MCP-shaped query", () => {
    // Widening the query predicate must not weaken the match predicate: a native tool in the
    // results still proves availability, whatever the query looked like.
    expect(
      classifyToolSearchTaskEvidence({
        query: "select:mcp__swiz__TaskCreate,TaskCreate",
        matches: ["mcp__swiz__TaskCreate", "TaskCreate"],
      })
    ).toBe("present")
  })

  test("reports unknown when the query could not have surfaced task tools", () => {
    expect(classifyToolSearchTaskEvidence({ query: "select:Read,Edit", matches: ["Read"] })).toBe(
      "unknown"
    )
    expect(classifyToolSearchTaskEvidence({ query: "notebook jupyter", matches: [] })).toBe(
      "unknown"
    )
  })

  test("reports unknown for missing or malformed evidence", () => {
    expect(classifyToolSearchTaskEvidence(null)).toBe("unknown")
    expect(classifyToolSearchTaskEvidence(undefined)).toBe("unknown")
    expect(classifyToolSearchTaskEvidence({ query: "select:TaskCreate" })).toBe("unknown")
  })
})

describe("resolveNativeTaskToolAvailability", () => {
  test("present wins over any absent evidence", () => {
    expect(
      resolveNativeTaskToolAvailability([
        { query: "task tools", matches: ["mcp__swiz__TaskList"] },
        { query: "select:TaskCreate", matches: ["TaskCreate"] },
      ])
    ).toBe("present")
  })

  test("a targeted miss proves absence", () => {
    expect(
      resolveNativeTaskToolAvailability([
        { query: "select:Read", matches: ["Read"] },
        { query: "select:TaskCreate,TaskList", matches: ["mcp__swiz__TaskList"] },
      ])
    ).toBe("absent")
  })

  test("no qualifying evidence stays unknown", () => {
    expect(resolveNativeTaskToolAvailability([])).toBe("unknown")
    expect(resolveNativeTaskToolAvailability([null, { query: "select:Read", matches: [] }])).toBe(
      "unknown"
    )
  })
})

describe("readNativeTaskToolAvailability", () => {
  afterEach(() => {
    resetNativeTaskToolAvailabilityCache()
  })

  async function writeCaptures(
    lines: Array<Record<string, unknown>>,
    event = "postToolUse"
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "swiz-toolsearch-"))
    const body = lines.map((line) => JSON.stringify(line)).join("\n")
    await Bun.write(join(dir, `${event}.jsonl`), `${body}\n`)
    return dir
  }

  test("reads absence from this session's captured evidence", async () => {
    const dir = await writeCaptures([
      {
        session_id: "session-a",
        tool_name: "ToolSearch",
        _toolSearch: {
          query: "task list tasks todo",
          matches: ["mcp__swiz__TaskList", "mcp__swiz__TaskCreate"],
        },
      },
    ])
    expect(await readNativeTaskToolAvailability("session-a", dir)).toBe("absent")
  })

  test("reads presence from bare native matches", async () => {
    const dir = await writeCaptures([
      {
        session_id: "session-a",
        tool_name: "ToolSearch",
        _toolSearch: {
          query: "select:TaskCreate,TaskUpdate,TaskList",
          matches: ["TaskCreate", "TaskUpdate", "TaskList"],
        },
      },
    ])
    expect(await readNativeTaskToolAvailability("session-a", dir)).toBe("present")
  })

  test("ignores evidence belonging to other sessions", async () => {
    const dir = await writeCaptures([
      {
        session_id: "session-b",
        tool_name: "ToolSearch",
        _toolSearch: { query: "select:TaskCreate", matches: [] },
      },
    ])
    expect(await readNativeTaskToolAvailability("session-a", dir)).toBe("unknown")
  })

  test("tolerates malformed lines without concluding absence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-toolsearch-"))
    await Bun.write(join(dir, "postToolUse.jsonl"), '{"_toolSearch": broken\n')
    expect(await readNativeTaskToolAvailability("session-a", dir)).toBe("unknown")
  })

  test("returns unknown for a missing directory or absent session id", async () => {
    expect(
      await readNativeTaskToolAvailability("session-a", join(tmpdir(), "swiz-no-such-dir"))
    ).toBe("unknown")
    expect(await readNativeTaskToolAvailability(null, tmpdir())).toBe("unknown")
  })

  test("caches a resolved verdict per session", async () => {
    const dir = await writeCaptures([
      {
        session_id: "session-a",
        tool_name: "ToolSearch",
        _toolSearch: { query: "select:TaskCreate", matches: [] },
      },
    ])
    expect(await readNativeTaskToolAvailability("session-a", dir)).toBe("absent")
    // Later reads short-circuit the cache even when the evidence is gone.
    expect(await readNativeTaskToolAvailability("session-a", join(tmpdir(), "swiz-gone"))).toBe(
      "absent"
    )
  })

  test("keeps an unknown transcript verdict incremental until new task evidence arrives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-task-transcript-"))
    const transcript = join(dir, "session.jsonl")
    await Bun.write(transcript, '{"type":"user","message":{"content":"hello"}}\n')
    expect(await readNativeTaskToolAvailabilityFromTranscript(transcript)).toBe("unknown")
    expect(await readNativeTaskToolAvailabilityFromTranscript(transcript)).toBe("unknown")
    await appendFile(
      transcript,
      '{"type":"assistant","message":"No such tool available: TaskList"}\n'
    )
    expect(await readNativeTaskToolAvailabilityFromTranscript(transcript)).toBe("absent")
  })

  test("keeps an unknown capture verdict incremental until a targeted search settles it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swiz-toolsearch-append-"))
    const capture = join(dir, "postToolUse.jsonl")
    await Bun.write(capture, `${JSON.stringify({ session_id: "other", _toolSearch: {} })}\n`)
    expect(await readNativeTaskToolAvailability("session-a", dir)).toBe("unknown")
    await appendFile(
      capture,
      `${JSON.stringify({
        session_id: "session-a",
        _toolSearch: { query: "select:TaskCreate", matches: [] },
      })}\n`
    )
    expect(await readNativeTaskToolAvailability("session-a", dir)).toBe("absent")
  })
})

describe("shouldEnforceTaskGovernance", () => {
  test("stands down only on proven absence", () => {
    expect(shouldEnforceTaskGovernance("absent")).toBe(false)
  })

  test("fails open for present and unknown", () => {
    expect(shouldEnforceTaskGovernance("present")).toBe(true)
    expect(shouldEnforceTaskGovernance("unknown")).toBe(true)
  })
})
