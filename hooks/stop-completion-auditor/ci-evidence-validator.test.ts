/**
 * Unit tests for ci-evidence-validator.ts
 *
 * Key behaviors under test:
 * - When task files are absent (native tool cleaned them up), fall back to
 *   transcript bashCommands to detect CI verification calls.
 * - When task description contains CI evidence, pass through.
 * - When neither is present after a push, block with guidance.
 */

import { describe, expect, test } from "bun:test"
import type { TranscriptSummary } from "../../src/transcript-summary.ts"
import { validateCiEvidence } from "./ci-evidence-validator.ts"
import type { CompletionAuditContext } from "./types.ts"

function makeCtx(overrides: Partial<CompletionAuditContext> = {}): CompletionAuditContext {
  return {
    cwd: "/tmp/test",
    sessionId: "test-session",
    transcript: "",
    home: "/tmp/home",
    tasksDir: "/tmp/home/.claude/tasks/test-session",
    gates: { taskCreation: true, auditLog: true, ciEvidence: true },
    allTasks: [],
    toolCallCount: 15,
    taskToolUsed: true,
    observedToolNames: [],
    summary: null,
    ...overrides,
  }
}

function makeSummary(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  return {
    toolNames: [],
    toolCallCount: 15,
    bashCommands: [],
    skillInvocations: [],
    hasGitPush: true,
    sessionLines: [],
    sessionDurationMs: 0,
    successfulTestRuns: 0,
    lastVerificationTime: null,
    sessionScope: "large",
    ...overrides,
  }
}

describe("validateCiEvidence", () => {
  test("passes when ciEvidence gate is disabled", async () => {
    const ctx = makeCtx({ gates: { taskCreation: true, auditLog: true, ciEvidence: false } })
    const result = await validateCiEvidence(ctx)
    expect(result.kind).toBe("ok")
  })

  test("passes when no git push in summary", async () => {
    const ctx = makeCtx({ summary: makeSummary({ hasGitPush: false }) })
    const result = await validateCiEvidence(ctx)
    expect(result.kind).toBe("ok")
  })

  test("passes when allTasks=[] and gh run watch is in bashCommands (cleanup path)", async () => {
    // Native task tools delete JSON files after completion. The transcript
    // bashCommands are the authoritative record of CI verification in this case.
    const ctx = makeCtx({
      allTasks: [],
      summary: makeSummary({
        bashCommands: ["gh run watch 24293796625 --exit-status"],
      }),
    })
    const result = await validateCiEvidence(ctx)
    expect(result.kind).toBe("ok")
  })

  test("passes when allTasks=[] and gh run view is in bashCommands", async () => {
    const ctx = makeCtx({
      allTasks: [],
      summary: makeSummary({
        bashCommands: ['gh run view 123 --json conclusion,status,jobs --jq ".[0]"'],
      }),
    })
    const result = await validateCiEvidence(ctx)
    expect(result.kind).toBe("ok")
  })

  test("passes when allTasks=[] and swiz ci-wait is in bashCommands", async () => {
    const ctx = makeCtx({
      allTasks: [],
      summary: makeSummary({
        bashCommands: ["swiz ci-wait abc123 --timeout 300"],
      }),
    })
    const result = await validateCiEvidence(ctx)
    expect(result.kind).toBe("ok")
  })

  test("blocks when allTasks=[] and no CI commands in bashCommands after push", async () => {
    const ctx = makeCtx({
      allTasks: [],
      transcript: "", // no siblings to search
      summary: makeSummary({
        bashCommands: ["git push origin main", "bun test"],
      }),
    })
    const result = await validateCiEvidence(ctx)
    expect(result.kind).toBe("ci-evidence")
  })

  test("passes when completed task has CI evidence in completionEvidence", async () => {
    const ctx = makeCtx({
      allTasks: [
        {
          id: "1",
          subject: "Verify CI",
          status: "completed",
          completionEvidence: "CI green — conclusion: success, run 12345",
        },
      ],
      summary: makeSummary(),
    })
    const result = await validateCiEvidence(ctx)
    expect(result.kind).toBe("ok")
  })

  test("passes when completed task has CI evidence in description (native TaskUpdate path)", async () => {
    // Native TaskUpdate tool stores evidence in description, not completionEvidence.
    const ctx = makeCtx({
      allTasks: [
        {
          id: "1",
          subject: "Verify CI green for governance push",
          status: "completed",
          description: "note:CI green — conclusion: success, run 24293796625 -- commit:ab7821eb",
        },
      ],
      summary: makeSummary(),
    })
    const result = await validateCiEvidence(ctx)
    expect(result.kind).toBe("ok")
  })

  test("blocks when completed task has no CI evidence in any field", async () => {
    const ctx = makeCtx({
      allTasks: [
        {
          id: "1",
          subject: "Push governance fixes",
          status: "completed",
          description: "commit:ab7821eb",
        },
      ],
      transcript: "",
      summary: makeSummary(),
    })
    const result = await validateCiEvidence(ctx)
    expect(result.kind).toBe("ci-evidence")
  })
})
