import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getGitClient } from "../src/git/client.ts"

/**
 * Initialize a temporary git repository with an initial commit on HEAD.
 *
 * Shared across hook test files so the `similar` pre-commit duplicate
 * detector stays green. Lives in `hooks/` (not `src/`) because test
 * files import it directly and the hook test tree intentionally avoids
 * cross-package imports.
 */
export async function initGitRepo(dir: string): Promise<void> {
  await getGitClient().run(["init", dir])
  await getGitClient().run(["config", "user.email", "test@test.com"], { cwd: dir })
  await getGitClient().run(["config", "user.name", "Test"], { cwd: dir })
  await writeFile(join(dir, ".gitkeep"), "")
  await getGitClient().run(["add", "."], { cwd: dir })
  await getGitClient().run(["commit", "-m", "init", "--no-verify"], { cwd: dir })
}
