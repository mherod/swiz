import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProjectIdentity } from "../src/project-identity.ts"
import { swizPushCooldownSentinelPath } from "../src/temp-paths.ts"
import { evaluatePosttoolusePushCooldown } from "./posttooluse-push-cooldown.ts"

describe("posttooluse push cooldown project identity", () => {
  test("writes the canonical repository sentinel from a symlinked subdirectory", async () => {
    const base = await mkdtemp(join(tmpdir(), "swiz-postpush-identity-"))
    const root = join(base, "repo")
    const nested = join(root, "src", "nested")
    const alias = join(base, "alias")
    await mkdir(join(root, ".git"), { recursive: true })
    await mkdir(nested, { recursive: true })
    await symlink(root, alias)

    const { repoKey } = await resolveProjectIdentity(root)
    const sentinelPath = swizPushCooldownSentinelPath(repoKey)
    await rm(sentinelPath, { force: true })

    try {
      await evaluatePosttoolusePushCooldown({
        cwd: join(alias, "src", "nested"),
        tool_name: "Bash",
        tool_input: { command: "git push origin main" },
      })

      expect(await Bun.file(sentinelPath).exists()).toBe(true)
    } finally {
      await Promise.all([
        rm(sentinelPath, { force: true }),
        rm(base, { recursive: true, force: true }),
      ])
    }
  })

  test("keeps hook repo-key ownership in project-identity", async () => {
    const hookPaths = [
      "pretooluse-push-cooldown.ts",
      "posttooluse-push-cooldown.ts",
      "posttooluse-upstream-sync-on-push.ts",
    ]

    for (const hookPath of hookPaths) {
      const source = await Bun.file(join(import.meta.dir, hookPath)).text()
      expect(source).toContain("resolveProjectIdentity")
      expect(source).not.toContain("getCanonicalPathHash")
      expect(source).not.toContain('["rev-parse", "--show-toplevel"]')
    }
  })
})
