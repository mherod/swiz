import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSkillCache } from "../src/skill-utils.ts"
import {
  makeSkillGateSummary,
  permissionDecisionOf,
  runSkillGateWithSkillInstalled,
  skillInvocationLine,
} from "../src/utils/skill-gate-test-utils.ts"
import { neutralAgentEnvOverrides, runHookInProcess } from "../src/utils/test-utils.ts"

const HOOK_SCRIPT = "hooks/pretooluse-collaborate-skill-gate.ts"
const SKILL_NAME = "collaborate-with-another-agent"

async function runGate(sessionLines: string[] = []): Promise<Record<string, any>> {
  return await runSkillGateWithSkillInstalled({
    hookScript: HOOK_SCRIPT,
    skillName: SKILL_NAME,
    payload: {
      tool_name: "SendMessage",
      tool_input: { to: "peer-session", message: "taking the hooks lane" },
    },
    sessionLines,
    tempPrefix: "collab-gate-",
  })
}

describe("pretooluse-collaborate-skill-gate (fail-open paths)", () => {
  beforeEach(() => {
    clearSkillCache()
  })

  afterEach(() => {
    clearSkillCache()
  })

  it("passes through when the skill is not installed", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "collab-gate-noskill-"))
    try {
      const result = await runHookInProcess(
        HOOK_SCRIPT,
        {
          tool_name: "SendMessage",
          tool_input: { to: "peer-session", message: "hi" },
          transcript_path: "fake.json",
          _transcriptSummary: makeSkillGateSummary(),
        },
        { env: neutralAgentEnvOverrides({ HOME: fakeHome }) }
      )
      expect(result.decision).toBeUndefined()
    } finally {
      clearSkillCache()
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it("passes through when transcript_path is empty", async () => {
    const result = await runHookInProcess(HOOK_SCRIPT, {
      tool_name: "SendMessage",
      tool_input: { to: "peer-session", message: "hi" },
      transcript_path: "",
    })
    expect(result.decision).toBeUndefined()
  })
})

describe("pretooluse-collaborate-skill-gate (with skill installed)", () => {
  it("blocks SendMessage when the collaborate skill was not recently invoked", async () => {
    const result = await runGate([])
    expect(permissionDecisionOf(result)).toBe("deny")
    expect((result as { systemMessage?: string }).systemMessage).toContain("BLOCKED")
  })

  it("allows SendMessage after the collaborate skill was invoked", async () => {
    const result = await runGate([skillInvocationLine(SKILL_NAME)])
    expect(permissionDecisionOf(result)).not.toBe("deny")
  })

  it("allows a later message when the skill was invoked earlier in the session", async () => {
    // The recency window has lapsed (no session lines), but the transcript still shows the skill
    // was invoked — so the session already has the protocol and a reload buys nothing.
    const dir = await mkdtemp(join(tmpdir(), "collab-gate-transcript-"))
    const transcript = join(dir, "session.jsonl")
    try {
      await writeFile(transcript, `${skillInvocationLine(SKILL_NAME, 60 * 60 * 1000)}\n`)
      const result = await runSkillGateWithSkillInstalled({
        hookScript: HOOK_SCRIPT,
        skillName: SKILL_NAME,
        payload: { tool_name: "SendMessage", tool_input: { to: "peer", message: "second one" } },
        sessionLines: [],
        tempPrefix: "collab-gate-",
        transcriptPath: transcript,
      })
      expect(permissionDecisionOf(result)).not.toBe("deny")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("still blocks when only an unrelated skill was invoked", async () => {
    const result = await runGate([skillInvocationLine("commit")])
    expect(permissionDecisionOf(result)).toBe("deny")
  })
})
