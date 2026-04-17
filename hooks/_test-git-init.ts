import { writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Initialize a temporary git repository with an initial commit on HEAD.
 *
 * Shared across hook test files so the `similar` pre-commit duplicate
 * detector stays green. Lives in `hooks/` (not `src/`) because test
 * files import it directly and the hook test tree intentionally avoids
 * cross-package imports.
 */
export async function initGitRepo(dir: string): Promise<void> {
  const init = Bun.spawn(["git", "init", dir], { stdout: "pipe", stderr: "pipe" })
  await init.exited
  const cfg = Bun.spawn(["git", "-C", dir, "config", "user.email", "test@test.com"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await cfg.exited
  const cfg2 = Bun.spawn(["git", "-C", dir, "config", "user.name", "Test"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await cfg2.exited
  await writeFile(join(dir, ".gitkeep"), "")
  const add = Bun.spawn(["git", "-C", dir, "add", "."], { stdout: "pipe", stderr: "pipe" })
  await add.exited
  const commit = Bun.spawn(["git", "-C", dir, "commit", "-m", "init", "--no-verify"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await commit.exited
}
