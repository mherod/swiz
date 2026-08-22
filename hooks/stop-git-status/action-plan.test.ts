import { describe, expect, test } from "bun:test"
import type { SessionFileOwnership } from "../../src/utils/session-file-ownership.ts"
import { buildGitWorkflowSections } from "./action-plan.ts"

function planFor(opts: { ownership?: SessionFileOwnership | null; behind?: number }): string {
  const steps = buildGitWorkflowSections({
    summary: "s",
    hasUncommitted: true,
    hasRemote: true,
    behind: opts.behind ?? 0,
    ahead: 0,
    branch: "main",
    upstream: "origin/main",
    collabMode: "solo",
    trunkMode: true,
    defaultBranch: "main",
    ownership: opts.ownership,
  })
  return JSON.stringify(steps)
}

const PEER_OWNERSHIP: SessionFileOwnership = {
  editedByUs: ["mine.ts", "also-mine.ts"],
  editedByOthers: ["theirs.ts"],
  unattributed: ["unknown.ts"],
}

describe("buildGitWorkflowSections ownership gating (issue #841)", () => {
  test("control: without ownership data the solo plan still uses git add .", () => {
    const plan = planFor({ ownership: null })
    expect(plan).toContain("git add .")
  })

  test("control: an ownership snapshot with no peer edits keeps the solo plan", () => {
    const plan = planFor({
      ownership: { editedByUs: ["mine.ts"], editedByOthers: [], unattributed: ["unknown.ts"] },
    })
    expect(plan).toContain("git add .")
  })

  test("peer edits present: stages only session-owned paths, never the whole tree", () => {
    const plan = planFor({ ownership: PEER_OWNERSHIP })
    expect(plan).not.toContain("git add .")
    // Space-joined so the advice is copy-runnable — comma-joined prose would
    // glue pathspecs together ("mine.ts,").
    expect(plan).toContain("git add mine.ts also-mine.ts")
    expect(plan).toContain("Leave the peer session's files uncommitted: theirs.ts")
    expect(plan).toContain("another live session has edits in this checkout")
  })

  test("paths with whitespace are quoted in the staged-command advice", () => {
    const plan = planFor({
      ownership: {
        editedByUs: ["my file.ts", "plain.ts"],
        editedByOthers: ["theirs.ts"],
        unattributed: [],
      },
    })
    expect(plan).toContain('git add \\"my file.ts\\" plain.ts')
  })

  test("peer edits present: unattributed files get ownership guidance, not staging", () => {
    const plan = planFor({ ownership: PEER_OWNERSHIP })
    expect(plan).toContain("establish ownership")
    expect(plan).toContain("unknown.ts")
  })

  test("peer edits with nothing recorded to this session: no staging command at all", () => {
    const plan = planFor({
      ownership: { editedByUs: [], editedByOthers: ["theirs.ts"], unattributed: [] },
    })
    expect(plan).not.toContain("git add")
    expect(plan).toContain("do not stage anything yet")
  })

  test("pull step warns about autostash sweeping peer files when behind", () => {
    const plan = planFor({ ownership: PEER_OWNERSHIP, behind: 2 })
    expect(plan).toContain("--autostash would sweep their work")
    // Control: without peer edits the caution is absent.
    const solo = planFor({ ownership: null, behind: 2 })
    expect(solo).not.toContain("--autostash would sweep")
  })
})
