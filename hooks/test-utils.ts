import { afterAll } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Concurrent-safe temporary directory manager for bun tests.
 *
 * Registers an afterAll hook so directories are removed after ALL tests in the
 * file complete — not after each individual test. This prevents concurrent
 * sibling tests from having their directories deleted mid-run, which causes
 * ENOENT errors in Bun.spawn({ cwd }) calls.
 *
 * Usage:
 *   const tmp = useTempDir("swiz-my-prefix-")
 *   const dir = await tmp.create()          // uses default prefix
 *   const dir = await tmp.create("other-")  // override prefix for this dir
 */
export function useTempDir(defaultPrefix = "swiz-test-") {
  const dirs: string[] = []

  afterAll(async () => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!
      await rm(dir, { recursive: true, force: true })
    }
  })

  return {
    async create(prefix = defaultPrefix): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), prefix))
      dirs.push(dir)
      return dir
    },
  }
}
