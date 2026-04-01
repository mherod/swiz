import { describe, expect, test } from "bun:test"
import type { Task } from "../../tasks/task-repository.ts"
import type { CurrentSessionToolUsage } from "../../transcript-summary.ts"
import {
  buildSessionTasksView,
  type CapturedToolCall,
  captureSessionToolCall,
  captureSessionToolUsage,
  extractMessageText,
  extractToolCalls,
  mergeToolStats,
  type SessionToolUsageState,
  seedSessionToolUsage,
  stripAnsi,
  supplementMessagesWithCapturedToolCalls,
  transcriptWatchPathsForProject,
} from "./utils.ts"

// Task helper that respects explicit null/undefined values
function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString()
  const statusChangedAt =
    overrides.statusChangedAt !== undefined
      ? overrides.statusChangedAt
      : (overrides.completionTimestamp ?? now)
  return {
    id: `task-${Math.random().toString(36).substring(7)}`,
    subject: "Test task",
    description: "",
    status: "pending",
    blocks: [],
    blockedBy: [],
    ...overrides,
    statusChangedAt,
    completionTimestamp:
      overrides.completionTimestamp ?? (overrides.status === "completed" ? now : undefined),
    completionEvidence:
      overrides.completionEvidence ?? (overrides.status === "completed" ? "done" : undefined),
  }
}

describe("transcriptWatchPathsForProject", () => {
  test("returns correct number of watch paths", () => {
    const paths = transcriptWatchPathsForProject("/home/user/project")
    expect(paths).toHaveLength(6)
  })

  test("each path has both path and label", () => {
    const paths = transcriptWatchPathsForProject("/home/user/project")
    for (const p of paths) {
      expect(typeof p.path).toBe("string")
      expect(typeof p.label).toBe("string")
      expect(p.path.length).toBeGreaterThan(0)
      expect(p.label.length).toBeGreaterThan(0)
    }
  })

  test("labels contain project identifier", () => {
    const cwd = "/home/user/my-project"
    const paths = transcriptWatchPathsForProject(cwd)
    const hasLabel = paths.some((p) => p.label.includes(":") && p.label.includes("my-project"))
    expect(hasLabel).toBe(true)
  })
})

describe("stripAnsi", () => {
  test("removes standard color codes", () => {
    expect(stripAnsi("\x1b[31mRed\x1b[0m")).toBe("Red")
    expect(stripAnsi("\x1b[1;32mBold Green\x1b[0m")).toBe("Bold Green")
  })

  test("handles empty string", () => {
    expect(stripAnsi("")).toBe("")
  })

  test("passes through plain text unchanged", () => {
    expect(stripAnsi("Hello World")).toBe("Hello World")
  })

  test("removes multiple ANSI sequences", () => {
    const input = "\x1b[31mA\x1b[0m \x1b[32mB\x1b[0m \x1b[33mC\x1b[0m"
    expect(stripAnsi(input)).toBe("A B C")
  })

  test("handles malformed ANSI sequences gracefully", () => {
    expect(stripAnsi("\x1b[31mIncomplete")).toBe("Incomplete")
    expect(stripAnsi("\x1b[zzzTest\x1b[0m")).toBe("zzTest")
  })

  test("preserves text containing ESC without full sequence", () => {
    const input = "Before\x1bXAfter"
    expect(stripAnsi(input)).toBe(input)
  })
})

