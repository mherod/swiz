import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { groupMatches } from "../src/dispatch/engine.ts"
import { getIssueStore, resetIssueStore } from "../src/issue-store.ts"
import { bundledHookManifest, hookIdentifier } from "../src/manifest.ts"
import { canonicalClaimPath, fileClaimProjectKey } from "../src/session-file-claims.ts"
import { evaluatePosttooluseSessionEdits as observeAfter } from "./posttooluse-session-edits.ts"
import { evaluatePretooluseSessionEdits as observeBefore } from "./pretooluse-session-edits.ts"

const dirs: string[] = []
afterEach(async () => {
  resetIssueStore()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(toolName = "functions.exec") {
  const dir = await mkdtemp(join(tmpdir(), "swiz-edit-observation-"))
  dirs.push(dir)
  const cwd = canonicalClaimPath(join(dir, "repo"))
  const proc = Bun.spawn(["git", "init", "-q", cwd], { stdout: "pipe", stderr: "pipe" })
  await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  expect(proc.exitCode).toBe(0)
  resetIssueStore()
  const store = getIssueStore(join(dir, "issues.db"))
  const input = {
    cwd,
    session_id: "owner",
    tool_use_id: crypto.randomUUID(),
    tool_name: toolName,
    tool_input: { code: "const dynamic = await getPath(); await tools.apply_patch(dynamic)" },
  }
  const paths = () =>
    store
      .listSessionEdits(fileClaimProjectKey(cwd), "owner")
      .map((row) => row.file_path)
      .sort()
  return { cwd, store, input, paths }
}

describe("session edit observation", () => {
  test("observes a real shell subprocess with dynamically computed output paths", async () => {
    const { cwd, input, paths } = await fixture("exec_command")
    await observeBefore(input)
    const proc = Bun.spawn(
      [process.execPath, "-e", 'await Bun.write(["generated", "ts"].join("."), "written")'],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    await observeAfter({ ...input, tool_response: { exit_code: proc.exitCode } })
    expect(paths()).toEqual([join(cwd, "generated.ts")])
  })

  test("survives a store restart between pre and post events", async () => {
    const { cwd, input } = await fixture()
    await observeBefore(input)
    resetIssueStore()
    const reopened = getIssueStore(join(cwd, "..", "issues.db"))
    await Bun.write(join(cwd, "persisted.ts"), "change")
    await observeAfter(input)
    expect(reopened.listSessionEdits(fileClaimProjectKey(cwd), "owner")[0]?.file_path).toBe(
      join(cwd, "persisted.ts")
    )
  })

  test("observes explicit ignored edit targets", async () => {
    const { cwd, input, paths } = await fixture("apply_patch")
    await Bun.write(join(cwd, ".gitignore"), "ignored.ts\n")
    const call = {
      ...input,
      tool_input: { patch: "*** Begin Patch\n*** Add File: ignored.ts\n+x\n*** End Patch" },
    }
    await observeBefore(call)
    await Bun.write(join(cwd, "ignored.ts"), "x")
    await observeAfter(call)
    expect(paths()).toEqual([join(cwd, "ignored.ts")])
  })

  test("does not misread newly ignored files as deleted", async () => {
    const { cwd, input, paths } = await fixture()
    await Bun.write(join(cwd, "unchanged.ts"), "old")
    await observeBefore(input)
    await Bun.write(join(cwd, ".gitignore"), "unchanged.ts\n")
    await observeAfter(input)
    expect(paths()).toEqual([join(cwd, ".gitignore")])
  })

  test("failed direct edits without a pre-hook do not create ownership", async () => {
    const { input, paths } = await fixture("apply_patch")
    await observeAfter({
      ...input,
      hook_event_name: "PostToolUseFailure",
      tool_input: { command: "*** Update File: unchanged.ts" },
    })
    expect(paths()).toEqual([])
  })

  test("a missing pre-hook is explicitly uncertain", async () => {
    const { input, paths } = await fixture()
    expect(JSON.stringify(await observeAfter(input))).toContain("uncertain")
    expect(paths()).toEqual([])
  })

  test("a failed post snapshot closes its interval without fabricating deletions", async () => {
    const { cwd, input, store, paths } = await fixture()
    await Bun.write(join(cwd, "existing.ts"), "unchanged")
    await observeBefore(input)
    await rm(join(cwd, ".git"), { recursive: true, force: true })
    expect(JSON.stringify(await observeAfter(input))).toContain("uncertain")
    expect(paths()).toEqual([])
    expect(
      store.editObservations.get(fileClaimProjectKey(cwd), "owner", input.tool_use_id)?.finished_at
    ).not.toBeNull()
  })
  test.each([
    "functions.exec",
    "exec",
    "functions.exec_command",
    "exec_command",
    "shell_command",
    "functions.apply_patch",
  ])("records actual changes through %s", async (tool) => {
    const { cwd, input, paths } = await fixture(tool)
    await Bun.write(join(cwd, "already-dirty.ts"), "peer work")
    expect(await observeBefore(input)).toEqual({})
    await Bun.write(join(cwd, "dynamic.ts"), "new content")
    expect(await observeAfter(input)).toEqual({})
    expect(paths()).toEqual([join(cwd, "dynamic.ts")])
  })

  test("records deletes and renames including paths with whitespace", async () => {
    const { cwd, input, paths } = await fixture()
    await Bun.write(join(cwd, "old name.ts"), "content")
    await Bun.write(join(cwd, "deleted.ts"), "deleted")
    await observeBefore(input)
    await Bun.write(join(cwd, "new name.ts"), await Bun.file(join(cwd, "old name.ts")).text())
    await Bun.file(join(cwd, "old name.ts")).delete()
    await Bun.file(join(cwd, "deleted.ts")).delete()
    await observeAfter(input)
    expect(paths()).toEqual(
      ["deleted.ts", "new name.ts", "old name.ts"].map((path) => join(cwd, path))
    )
  })

  test("does not turn failed or unexecuted wrapper text into ownership", async () => {
    const { cwd, input, paths } = await fixture()
    await Bun.write(join(cwd, "example.ts"), "unchanged")
    input.tool_input.code = 'if (false) await tools.apply_patch("*** Update File: example.ts")'
    await observeBefore(input)
    await observeAfter({ ...input, tool_response: { isError: true } })
    expect(paths()).toEqual([])
  })

  test("records partial shell writes even when the command fails", async () => {
    const { cwd, input, paths } = await fixture("exec_command")
    await observeBefore(input)
    await Bun.write(join(cwd, "partial.ts"), "written before failure")
    await observeAfter({ ...input, tool_response: { exit_code: 1 } })
    expect(paths()).toEqual([join(cwd, "partial.ts")])
  })

  test("refuses attribution for both overlapping sessions", async () => {
    const { cwd, input, store, paths } = await fixture()
    const peer = { ...input, session_id: "peer", tool_use_id: "peer-call" }
    await observeBefore(input)
    await observeBefore(peer)
    await Bun.write(join(cwd, "shared.ts"), "unknown writer")
    expect(JSON.stringify(await observeAfter(peer))).toContain("uncertain")
    expect(JSON.stringify(await observeAfter(input))).toContain("uncertain")
    expect(paths()).toEqual([])
    expect(store.listSessionEdits(fileClaimProjectKey(cwd), "peer")).toEqual([])
  })

  test("cancels a denied call so it cannot poison later ownership", async () => {
    const { cwd, input, paths } = await fixture()
    const controller = new AbortController()
    await observeBefore({ ...input, session_id: "denied" }, { signal: controller.signal })
    controller.abort()
    await observeBefore(input)
    await Bun.write(join(cwd, "allowed.ts"), "allowed")
    await observeAfter(input)
    expect(paths()).toEqual([join(cwd, "allowed.ts")])
  })

  test("retains the original baseline across a yielded code cell", async () => {
    const { cwd, input, paths } = await fixture()
    await observeBefore(input)
    await observeAfter({ ...input, tool_response: "Script running with cell ID cell-1" })
    await Bun.write(join(cwd, "between-polls.ts"), "written while yielded")
    const poll = {
      ...input,
      tool_name: "functions.wait",
      tool_use_id: "wait-1",
      tool_input: { cell_id: "cell-1" },
    }
    await observeBefore(poll)
    await observeAfter({ ...poll, tool_response: "Script completed" })
    expect(paths()).toEqual([join(cwd, "between-polls.ts")])
  })

  test("retains the original baseline across shell process polling", async () => {
    const { cwd, input, paths } = await fixture("exec_command")
    await observeBefore(input)
    await observeAfter({ ...input, tool_response: { session_id: 42 } })
    await Bun.write(join(cwd, "background.ts"), "written while yielded")
    const poll = {
      ...input,
      tool_name: "write_stdin",
      tool_use_id: "poll-1",
      tool_input: { session_id: 42, chars: "" },
    }
    await observeBefore(poll)
    await observeAfter({ ...poll, tool_response: { exit_code: 0 } })
    expect(paths()).toEqual([join(cwd, "background.ts")])
  })

  test("duplicate post events do not steal ownership back from a newer edit", async () => {
    const { cwd, input, store } = await fixture()
    await observeBefore(input)
    const path = join(cwd, "shared.ts")
    await Bun.write(path, "first")
    await observeAfter(input)
    const original = store.listSessionEdits(fileClaimProjectKey(cwd), "owner")[0]!.updated_at
    store.recordSessionEdit(fileClaimProjectKey(cwd), "peer", path, original + 100)
    await observeAfter(input)
    expect(store.listSessionEdits(fileClaimProjectKey(cwd), "owner")[0]!.updated_at).toBe(original)
  })

  test("manifest dispatch reaches both observers for all Codex mutation forms", () => {
    for (const tool of [
      "apply_patch",
      "functions.apply_patch",
      "exec_command",
      "functions.exec_command",
      "exec",
      "functions.exec",
      "write_stdin",
      "functions.wait",
    ]) {
      for (const event of ["preToolUse", "postToolUse"]) {
        const names = bundledHookManifest
          .filter((group) => group.event === event && groupMatches(group, tool, undefined))
          .flatMap((group) => group.hooks.map(hookIdentifier))
        expect(names).toContain(
          event === "preToolUse" ? "pretooluse-session-edits.ts" : "posttooluse-session-edits.ts"
        )
      }
    }
  })
})
