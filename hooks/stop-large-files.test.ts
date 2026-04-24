/**
 * Unit tests for hooks/stop-large-files.ts.
 *
 * Pins the batching behaviour required by issue #510:
 *   AC1: `.gitattributes` is read exactly once per evaluator invocation
 *        (no per-file reads, no duplicate team-mode read)
 *   AC2: `git ls-tree` is called exactly once with all candidate files,
 *        regardless of how many candidates exist
 *   AC3: Existing file-flagging behaviour is preserved — same files flagged,
 *        same LFS check
 *   AC4: Total git subprocess spawns per invocation is bounded by 4
 *        (log + show + ls-tree + cat-file-batch), independent of file count
 *
 * The tests inject hook dependencies so the evaluator runs in-process without
 * touching the real filesystem or real git.
 */
import { beforeEach, describe, expect, test } from "bun:test"

// ─── Mock state ─────────────────────────────────────────────────────────────

interface GitCall {
  args: string[]
  cwd: string
}

const gitCalls: GitCall[] = []
let gitResponses: Record<string, string | null> = {}
let collaborationMode: "solo" | "team" = "solo"
let largeFileSizeKb = 500
let allowPatterns: string[] = []

// Key into gitResponses is the join of the args so the test can set canned
// output per call pattern (e.g. "ls-tree HEAD -- a b c").
function gitResponseKey(args: string[]): string {
  return args.join(" ")
}

const testDeps = {
  git: (args: string[], cwd: string): Promise<string> => {
    gitCalls.push({ args, cwd })
    const key = gitResponseKey(args)
    // Match on exact key first, then fall back to prefix matches so tests can
    // set one response for all "ls-tree HEAD -- *" calls regardless of files.
    if (key in gitResponses) return Promise.resolve(gitResponses[key] ?? "")
    for (const prefix of Object.keys(gitResponses)) {
      if (key.startsWith(prefix)) return Promise.resolve(gitResponses[prefix] ?? "")
    }
    return Promise.resolve("")
  },
  isGitRepo: (_cwd: string): Promise<boolean> => Promise.resolve(true),
  recentHeadRange: (_cwd: string, _n: number): Promise<string> => Promise.resolve("HEAD~10..HEAD"),
  blockStopObj: (reason: string) => ({ decision: "block", reason }),
  readSwizSettings: () => Promise.resolve({}),
  readProjectSettings: () => Promise.resolve({ largeFileAllowPatterns: allowPatterns }),
  getEffectiveSwizSettings: () => ({ collaborationMode }),
  resolveNumericSetting: (_cwd: string, _key: string, _fallback: number) =>
    Promise.resolve(largeFileSizeKb),
  spawn: (cmd: string[], _opts: unknown): unknown => {
    if (cmd[0] !== "git" || cmd[1] !== "cat-file" || cmd[2] !== "--batch") {
      throw new Error(`Unexpected spawn: ${cmd.join(" ")}`)
    }
    catFileSpawnCount++
    const output = catFileBatchStub
    return {
      stdin: {
        write: () => Promise.resolve(),
        end: () => undefined,
      },
      stdout: new Response(output).body,
      exited: Promise.resolve(0),
      exitCode: 0,
    }
  },
}

let catFileBatchStub: string = ""
let catFileSpawnCount = 0

beforeEach(() => {
  gitCalls.length = 0
  gitResponses = {}
  collaborationMode = "solo"
  largeFileSizeKb = 500
  allowPatterns = []
  catFileBatchStub = ""
  catFileSpawnCount = 0
})

const { evaluateStopLargeFiles } = await import("./stop-large-files.ts")

