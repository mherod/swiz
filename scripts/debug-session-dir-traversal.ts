/**
 * Probe session-id path traversal in the task store.
 *
 * `createSessionTask` sanitizes `sessionId` into `safeSession` but uses it only for the dedup
 * sentinel path; the raw value reaches `createTaskInProcess`, which joins it straight onto
 * `tasksDir`. A hook payload's `session_id` therefore escapes the store — the real
 * `~/.claude/tasks` picked up an `$(whoami)` directory, and `../../etc/passwd` landed in `~/etc`.
 *
 * Run: bun scripts/debug-session-dir-traversal.ts
 *
 * Writes only inside a throwaway temp HOME, never the real store.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const home = await mkdtemp(join(tmpdir(), "swiz-traversal-probe-"))
process.env.HOME = home
const tasksDir = join(home, ".claude", "tasks")

// Import *after* HOME is set — the store root is resolved from the environment at module load.
const { createTaskInProcess } = await import("../src/tasks/task-service.ts")

const CASES = [
  { label: "ordinary session id", sessionId: "7ed7644d-3b7c-4d02-8278-9aa2d4059950" },
  { label: "parent traversal", sessionId: "../../etc/passwd" },
  { label: "shell injection", sessionId: "$(whoami)" },
  { label: "absolute path", sessionId: "/tmp/swiz-traversal-absolute" },
  { label: "nested traversal", sessionId: "a/../../../../escaped" },
]

console.log("temp HOME: ", home)
console.log("tasksDir:  ", tasksDir)

for (const [i, testCase] of CASES.entries()) {
  // Predict with `join`, not `resolve` — the production sites use `join(tasksDir, sessionId)`,
  // which keeps an absolute-looking id *inside* the store rather than rebasing on it. Only `..`
  // segments escape, so a `resolve(tasksDir, id)` predictor overstates the vulnerability.
  const resolved = resolve(join(tasksDir, testCase.sessionId))
  const contained = resolved === tasksDir || resolved.startsWith(`${tasksDir}/`)
  console.log(`\n--- case ${i + 1}: ${testCase.label} ---`)
  console.log("sessionId:", JSON.stringify(testCase.sessionId))
  console.log("resolves to:", resolved)
  console.log("contained in tasksDir?", contained, contained ? "" : "  <-- ESCAPES THE STORE")

  try {
    const task = await createTaskInProcess({
      sessionId: testCase.sessionId,
      subject: `probe ${i + 1}`,
      description: "traversal probe",
      skipSubjectValidation: true,
    })
    console.log("createTaskInProcess: wrote task", task.id)
  } catch (err) {
    console.log("createTaskInProcess threw:", err instanceof Error ? err.message : err)
  }
}

// What actually exists on disk decides it — not what the calls returned.
console.log("\n--- resulting directories ---")
for (const dir of [tasksDir, join(home, "etc"), join(home, ".claude")]) {
  try {
    console.log(`${dir}:`, await readdir(dir))
  } catch (err) {
    console.log(`${dir}: <absent> (${err instanceof Error ? err.message.slice(0, 40) : err})`)
  }
}

await rm(home, { recursive: true, force: true })
await rm("/tmp/swiz-traversal-absolute", { recursive: true, force: true })
console.log("\ncleaned up temp HOME")