describe("captureSessionToolCall", () => {
  test("adds new call to empty session map", () => {
    const map = new Map<string, CapturedToolCall[]>()
    const now = Date.now()
    captureSessionToolCall(map, "sess1", "Read", { path: "/test" }, now)

    expect(map.has("sess1")).toBe(true)
    expect(map.get("sess1")).toHaveLength(1)
    const call = map.get("sess1")![0]!
    expect(call.name).toBe("Read")
    expect(call.timestamp).toBe(new Date(now).toISOString())
    // summarizeToolInput extracts path via summarizeFileOrCommandInput
    expect(call.detail).toBe("/test")
  })

  test("appends to existing session calls", () => {
    const map = new Map<string, CapturedToolCall[]>([
      ["sess1", [{ name: "Bash", detail: "ls", timestamp: new Date().toISOString() }]],
    ])
    const now = Date.now()
    captureSessionToolCall(map, "sess1", "Read", { path: "/test" }, now)

    expect(map.get("sess1")!).toHaveLength(2)
  })

  test("respects MAX_CAPTURED_TOOL_CALLS_PER_SESSION limit (400)", () => {
    const map = new Map<string, CapturedToolCall[]>()
    const now = Date.now()

    for (let i = 0; i < 410; i++) {
      captureSessionToolCall(map, "sess1", "Tool", { i }, now)
    }

    expect(map.get("sess1")!).toHaveLength(400)
  })

  test("maintains insertion order after truncation (keeps last 400)", () => {
    const map = new Map<string, CapturedToolCall[]>()
    const now = Date.now()

    for (let i = 0; i < 410; i++) {
      captureSessionToolCall(map, "sess1", "Tool", { i }, now)
    }

    const calls = map.get("sess1")!
    // First entry should be from evicted prefix (i=10)
    expect(calls).toHaveLength(400)
  })
})

describe("seedSessionToolUsage", () => {
  test("creates new SessionToolUsageState from CurrentSessionToolUsage", () => {
    const map = new Map<string, SessionToolUsageState>()
    const usage: CurrentSessionToolUsage = {
      toolNames: ["Read", "Bash"],
      skillInvocations: ["commit"],
    }

    const result = seedSessionToolUsage(map, "sess1", usage, Date.now())

    expect(result.toolNames).toEqual(["Read", "Bash"])
    expect(result.skillInvocations).toEqual(["commit"])
    expect(typeof result.lastSeen).toBe("number")
    expect(map.get("sess1")).toBe(result)
  })

  test("does not mutate input usage object", () => {
    const map = new Map<string, SessionToolUsageState>()
    const usage: CurrentSessionToolUsage = {
      toolNames: ["Read"],
      skillInvocations: [],
    }

    seedSessionToolUsage(map, "sess1", usage, Date.now())

    usage.toolNames.push("Bash")
    expect(map.get("sess1")!.toolNames).not.toContain("Bash")
  })
})

describe("captureSessionToolUsage", () => {
  test("creates new session with tool name when none exists", () => {
    const map = new Map<string, SessionToolUsageState>()

    const result = captureSessionToolUsage(map, "sess1", "Read", {}, Date.now())

    expect(result.toolNames).toEqual(["Read"])
    expect(result.skillInvocations).toEqual([])
  })

  test("appends tool name to existing session", () => {
    const map = new Map<string, SessionToolUsageState>([
      ["sess1", { toolNames: ["Bash"], skillInvocations: [], lastSeen: Date.now() }],
    ])

    captureSessionToolUsage(map, "sess1", "Read", {}, Date.now())

    expect(map.get("sess1")!.toolNames).toEqual(["Bash", "Read"])
  })

  test("records skill invocation only when toolName is 'Skill' and skill is string", () => {
    const map = new Map<string, SessionToolUsageState>()

    captureSessionToolUsage(map, "sess1", "Skill", { skill: "commit" }, Date.now())
    expect(map.get("sess1")!.skillInvocations).toEqual(["commit"])

    captureSessionToolUsage(map, "sess1", "Skill", { skill: "push" }, Date.now())
    expect(map.get("sess1")!.skillInvocations).toEqual(["commit", "push"])

    captureSessionToolUsage(map, "sess1", "Read", {}, Date.now())
    expect(map.get("sess1")!.skillInvocations).toEqual(["commit", "push"])
  })

  test("does not record skill invocation when skill is not a string", () => {
    const map = new Map<string, SessionToolUsageState>()

    captureSessionToolUsage(map, "sess1", "Skill", { skill: 123 }, Date.now())
    expect(map.get("sess1")!.skillInvocations).toEqual([])

    captureSessionToolUsage(map, "sess1", "Skill", { skill: null }, Date.now())
    expect(map.get("sess1")!.skillInvocations).toEqual([])
  })

  test("updates lastSeen on each call", () => {
    const map = new Map<string, SessionToolUsageState>()
    const time1 = 1000
    const time2 = 2000

    captureSessionToolUsage(map, "sess1", "Read", {}, time1)
    expect(map.get("sess1")!.lastSeen).toBe(time1)

    captureSessionToolUsage(map, "sess1", "Bash", {}, time2)
    expect(map.get("sess1")!.lastSeen).toBe(time2)
  })
})

