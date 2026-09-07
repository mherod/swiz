import { describe, expect, test } from "bun:test"
import { mkdir, symlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { runCommandInProcess, useTempDir } from "../../utils/test-utils.ts"
import { doctorCommand } from "../doctor.ts"
import { truncateJsonlFile } from "./cleanup.ts"

const tmp = useTempDir("swiz-cleanup-truncation-")
const DAY_MS = 24 * 60 * 60 * 1000
const cutoffMs = Date.now() - 7 * DAY_MS
const old = new Date(cutoffMs - 7 * DAY_MS).toISOString()
const recent = new Date().toISOString()
const transcriptParts = [".system_generated", "logs", "transcript.jsonl"]
const antigravityLine = JSON.stringify({
  step_index: 0,
  source: "USER_EXPLICIT",
  type: "USER_INPUT",
  status: "DONE",
  created_at: old,
  content: "old message",
})

function clean(home: string, ...args: string[]) {
  return runCommandInProcess(doctorCommand, ["clean", "--older-than=7d", ...args], {
    cwd: home,
    env: { HOME: home },
  })
}

describe("retained transcript truncation (#828)", () => {
  test("uses the first valid date and retains malformed or undated records", async () => {
    const file = join(await tmp.create(), "transcript.jsonl")
    const removed = [
      antigravityLine,
      JSON.stringify({ timestamp: old, created_at: recent }),
      JSON.stringify({ timestamp: "invalid", created_at: old }),
      JSON.stringify({ timestamp: 17, created_at: old }),
    ]
    const kept = [
      JSON.stringify({ timestamp: recent, created_at: old }),
      JSON.stringify({ timestamp: recent }),
      JSON.stringify({ created_at: recent }),
      JSON.stringify({ created_at: "invalid" }),
      JSON.stringify({ timestamp: 17 }),
      JSON.stringify({ timestamp: new Date(cutoffMs).toISOString() }),
      JSON.stringify({ type: "metadata" }),
      "{broken-json",
      "null",
      "[]",
      "",
    ]
    const original = [...removed, ...kept].join("\n")
    await Bun.write(file, original)

    // The previous timestamp-only parser sees no date on this provider's record.
    expect(JSON.parse(antigravityLine).timestamp ?? null).toBeNull()
    expect(await truncateJsonlFile(file, cutoffMs)).toBe(removed.length)
    expect(await Bun.file(file).text()).toBe(kept.join("\n"))
    expect(await Bun.file(`${file}.bak`).text()).toBe(original)
    expect(await truncateJsonlFile(file, cutoffMs)).toBe(0)
    expect(await Bun.file(`${file}.bak`).text()).toBe(original)
  })

  test.each([false, true])("cleans only known text paths (skip backup: %s)", async (skipBackup) => {
    const home = await tmp.create()
    const root = join(home, ".gemini", "antigravity-cli")
    const session = join(root, "brain", crypto.randomUUID())
    const nested = join(session, ...transcriptParts)
    const topLevel = join(session, "session.jsonl")
    const untouched = [
      join(session, "artifacts", "other.jsonl"),
      join(session, ".system_generated", "logs", "other.jsonl"),
      join(session, "task.md"),
      join(root, "conversations", `${session.split("/").at(-1)}.pb`),
    ]
    const retained = `${JSON.stringify({ created_at: recent })}\n{malformed\n`
    const original = `${antigravityLine}\n${retained}`
    for (const path of [nested, topLevel, ...untouched]) {
      await mkdir(dirname(path), { recursive: true })
      await Bun.write(path, original)
    }

    const preview = await clean(home, "--dry-run")
    expect(preview.exitCode).toBe(0)
    expect(await Bun.file(nested).text()).toBe(original)
    expect(await Bun.file(`${nested}.bak`).exists()).toBe(false)

    const result = await clean(home, ...(skipBackup ? ["--skip-trash"] : []))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Truncated 2 old line(s) from 2 transcript(s).")
    for (const path of [nested, topLevel]) {
      expect(await Bun.file(path).text()).toBe(retained)
      expect(await Bun.file(`${path}.bak`).exists()).toBe(!skipBackup)
      if (!skipBackup) expect(await Bun.file(`${path}.bak`).text()).toBe(original)
    }
    for (const path of untouched) expect(await Bun.file(path).text()).toBe(original)

    const repeated = await clean(home, ...(skipBackup ? ["--skip-trash"] : []))
    expect(repeated.exitCode).toBe(0)
    expect(repeated.stdout).not.toContain("Truncated")
    if (!skipBackup) expect(await Bun.file(`${nested}.bak`).text()).toBe(original)
  })

  test.each([0, 1, 2, 3])("does not follow a symlink at nested path depth %s", async (depth) => {
    const home = await tmp.create()
    const session = join(home, ".gemini", "antigravity-cli", "brain", crypto.randomUUID())
    const external = join(home, "outside")
    const externalFile = join(external, ...transcriptParts)
    const original = `${antigravityLine}\n`
    await mkdir(dirname(externalFile), { recursive: true })
    await Bun.write(externalFile, original)
    const link = join(session, ...transcriptParts.slice(0, depth))
    await mkdir(dirname(link), { recursive: true })
    await symlink(join(external, ...transcriptParts.slice(0, depth)), link)

    const result = await clean(home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("Truncated")
    expect(await Bun.file(externalFile).text()).toBe(original)
    expect(await Bun.file(`${externalFile}.bak`).exists()).toBe(false)
  })

  test("does not truncate a top-level symlink", async () => {
    const home = await tmp.create()
    const session = join(home, ".gemini", "antigravity-cli", "brain", crypto.randomUUID())
    const external = join(home, "outside.jsonl")
    const original = `${JSON.stringify({ timestamp: old })}\n`
    await mkdir(session, { recursive: true })
    await Bun.write(external, original)
    await symlink(external, join(session, "session.jsonl"))

    const result = await clean(home)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("Truncated")
    expect(await Bun.file(external).text()).toBe(original)
    expect(await Bun.file(`${external}.bak`).exists()).toBe(false)
  })
})
