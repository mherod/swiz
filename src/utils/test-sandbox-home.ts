/**
 * One throwaway HOME per test process, for code under test that does not choose HOME (#924).
 *
 * Tests used to run hooks and task writers against the developer's real home. Fixture tasks
 * piled up in ~/.claude/tasks until task governance blocked real work.
 *
 * One per process rather than per run: process-level singletons such as the issue store open
 * files under HOME on first use and outlive a single hook run, so a home deleted after each run
 * leaves them reading a vanished file (SQLITE_IOERR_VNODE). `bun test` fires no process exit
 * handlers, so `src/utils/test-preload.ts` removes the sandbox after the process's last file.
 *
 * Kept free of heavy imports: the preload loads this module for every test file.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let sandboxHome: Promise<string> | null = null

/** This process's sandbox HOME, created on first use. */
export function testSandboxHome(): Promise<string> {
  sandboxHome ??= mkdtemp(join(tmpdir(), "swiz-sandbox-home-"))
  return sandboxHome
}

/** Remove the sandbox HOME if this process created one. */
export async function removeTestSandboxHome(): Promise<void> {
  if (!sandboxHome) return
  const home = await sandboxHome
  sandboxHome = null
  await rm(home, { recursive: true, force: true })
}
