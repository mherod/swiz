import { describe, expect, test } from "bun:test"
import { isTaskTrackingExemptShellCommand } from "../../utils/git-utils.ts"
import {
  classifyDivergenceWeight,
  classifyShellCommandWeight,
  DEFAULT_DIVERGENCE_ADVISORY_THRESHOLD,
  DEFAULT_DIVERGENCE_STEER_THRESHOLD,
  type DivergenceMovementKind,
  hasMutatingUpdateFields,
  isOutwardShellCommand,
  MAX_DIVERGENCE_SESSIONS,
  type PriorTaskState,
  recordDivergenceToolCall,
  recoverSessionDivergence,
  resolveTaskMovement,
  type SessionDivergenceState,
  snapshotSessionDivergence,
} from "./divergence.ts"
import type { CapturedToolCall } from "./utils.ts"

const NOW = 1_755_000_000_000

function captured(name: string, detail: string, offsetMs = 0): CapturedToolCall {
  return { name, detail, timestamp: new Date(NOW + offsetMs).toISOString() }
}

function rec(
  map: Map<string, SessionDivergenceState>,
  sessionId: string,
  spec: {
    name: string
    input?: Record<string, any>
    at?: number
    movement?: DivergenceMovementKind | null
  }
): void {
  recordDivergenceToolCall(map, {
    sessionId,
    toolName: spec.name,
    toolInput: spec.input,
    nowMs: spec.at ?? NOW,
    movement: spec.movement ?? null,
  })
}

describe("classifyDivergenceWeight", () => {
  test("task, read, and search tools weigh 0 across providers", () => {
    for (const name of [
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TodoWrite",
      "mcp__swiz__TaskUpdate",
      "mcp__swiz__TaskList",
      "Read",
      "read_file",
      "Grep",
      "Glob",
      "grep_search",
    ]) {
      expect(classifyDivergenceWeight(name, undefined)).toBe(0)
    }
  })

  test("local file mutations weigh 1", () => {
    for (const name of ["Edit", "Write", "NotebookEdit", "StrReplace", "apply_patch"]) {
      expect(classifyDivergenceWeight(name, undefined)).toBe(1)
    }
  })

  test("unknown tools weigh 0", () => {
    for (const name of ["WebFetch", "SendMessage", "mcp__resect__find", "Artifact"]) {
      expect(classifyDivergenceWeight(name, undefined)).toBe(0)
    }
  })

  test("exempt shell commands weigh 0", () => {
    for (const command of [
      "rg -n foo src",
      "ls -la",
      "git status --short",
      "git log --oneline -5",
      "gh run list --limit 5",
      "gh api repos/o/r/issues",
      "gh pr list --state open",
      "bun test src/x.test.ts",
    ]) {
      expect(classifyShellCommandWeight(command)).toBe(0)
      expect(classifyDivergenceWeight("Bash", { command })).toBe(0)
    }
  })

  test("non-exempt local shell commands weigh 1", () => {
    for (const command of ['bun -e "console.log(1)"', "mkdir -p out", "cp a.txt b.txt"]) {
      expect(classifyShellCommandWeight(command)).toBe(1)
    }
  })

  test("outward commands weigh 2", () => {
    for (const command of [
      'git commit -m "feat: x"',
      "git push origin main",
      "git -C /repo push origin main",
      "gh issue create --title t",
      "gh pr merge 5 --squash",
      "gh api repos/o/r/issues/3 -X PATCH -f state=closed",
      "gh api repos/o/r/issues -f title=t",
      "gh api repos/o/r/labels --method POST",
      "swiz issue resolve 12 --body done",
      "swiz issue close 12",
    ]) {
      expect(isOutwardShellCommand(command)).toBe(true)
      expect(classifyShellCommandWeight(command)).toBe(2)
    }
  })

  test("gh reads and watches are not outward", () => {
    for (const command of [
      "gh run watch 123 --exit-status",
      "gh api repos/o/r/issues --jq .[].number",
      "gh pr view 12 --json state",
    ]) {
      expect(isOutwardShellCommand(command)).toBe(false)
      expect(classifyShellCommandWeight(command)).toBe(0)
    }
  })

  test("outwardness beats gate exemption — the gate exempts git push and all gh", () => {
    for (const command of ["git push origin main", "gh issue create --title t"]) {
      expect(isTaskTrackingExemptShellCommand(command)).toBe(true)
      expect(classifyShellCommandWeight(command)).toBe(2)
    }
  })

  test("shell with no command payload weighs 1", () => {
    expect(classifyShellCommandWeight("")).toBe(1)
    expect(classifyDivergenceWeight("Bash", undefined)).toBe(1)
    expect(classifyDivergenceWeight("Bash", {})).toBe(1)
  })
})

