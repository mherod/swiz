import { beforeEach, describe, expect, test } from "bun:test"
import {
  evaluatePermissionrequestInfractionRecord,
  PERMISSION_ESCALATION_THRESHOLD,
  resetPermissionRequestCounts,
} from "./permissionrequest-infraction-record.ts"

function contextOf(output: unknown): string {
  const o = output as { hookSpecificOutput?: { additionalContext?: string } }
  return o.hookSpecificOutput?.additionalContext ?? ""
}

const req = (sessionId: string, command: string) => ({
  session_id: sessionId,
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command },
})

describe("evaluatePermissionrequestInfractionRecord", () => {
  beforeEach(() => resetPermissionRequestCounts())

  test("stays silent on the first permission request", () => {
    const out = evaluatePermissionrequestInfractionRecord(req("s1", "rm -rf build"))
    expect(out).toEqual({})
  })

  test("escalates once the same action repeats to the threshold", () => {
    const session = "s2"
    const command = "curl http://example.com"
    let out: unknown = {}
    for (let i = 0; i < PERMISSION_ESCALATION_THRESHOLD; i++) {
      out = evaluatePermissionrequestInfractionRecord(req(session, command))
    }
    expect(contextOf(out)).toContain("needed permission")
  })

  test("different actions are tracked independently", () => {
    evaluatePermissionrequestInfractionRecord(req("s3", "ls"))
    const out = evaluatePermissionrequestInfractionRecord(req("s3", "pwd"))
    expect(out).toEqual({})
  })

  test("returns empty output for malformed input", () => {
    expect(evaluatePermissionrequestInfractionRecord(null)).toEqual({})
    expect(evaluatePermissionrequestInfractionRecord({ tool_name: "Bash" })).toEqual({})
  })
})
