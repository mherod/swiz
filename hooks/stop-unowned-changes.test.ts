import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyDisowns, readDisownedPaths } from "../src/utils/session-file-disowns.ts"
import { buildUnownedChangesReason, parseDirtyFiles } from "./stop-unowned-changes.ts"

// PROCESS_CONTRACT_TEST: verifies the stop hook's block/allow stdout from real git state and a transcript at the executable boundary.
const hookPath = join(process.cwd(), "hooks", "stop-unowned-changes.ts")
const tempDirs: string[] = []

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

function transcriptLine(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name, input }] },
  })
}

async function run(cmd: string[], cwd: string, env?: Record<string, string>) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env })
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return stdout
}

describe("parseDirtyFiles", () => {
  test("reads modified, untracked, unmerged and renamed entries", () => {
    const porcelain = [
      "1 .M N... 100644 100644 100644 abc abc src/a file.ts",
      "? new.ts",
      "u UU N... 100644 100644 100644 100644 a b c conflict.ts",
      "2 R. N... 100644 100644 100644 abc abc R100 renamed.ts",
      "old-name.ts",
      "",
    ].join("\0")
    expect(parseDirtyFiles(porcelain)).toEqual([
      "src/a file.ts",
      "new.ts",
      "conflict.ts",
      "renamed.ts",
    ])
  })
})

describe("buildUnownedChangesReason", () => {
  test("names both explicit resolutions with the session id", () => {
    const reason = buildUnownedChangesReason(["a.ts"], "session-1")
    expect(reason).toContain('action: "claim", sessionId: "session-1"')
    expect(reason).toContain('action: "disown", sessionId: "session-1"')
    expect(reason).toContain("  - a.ts")
  })
})

describe("disowns", () => {
  test("reads only FileOwnership disown calls from the transcript", async () => {
    const dir = await tempDir("swiz-disown-")
    const transcript = join(dir, "t.jsonl")
    await Bun.write(
      transcript,
      [
        transcriptLine("mcp__swiz__FileOwnership", { action: "disown", paths: ["a.ts"] }),
        transcriptLine("mcp__swiz__FileOwnership", { action: "claim", paths: ["b.ts"] }),
        transcriptLine("Bash", { command: "echo disown c.ts FileOwnership" }),
        "not json",
      ].join("\n")
    )
    expect([...(await readDisownedPaths(transcript, dir))]).toEqual([join(dir, "a.ts")])
  })

  test("moves only unattributed disowned files, expanding untracked directories", async () => {
    const dir = await tempDir("swiz-disown-")
    const disowned = new Set([join(dir, "x.ts"), join(dir, "mine.ts"), join(dir, "new/one.ts")])
    const result = await applyDisowns(
      { editedByUs: ["mine.ts"], editedByOthers: [], unattributed: ["x.ts", "y.ts", "new/"] },
      { gitRoot: dir, disowned, expandDirectory: () => Promise.resolve(["new/one.ts"]) }
    )
    expect(result).toEqual({
      editedByUs: ["mine.ts"],
      editedByOthers: ["x.ts", "new/"],
      unattributed: ["y.ts"],
    })
  })
})

describe("stop-unowned-changes hook", () => {
  test("blocks on an unowned file, then allows once it is disowned", async () => {
    const home = await tempDir("swiz-unowned-home-")
    const repo = join(home, "repo")
    await mkdir(repo)
    await run(["git", "init", "-q"], repo)
    await Bun.write(join(repo, "stray.ts"), "export {}\n")
    const transcript = join(home, "t.jsonl")
    await Bun.write(transcript, "")
    const env = { ...process.env, HOME: home, SWIZ_DIRECT: "1" }
    const payload = { session_id: "unowned-session", cwd: repo, transcript_path: transcript }

    const blocked = await runHook(payload, repo, env)
    expect(blocked.decision).toBe("block")
    expect(blocked.reason).toContain("stray.ts")

    await Bun.write(
      transcript,
      transcriptLine("mcp__swiz__FileOwnership", {
        action: "disown",
        sessionId: "unowned-session",
        paths: ["stray.ts"],
      })
    )
    const allowed = await runHook(payload, repo, env)
    expect(allowed.decision).toBeUndefined()
  }, 30_000)
})

async function runHook(
  payload: Record<string, unknown>,
  cwd: string,
  env: Record<string, string | undefined>
): Promise<{ decision?: string; reason?: string }> {
  const proc = Bun.spawn(["bun", hookPath], {
    cwd,
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return stdout.trim() ? JSON.parse(stdout.trim()) : {}
}