describe("resolveTaskMovement", () => {
  const PRIOR: PriorTaskState[] = [
    {
      id: "349d-1",
      status: "in_progress",
      subject: "Fix parser",
      description: "Old text",
      blockedBy: ["349d-9"],
      blocks: [],
    },
    { id: "349d-2", status: "pending", subject: "Write docs" },
  ]

  test("TaskCreate is always movement", () => {
    expect(resolveTaskMovement("TaskCreate", { subject: "New" }, null)).toBe("task-create")
    expect(resolveTaskMovement("mcp__swiz__TaskCreate", { subject: "New" }, PRIOR)).toBe(
      "task-create"
    )
  })

  test("TaskList and TaskGet never move, even without prior state", () => {
    for (const name of ["TaskList", "TaskGet", "mcp__swiz__TaskList"]) {
      expect(resolveTaskMovement(name, {}, null)).toBeNull()
    }
  })

  test("a TaskUpdate carrying no mutating fields is a no-op regardless of prior state", () => {
    expect(resolveTaskMovement("TaskUpdate", { taskId: "349d-1" }, null)).toBeNull()
    expect(resolveTaskMovement("TaskUpdate", { taskId: "349d-1" }, PRIOR)).toBeNull()
    expect(resolveTaskMovement("mcp__swiz__TaskUpdate", undefined, null)).toBeNull()
  })

  test("a field-carrying TaskUpdate is movement when prior state is unavailable", () => {
    expect(resolveTaskMovement("TaskUpdate", { taskId: "349d-1", status: "completed" }, null)).toBe(
      "task-update"
    )
  })

  test("valid status transitions are movement; same-status and invalid ones are not", () => {
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", status: "completed" }, PRIOR)
    ).toBe("task-update")
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", status: "in_progress" }, PRIOR)
    ).toBeNull()
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", status: "pending" }, PRIOR)
    ).toBeNull()
  })

  test("updates against ids the visible store does not hold are not movement", () => {
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-99", status: "completed" }, PRIOR)
    ).toBeNull()
  })

  test("hash-prefixed task ids match unprefixed prior ids", () => {
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "#349d-1", status: "completed" }, PRIOR)
    ).toBe("task-update")
  })

  test("subject changes are movement; identical subjects are not", () => {
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", subject: "Fix parser" }, PRIOR)
    ).toBeNull()
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", subject: "Fix tokenizer" }, PRIOR)
    ).toBe("task-update")
  })

  test("description changes are movement; identical descriptions are not", () => {
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", description: "Old text" }, PRIOR)
    ).toBeNull()
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", description: "New text" }, PRIOR)
    ).toBe("task-update")
  })

  test("unknown prior fields compare optimistically", () => {
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-2", description: "Anything" }, PRIOR)
    ).toBe("task-update")
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-2", addBlocks: ["349d-1"] }, PRIOR)
    ).toBe("task-update")
  })

  test("edge additions already held and removals not held are no-ops", () => {
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", addBlockedBy: ["349d-9"] }, PRIOR)
    ).toBeNull()
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", addBlockedBy: ["#349d-9"] }, PRIOR)
    ).toBeNull()
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", removeBlockedBy: ["349d-3"] }, PRIOR)
    ).toBeNull()
  })

  test("effective edge edits are movement", () => {
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", addBlockedBy: ["349d-3"] }, PRIOR)
    ).toBe("task-update")
    expect(
      resolveTaskMovement("TaskUpdate", { taskId: "349d-1", removeBlockedBy: ["349d-9"] }, PRIOR)
    ).toBe("task-update")
  })

  test("hasMutatingUpdateFields ignores empty arrays and bare ids", () => {
    expect(hasMutatingUpdateFields(undefined)).toBe(false)
    expect(hasMutatingUpdateFields({ taskId: "349d-1" })).toBe(false)
    expect(hasMutatingUpdateFields({ addBlocks: [] })).toBe(false)
    expect(hasMutatingUpdateFields({ status: "completed" })).toBe(true)
    expect(hasMutatingUpdateFields({ addBlocks: ["349d-1"] })).toBe(true)
  })
})