describe("mergeToolStats", () => {
  test("merges base counts with supplemental calls", () => {
    const base = [
      { name: "Read", count: 5 },
      { name: "Bash", count: 3 },
    ]
    const supplemental = [
      { name: "Read", detail: "f1" },
      { name: "Skill", detail: "commit" },
    ]

    const result = mergeToolStats(base, supplemental)

    expect(result).toEqual([
      { name: "Read", count: 6 },
      { name: "Bash", count: 3 },
      { name: "Skill", count: 1 },
    ])
  })

  test("handles empty base array", () => {
    const result = mergeToolStats([], [{ name: "Read", detail: "file" }])
    expect(result).toEqual([{ name: "Read", count: 1 }])
  })

  test("handles empty supplemental array", () => {
    const base = [{ name: "Read", count: 5 }]
    const result = mergeToolStats(base, [])
    expect(result).toEqual(base)
  })

  test("sorts by count descending", () => {
    const base = [
      { name: "A", count: 1 },
      { name: "B", count: 3 },
    ]
    const supplemental = [
      { name: "C", detail: "x" },
      { name: "A", detail: "y" },
    ]

    const result = mergeToolStats(base, supplemental)
    expect(result.map((r) => r.name)).toEqual(["B", "A", "C"])
  })

  test("combines counts correctly when name appears in both arrays", () => {
    const base = [{ name: "Read", count: 10 }]
    const supplemental = [
      { name: "Read", detail: "f1" },
      { name: "Read", detail: "f2" },
    ]

    const result = mergeToolStats(base, supplemental)

    expect(result.find((r) => r.name === "Read")!.count).toBe(12)
  })
})

describe("supplementMessagesWithCapturedToolCalls", () => {
  test("returns messages unchanged when captured is empty", () => {
    const messages = [
      { role: "user" as const, text: "Hello", timestamp: "2024-01-01T00:00:00Z" },
      {
        role: "assistant" as const,
        text: "Hi",
        timestamp: "2024-01-01T00:00:01Z",
        toolCalls: undefined,
      },
    ]

    const result = supplementMessagesWithCapturedToolCalls(messages, [])

    expect(result).toEqual(messages)
  })

  test("adds captured calls to existing assistant messages", () => {
    const messages = [
      {
        role: "assistant" as const,
        text: "Reading file",
        timestamp: "2024-01-01T00:00:00Z",
        toolCalls: [],
      },
    ]
    const captured: CapturedToolCall[] = [
      { name: "Read", detail: "/path/to/file", timestamp: "2024-01-01T00:00:00Z" },
    ]

    const result = supplementMessagesWithCapturedToolCalls(messages, captured)

    expect(result[0]!.toolCalls!).toHaveLength(1)
    expect(result[0]!.toolCalls![0]!.name).toBe("Read")
    expect(result[0]!.toolCalls![0]!.detail).toBe("/path/to/file")
  })

  test("spreads captured calls across multiple assistant messages", () => {
    const messages = [
      { role: "assistant" as const, text: "A", timestamp: "2024-01-01T00:00:00Z", toolCalls: [] },
      { role: "assistant" as const, text: "B", timestamp: "2024-01-01T00:00:01Z", toolCalls: [] },
    ]
    const captured: CapturedToolCall[] = [
      { name: "T1", detail: "d1", timestamp: "" },
      { name: "T2", detail: "d2", timestamp: "" },
      { name: "T3", detail: "d3", timestamp: "" },
    ]

    const result = supplementMessagesWithCapturedToolCalls(messages, captured)

    expect(result[0]!.toolCalls!.length).toBe(1)
    expect(result[1]!.toolCalls!.length).toBe(2)
    expect(result[1]!.toolCalls![1]!.name).toBe("T3")
  })

  test("when no assistant messages exist, appends new assistant messages sorted by timestamp", () => {
    const messages = [{ role: "user" as const, text: "Hello", timestamp: "2024-01-01T00:00:00Z" }]
    const captured: CapturedToolCall[] = [
      { name: "T1", detail: "d1", timestamp: "2024-01-01T00:00:02Z" },
      { name: "T2", detail: "d2", timestamp: "2024-01-01T00:00:01Z" },
    ]

    const result = supplementMessagesWithCapturedToolCalls(messages, captured)

    const assistantMessages = result.filter((m) => m.role === "assistant")
    expect(assistantMessages).toHaveLength(2)
    expect(assistantMessages[0]!.timestamp!).toBe("2024-01-01T00:00:01Z")
    expect(assistantMessages[1]!.timestamp!).toBe("2024-01-01T00:00:02Z")
  })

  test("does not mutate original messages array", () => {
    const messages = [
      { role: "assistant" as const, text: "A", timestamp: "2024-01-01T00:00:00Z", toolCalls: [] },
    ]
    const captured: CapturedToolCall[] = [{ name: "Read", detail: "file", timestamp: "" }]

    supplementMessagesWithCapturedToolCalls(messages, captured)

    expect(messages[0]!.toolCalls!).toHaveLength(0)
  })

  test("handles assistant messages with existing toolCalls", () => {
    const messages = [
      {
        role: "assistant" as const,
        text: "A",
        timestamp: "2024-01-01T00:00:00Z",
        toolCalls: [{ name: "Existing", detail: "old" }],
      },
    ]
    const captured: CapturedToolCall[] = [{ name: "New", detail: "new", timestamp: "" }]

    const result = supplementMessagesWithCapturedToolCalls(messages, captured)

    expect(result[0]!.toolCalls!).toHaveLength(2)
    expect(result[0]!.toolCalls![0]!.name).toBe("Existing")
    expect(result[0]!.toolCalls![1]!.name).toBe("New")
  })
})

