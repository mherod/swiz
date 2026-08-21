/**
 * Cancel one task in another session's store by subject match.
 *
 * The dashboard can create tasks but has no cancel affordance, and a task created there while
 * testing the form otherwise sits in that session's queue blocking its stop gate. Matching on
 * subject rather than id keeps the caller from having to guess the generated id.
 *
 * Usage: bun scripts/cancel-stray-task.ts <sessionId> <exact subject>
 */

import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const [sessionId, subject] = process.argv.slice(2)
if (!sessionId || !subject) {
  console.error("usage: bun scripts/cancel-stray-task.ts <sessionId> <exact subject>")
  process.exit(1)
}

const dir = join(homedir(), ".claude", "tasks", sessionId)
const files = await readdir(dir).catch(() => {
  console.error(`no task store at ${dir}`)
  process.exit(1)
})

let matched = 0
for (const file of files) {
  if (!file.endsWith(".json") || file.startsWith(".")) continue
  const path = join(dir, file)
  const task = await Bun.file(path)
    .json()
    .catch(() => null)
  if (!task || task.subject !== subject) continue
  if (task.status === "completed" || task.status === "cancelled") {
    console.log(`#${task.id} already ${task.status} — leaving it`)
    matched++
    continue
  }
  const now = new Date().toISOString()
  await Bun.write(
    path,
    `${JSON.stringify({ ...task, status: "cancelled", statusChangedAt: now }, null, 2)}\n`
  )
  console.log(`#${task.id} ${task.status} -> cancelled`)
  matched++
}

if (matched === 0) {
  console.error(`no task matching subject: ${subject}`)
  process.exit(1)
}
