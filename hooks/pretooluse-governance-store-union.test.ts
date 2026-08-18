import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectKeyFromCwd } from "../src/project-key.ts"
import { hookOutputSchema } from "../src/schemas.ts"
import type { Task } from "../src/tasks/task-repository.ts"
import { evaluatePretooluseRequireTasks } from "./pretooluse-task-governance.ts"

// #823: governance read the session-keyed store while the MCP server wrote the project-keyed one,
// so an MCP-only session was judged against an empty queue and denied with a remedy it had already
// satisfied. These cases prove the union closes that gap without changing session-keyed behaviour.

// Governance stands down outside a git repository, so the fixture must run against a real one for
// the gates to fire at all. The repo itself supplies that; only the task store is redirected to a
// temp home via `_taskHome`, keeping the assertions isolated from real task state.
const CWD = process.cwd()
const PROJECT_KEY = projectKeyFromCwd(CWD)

const homes: string[] = []

afterEach(async () => {
  while (homes.length > 0) {
    const home = homes.pop()
    if (home) await rm(home, { recursive: true, force: true })
  }
})

async function makeHome(): Promise<string> {
  const home = join(tmpdir(), `swiz-gov-union-${process.pid}-${homes.length}-${Math.random()}`)
  await mkdir(join(home, ".claude", "tasks"), { recursive: true })
  homes.push(home)
  return home
}

function task(id: string, status: Task["status"]): Task {
  return {
    id,
    subject: `subject ${id}`,
    description: `description ${id}`,
    status,
    blocks: [],
    blockedBy: [],
    statusChangedAt: new Date().toISOString(),
  }
}

async function seedStore(home: string, storeKey: string, tasks: Task[]): Promise<void> {
  const dir = join(home, ".claude", "tasks", storeKey)
  await mkdir(dir, { recursive: true })
  for (const value of tasks) {
    await writeFile(join(dir, `${value.id}.json`), JSON.stringify(value))
  }
}

/** A governance payload that reaches the task-state gates for a Bash call. */
function governanceInput(home: string, sessionId: string) {
  return {
    session_id: sessionId,
    cwd: CWD,
    transcript_path: "/definitely/unavailable/transcript.jsonl",
    tool_name: "Bash",
    tool_input: { command: "echo probe" },
    _taskHome: home,
    // The canonical TaskList-sync gate runs ahead of the task-count gates and would deny every
    // case regardless of store, masking what these tests measure. Supplying recent TaskList
    // evidence satisfies it so the store-union behaviour is the only variable left.
    _currentSessionToolUsage: {
      toolNames: ["TaskList"],
      skillInvocations: [],
      events: [
        { kind: "tool", value: "TaskList", turnIndex: 1, timestamp: new Date().toISOString() },
      ],
    },
  }
}

/** Returns the decision alongside its reason so a failing expectation prints why the gate fired. */
async function decisionFor(
  home: string,
  sessionId: string
): Promise<{ decision: string | undefined; reason: string }> {
  const result = await evaluatePretooluseRequireTasks(governanceInput(home, sessionId))
  const hso = hookOutputSchema.parse(result).hookSpecificOutput
  return {
    decision: hso?.permissionDecision,
    reason: String(hso?.permissionDecisionReason ?? "").slice(0, 300),
  }
}

describe("task governance reads across both task stores", () => {
  test("denies when neither store has tasks (control)", async () => {
    // Establishes that this payload really does reach a denying gate, so the allows below are
    // attributable to the tasks being found rather than to the gate never firing.
    const home = await makeHome()
    expect(await decisionFor(home, "00000000-0000-0000-0000-00000000c001")).toMatchObject({
      decision: "deny",
    })
  })

  test("allows when tasks exist only in the project-keyed store", async () => {
    const home = await makeHome()
    await seedStore(home, PROJECT_KEY, [
      task("user-1", "in_progress"),
      task("user-2", "pending"),
      task("user-3", "pending"),
    ])
    const { decision, reason } = await decisionFor(home, "00000000-0000-0000-0000-00000000c002")
    expect(reason).toBe("")
    expect(decision).not.toBe("deny")
  })

  test("still allows when tasks exist only in the session-keyed store", async () => {
    const home = await makeHome()
    const sessionId = "00000000-0000-0000-0000-00000000c003"
    await seedStore(home, sessionId, [
      task("c003-1", "in_progress"),
      task("c003-2", "pending"),
      task("c003-3", "pending"),
    ])
    const { decision, reason } = await decisionFor(home, sessionId)
    expect(reason).toBe("")
    expect(decision).not.toBe("deny")
  })
})
