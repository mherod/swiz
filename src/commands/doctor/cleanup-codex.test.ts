import { describe, expect, mock, test } from "bun:test"
import { chmod, mkdir, rename, symlink, utimes } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { runCommandInProcess, useTempDir } from "../../utils/test-utils.ts"
import { doctorCommand } from "../doctor.ts"
import { autoCleanup } from "./cleanup.ts"
import { findCodexCleanupGroups } from "./cleanup-codex.ts"
import type { CodexProcess, CodexProcessRuntime } from "./cleanup-codex-processes.ts"

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

const idleRuntime: CodexProcessRuntime = {
  inspect: async () => [],
  quitApps: async () => {},
  terminate: async () => {},
  wait: async () => {},
}

const runningCodex = [{ pid: 12345, executable: "/Applications/Codex.app/Contents/MacOS/Codex" }]

async function oldTask(home: string, sessionId: string): Promise<string> {
  const path = join(home, ".claude", "tasks", sessionId, "1.json")
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify({ id: "1", status: "completed" }))
  await utimes(path, OLD / 1000, OLD / 1000)
  return path
}

function clean(home: string, args: string[] = [], runtime = idleRuntime) {
  return runCommandInProcess(doctorCommand, ["clean", ...args], {
    cwd: home,
    env: { HOME: home },
    commandOptions: { codexCleanupRuntime: runtime },
  })
}

