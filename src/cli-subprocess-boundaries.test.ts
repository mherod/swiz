import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")
const PROCESS_CONTRACT_MARKER = "PROCESS_CONTRACT_TEST:"
const SELF = "src/cli-subprocess-boundaries.test.ts"

function launchesSwizCliInSubprocess(source: string): boolean {
  return (
    (source.includes("Bun.spawn") || source.includes("Bun.spawnSync")) &&
    (source.includes('"index.ts"') || source.includes("INDEX_PATH"))
  )
}

function launchesHookInSubprocess(source: string): boolean {
  return /Bun\.spawn(?:Sync)?\(\s*\[\s*(?:process\.execPath|["']bun["'])\s*,\s*(?:["']hooks\/|HOOK(?:_PATH|_ABS|_SCRIPT)?\b|hookPath\b)/m.test(
    source
  )
}

describe("subprocess test boundaries", () => {
  test("requires every CLI subprocess test to document its process contract", async () => {
    const missingMarkers: string[] = []
    const glob = new Bun.Glob("src/**/*.test.ts")

    for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
      if (relativePath === SELF) continue
      const source = await Bun.file(join(REPO_ROOT, relativePath)).text()
      if (launchesSwizCliInSubprocess(source) && !source.includes(PROCESS_CONTRACT_MARKER)) {
        missingMarkers.push(relativePath)
      }
    }

    expect(missingMarkers).toEqual([])
  })

  test("requires every hook subprocess test to document its process contract", async () => {
    const missingMarkers: string[] = []

    for (const pattern of ["hooks/**/*.test.ts", "src/**/*.test.ts"]) {
      const glob = new Bun.Glob(pattern)
      for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
        const source = await Bun.file(join(REPO_ROOT, relativePath)).text()
        if (launchesHookInSubprocess(source) && !source.includes(PROCESS_CONTRACT_MARKER)) {
          missingMarkers.push(relativePath)
        }
      }
    }

    expect(missingMarkers.sort()).toEqual([])
  })
})