describe("recordDivergenceToolCall", () => {
  test("accumulates weights, resets on movement, and records the run peak", () => {
    const map = new Map<string, SessionDivergenceState>()
    rec(map, "sess-a", { name: "Edit", input: { file_path: "/a.ts" } })
    rec(map, "sess-a", { name: "Edit", input: { file_path: "/b.ts" }, at: NOW + 1 })
    rec(map, "sess-a", { name: "Bash", input: { command: 'git commit -m "x"' }, at: NOW + 2 })
    let state = map.get("sess-a")!
    expect(state.weightedSum).toBe(4)
    expect(state.callsSinceMovement).toBe(3)

    rec(map, "sess-a", {
      name: "TaskUpdate",
      input: { taskId: "349d-1", status: "completed" },
      at: NOW + 3,
      movement: "task-update",
    })
    state = map.get("sess-a")!
    expect(state.weightedSum).toBe(0)
    expect(state.callsSinceMovement).toBe(0)
    expect(state.lastMovementKind).toBe("task-update")
    expect(state.peaks).toHaveLength(1)
    expect(state.peaks[0]).toMatchObject({ peak: 4, calls: 3, movementKind: "task-update" })
  })

  test("sampling calls after a reset accumulate calls but no weight", () => {
    const map = new Map<string, SessionDivergenceState>()
    rec(map, "sess-b", { name: "TaskCreate", input: { subject: "S" }, movement: "task-create" })
    rec(map, "sess-b", { name: "TaskList", input: {}, at: NOW + 1 })
    const state = map.get("sess-b")!
    expect(state.weightedSum).toBe(0)
    expect(state.callsSinceMovement).toBe(1)
    expect(state.lastMovementKind).toBe("task-create")
  })

  test("movement on an empty run records no peak", () => {
    const map = new Map<string, SessionDivergenceState>()
    rec(map, "sess-c", { name: "TaskCreate", input: { subject: "S" }, movement: "task-create" })
    expect(map.get("sess-c")!.peaks).toHaveLength(0)
  })

  test("snapshot carries thresholds and recent peaks; unknown sessions are null", () => {
    const map = new Map<string, SessionDivergenceState>()
    rec(map, "sess-d", { name: "Edit", input: { file_path: "/a.ts" } })
    const snapshot = snapshotSessionDivergence(map, "sess-d")!
    expect(snapshot.weightedSum).toBe(1)
    expect(snapshot.advisoryThreshold).toBe(DEFAULT_DIVERGENCE_ADVISORY_THRESHOLD)
    expect(snapshot.steerThreshold).toBe(DEFAULT_DIVERGENCE_STEER_THRESHOLD)
    expect(snapshotSessionDivergence(map, "sess-none")).toBeNull()
  })

  test("the session map stays bounded", () => {
    const map = new Map<string, SessionDivergenceState>()
    for (let i = 0; i < MAX_DIVERGENCE_SESSIONS + 3; i++) {
      rec(map, `sess-${i}`, { name: "Edit", input: { file_path: "/a.ts" }, at: NOW + i })
    }
    expect(map.size).toBe(MAX_DIVERGENCE_SESSIONS)
    expect(map.has("sess-0")).toBe(false)
    expect(map.has(`sess-${MAX_DIVERGENCE_SESSIONS + 2}`)).toBe(true)
  })
})