describe("extractToolCalls", () => {
  test("returns empty array for non-array content", () => {
    expect(extractToolCalls("string")).toEqual([])
    expect(extractToolCalls(null)).toEqual([])
    expect(extractToolCalls(undefined)).toEqual([])
    expect(extractToolCalls({})).toEqual([])
  })

  test("filters blocks by type === 'tool_use'", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "tool_use", name: "Read", input: { path: "/test" } },
      { type: "tool_use", name: "Bash" },
    ]

    const result = extractToolCalls(content)

    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe("Read")
    expect(result[1]!.name).toBe("Bash")
  })

  test("excludes blocks without name or non-string name", () => {
    const content = [
      { type: "tool_use", name: "Valid" },
      { type: "tool_use", name: null },
      { type: "tool_use" },
      { type: "tool_use", name: 123 },
    ]

    const result = extractToolCalls(content)

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("Valid")
  })

  test("formats detail from input using JSON.stringify with 2-space indent", () => {
    const content = [{ type: "tool_use", name: "Read", input: { path: "/test/file.txt" } }]

    const result = extractToolCalls(content)

    // JSON.stringify(input, null, 2) produces 2-space indented JSON
    expect(result[0]!.detail).toBe('{\n  "path": "/test/file.txt"\n}')
  })

  test("handles tool_use with undefined input", () => {
    const content = [{ type: "tool_use", name: "Bash" }]

    const result = extractToolCalls(content)

    expect(result).toHaveLength(1)
    // formatToolInputForDisplay returns "" for undefined input
    expect(result[0]!.detail).toBe("")
  })
})

describe("extractMessageText", () => {
  test("extracts text from string content", () => {
    expect(extractMessageText("Hello World")).toBe("Hello World")
  })

  test("extracts text from block format (joined with newlines)", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text", text: " World" },
    ]
    expect(extractMessageText(content)).toBe("Hello\n World")
  })

  test("handles undefined content", () => {
    expect(extractMessageText(undefined)).toBe("")
  })

  test("trims extracted text", () => {
    const content = [{ type: "text", text: "  spaced  " }]
    expect(extractMessageText(content)).toBe("spaced")
  })

  test("returns empty string for empty array", () => {
    expect(extractMessageText([])).toBe("")
  })

  test("handles mixed block types - non-text blocks ignored", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "tool_use", name: "Read" },
      { type: "text", text: " World" },
    ]
    expect(extractMessageText(content)).toBe("Hello\n World")
  })
})

