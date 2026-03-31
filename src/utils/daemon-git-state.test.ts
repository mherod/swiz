import { describe, expect, it } from "vitest"
import { parseDaemonGitStateRecord } from "./daemon-git-state.ts"

describe("parseDaemonGitStateRecord", () => {
  it("returns null without branch string", () => {
    expect(parseDaemonGitStateRecord({ staged: 1 })).toBeNull()
  })

  it("maps daemon fields to GitStatusV2", () => {
    const v = parseDaemonGitStateRecord({
      branch: "main",
      staged: 1,
      unstaged: 2,
      untracked: 3,
      upstream: "origin/main",
      upstreamGone: false,
      ahead: 4,
      behind: 5,
    })
    expect(v).toEqual({
      branch: "main",
      total: 6,
      modified: 3,
      added: 0,
      deleted: 0,
      untracked: 3,
      lines: [],
      ahead: 4,
      behind: 5,
      upstream: "origin/main",
      upstreamGone: false,
    })
  })

  it("treats missing numeric fields as zero", () => {
    const v = parseDaemonGitStateRecord({ branch: "x", upstream: null })
    expect(v?.total).toBe(0)
    expect(v?.ahead).toBe(0)
    expect(v?.upstream).toBeNull()
  })
})
