import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as gitHelpers from "../git-helpers.ts"
import * as transcriptUtils from "../transcript-utils.ts"
import * as gitUtils from "./git-utils.ts"
import { resolvePeerHeldFiles, resolveSessionFileOwnership } from "./session-file-ownership.ts"

const ownQuery = mock(() => [] as { file_path: string }[])
const peerQuery = mock(() => [] as { file_path: string }[])
const store = { isNoOp: false, listOtherSessionEdits: peerQuery }
beforeAll(() =>
  mock.module("../issue-store.ts", () => ({
    getIssueStore: () => store,
    getIssueStoreReader: () => ({ listSessionEdits: ownQuery }),
  }))
)
const status = spyOn(gitUtils, "getGitStatusV2")
const git = spyOn(gitHelpers, "git")
const projectKey = spyOn(transcriptUtils, "projectKeyFromCwd")

beforeEach(() => {
  store.isNoOp = false
  ownQuery.mockReset().mockReturnValue([])
  peerQuery.mockReset().mockReturnValue([])
  projectKey.mockReset().mockReturnValue("repo")
  git.mockReset().mockResolvedValue("/repo")
  status.mockReset().mockResolvedValue({
    branch: "main",
    total: 1,
    lines: ["file.ts"],
    added: 0,
    deleted: 0,
    modified: 1,
    untracked: 0,
    ahead: 0,
    behind: 0,
    upstream: null,
    upstreamGone: false,
  })
})
afterAll(() => mock.restore())

describe("ownership resolution certainty", () => {
  test("successful discovery with no peer records is known", async () => {
    expect(await resolvePeerHeldFiles("/repo", "self")).toEqual({ known: true, files: [] })
  })
  test("successful discovery reports positive peer evidence", async () => {
    peerQuery.mockReturnValue([{ file_path: "file.ts" }])
    expect(await resolvePeerHeldFiles("/repo", "self")).toEqual({ known: true, files: ["file.ts"] })
  })
  test("missing cwd never queries the daemon checkout", async () => {
    expect(await resolvePeerHeldFiles(undefined, "self")).toEqual({
      known: false,
      reason: "missing-cwd",
    })
    expect(status).not.toHaveBeenCalled()
  })
  test("missing session is unknown even before a clean status can be used", async () => {
    expect(await resolvePeerHeldFiles("/repo", undefined)).toEqual({
      known: false,
      reason: "missing-session",
    })
    expect(status).not.toHaveBeenCalled()
  })
  test("missing project identity is unknown", async () => {
    projectKey.mockReturnValue("")
    expect(await resolvePeerHeldFiles("/repo", "self")).toEqual({
      known: false,
      reason: "missing-project",
    })
  })
  test("failed git status is unknown", async () => {
    status.mockResolvedValue(null)
    expect(await resolvePeerHeldFiles("/repo", "self")).toEqual({
      known: false,
      reason: "git-status-unavailable",
    })
  })
  test("failed git root cannot silently use cwd for attribution", async () => {
    git.mockResolvedValue("")
    expect(await resolvePeerHeldFiles("/repo", "self")).toEqual({
      known: false,
      reason: "git-root-unavailable",
    })
  })
  test("store exceptions preserve unknown rather than implying no peers", async () => {
    peerQuery.mockImplementation(() => {
      throw new Error("unavailable")
    })
    expect(await resolvePeerHeldFiles("/repo", "self")).toEqual({
      known: false,
      reason: "query-failed",
    })
    expect(await resolveSessionFileOwnership("/repo", "self", ["file.ts"])).toEqual({
      editedByUs: [],
      editedByOthers: [],
      unattributed: ["file.ts"],
    })
  })
  test("a failed own-session query also preserves unknown", async () => {
    ownQuery.mockImplementation(() => {
      throw new Error("unavailable")
    })
    expect(await resolvePeerHeldFiles("/repo", "self")).toEqual({
      known: false,
      reason: "query-failed",
    })
  })
  test("the no-op store is unavailable even though it returns empty lists", async () => {
    store.isNoOp = true
    expect(await resolvePeerHeldFiles("/repo", "self")).toEqual({
      known: false,
      reason: "store-unavailable",
    })
  })
  test("a verified clean tree does not need an ownership store query", async () => {
    const clean = await status("/repo")
    if (!clean) throw new Error("status fixture unavailable")
    status.mockResolvedValue({ ...clean, total: 0, lines: [] })
    expect(await resolvePeerHeldFiles("/repo", "self")).toEqual({ known: true, files: [] })
    expect(peerQuery).not.toHaveBeenCalled()
  })
})
