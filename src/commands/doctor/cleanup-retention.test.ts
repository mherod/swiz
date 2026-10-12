import { describe, expect, test } from "bun:test"
import { mkdir, stat, utimes } from "node:fs/promises"
import { dirname, join } from "node:path"
import { projectKeyFromCwd } from "../../project-key.ts"
import { runCommandInProcess, useTempDir } from "../../utils/test-utils.ts"
import { doctorCommand } from "../doctor.ts"

const tmp = useTempDir("swiz-cleanup-retention-")
const HOUR_MS = 60 * 60 * 1000
const NOW = Date.now()
const original = `${JSON.stringify({ timestamp: "2020-01-01T00:00:00Z", type: "user" })}\n`

async function age(path: string, hours: number): Promise<void> {
  const seconds = (NOW - hours * HOUR_MS) / 1000
  await utimes(path, seconds, seconds)
}

async function project(home: string, name: string, count: number, hours = 4) {
  const cwd = join(home, name)
  await mkdir(cwd, { recursive: true })
  const key = projectKeyFromCwd(cwd)
  const directory = join(home, ".claude", "projects", key)
  await mkdir(directory, { recursive: true })
  const sessions = []
  for (let index = 0; index < count; index++) {
    // Reverse filename order so retention must use activity, not directory enumeration.
    const id = `00000000-0000-0000-0000-${String(count - index).padStart(12, "0")}`
    const path = join(directory, `${id}.jsonl`)
    await Bun.write(path, original)
    await age(path, hours + index / 1000)
    sessions.push({ id, path })
  }
  return { directory, key, sessions }
}

function clean(home: string, ...args: string[]) {
  return runCommandInProcess(doctorCommand, ["clean", ...args], {
    cwd: home,
    env: { HOME: home },
  })
}

describe("doctor session retention", () => {
  test.each([49, 50, 51])("applies the per-directory threshold to %i sessions", async (count) => {
    const home = await tmp.create()
    const fixture = await project(home, "project", count)
    // A second artifact for one session and unrelated files must not inflate the count.
    const paired = join(fixture.directory, fixture.sessions[0]!.id)
    await mkdir(paired)
    await age(paired, 4)
    await Bun.write(join(fixture.directory, "README.md"), "not a session")

    const result = await clean(home, "--dry-run", "--project", fixture.key)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`${count} sessions`)
    expect(result.stdout).toContain(`${Math.min(count, 50)} kept`)
    expect(result.stdout).toContain(`${Math.max(0, count - 50)} trashable`)
    for (const session of fixture.sessions)
      expect(await Bun.file(session.path).text()).toBe(original)
  })

  test("deletes only the oldest excess sessions within the selected directory", async () => {
    const home = await tmp.create()
    const fixture = await project(home, "busy", 52)
    const other = await project(home, "other", 51)
    const oldest = fixture.sessions[51]!
    const paired = join(fixture.directory, oldest.id)
    const task = join(home, ".claude", "tasks", oldest.id, "1.json")
    await mkdir(paired)
    await age(paired, 5)
    await Bun.write(task, '{"id":"1","status":"completed"}')

    const result = await clean(home, "--project", fixture.key, "--skip-trash")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("2 session(s)")
    for (const [index, session] of fixture.sessions.entries()) {
      expect(await Bun.file(session.path).exists()).toBe(index < 50)
    }
    expect(await stat(paired).catch(() => null)).toBeNull()
    expect(await Bun.file(task).exists()).toBe(false)
    for (const session of other.sessions) expect(await Bun.file(session.path).text()).toBe(original)

    const repeated = await clean(home, "--project", fixture.key, "--dry-run")
    expect(repeated.exitCode).toBe(0)
    expect(repeated.stdout).toContain("50 kept")
    expect(repeated.stdout).toContain("0 trashable")
  })

  test("retains more than 50 recently changed sessions and their tasks intact", async () => {
    const home = await tmp.create()
    const fixture = await project(home, "active", 52, 2)
    const task = join(home, ".claude", "tasks", fixture.sessions[51]!.id, "1.json")
    await Bun.write(task, '{"id":"1","status":"completed","completionTimestamp":"2020-01-01"}')
    const result = await clean(home, "--older-than=1h", "--task-older-than=1h", "--skip-trash")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("52 kept")
    expect(result.stdout).toContain("0 trashable")
    for (const session of fixture.sessions)
      expect(await Bun.file(session.path).text()).toBe(original)
    expect(await Bun.file(task).exists()).toBe(true)
  })

  test("protects recent nested changes even when a project path is gone", async () => {
    const home = await tmp.create()
    const session = join(
      home,
      ".claude",
      "projects",
      projectKeyFromCwd(join(home, "gone")),
      crypto.randomUUID()
    )
    const nested = join(session, "subagents", "session.jsonl")
    await Bun.write(nested, original)
    await age(nested, 2)
    await age(dirname(nested), 48)
    await age(session, 48)
    const result = await clean(home, "--older-than=1h", "--skip-trash")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("path gone")
    expect(result.stdout).toContain("1 kept")
    expect(await Bun.file(nested).text()).toBe(original)
  })

  test("honors the three-hour floor while retaining age-based cleanup below 50", async () => {
    const home = await tmp.create()
    const fixture = await project(home, "boundary", 3)
    await age(fixture.sessions[0]!.path, 3 - 1 / 60)
    await age(fixture.sessions[1]!.path, 3 + 1 / 60)
    await age(fixture.sessions[2]!.path, 31 * 24)
    const preview = await clean(home, "--dry-run")
    expect(preview.stdout).toContain("2 kept")
    expect(preview.stdout).toContain("1 trashable")
    const result = await clean(home, "--older-than=1h", "--skip-trash")
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(fixture.sessions[0]!.path).text()).toBe(original)
    expect(await Bun.file(fixture.sessions[1]!.path).exists()).toBe(false)
    expect(await Bun.file(fixture.sessions[2]!.path).exists()).toBe(false)
  })

  test("protects recent Antigravity sessions and recently changed orphan tasks", async () => {
    const home = await tmp.create()
    const session = join(home, ".gemini", "antigravity-cli", "brain", crypto.randomUUID())
    const transcript = join(session, "session.jsonl")
    await Bun.write(transcript, original)
    await age(transcript, 2)
    await age(session, 48)
    const orphan = join(home, ".claude", "tasks", crypto.randomUUID())
    const task = join(orphan, "1.json")
    await Bun.write(task, '{"id":"1","status":"completed","completionTimestamp":"2020-01-01"}')
    await age(task, 2)
    await age(orphan, 48)
    const result = await clean(home, "--older-than=1h", "--task-older-than=1h", "--skip-trash")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("0 trashable")
    expect(await Bun.file(transcript).text()).toBe(original)
    expect(await Bun.file(task).exists()).toBe(true)
  })
})
