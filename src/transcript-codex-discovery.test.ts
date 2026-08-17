import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  findCodexSessions,
  getCodexSessionDiscoveryMetrics,
} from "./transcript-sessions-discovery.ts"

const tempRoots: string[] = []

type CodexSource =
  | "vscode"
  | {
      subagent:
        | { other: "guardian" }
        | {
            thread_spawn: {
              parent_thread_id: string
              depth: number
              agent_path: string
              agent_nickname: string
              agent_role: null
            }
          }
    }

async function createCodexRollout(options: {
  id: string
  source: CodexSource
  baseInstructionsLength?: number
}): Promise<{ home: string; targetDir: string }> {
  const home = await mkdtemp(join(tmpdir(), "swiz-codex-discovery-"))
  tempRoots.push(home)
  const targetDir = join(home, "workspace")
  const sessionDir = join(home, ".codex", "sessions", "2026", "07", "31")
  await mkdir(targetDir, { recursive: true })
  await mkdir(sessionDir, { recursive: true })

  const meta = {
    timestamp: "2026-07-31T12:00:00.000Z",
    type: "session_meta",
    payload: {
      id: options.id,
      cwd: targetDir,
      source: options.source,
      base_instructions: "x".repeat(options.baseInstructionsLength ?? 0),
    },
  }
  const path = join(sessionDir, `rollout-2026-07-31T12-00-00-${options.id}.jsonl`)
  await Bun.write(path, `${JSON.stringify(meta)}\n`)
  return { home, targetDir }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("Codex transcript discovery", () => {
  it("discovers a primary session when session_meta exceeds the old fixed prefix", async () => {
    const id = "019fb700-0000-7000-8000-000000000001"
    const { home, targetDir } = await createCodexRollout({
      id,
      source: "vscode",
      baseInstructionsLength: 50_000,
    })

    const sessions = await findCodexSessions(targetDir, home)

    expect(sessions.map((session) => session.id)).toContain(id)
  })

  it("keeps work sessions while excluding guardian approval sessions", async () => {
    const primaryId = "019fb700-0000-7000-8000-000000000002"
    const { home, targetDir } = await createCodexRollout({
      id: primaryId,
      source: "vscode",
    })
    const sessionDir = join(home, ".codex", "sessions", "2026", "07", "31")

    const guardianId = "019fb700-0000-7000-8000-000000000003"
    await Bun.write(
      join(sessionDir, `rollout-2026-07-31T12-01-00-${guardianId}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: guardianId,
          cwd: targetDir,
          source: { subagent: { other: "guardian" } },
        },
      })}\n`
    )

    const spawnedId = "019fb700-0000-7000-8000-000000000004"
    await Bun.write(
      join(sessionDir, `rollout-2026-07-31T12-02-00-${spawnedId}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: spawnedId,
          cwd: targetDir,
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: primaryId,
                depth: 1,
                agent_path: "/root/transcript_reader",
                agent_nickname: "Reader",
                agent_role: null,
              },
            },
          },
        },
      })}\n`
    )

    const sessions = await findCodexSessions(targetDir, home)
    const ids = sessions.map((session) => session.id)

    expect(ids).toContain(primaryId)
    expect(ids).toContain(spawnedId)
    expect(ids).not.toContain(guardianId)
  })

  it("reuses unchanged metadata and invalidates it when modified time changes", async () => {
    const firstId = "019fb700-0000-7000-8000-000000000005"
    const { home, targetDir } = await createCodexRollout({ id: firstId, source: "vscode" })
    const sessionDir = join(home, ".codex", "sessions", "2026", "07", "31")
    const sessionPath = join(sessionDir, `rollout-2026-07-31T12-00-00-${firstId}.jsonl`)
    const before = getCodexSessionDiscoveryMetrics()

    await findCodexSessions(targetDir, home)
    const afterFirst = getCodexSessionDiscoveryMetrics()
    await findCodexSessions(targetDir, home)
    const afterUnchanged = getCodexSessionDiscoveryMetrics()

    expect(afterFirst.metadataMisses - before.metadataMisses).toBe(1)
    expect(afterUnchanged.metadataHits - afterFirst.metadataHits).toBe(1)

    await Bun.sleep(5)
    const secondId = "019fb700-0000-7000-8000-000000000006"
    await Bun.write(
      sessionPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: secondId, cwd: targetDir, source: "vscode" },
      })}\n`
    )

    const sessions = await findCodexSessions(targetDir, home)
    const afterModified = getCodexSessionDiscoveryMetrics()
    expect(afterModified.metadataMisses - afterUnchanged.metadataMisses).toBe(1)
    expect(sessions.map((session) => session.id)).toContain(secondId)
  })
})
