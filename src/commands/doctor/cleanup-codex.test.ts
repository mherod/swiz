import { describe, expect, test } from "bun:test"
import { chmod, mkdir, symlink, utimes } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { runCommandInProcess, useTempDir } from "../../utils/test-utils.ts"
import { doctorCommand } from "../doctor.ts"
import { findCodexCleanupGroups } from "./cleanup-codex.ts"

const tmp = useTempDir("swiz-codex-cleanup-")
const HOUR_MS = 60 * 60 * 1000
const NOW = Math.floor(Date.now() / 1000) * 1000
const CUTOFF = NOW - 48 * HOUR_MS
const OLD = CUTOFF - HOUR_MS
const RECENT = NOW - HOUR_MS
const SESSION_DIR = ["sessions", "2026", "07", "28"]

async function rollout(home: string, archived: boolean, mtime: number) {
  const id = crypto.randomUUID()
  const path = join(
    home,
    ".codex",
    ...(archived ? ["archived_sessions"] : SESSION_DIR),
    `rollout-2026-07-28T01-56-39-${id}.jsonl`
  )
  const original = [
    JSON.stringify({
      type: "session_meta",
      timestamp: new Date(OLD).toISOString(),
      payload: { id, cwd: join(home, "project") },
    }),
    JSON.stringify({ type: "compacted", timestamp: new Date(OLD).toISOString() }),
    JSON.stringify({ type: "event_msg", timestamp: new Date(mtime).toISOString() }),
    "",
  ].join("\n")
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, original)
  await utimes(path, mtime / 1000, mtime / 1000)
  return { id, path, original }
}

function clean(home: string, args: string[] = []) {
  return runCommandInProcess(doctorCommand, ["clean", "--older-than=48h", ...args], {
    cwd: home,
    env: { HOME: home },
  })
}

async function cleanWithTrash(home: string, args: string[], env: Record<string, string>) {
  // Set PATH at process startup so Bun resolves the fixture executable rather
  // than reusing the test runner's cached lookup of the system trash command.
  const proc = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../../index.ts"),
      "doctor",
      "clean",
      "--older-than=48h",
      ...args,
    ],
    {
      cwd: home,
      env: { ...process.env, ...env, HOME: home, SWIZ_DIRECT: "1", AI_TEST_NO_BACKEND: "1" },
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { stdout, stderr, exitCode: await proc.exited }
}

describe("Codex session cleanup", () => {
  test("discovers both stores and uses file mtime, retaining the exact cutoff", async () => {
    const home = await tmp.create()
    const old = await rollout(home, false, OLD)
    const recent = await rollout(home, false, RECENT)
    const boundary = await rollout(home, false, CUTOFF)
    const archived = await rollout(home, true, OLD)
    const groups = await findCodexCleanupGroups(home, CUTOFF)
    const sessions = groups.find((group) => group.name === "(codex sessions)")!
    const archives = groups.find((group) => group.name === "(codex archived sessions)")!

    expect(sessions.old.map((session) => session.sessionId)).toEqual([old.id])
    expect(sessions.keep.map((session) => session.sessionId).sort()).toEqual(
      [recent.id, boundary.id].sort()
    )
    expect(sessions.old[0]!.paths).toEqual([old.path])
    expect(sessions.old[0]!.sizeBytes).toBe(Bun.file(old.path).size)
    expect(archives.old.map((session) => session.sessionId)).toEqual([archived.id])
    expect(archives.old[0]!.paths).toEqual([archived.path])
  })

  test("ignores non-rollout files and absent stores", async () => {
    const home = await tmp.create()
    expect(await findCodexCleanupGroups(home, CUTOFF)).toEqual([])
    const directory = join(home, ".codex", ...SESSION_DIR)
    await mkdir(directory, { recursive: true })
    for (const name of [
      "history.jsonl",
      "rollout-not-a-session.jsonl",
      "rollout-session.jsonl.bak",
    ]) {
      await Bun.write(join(directory, name), "not a session")
    }
    expect(await findCodexCleanupGroups(home, CUTOFF)).toEqual([])
  })

  test.each([
    ".codex",
    ".codex/sessions",
    ".codex/sessions/2026",
    "file",
  ])("does not follow symlinks at %s", async (depth) => {
    const home = await tmp.create()
    const external = await tmp.create()
    const old = await rollout(external, false, OLD)
    const relative = depth === "file" ? join(".codex", ...SESSION_DIR, basename(old.path)) : depth
    const link = join(home, relative)
    await mkdir(dirname(link), { recursive: true })
    await symlink(join(external, relative), link)

    expect(await findCodexCleanupGroups(home, CUTOFF)).toEqual([])
    expect(await Bun.file(old.path).text()).toBe(old.original)
  })

  test("dry-run reports both stores without changing any transcript", async () => {
    const home = await tmp.create()
    const files = [
      await rollout(home, false, OLD),
      await rollout(home, true, OLD),
      await rollout(home, false, RECENT),
    ]
    const result = await clean(home, ["--dry-run"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/\(codex sessions\).*1 kept.*1 trashable/)
    expect(result.stdout).toMatch(/\(codex archived sessions\).*0 kept.*1 trashable/)
    expect(result.stdout).toMatch(/Total: .*2 sessions/)
    for (const file of files) expect(await Bun.file(file.path).text()).toBe(file.original)
  })

  test("project-scoped cleanup leaves global Codex stores untouched", async () => {
    const home = await tmp.create()
    const file = await rollout(home, false, OLD)
    const result = await clean(home, ["--project", "some-other-project", "--skip-trash"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("codex sessions")
    expect(await Bun.file(file.path).text()).toBe(file.original)
  })

  test.each([false, true])("removes only old rollouts (skip Trash: %s)", async (skipTrash) => {
    const home = await tmp.create()
    const old = await rollout(home, false, OLD)
    const archived = await rollout(home, true, OLD)
    const recent = await rollout(home, false, RECENT)
    const trash = join(home, "fixture-trash")
    const bin = join(home, "bin")
    await mkdir(trash)
    await mkdir(bin)
    await Bun.write(join(bin, "trash"), '#!/bin/sh\nexec /bin/mv "$1" "$SWIZ_TEST_TRASH_DIR/"\n')
    await chmod(join(bin, "trash"), 0o755)
    const result = await cleanWithTrash(home, skipTrash ? ["--skip-trash"] : [], {
      PATH: `${bin}:${process.env.PATH}`,
      SWIZ_TEST_TRASH_DIR: trash,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("2 session(s)")
    expect(result.stdout).toContain(skipTrash ? "deleted" : "moved to Trash")
    expect(result.stdout).not.toContain("could not be trashed")
    for (const file of [old, archived]) {
      expect(await Bun.file(file.path).exists()).toBe(false)
      expect(await Bun.file(join(trash, basename(file.path))).exists()).toBe(!skipTrash)
    }
    expect(await Bun.file(recent.path).text()).toBe(recent.original)
    expect(await Bun.file(`${recent.path}.bak`).exists()).toBe(false)

    // Exercise the nothing-to-trash branch too: old metadata must still survive.
    const repeated = await clean(home)
    expect(repeated.exitCode).toBe(0)
    expect(repeated.stdout).not.toContain("Truncated")
    expect(await Bun.file(recent.path).text()).toBe(recent.original)
  })
})