function evaluate(input: Parameters<typeof evaluateStopLargeFiles>[0]) {
  return evaluateStopLargeFiles(input, testDeps as any)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeBlobHash(seed: number): string {
  // 40-char hex hashes. Pad a numeric seed so each call gets a distinct hash.
  return seed.toString(16).padStart(40, "0")
}

function buildLsTreeOutput(entries: Array<{ name: string; hash: string }>): string {
  return entries.map((e) => `100644 blob ${e.hash}\t${e.name}`).join("\n")
}

function buildCatFileBatchOutput(entries: Array<{ hash: string; sizeBytes: number }>): string {
  // Format: `<hash> blob <size>\n<content bytes of size length>\n`
  // The evaluator only parses the header line; the body can be empty padding.
  return `${entries.map((e) => `${e.hash} blob ${e.sizeBytes}\n`).join("")}\n`
}

function countCalls(pattern: (call: GitCall) => boolean): number {
  return gitCalls.filter(pattern).length
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("evaluateStopLargeFiles", () => {
  test("AC3: flags a large non-LFS file", async () => {
    const bigHash = makeBlobHash(1)
    gitResponses["log --diff-filter=A --name-only --format= HEAD~10..HEAD"] = "big.bin\n"
    gitResponses["show HEAD:.gitattributes"] = ""
    gitResponses["ls-tree HEAD --"] = buildLsTreeOutput([{ name: "big.bin", hash: bigHash }])
    catFileBatchStub = buildCatFileBatchOutput([
      { hash: bigHash, sizeBytes: 600 * 1024 }, // 600 KB > 500 KB limit
    ])

    const result = (await evaluate({ cwd: "/repo" })) as {
      decision?: string
      reason?: string
    }

    expect(result.decision).toBe("block")
    expect(result.reason).toContain("big.bin")
    expect(result.reason).toContain("600KB")
  })

  test("AC3: ignores under-limit files", async () => {
    const smallHash = makeBlobHash(2)
    gitResponses["log --diff-filter=A --name-only --format= HEAD~10..HEAD"] = "small.bin\n"
    gitResponses["show HEAD:.gitattributes"] = ""
    gitResponses["ls-tree HEAD --"] = buildLsTreeOutput([{ name: "small.bin", hash: smallHash }])
    catFileBatchStub = buildCatFileBatchOutput([
      { hash: smallHash, sizeBytes: 10 * 1024 }, // 10 KB under 500 KB
    ])

    const result = await evaluate({ cwd: "/repo" })

    expect(result).toEqual({})
  })

  test("AC3: skips LFS-tracked files even when over limit", async () => {
    const lfsHash = makeBlobHash(3)
    gitResponses["log --diff-filter=A --name-only --format= HEAD~10..HEAD"] = "huge.psd\n"
    // isLfsTracked does a literal-name match against .gitattributes (see
    // hooks/stop-large-files.ts:53), so the test gitattributes must contain
    // the literal filename next to filter=lfs. Preserving this behaviour is
    // AC3's "same LFS check" guarantee.
    gitResponses["show HEAD:.gitattributes"] = "huge.psd filter=lfs -text\n"
    gitResponses["ls-tree HEAD --"] = buildLsTreeOutput([{ name: "huge.psd", hash: lfsHash }])
    catFileBatchStub = buildCatFileBatchOutput([
      { hash: lfsHash, sizeBytes: 5 * 1024 * 1024 }, // 5 MB, but LFS-tracked
    ])

    const result = await evaluate({ cwd: "/repo" })

    expect(result).toEqual({})
  })

  test("AC3: honors largeFileAllowPatterns", async () => {
    allowPatterns = ["fixtures/**"]
    const ignoredHash = makeBlobHash(4)
    gitResponses["log --diff-filter=A --name-only --format= HEAD~10..HEAD"] = "fixtures/large.bin\n"
    gitResponses["show HEAD:.gitattributes"] = ""
    gitResponses["ls-tree HEAD --"] = buildLsTreeOutput([
      { name: "fixtures/large.bin", hash: ignoredHash },
    ])
    catFileBatchStub = buildCatFileBatchOutput([{ hash: ignoredHash, sizeBytes: 5 * 1024 * 1024 }])

    const result = await evaluate({ cwd: "/repo" })

    expect(result).toEqual({})
  })

  test("AC3: no-op when no files were added in recent history", async () => {
    gitResponses["log --diff-filter=A --name-only --format= HEAD~10..HEAD"] = null
    gitResponses["show HEAD:.gitattributes"] = ""

    const result = await evaluate({ cwd: "/repo" })

    expect(result).toEqual({})
  })

  test("AC3: team mode exits early when .gitattributes has no LFS filter", async () => {
    collaborationMode = "team"
    gitResponses["show HEAD:.gitattributes"] = "# no lfs here\n"
    gitResponses["log --diff-filter=A --name-only --format= HEAD~10..HEAD"] = "big.bin\n"

    const result = await evaluate({ cwd: "/repo" })

    expect(result).toEqual({})
    // Team mode still read .gitattributes — but only once.
    expect(countCalls((c) => c.args[0] === "show" && c.args[1] === "HEAD:.gitattributes")).toBe(1)
  })

  test("AC1: .gitattributes is read exactly once per invocation (solo mode)", async () => {
    gitResponses["log --diff-filter=A --name-only --format= HEAD~10..HEAD"] =
      "a.bin\nb.bin\nc.bin\n"
    gitResponses["show HEAD:.gitattributes"] = "*.bin filter=lfs\n"
    gitResponses["ls-tree HEAD --"] = buildLsTreeOutput([
      { name: "a.bin", hash: makeBlobHash(10) },
      { name: "b.bin", hash: makeBlobHash(11) },
      { name: "c.bin", hash: makeBlobHash(12) },
    ])
    catFileBatchStub = buildCatFileBatchOutput([
      { hash: makeBlobHash(10), sizeBytes: 600 * 1024 },
      { hash: makeBlobHash(11), sizeBytes: 700 * 1024 },
      { hash: makeBlobHash(12), sizeBytes: 800 * 1024 },
    ])

    await evaluate({ cwd: "/repo" })

    const showCalls = countCalls((c) => c.args[0] === "show" && c.args[1] === "HEAD:.gitattributes")
    expect(showCalls).toBe(1)
  })

  test("AC1: .gitattributes is read exactly once per invocation (team mode, lfs present)", async () => {
    collaborationMode = "team"
    gitResponses["log --diff-filter=A --name-only --format= HEAD~10..HEAD"] = "big.bin\n"
    gitResponses["show HEAD:.gitattributes"] = "*.bin filter=lfs\n"
    gitResponses["ls-tree HEAD --"] = buildLsTreeOutput([
      { name: "big.bin", hash: makeBlobHash(20) },
    ])
    catFileBatchStub = buildCatFileBatchOutput([{ hash: makeBlobHash(20), sizeBytes: 600 * 1024 }])

    await evaluate({ cwd: "/repo" })

    const showCalls = countCalls((c) => c.args[0] === "show" && c.args[1] === "HEAD:.gitattributes")
    expect(showCalls).toBe(1)
  })

  test("AC2: git ls-tree is batched into a single call for N candidates", async () => {
    const N = 50
    const files = Array.from({ length: N }, (_, i) => `file_${i}.bin`)
    const hashes = Array.from({ length: N }, (_, i) => makeBlobHash(100 + i))
    gitResponses["log --diff-filter=A --name-only --format= HEAD~10..HEAD"] =
      `${files.join("\n")}\n`
    gitResponses["show HEAD:.gitattributes"] = ""
    gitResponses["ls-tree HEAD --"] = buildLsTreeOutput(
      files.map((name, i) => ({ name, hash: hashes[i]! }))
    )
    catFileBatchStub = buildCatFileBatchOutput(
      hashes.map((hash) => ({ hash, sizeBytes: 10 * 1024 })) // under limit
    )

    await evaluate({ cwd: "/repo" })

    const lsTreeCalls = gitCalls.filter((c) => c.args[0] === "ls-tree")
    expect(lsTreeCalls.length).toBe(1)
    // The single ls-tree call must carry all N file paths.
    const passedFiles = lsTreeCalls[0]!.args.slice(3) // skip "ls-tree HEAD --"
    expect(passedFiles.length).toBe(N)
    expect(passedFiles).toEqual(files)
  })

  test("AC4: total git subprocess spawns are bounded independent of file count", async () => {
    const N = 50
    const files = Array.from({ length: N }, (_, i) => `file_${i}.bin`)
    const hashes = Array.from({ length: N }, (_, i) => makeBlobHash(200 + i))
    gitResponses["log --diff-filter=A --name-only --format= HEAD~10..HEAD"] =
      `${files.join("\n")}\n`
    gitResponses["show HEAD:.gitattributes"] = ""
    gitResponses["ls-tree HEAD --"] = buildLsTreeOutput(
      files.map((name, i) => ({ name, hash: hashes[i]! }))
    )
    catFileBatchStub = buildCatFileBatchOutput(
      hashes.map((hash) => ({ hash, sizeBytes: 10 * 1024 }))
    )

    await evaluate({ cwd: "/repo" })

    // Budget: 1 show + 1 log + 1 ls-tree = 3 git() helper calls,
    // plus 1 direct Bun.spawn for `git cat-file --batch` = 4 subprocesses total.
    // This bound holds for N=50 and must hold for any N >= 1.
    const gitHelperCalls = gitCalls.length
    expect(gitHelperCalls).toBe(3)
    expect(catFileSpawnCount).toBe(1)
    const totalSpawns = gitHelperCalls + catFileSpawnCount
    expect(totalSpawns).toBeLessThanOrEqual(4)
  })

  test("AC3: caps output at 10 large files", async () => {
    const N = 15
    const files = Array.from({ length: N }, (_, i) => `big_${i}.bin`)
    const hashes = Array.from({ length: N }, (_, i) => makeBlobHash(300 + i))
    gitResponses["log --diff-filter=A --name-only --format= HEAD~10..HEAD"] =
      `${files.join("\n")}\n`
    gitResponses["show HEAD:.gitattributes"] = ""
    gitResponses["ls-tree HEAD --"] = buildLsTreeOutput(
      files.map((name, i) => ({ name, hash: hashes[i]! }))
    )
    catFileBatchStub = buildCatFileBatchOutput(
      hashes.map((hash) => ({ hash, sizeBytes: 600 * 1024 }))
    )

    const result = (await evaluate({ cwd: "/repo" })) as {
      decision?: string
      reason?: string
    }

    expect(result.decision).toBe("block")
    // Count how many `big_N.bin` entries appear in the blocked reason.
    const flaggedCount = (result.reason ?? "").match(/big_\d+\.bin/g)?.length ?? 0
    expect(flaggedCount).toBe(10)
  })
})
