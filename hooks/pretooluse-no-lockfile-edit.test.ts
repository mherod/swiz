import { describe, expect, test } from "bun:test"

interface HookResult {
  exitCode: number | null
  decision?: string
  reason?: string
}

async function runHook(filePath: string): Promise<HookResult> {
  const payload = JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: filePath },
  })

  const proc = Bun.spawn(["bun", "hooks/pretooluse-no-lockfile-edit.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(payload)
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  await proc.exited

  let decision: string | undefined
  let reason: string | undefined

  if (stdout.trim()) {
    try {
      const parsed = JSON.parse(stdout.trim())
      const hso = parsed.hookSpecificOutput as Record<string, unknown> | undefined
      decision = (hso?.permissionDecision ?? parsed.decision) as string | undefined
      reason = (hso?.permissionDecisionReason ?? parsed.reason) as string | undefined
    } catch {}
  }

  return { exitCode: proc.exitCode, decision, reason }
}

describe("pretooluse-no-lockfile-edit", () => {
  describe("blocked lockfiles", () => {
    test("pnpm-lock.yaml", async () => {
      const result = await runHook("pnpm-lock.yaml")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("package-lock.json", async () => {
      const result = await runHook("package-lock.json")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("yarn.lock", async () => {
      const result = await runHook("yarn.lock")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("bun.lock", async () => {
      const result = await runHook("bun.lock")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("bun.lockb", async () => {
      const result = await runHook("bun.lockb")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("npm-shrinkwrap.json", async () => {
      const result = await runHook("npm-shrinkwrap.json")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("shrinkwrap.yaml", async () => {
      const result = await runHook("shrinkwrap.yaml")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("absolute path: /project/pnpm-lock.yaml", async () => {
      const result = await runHook("/project/pnpm-lock.yaml")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("nested workspace: packages/app/package-lock.json", async () => {
      const result = await runHook("packages/app/package-lock.json")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("uppercase: PNPM-LOCK.YAML", async () => {
      const result = await runHook("PNPM-LOCK.YAML")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })

    test("Windows-style path: project\\yarn.lock", async () => {
      const result = await runHook("project\\yarn.lock")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("deny")
    })
  })

  describe("allowed paths", () => {
    test("source file: /project/src/file.ts", async () => {
      const result = await runHook("/project/src/file.ts")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("allow")
    })

    test("file with lockfile name as prefix: bun.lock.backup", async () => {
      const result = await runHook("bun.lock.backup")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("allow")
    })

    test("file mentioning lockfile in name: my-yarn.lock-helper.ts", async () => {
      const result = await runHook("/project/src/my-yarn.lock-helper.ts")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("allow")
    })

    test("package.json (not a lockfile)", async () => {
      const result = await runHook("package.json")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("allow")
    })

    test("empty path", async () => {
      const result = await runHook("")
      expect(result.exitCode).toBe(0)
      expect(result.decision).toBe("allow")
    })
  })
})