describe("buildSessionTasksView", () => {
  test("sorts tasks by status rank (in_progress first, then pending, completed, cancelled)", () => {
    const baseTime = new Date().toISOString()
    const tasks = [
      makeTask({ id: "t3", status: "completed", statusChangedAt: baseTime }),
      makeTask({ id: "t1", status: "in_progress", statusChangedAt: baseTime }),
      makeTask({ id: "t4", status: "cancelled", statusChangedAt: baseTime }),
      makeTask({ id: "t2", status: "pending", statusChangedAt: baseTime }),
    ]

    const result = buildSessionTasksView(tasks, 10)

    expect(result.tasks.map((t) => t.status)).toEqual([
      "in_progress",
      "pending",
      "completed",
      "cancelled",
    ])
  })

  test("sorts same-status tasks by statusChangedAt DESCENDING (newer first)", () => {
    const now = Date.now()
    const tasks = [
      makeTask({
        id: "t1",
        status: "pending",
        statusChangedAt: new Date(now - 1000).toISOString(),
      }),
      makeTask({
        id: "t2",
        status: "pending",
        statusChangedAt: new Date(now - 2000).toISOString(),
      }),
      makeTask({ id: "t3", status: "pending", statusChangedAt: new Date(now - 500).toISOString() }),
    ]

    const result = buildSessionTasksView(tasks, 10)

    expect(result.tasks.map((t) => t.id)).toEqual(["t3", "t1", "t2"])
  })

  test("sorts same-timestamp tasks by ID descending", () => {
    const baseTime = new Date().toISOString()
    const tasks = [
      makeTask({ id: "t10", status: "pending", statusChangedAt: baseTime }),
      makeTask({ id: "t2", status: "pending", statusChangedAt: baseTime }),
      makeTask({ id: "t5", status: "pending", statusChangedAt: baseTime }),
    ]

    const result = buildSessionTasksView(tasks, 10)

    expect(result.tasks.map((t) => t.id)).toEqual(["t5", "t2", "t10"])
  })

  test("respects limit parameter", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => makeTask({ id: `t${i}`, status: "pending" }))

    const result = buildSessionTasksView(tasks, 3)

    expect(result.tasks).toHaveLength(3)
  })

  test("handles empty tasks array", () => {
    const result = buildSessionTasksView([], 10)

    expect(result.tasks).toEqual([])
    expect(result.summary).toEqual({ total: 0, open: 0, completed: 0, cancelled: 0 })
  })

  test("summary counts tasks by status correctly", () => {
    const tasks = [
      makeTask({ status: "pending" }),
      makeTask({ status: "pending" }),
      makeTask({ status: "in_progress" }),
      makeTask({ status: "completed" }),
      makeTask({ status: "cancelled" }),
    ]

    const result = buildSessionTasksView(tasks, 10)

    expect(result.summary).toEqual({
      total: 5,
      open: 3,
      completed: 1,
      cancelled: 1,
    })
  })

  test("open count includes both pending and in_progress", () => {
    const tasks = [
      makeTask({ status: "pending" }),
      makeTask({ status: "in_progress" }),
      makeTask({ status: "completed" }),
    ]

    const result = buildSessionTasksView(tasks, 10)

    expect(result.summary.open).toBe(2)
  })
})

describe("taskStatusRank ordering", () => {
  test("in_progress has highest priority (lowest rank)", () => {
    const baseTime = new Date().toISOString()
    const tasks = [
      makeTask({ id: "t1", status: "completed", statusChangedAt: baseTime }),
      makeTask({ id: "t2", status: "in_progress", statusChangedAt: baseTime }),
      makeTask({ id: "t3", status: "pending", statusChangedAt: baseTime }),
      makeTask({ id: "t4", status: "cancelled", statusChangedAt: baseTime }),
    ]
    const result = buildSessionTasksView(tasks, 10)
    expect(result.tasks[0]!.status).toBe("in_progress")
  })
})