describe("incidence", () => {
  test("an agent honestly draining its queue never approaches the advisory", () => {
    const map = new Map<string, SessionDivergenceState>()
    let maxSum = 0
    for (let i = 0; i < 10; i++) {
      rec(map, "honest", {
        name: "TaskCreate",
        input: { subject: `S${i}` },
        movement: "task-create",
      })
      rec(map, "honest", { name: "Edit", input: { file_path: "/a.ts" } })
      rec(map, "honest", { name: "Edit", input: { file_path: "/b.ts" } })
      maxSum = Math.max(maxSum, map.get("honest")!.weightedSum)
      rec(map, "honest", {
        name: "TaskUpdate",
        input: { taskId: `349d-${i}`, status: "completed" },
        movement: "task-update",
      })
    }
    expect(maxSum).toBeLessThan(DEFAULT_DIVERGENCE_ADVISORY_THRESHOLD)
    expect(map.get("honest")!.weightedSum).toBe(0)
  })

  test("an agent that stopped planning but keeps shipping crosses both thresholds", () => {
    const map = new Map<string, SessionDivergenceState>()
    rec(map, "drift", { name: "TaskCreate", input: { subject: "S" }, movement: "task-create" })
    for (let i = 0; i < 20; i++) {
      rec(map, "drift", { name: "Edit", input: { file_path: `/f${i}.ts` } })
    }
    for (let i = 0; i < 5; i++) {
      rec(map, "drift", { name: "Bash", input: { command: "git push origin main" } })
    }
    const sum = map.get("drift")!.weightedSum
    expect(sum).toBeGreaterThanOrEqual(DEFAULT_DIVERGENCE_STEER_THRESHOLD)
  })

  test("a long read-only investigation accumulates nothing", () => {
    const map = new Map<string, SessionDivergenceState>()
    for (let i = 0; i < 20; i++) {
      rec(map, "reader", { name: "Read", input: { file_path: `/f${i}.ts` } })
    }
    for (let i = 0; i < 10; i++) {
      rec(map, "reader", { name: "Bash", input: { command: "rg -n pattern src" } })
    }
    for (let i = 0; i < 10; i++) {
      rec(map, "reader", { name: "Bash", input: { command: "git log --oneline -3" } })
    }
    const state = map.get("reader")!
    expect(state.weightedSum).toBe(0)
    expect(state.callsSinceMovement).toBe(40)
  })
})

describe("recoverSessionDivergence", () => {
  test("rebuilds weights and movements from captured calls", () => {
    const calls: CapturedToolCall[] = [
      captured("Read", "/x.ts"),
      captured("Bash", "rg -n foo src", 1),
      captured("Edit", '{"file_path":"/x.ts"}', 2),
      captured("Bash", 'git commit -m "feat: add thing that has quite a long messa', 3),
      captured("mcp__swiz__TaskUpdate", '{"taskId":"349d-1","status":"completed"}', 4),
      captured("TaskList", "{}", 5),
      captured("Bash", 'bun -e "console.log(1)"', 6),
    ]
    const state = recoverSessionDivergence(calls, NOW + 100)
    expect(state.peaks).toHaveLength(1)
    expect(state.peaks[0]).toMatchObject({ peak: 3, calls: 4, movementKind: "task-update" })
    expect(state.weightedSum).toBe(1)
    expect(state.callsSinceMovement).toBe(2)
    expect(state.lastMovementKind).toBe("task-update")
    expect(state.updatedAt).toBe(NOW + 100)
  })

  test("a captured TaskUpdate without mutating fields does not reset", () => {
    const calls: CapturedToolCall[] = [
      captured("Edit", '{"file_path":"/x.ts"}'),
      captured("TaskUpdate", '{"taskId":"349d-1"}', 1),
    ]
    const state = recoverSessionDivergence(calls, NOW + 10)
    expect(state.weightedSum).toBe(1)
    expect(state.peaks).toHaveLength(0)
  })

  test("malformed captured task detail neither moves nor weighs", () => {
    const calls: CapturedToolCall[] = [
      captured("Edit", '{"file_path":"/x.ts"}'),
      captured("TaskUpdate", "not json", 1),
    ]
    const state = recoverSessionDivergence(calls, NOW + 10)
    expect(state.weightedSum).toBe(1)
    expect(state.callsSinceMovement).toBe(2)
    expect(state.peaks).toHaveLength(0)
  })
})
