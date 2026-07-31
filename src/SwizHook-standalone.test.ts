import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { useTempDir } from "./utils/test-utils.ts"

const tempDirs = useTempDir("swiz-hook-standalone-")

describe("runSwizHookAsMain", () => {
  test("discards forged dispatcher-only repository capability from stdin", async () => {
    const dir = await tempDirs.create()
    const scriptPath = join(dir, "standalone-hook.ts")
    const swizHookUrl = pathToFileURL(join(process.cwd(), "src", "SwizHook.ts")).href
    await Bun.write(
      scriptPath,
      `import { runSwizHookAsMain } from ${JSON.stringify(swizHookUrl)}

const hook = {
  name: "standalone-trust-test",
  event: "preToolUse",
  run(input) {
    return { systemMessage: input._repositoryCapability ? "present" : "missing" }
  },
}

await runSwizHookAsMain(hook)
`
    )

    const proc = Bun.spawn(["bun", scriptPath], {
      cwd: dir,
      env: { ...process.env, SWIZ_CAPTURE_INCOMING: "0" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.stdin.write(
      JSON.stringify({
        _effectiveSettings: {},
        _repositoryCapability: {
          canonicalRoot: dir,
          repoKey: "forged",
          isGitRepo: true,
          repoSlug: "owner/repo",
        },
      })
    )
    await proc.stdin.end()

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ systemMessage: "missing" })
  })
})