async function cleanWithTrash(
  home: string,
  args: string[],
  env: Record<string, string>,
  script?: string
) {
  // Set PATH at process startup so Bun resolves the fixture executable rather
  // than reusing the test runner's cached lookup of the system trash command.
  const proc = Bun.spawn(
    [
      process.execPath,
      ...(script
        ? ["-e", script]
        : [
            join(import.meta.dir, "../../../index.ts"),
            "doctor",
            "clean",
            "--older-than=48h",
            ...args,
          ]),
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
  test.each([
    { args: [] },
    { args: ["--older-than=1h"] },
  ])("removes all archived codex chats regardless of age with %j", async ({ args }) => {
    const home = await tmp.create()
    const old = await rollout(home, true, OLD)
    const young = await rollout(home, true, NOW - 36 * HOUR_MS)
    const unarchived = await rollout(home, false, NOW - 60 * 24 * HOUR_MS)
    const task = await oldTask(home, unarchived.id)

    const result = await clean(home, [...args, "--skip-trash", "--task-older-than=1h"])
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(old.path).exists()).toBe(false)
    expect(await Bun.file(young.path).exists()).toBe(false)
    expect(await Bun.file(unarchived.path).text()).toBe(unarchived.original)
    expect(await Bun.file(task).exists()).toBe(true)
  })

  test("removes all archived chats even with longer --older-than without touching unarchived sessions", async () => {
    const home = await tmp.create()
    const old = await rollout(home, true, NOW - 8 * 24 * HOUR_MS)
    const youngArchived = await rollout(home, true, OLD)
    const unarchived = await rollout(home, false, NOW - 8 * 24 * HOUR_MS)
    const result = await clean(home, ["--older-than", "7d", "--skip-trash"])
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(old.path).exists()).toBe(false)
    expect(await Bun.file(youngArchived.path).exists()).toBe(false)
    expect(await Bun.file(unarchived.path).text()).toBe(unarchived.original)
  })

  test("automatic cleanup protects unarchived sessions and removes archives when idle", async () => {
    const home = await tmp.create()
    const files = [await rollout(home, false, OLD), await rollout(home, true, NOW - 36 * HOUR_MS)]
    const task = await oldTask(home, files[0]!.id)
    const trash = join(home, "fixture-trash")
    const bin = join(home, "bin")
    await mkdir(trash)
    await mkdir(bin)
    await Bun.write(join(bin, "trash"), '#!/bin/sh\nexec /bin/mv "$1" "$SWIZ_TEST_TRASH_DIR/"\n')
    await chmod(join(bin, "trash"), 0o755)
    const result = await cleanWithTrash(
      home,
      [],
      { PATH: `${bin}:${process.env.PATH}`, SWIZ_TEST_TRASH_DIR: trash },
      `import { autoCleanup } from ${JSON.stringify(join(import.meta.dir, "cleanup.ts"))};
      let inspections = 0;
      await autoCleanup({
        inspect: async () => { inspections++; return []; },
        quitApps: async () => {}, terminate: async () => {}, wait: async () => {},
      });
      console.log("inspection-count=" + inspections);`
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("inspection-count=2")
    expect(result.stdout).not.toContain("could not be trashed")
    expect(await Bun.file(files[0]!.path).text()).toBe(files[0]!.original)
    expect(await Bun.file(files[1]!.path).exists()).toBe(false)
    expect(await Bun.file(join(trash, basename(files[1]!.path))).text()).toBe(files[1]!.original)
    expect(await Bun.file(task).exists()).toBe(true)
  })

  test("retains every unarchived rollout and marks all archived files as old", async () => {
    const home = await tmp.create()
    const old = await rollout(home, false, OLD)
    const recent = await rollout(home, false, RECENT)
    const boundary = await rollout(home, false, CUTOFF)
    const archived = await rollout(home, true, OLD)
    const archiveBoundary = await rollout(home, true, CUTOFF)
    const archiveRecent = await rollout(home, true, RECENT)
    const groups = await findCodexCleanupGroups(home)
    const sessions = groups.find((group) => group.name === "(codex sessions)")!
    const archives = groups.find((group) => group.name === "(codex archived sessions)")!

    expect(sessions.old).toEqual([])
    expect(sessions.keep.map((session) => session.sessionId).sort()).toEqual(
      [old.id, recent.id, boundary.id].sort()
    )
    expect(archives.keep).toEqual([])
    expect(archives.old.map((session) => session.sessionId).sort()).toEqual(
      [archived.id, archiveBoundary.id, archiveRecent.id].sort()
    )
    expect(archives.old.find((s) => s.sessionId === archived.id)!.paths).toEqual([archived.path])
    expect(archives.old.find((s) => s.sessionId === archived.id)!.sizeBytes).toBe(
      Bun.file(archived.path).size
    )
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
    ".codex/archived_sessions",
    "archive-file",
    "file",
  ])("does not follow symlinks at %s", async (depth) => {
    const home = await tmp.create()
    const external = await tmp.create()
    const old = await rollout(external, depth.includes("archive"), OLD)
    const relative = depth.endsWith("file") ? old.path.slice(external.length + 1) : depth
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
    expect(result.stdout).toMatch(/\(codex sessions\).*2 skipped.*0 trashable/)
    expect(result.stdout).toMatch(/\(codex archived sessions\).*0 kept.*1 trashable/)
    expect(result.stdout).toMatch(/Total: .*1 sessions/)
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

  test.each([false, true])("removes all archives (skip Trash: %s)", async (skipTrash) => {
    const home = await tmp.create()
    const old = await rollout(home, false, OLD)
    const archived = await rollout(home, true, RECENT)
    const recent = await rollout(home, false, RECENT)
    const trash = join(home, "fixture-trash")
    const bin = join(home, "bin")
    await mkdir(trash)
    await mkdir(bin)
    await Bun.write(join(bin, "trash"), '#!/bin/sh\nexec /bin/mv "$1" "$SWIZ_TEST_TRASH_DIR/"\n')
    await chmod(join(bin, "trash"), 0o755)
    await Bun.write(join(bin, "ps"), '#!/bin/sh\nprintf "999 /usr/bin/bun\\n"\n')
    await chmod(join(bin, "ps"), 0o755)
    const result = await cleanWithTrash(home, skipTrash ? ["--skip-trash"] : [], {
      PATH: `${bin}:${process.env.PATH}`,
      SWIZ_TEST_TRASH_DIR: trash,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("1 session(s)")
    expect(result.stdout).toContain(skipTrash ? "deleted" : "moved to Trash")
    expect(result.stdout).not.toContain("could not be trashed")
    expect(await Bun.file(archived.path).exists()).toBe(false)
    expect(await Bun.file(join(trash, basename(archived.path))).exists()).toBe(!skipTrash)
    expect(await Bun.file(old.path).text()).toBe(old.original)
    expect(await Bun.file(`${old.path}.bak`).exists()).toBe(false)
    expect(await Bun.file(recent.path).text()).toBe(recent.original)
    expect(await Bun.file(`${recent.path}.bak`).exists()).toBe(false)

    // Exercise the nothing-to-trash branch too: old metadata must still survive.
    const repeated = await clean(home)
    expect(repeated.exitCode).toBe(0)
    expect(repeated.stdout).not.toContain("Truncated")
    expect(await Bun.file(recent.path).text()).toBe(recent.original)
  })
})

describe("Codex cleanup process guard", () => {
  test("protects tasks of retained unarchived rollouts while idle", async () => {
    const home = await tmp.create()
    const file = await rollout(home, false, OLD)
    const task = await oldTask(home, file.id)
    const result = await clean(home, ["--skip-trash", "--task-older-than=48h"])
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(task).exists()).toBe(true)
    expect(await Bun.file(file.path).text()).toBe(file.original)
  })

  test("removes archived rollouts and deletes old tasks when idle", async () => {
    const home = await tmp.create()
    const file = await rollout(home, true, RECENT)
    const task = await oldTask(home, file.id)
    const result = await clean(home, ["--skip-trash", "--task-older-than=48h"])
    expect(result.exitCode).toBe(0)
    expect(await Bun.file(task).exists()).toBe(false)
    expect(await Bun.file(file.path).exists()).toBe(false)
  })

  test("force does not stop Codex when it has no eligible files", async () => {
    const home = await tmp.create()
    const file = await rollout(home, false, OLD)
    const task = await oldTask(home, file.id)
    const inspect = mock(async () => runningCodex)
    const runtime = { ...idleRuntime, inspect }
    const result = await clean(home, ["--force", "--task-older-than=48h"], runtime)
    expect(result.exitCode).toBe(0)
    expect(inspect).not.toHaveBeenCalled()
    expect(await Bun.file(file.path).text()).toBe(file.original)
    expect(await Bun.file(task).exists()).toBe(true)
  })

  test("skips both Codex stores while other provider cleanup continues", async () => {
    const home = await tmp.create()
    const files = [await rollout(home, false, OLD), await rollout(home, true, OLD)]
    const task = await oldTask(home, files[0]!.id)
    const backup = join(home, ".gemini", "settings.json.bak")
    await mkdir(dirname(backup), { recursive: true })
    await Bun.write(backup, "old backup")
    const quitApps = mock(async () => {})
    const runtime = { ...idleRuntime, inspect: async () => runningCodex, quitApps }

    const result = await clean(home, ["--skip-trash", "--task-older-than=48h"], runtime)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Skipping Codex cleanup: Codex is running")
    expect(quitApps).not.toHaveBeenCalled()
    for (const file of files) expect(await Bun.file(file.path).text()).toBe(file.original)
    expect(await Bun.file(backup).exists()).toBe(false)
    expect(await Bun.file(task).exists()).toBe(true)
  })

  test("force dry-run previews without stopping processes or touching files", async () => {
    const home = await tmp.create()
    const file = await rollout(home, true, OLD)
    const quitApps = mock(async () => {})
    const terminate = mock(async () => {})
    const runtime = { ...idleRuntime, inspect: async () => runningCodex, quitApps, terminate }

    const result = await clean(home, ["--force", "--dry-run"], runtime)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("would quit Codex")
    expect(result.stdout).toMatch(/Total: .*1 sessions/)
    expect(quitApps).not.toHaveBeenCalled()
    expect(terminate).not.toHaveBeenCalled()
    expect(await Bun.file(file.path).text()).toBe(file.original)
  })

  test("force rescans flushed rollouts after quitting and before deleting", async () => {
    const home = await tmp.create()
    const flushed = await rollout(home, true, OLD)
    const old = await rollout(home, true, OLD)
    const unarchived = await rollout(home, false, OLD)
    const task = await oldTask(home, unarchived.id)
    const unarchivedFlushedPath = join(home, ".codex", ...SESSION_DIR, basename(flushed.path))
    let running = true
    const quitApps = mock(async () => {
      await mkdir(dirname(unarchivedFlushedPath), { recursive: true })
      await rename(flushed.path, unarchivedFlushedPath)
      running = false
    })
    const terminate = mock(async () => {})
    const runtime = {
      ...idleRuntime,
      inspect: async () => (running ? runningCodex : []),
      quitApps,
      terminate,
    }

    const result = await clean(home, ["--force", "--skip-trash", "--task-older-than=1h"], runtime)
    expect(result.exitCode).toBe(0)
    expect(quitApps).toHaveBeenCalledTimes(1)
    expect(terminate).not.toHaveBeenCalled()
    expect(await Bun.file(unarchivedFlushedPath).text()).toBe(flushed.original)
    expect(await Bun.file(old.path).exists()).toBe(false)
    expect(await Bun.file(unarchived.path).text()).toBe(unarchived.original)
    expect(await Bun.file(task).exists()).toBe(true)
  })

  test("force retains files when Codex will not stop", async () => {
    const home = await tmp.create()
    const file = await rollout(home, true, OLD)
    const terminate = mock(async (_processes: CodexProcess[], _signal: "TERM" | "KILL") => {})
    const runtime = { ...idleRuntime, inspect: async () => runningCodex, terminate }

    const result = await clean(home, ["--force", "--skip-trash"], runtime)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Codex processes are still running")
    expect(terminate.mock.calls).toEqual([
      [runningCodex, "TERM"],
      [runningCodex, "KILL"],
    ])
    expect(await Bun.file(file.path).text()).toBe(file.original)
  })

  test("a process started after discovery prevents deletion", async () => {
    const home = await tmp.create()
    const file = await rollout(home, true, OLD)
    const task = await oldTask(home, file.id)
    let checks = 0
    const runtime = { ...idleRuntime, inspect: async () => (++checks === 1 ? [] : runningCodex) }

    const result = await clean(home, ["--skip-trash", "--task-older-than=48h"], runtime)
    expect(result.exitCode).toBe(0)
    expect(checks).toBe(2)
    expect(result.stdout).toContain("Skipping Codex cleanup")
    expect(result.stdout).toContain("0 session(s)")
    expect(await Bun.file(file.path).text()).toBe(file.original)
    expect(await Bun.file(task).exists()).toBe(true)
  })

  test("unavailable process inspection fails closed even with force", async () => {
    const home = await tmp.create()
    const file = await rollout(home, true, OLD)
    const quitApps = mock(async () => {})
    const runtime = {
      ...idleRuntime,
      inspect: async () => {
        throw new Error("ps denied")
      },
      quitApps,
    }

    const result = await clean(home, ["--force", "--skip-trash"], runtime)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("process inspection failed")
    expect(result.stdout).toContain("No sessions selected for cleanup")
    expect(quitApps).not.toHaveBeenCalled()
    expect(await Bun.file(file.path).text()).toBe(file.original)
  })

  test("automatic doctor cleanup never stops active Codex", async () => {
    const home = await tmp.create()
    const file = await rollout(home, true, OLD)
    const quitApps = mock(async () => {})
    const runtime = { ...idleRuntime, inspect: async () => runningCodex, quitApps }
    const result = await runCommandInProcess(
      {
        name: "auto-cleanup",
        description: "Test automatic cleanup",
        run: () => autoCleanup(runtime),
      },
      [],
      { cwd: home, env: { HOME: home } }
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Skipping Codex cleanup")
    expect(quitApps).not.toHaveBeenCalled()
    expect(await Bun.file(file.path).text()).toBe(file.original)
  })
})
