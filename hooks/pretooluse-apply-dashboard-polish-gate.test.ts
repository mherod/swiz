import { describe, expect, test } from "bun:test"
import { bundledHookManifest } from "../src/manifest.ts"
import {
  makeSkillGateSummary,
  permissionDecisionOf,
  runSkillGateWithSkillInstalled,
  skillInvocationLine,
} from "../src/utils/skill-gate-test-utils.ts"
import dashboardPolishGate, {
  evaluateApplyDashboardPolishGate,
  isDashboardPolishGatedFile,
} from "./pretooluse-apply-dashboard-polish-gate.ts"

const SKILL = "apply-dashboard-polish"
const EXAMPLE_PATH = "apps/main-web/components/admin/campaigns/campaign-brief-card.tsx"

function editPayload(sessionLines: string[] = [], filePath = EXAMPLE_PATH) {
  return {
    tool_name: "Edit",
    tool_input: { file_path: filePath },
    cwd: "/repo",
    transcript_path: "dashboard-polish-transcript.jsonl",
    _agent: "claude",
    _transcriptSummary: makeSkillGateSummary(sessionLines),
  }
}

describe("isDashboardPolishGatedFile", () => {
  test.each([
    EXAMPLE_PATH,
    "admin/card.tsx",
    "dashboard/card.tsx",
    "src/components/admin/campaigns/card.tsx",
    "src/app/dashboard/reports/monthly/chart.tsx",
    "/repo/dashboard/page.tsx",
    "C:\\repo\\components\\admin\\campaigns\\card.tsx",
    "C:\\repo\\dashboard\\reports\\chart.tsx",
  ])("matches %s", (filePath) => {
    expect(isDashboardPolishGatedFile(filePath)).toBe(true)
  })

  test.each([
    "",
    "src/components/card.tsx",
    "src/components/admin.tsx",
    "src/components/dashboard.tsx",
    "src/administrator/card.tsx",
    "src/my-admin/card.tsx",
    "src/dashboards/card.tsx",
    "src/dashboard-old/card.tsx",
    "src/admin/card.ts",
    "src/dashboard/card.jsx",
    "src/admin/card.tsx.bak",
    "src/admin/card.tsx/style.css",
  ])("ignores %s", (filePath) => {
    expect(isDashboardPolishGatedFile(filePath)).toBe(false)
  })
})

describe("dashboard polish skill gate", () => {
  test.each([
    "Edit",
    "Write",
    "MultiEdit",
    "StrReplace",
    "replace",
    "write_file",
  ])("blocks %s without the required skill", async (tool_name) => {
    const result = await evaluateApplyDashboardPolishGate(
      { ...editPayload(), tool_name },
      () => true
    )
    expect(permissionDecisionOf(result)).toBe("deny")
    const reason =
      "hookSpecificOutput" in result
        ? result.hookSpecificOutput?.permissionDecisionReason
        : undefined
    expect(reason).toContain(SKILL)
    expect(reason).toContain(EXAMPLE_PATH)
  })

  test("allows a recent native Skill invocation", async () => {
    const result = await evaluateApplyDashboardPolishGate(
      editPayload([skillInvocationLine(SKILL)]),
      () => true
    )
    expect(permissionDecisionOf(result)).toBe("allow")
  })

  test.each([
    skillInvocationLine("apply-rsc"),
    skillInvocationLine(SKILL, 86_400_000),
  ])("rejects unrelated or expired skill evidence", async (line) => {
    const result = await evaluateApplyDashboardPolishGate(editPayload([line]), () => true)
    expect(permissionDecisionOf(result)).toBe("deny")
  })

  test("allows a recent Codex SKILL.md read", async () => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: {
        type: "function_call",
        name: "functions.exec_command",
        arguments: JSON.stringify({ cmd: `cat ~/.codex/skills/${SKILL}/SKILL.md` }),
      },
    })
    const result = await evaluateApplyDashboardPolishGate(
      { ...editPayload([line]), _agent: "codex" },
      () => true
    )
    expect(permissionDecisionOf(result)).toBe("allow")
  })

  test.each([
    "apply_patch",
    "functions.apply_patch",
  ])("checks every target in a %s patch", async (tool_name) => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/components/public/card.tsx",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/dashboard/reports/chart.tsx",
      "+export const chart = null",
      "*** End Patch",
    ].join("\n")
    const result = await evaluateApplyDashboardPolishGate(
      { ...editPayload(), tool_name, tool_input: { input: patch } },
      () => true
    )
    expect(permissionDecisionOf(result)).toBe("deny")
  })

  test("handles a raw patch input", async () => {
    const result = await evaluateApplyDashboardPolishGate(
      {
        ...editPayload(),
        tool_name: "apply_patch",
        tool_input:
          "*** Begin Patch\n*** Update File: admin/card.tsx\n@@\n-old\n+new\n*** End Patch",
      },
      () => true
    )
    expect(permissionDecisionOf(result)).toBe("deny")
  })

  test.each([
    "Read",
    "TaskCreate",
    "TaskUpdate",
    "Skill",
    "Bash",
  ])("keeps %s reachable without invoking the skill", async (tool_name) => {
    expect(
      await evaluateApplyDashboardPolishGate({ ...editPayload(), tool_name }, () => true)
    ).toEqual({})
  })

  test("ignores files outside admin and dashboard directories", async () => {
    expect(
      await evaluateApplyDashboardPolishGate(editPayload([], "src/components/card.tsx"), () => true)
    ).toEqual({})
  })

  test("fails open when the skill is unavailable", async () => {
    expect(await evaluateApplyDashboardPolishGate(editPayload(), () => false)).toEqual({})
  })

  test("fails open without a transcript", async () => {
    expect(
      await evaluateApplyDashboardPolishGate({ ...editPayload(), transcript_path: "" }, () => true)
    ).toEqual({})
  })

  test("enforces the installed skill through the registered hook", async () => {
    const result = await runSkillGateWithSkillInstalled({
      hookScript: "hooks/pretooluse-apply-dashboard-polish-gate.ts",
      skillName: SKILL,
      payload: editPayload(),
    })
    expect(permissionDecisionOf(result)).toBe("deny")
    const group = bundledHookManifest.find(
      (entry) => entry.event === "preToolUse" && entry.matcher === "Edit|Write|NotebookEdit"
    )
    expect(group?.hooks).toContainEqual({ hook: dashboardPolishGate })
  })
})
