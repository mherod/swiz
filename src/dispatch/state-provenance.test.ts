import { expect, test } from "bun:test"
import { join } from "node:path"
import { evaluatePosttooluseStateTransition } from "../../hooks/posttooluse-state-transition.ts"
import tsGate from "../../hooks/pretooluse-ts-edit-state-gate.ts"
import { readStateData, writeProjectState } from "../settings.ts"
import { getLockPathForFile } from "../utils/file-lock.ts"
import { useTempDir } from "../utils/test-utils.ts"
import { executeDispatch } from "./execute.ts"
import { projectStateProvenance } from "./state-provenance.ts"

const { create } = useTempDir("state-provenance-")
const timestamp = "2026-09-07T10:00:00.000Z"
const capability = (cwd: string) => ({
  canonicalRoot: cwd,
  repoKey: cwd,
  isRepo: true,
  repoSlug: null,
  hasGhCli: false,
  resolvedAt: Date.now(),
})

test("same-session context stays unchanged and malformed provenance stays unknown", () => {
  const data = {
    session_id: "session-A",
    _projectState: "reviewing",
    _projectStateTransition: {
      from: "developing",
      to: "reviewing",
      timestamp,
      sessionId: "session-A",
    },
  }
  expect(projectStateProvenance(JSON.stringify(data))).toBeNull()
  expect(
    projectStateProvenance(JSON.stringify({ ...data, _projectStateTransition: null }))
  ).toContain("source unknown")
  expect(
    projectStateProvenance(
      JSON.stringify({
        ...data,
        _projectStateTransition: { ...data._projectStateTransition, sessionId: null },
      })
    )
  ).toContain("source unknown")
})

test("filtered hooks still expose peer state provenance without changing filtering", async () => {
  const cwd = await create()
  await writeProjectState(cwd, "reviewing", "session-A")
  let ran = false
  const { response } = await executeDispatch({
    canonicalEvent: "preToolUse",
    hookEventName: "PreToolUse",
    daemonContext: true,
    payloadStr: JSON.stringify({
      cwd,
      session_id: "session-B",
      tool_name: "Bash",
      tool_input: { command: "git status" },
      _projectStateTransition: { sessionId: "forged" },
    }),
    settingsHomeOverride: await create(),
    manifestProvider: async () => [
      {
        event: "preToolUse",
        matcher: "Bash",
        hooks: [
          {
            hook: {
              name: "pretooluse-state-gate",
              event: "preToolUse",
              run: () => {
                ran = true
                return {}
              },
            },
          },
        ],
      },
    ],
    repositoryCapabilityProvider: async () => capability(cwd),
    replayPendingMutations: async () => {},
  })
  expect(ran).toBe(false)
  expect(response.systemMessage).toContain("session-A")
  expect(response.systemMessage).not.toContain("forged")
  expect(response.decision).toBeUndefined()
})

test("lock-timeout fallback retains actor but does not claim serialization", async () => {
  const cwd = await create()
  await writeProjectState(cwd, "developing")
  const lock = getLockPathForFile(join(cwd, ".swiz/state.json"))
  await Bun.write(lock, String(process.pid))
  try {
    await writeProjectState(cwd, "reviewing", "session-A")
    expect((await readStateData(cwd))?.stateHistory.at(-1)).toMatchObject({
      from: "developing",
      to: "reviewing",
      sessionId: "session-A",
    })
    expect(await Bun.file(lock).exists()).toBe(true)
  } finally {
    await Bun.file(lock).delete()
  }
})

test("lifecycle transitions persist their originating session", async () => {
  const cwd = await create()
  await writeProjectState(cwd, "developing")
  await evaluatePosttooluseStateTransition({
    cwd,
    session_id: "session-A",
    tool_name: "Bash",
    tool_input: { command: "gh pr create" },
    _repositoryCapability: capability(cwd),
  })
  const data = await Bun.file(join(cwd, ".swiz/state.json")).json()
  expect(data.stateHistory.at(-1).sessionId).toBe("session-A")
  expect((await readStateData(cwd))?.stateHistory.at(-1)).toMatchObject({ sessionId: "session-A" })
})

test.each([
  "session-A",
  undefined,
])("peer gate attributes persisted transitions (%s)", async (sessionId) => {
  const cwd = await create()
  await Bun.write(
    join(cwd, ".swiz/state.json"),
    JSON.stringify({
      state: "planning",
      stateHistory: [{ from: "developing", to: "planning", timestamp, sessionId }],
    })
  )
  const { response } = await executeDispatch({
    canonicalEvent: "preToolUse",
    hookEventName: "PreToolUse",
    daemonContext: true,
    payloadStr: JSON.stringify({
      cwd,
      session_id: "session-B",
      tool_name: "Edit",
      tool_input: { file_path: "src/file.ts" },
    }),
    settingsHomeOverride: await create(),
    manifestProvider: async () => [
      { event: "preToolUse", matcher: "Edit", hooks: [{ hook: tsGate }] },
    ],
    repositoryCapabilityProvider: async () => capability(cwd),
    replayPendingMutations: async () => {},
  })
  const context = JSON.stringify(response)
  expect(context).toContain("Current state")
  expect(context).toContain(sessionId ?? "source unknown")
  expect(context).toContain("developing → planning")
  expect(context).toContain(timestamp)
})
