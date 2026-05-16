import { describe, expect, test } from "bun:test"
import pretoolusNoReadyToBacklog from "./pretooluse-no-ready-to-backlog.ts"

function run(command: string) {
  return pretoolusNoReadyToBacklog.run({
    tool_name: "Bash",
    tool_input: { command },
    session_id: "test-session",
  } as any) as any
}

function decision(result: any): string | undefined {
  return result?.hookSpecificOutput?.permissionDecision ?? result?.decision
}

function reason(result: any): string | undefined {
  return result?.hookSpecificOutput?.permissionDecisionReason ?? result?.reason
}

describe("pretooluse-no-ready-to-backlog", () => {
  test("blocks plain ready-to-backlog demotion", () => {
    const result = run("gh issue edit 42 --remove-label ready --add-label backlog")
    expect(decision(result)).toBe("deny")
  })

  test("blocks demotion with quoted labels", () => {
    const result = run(`gh issue edit 42 --remove-label "ready" --add-label "backlog"`)
    expect(decision(result)).toBe("deny")
  })

  test("blocks demotion regardless of argument order", () => {
    const result = run("gh issue edit 42 --add-label backlog --remove-label ready")
    expect(decision(result)).toBe("deny")
  })

  test("allows audited correction with # correction: token", () => {
    const result = run(
      "gh issue edit 42 --remove-label ready --add-label backlog # correction: mislabeled during triage"
    )
    expect(decision(result)).not.toBe("deny")
  })

  test("allows audited correction — case-insensitive token", () => {
    const result = run(
      "gh issue edit 42 --remove-label ready --add-label backlog # Correction: wrong readiness set"
    )
    expect(decision(result)).not.toBe("deny")
  })

  test("allows commands that only remove ready without adding backlog", () => {
    const result = run("gh issue edit 42 --remove-label ready --add-label triaged")
    expect(decision(result)).not.toBe("deny")
  })

  test("allows commands that only add backlog without removing ready", () => {
    const result = run("gh issue edit 42 --add-label backlog")
    expect(decision(result)).not.toBe("deny")
  })

  test("allows unrelated gh issue edit commands", () => {
    const result = run(
      `gh issue edit 42 --add-label "bug,priority-high" --remove-label "needs-refinement"`
    )
    expect(decision(result)).not.toBe("deny")
  })

  test("passes through non-issue-edit commands", () => {
    const result = run("gh issue list --label ready")
    expect(decision(result)).not.toBe("deny")
  })

  test("block message explains the # correction: mechanism", () => {
    const result = run("gh issue edit 99 --remove-label ready --add-label backlog")
    expect(reason(result)).toContain("# correction:")
  })

  test("block message includes example with mislabeled reason", () => {
    const result = run("gh issue edit 99 --remove-label ready --add-label backlog")
    expect(reason(result)).toContain("mislabeled")
  })
})
