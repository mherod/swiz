import { describe, expect, it } from "bun:test"
import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { dirname, join } from "node:path"

// Regression guard for issue #656 / #655.
//
// When a Bun.spawn caller pipes BOTH stdout and stderr and drains them
// sequentially (await stdout, then await stderr — or the reverse), the pipe
// buffer for the second stream can fill while the first is still draining,
// blocking the subprocess and triggering test timeouts under CI load.
//
// Canonical fix: drain concurrently via Promise.all, or call
// `spawnAndCapture()` from `src/test-utils/subprocess-helper.ts`.
//
// This test scans the repo for the sequential pattern and fails loudly if it
// reappears. It is intentionally narrow — it only flags the literal anti-
// pattern, not legitimate single-stream draining where the other stream is
// "inherit" or unused.

const REPO_ROOT = join(dirname(import.meta.path), "..")
const SCAN_DIRS = ["src", "hooks"]
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".swiz"])
const FILE_EXTS = [".ts", ".tsx"]
// Self-reference: this test file must be allowed to discuss the anti-pattern
// in comments without flagging itself.
const SELF_BASENAME = "subprocess-drain-pattern.test.ts"

// Two `await new Response(proc.stdXXX).text()` calls separated only by
// whitespace, blank lines, or comments — that's the deadlock pattern.
// Direction-agnostic: catches stdout-then-stderr AND stderr-then-stdout.
const SEQUENTIAL_DRAIN_RE = new RegExp(
  String.raw`await\s+new\s+Response\(\s*\w+\.std(out|err)\s*\)\.text\(\)` +
    String.raw`(?:\s|//[^\n]*\n|/\*[^]*?\*/)*` +
    String.raw`await\s+new\s+Response\(\s*\w+\.std(out|err)\s*\)\.text\(\)`,
  "g"
)

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: Dirent[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[]
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walk(full)
    } else if (entry.isFile() && FILE_EXTS.some((ext) => entry.name.endsWith(ext))) {
      yield full
    }
  }
}

async function findSequentialDrainSites(): Promise<Array<{ file: string; lines: number[] }>> {
  const hits: Array<{ file: string; lines: number[] }> = []
  for (const baseDir of SCAN_DIRS) {
    for await (const file of walk(join(REPO_ROOT, baseDir))) {
      if (file.endsWith(SELF_BASENAME)) continue
      const text = await Bun.file(file).text()
      const matches = [...text.matchAll(SEQUENTIAL_DRAIN_RE)]
      if (matches.length === 0) continue
      // Make sure the match is NOT inside a Promise.all([...]) call.
      // The pattern requires `await` immediately before each Response call;
      // Promise.all elements look like `new Response(...).text(),` (no await
      // and a trailing comma). So matches here are genuinely sequential.
      const lines = matches.map((m) => text.slice(0, m.index ?? 0).split("\n").length)
      hits.push({ file: file.replace(`${REPO_ROOT}/`, ""), lines })
    }
  }
  return hits
}

describe("Bun.spawn drain pattern", () => {
  it("does not use the sequential stdout/stderr drain anti-pattern", async () => {
    const hits = await findSequentialDrainSites()
    if (hits.length > 0) {
      const report = hits.map((h) => `  ${h.file}: line(s) ${h.lines.join(", ")}`).join("\n")
      throw new Error(
        `Sequential Bun.spawn drain pattern detected — pipe buffer deadlock risk.\n\n` +
          `Drain stdout and stderr concurrently via Promise.all, or use\n` +
          `spawnAndCapture() from src/test-utils/subprocess-helper.ts.\n\n` +
          `Offending sites:\n${report}`
      )
    }
    expect(hits).toEqual([])
  })
})
