import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getIssueStore, resetIssueStore } from "../src/issue-store.ts"
import { fileClaimProjectKey } from "../src/session-file-claims.ts"
import { evaluatePosttooluseReadClaims, READ_CLAIM_LANE } from "./posttooluse-read-claims.ts"

const SESSION = "session-reader"
const PEER = "session-peer"

let repo: string

function run(args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
}

beforeEach(async () => {
  const base = join(tmpdir(), `swiz-read-claims-${crypto.randomUUID()}`)
  mkdirSync(join(base, "repo"), { recursive: true })
  repo = realpathSync(join(base, "repo"))
  resetIssueStore()
  getIssueStore(join(base, "test.db"))
  run(["init", "-q"])
  run(["config", "user.email", "test@example.invalid"])
  run(["config", "user.name", "Test"])
  run(["config", "commit.gpgsign", "false"])
  await Bun.write(join(repo, "clean.ts"), "export const a = 1\n")
  await Bun.write(join(repo, "dirty.ts"), "export const b = 1\n")
  run(["add", "."])
  run(["commit", "-q", "-m", "init"])
  await Bun.write(join(repo, "dirty.ts"), "export const b = 2\n")
})

afterEach(() => {
  resetIssueStore()
})

function claims() {
  return getIssueStore().fileClaims.list(fileClaimProjectKey(repo))
}

function read(toolName: string, toolInput: Record<string, unknown>, extra = {}) {
  return evaluatePosttooluseReadClaims({
    cwd: repo,
    session_id: SESSION,
    tool_name: toolName,
    tool_input: toolInput,
    ...extra,
  })
}

describe("posttooluse-read-claims", () => {
  test("claims a dirty unowned file read with the Read tool", async () => {
    const output = await read("Read", { file_path: join(repo, "dirty.ts") })
    expect(claims()).toEqual([
      expect.objectContaining({
        file_path: join(repo, "dirty.ts"),
        session_id: SESSION,
        lane: READ_CLAIM_LANE,
      }),
    ])
    expect(JSON.stringify(output)).toContain("dirty.ts")
  })

  test("claims dirty files viewed through shell commands", async () => {
    await Bun.write(join(repo, "new.ts"), "untracked\n")
    await read("Bash", { command: "sed -n 1,5p dirty.ts && cat new.ts clean.ts" })
    expect(claims().map((claim) => claim.file_path)).toEqual([
      join(repo, "dirty.ts"),
      join(repo, "new.ts"),
    ])
  })

  test("claims a file whose only change is staged", async () => {
    await Bun.write(join(repo, "clean.ts"), "export const a = 2\n")
    run(["add", "clean.ts"])
    await read("Read", { file_path: join(repo, "clean.ts") })
    expect(claims().map((claim) => claim.file_path)).toEqual([join(repo, "clean.ts")])
  })

  test("never claims a clean file", async () => {
    const output = await read("Read", { file_path: join(repo, "clean.ts") })
    expect(claims()).toEqual([])
    expect(output).toEqual({})
  })

  test("leaves a dirty file another session edited", async () => {
    getIssueStore().recordSessionEdit(fileClaimProjectKey(repo), PEER, join(repo, "dirty.ts"))
    await read("Read", { file_path: join(repo, "dirty.ts") })
    expect(claims()).toEqual([])
  })

  test("leaves a dirty file another session claimed", async () => {
    getIssueStore().fileClaims.mutate({
      projectKey: fileClaimProjectKey(repo),
      sessionId: PEER,
      paths: [join(repo, "dirty.ts")],
      action: "claim",
      leaseMs: 60_000,
    })
    await read("Read", { file_path: join(repo, "dirty.ts") })
    expect(claims()).toEqual([expect.objectContaining({ session_id: PEER })])
  })

  test("does not reclaim a file this session disowned", async () => {
    const transcript = join(repo, "..", "transcript.jsonl")
    const disown = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mcp__swiz__FileOwnership",
            input: { action: "disown", paths: ["dirty.ts"] },
          },
        ],
      },
    }
    await Bun.write(transcript, `${JSON.stringify(disown)}\n`)
    await read("Read", { file_path: join(repo, "dirty.ts") }, { transcript_path: transcript })
    expect(claims()).toEqual([])
  })

  test("ignores tools that read nothing", async () => {
    await read("Bash", { command: "git status" })
    expect(claims()).toEqual([])
  })
})
