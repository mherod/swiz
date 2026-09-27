import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { evaluatePosttooluseSessionEdits } from "../../hooks/posttooluse-session-edits.ts"
import { evaluatePretooluseConcurrentSessionEdits } from "../../hooks/pretooluse-concurrent-session-edits.ts"
import { manageFileOwnership, renderFileOwnership } from "../file-ownership-tool.ts"
import { getIssueStore, resetIssueStore } from "../issue-store.ts"
import { runMcpTool } from "../mcp-tool-core.ts"
import { projectKeyFromCwd } from "../project-key.ts"
import { canonicalClaimPath, fileClaimProjectKey } from "../session-file-claims.ts"
import { resolveSessionFileOwnershipResult } from "../utils/session-file-ownership.ts"
import { acquireEnvLock, releaseEnvLockFn, runGit, useTempDir } from "../utils/test-utils.ts"

const tmp = useTempDir("swiz-file-history-")
let root: string
let alias: string
let base: string

beforeEach(async () => {
  await acquireEnvLock()
  base = canonicalClaimPath(await tmp.create())
  root = join(base, "repo")
  alias = join(base, "alias")
  mkdirSync(root)
  symlinkSync(root, alias)
  resetIssueStore()
  getIssueStore(join(base, "issues.db"))
})

afterEach(() => {
  resetIssueStore()
  releaseEnvLockFn()
})

test("new root and alias edits converge through the MCP tool and ownership readers", async () => {
  await runGit(root, ["init"])
  for (const [cwd, file] of [
    [root, "root.ts"],
    [alias, "alias.ts"],
  ] as const) {
    await Bun.write(join(cwd, file), "edit")
    await evaluatePosttooluseSessionEdits({
      cwd,
      session_id: "writer",
      tool_name: "Write",
      tool_input: { file_path: join(cwd, file) },
    })
  }
  const edits = getIssueStore().listSessionEdits(fileClaimProjectKey(root), "writer")
  expect(edits).toHaveLength(2)
  expect(edits.every((edit) => edit.file_path.startsWith(`${root}/`))).toBe(true)
  manageFileOwnership({ action: "claim", sessionId: "writer", paths: ["root.ts"] }, alias)
  const real = (await runMcpTool("FileOwnership", {}, root)).structuredContent?.fileOwnership
  const linked = (await runMcpTool("FileOwnership", {}, alias)).structuredContent?.fileOwnership
  expect(linked?.recentEdits).toEqual(real?.recentEdits)
  expect(linked?.claims).toEqual(real?.claims)
  expect(linked?.recentEdits).toHaveLength(2)
  manageFileOwnership({ action: "release", sessionId: "writer", paths: ["root.ts"] }, root)
  for (const cwd of [root, alias]) {
    expect(
      await resolveSessionFileOwnershipResult(cwd, "peer", ["root.ts", "alias.ts"])
    ).toMatchObject({ known: true, ownership: { editedByOthers: ["root.ts", "alias.ts"] } })
    expect(
      await evaluatePretooluseConcurrentSessionEdits({
        cwd,
        session_id: "peer",
        tool_name: "Edit",
        tool_input: { file_path: join(cwd, "alias.ts") },
      })
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } })
  }
})

test("preserves known legacy alias rows and discloses unknown alias coverage", () => {
  const store = getIssueStore()
  const record = (cwd: string, file: string) =>
    store.recordSessionEdit(projectKeyFromCwd(cwd), "writer", join(cwd, file), 1000)
  record(root, "canonical.ts")
  record(alias, "legacy.ts")
  const unknownAlias = join(base, "older-alias")
  symlinkSync(root, unknownAlias)
  record(unknownAlias, "older.ts")
  const linked = manageFileOwnership({}, alias, 1000)
  expect(linked.recentEdits.map((edit) => edit.file_path).sort()).toEqual([
    join(root, "canonical.ts"),
    join(root, "legacy.ts"),
  ])
  expect(manageFileOwnership({}, root, 1000).recentEdits).toHaveLength(1)
  expect(linked.historyWarnings.join(" ")).toContain("other directory aliases")
  expect(renderFileOwnership(linked)).toContain("other directory aliases")
  expect(manageFileOwnership({}, unknownAlias, 1000).recentEdits).toHaveLength(2)
  manageFileOwnership({ action: "release", sessionId: "writer", paths: ["legacy.ts"] }, alias, 1000)
  expect(store.listSessionEdits(projectKeyFromCwd(alias), "writer")).toHaveLength(1)
  expect(store.listSessionEdits(projectKeyFromCwd(unknownAlias), "writer")).toHaveLength(1)
})

test("does not merge sibling history even when legacy project keys collide", () => {
  const one = join(base, "repo.one")
  const two = join(base, "repo/one")
  mkdirSync(one)
  mkdirSync(two)
  expect(projectKeyFromCwd(one)).toBe(projectKeyFromCwd(two))
  const store = getIssueStore()
  store.recordSessionEdit(projectKeyFromCwd(one), "writer-a", join(one, "a.ts"), 1000)
  store.recordSessionEdit(projectKeyFromCwd(two), "writer-b", join(two, "b.ts"), 1000)
  expect(manageFileOwnership({}, one, 1000).recentEdits.map((edit) => edit.session_id)).toEqual([
    "writer-a",
  ])
  expect(manageFileOwnership({}, two, 1000).recentEdits.map((edit) => edit.session_id)).toEqual([
    "writer-b",
  ])
})

test("combines duplicate legacy evidence using the latest timestamp", () => {
  const store = getIssueStore()
  store.recordSessionEdit(projectKeyFromCwd(root), "writer", join(root, "same.ts"), 1000)
  store.recordSessionEdit(projectKeyFromCwd(alias), "writer", join(alias, "same.ts"), 2000)
  const result = manageFileOwnership({}, alias, 2000)
  expect(result.recentEdits).toEqual([
    { file_path: join(root, "same.ts"), session_id: "writer", updated_at: 2000 },
  ])
  expect(store.listSessionEdits(projectKeyFromCwd(root), "writer")).toHaveLength(1)
  expect(store.listSessionEdits(projectKeyFromCwd(alias), "writer")).toHaveLength(1)
})
