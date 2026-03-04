#!/usr/bin/env bun
// PreCompact hook: Snapshot all current-session task IDs and statuses to disk
// before context compaction rewrites the transcript.
//
// Writes ~/.claude/tasks/<session-id>/compact-snapshot.json with the complete
// task list at the moment compaction triggers. The sessionstart-compact-context
// hook reads this snapshot on resume to verify and recreate any missing task
// files, providing a definitive fallback that does not depend on transcript
// discovery or the agent's in-context memory.

import { join } from "node:path"
import { readSessionTasks, type SessionHookInput, type SessionTask } from "./hook-utils.ts"

export interface CompactSnapshot {
  sessionId: string
  compactedAt: string
  tasks: Pick<SessionTask, "id" | "subject" | "status" | "activeForm" | "description">[]
}

async function main(): Promise<void> {
  const input = (await Bun.stdin.json().catch(() => null)) as SessionHookInput | null
  const sessionId = input?.session_id ?? ""
  if (!sessionId) return

  const home = process.env.HOME ?? ""
  if (!home) return

  const tasks = await readSessionTasks(sessionId, home)
  if (tasks.length === 0) return

  const snapshot: CompactSnapshot = {
    sessionId,
    compactedAt: new Date().toISOString(),
    tasks: tasks.map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      ...(t.activeForm ? { activeForm: t.activeForm } : {}),
      ...(t.description ? { description: t.description } : {}),
    })),
  }

  const snapshotPath = join(home, ".claude", "tasks", sessionId, "compact-snapshot.json")
  await Bun.write(snapshotPath, JSON.stringify(snapshot, null, 2))
}

if (import.meta.main) main()
