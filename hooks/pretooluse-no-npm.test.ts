import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const HOOK_PATH = resolve(process.cwd(), "hooks/pretooluse-no-npm.ts")

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "swiz-no-npm-"))
  tempDirs.push(dir)
  return dir
}

async function runHook(
  command: string,
  opts: { toolName?: string; cwd?: string } = {}
): Promise<{ decision?: string; reason?: string; stdout: string }> {
  const payload = JSON.stringify({
    tool_name: opts.toolName ?? "Bash",
    tool_input: { command },
  })
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd ?? process.cwd(),
  })
  proc.stdin.write(payload)
  proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited

  const stdout = out.trim()
  if (!stdout) return { stdout }
  const parsed = JSON.parse(stdout)
  const hso = parsed.hookSpecificOutput
  return {
    decision: hso?.permissionDecision ?? parsed.decision,
    reason: hso?.permissionDecisionReason ?? parsed.reason,
    stdout,
  }
}

// These tests run from the swiz project root which has bun.lock → PM=bun

describe("pretooluse-no-npm (bun project)", () => {
  describe("npm commands are blocked", () => {
    test("npm install is denied", async () => {
      const result = await runHook("npm install")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("bun")
    })

    test("npm install <pkg> is denied", async () => {
      const result = await runHook("npm install lodash")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("bun add")
    })

    test("npm install -D is denied", async () => {
      const result = await runHook("npm install -D typescript")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("bun add -D")
    })

    test("npm run dev is denied", async () => {
      const result = await runHook("npm run dev")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("bun run")
    })

    test("npm test is denied", async () => {
      const result = await runHook("npm test")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("bun test")
    })
  })

  describe("npx is blocked", () => {
    test("npx some-tool is denied", async () => {
      const result = await runHook("npx some-tool")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("bunx")
    })

    test("npx tsc is denied", async () => {
      const result = await runHook("npx tsc --noEmit")
      expect(result.decision).toBe("deny")
    })
  })

  describe("bun commands are allowed", () => {
    test("bun install passes through", async () => {
      const result = await runHook("bun install")
      expect(result.stdout).toBe("")
    })

    test("bunx passes through", async () => {
      const result = await runHook("bunx tsc")
      expect(result.stdout).toBe("")
    })

    test("bun test passes through", async () => {
      const result = await runHook("bun test")
      expect(result.stdout).toBe("")
    })

    test("bun run dev passes through", async () => {
      const result = await runHook("bun run dev")
      expect(result.stdout).toBe("")
    })

    test("pnpm install also passes through (plausible alternative)", async () => {
      const result = await runHook("pnpm install")
      expect(result.stdout).toBe("")
    })
  })

  describe("non-shell tools are ignored", () => {
    test("Edit tool with npm command exits silently", async () => {
      const result = await runHook("npm install", { toolName: "Edit" })
      expect(result.stdout).toBe("")
    })
  })

  describe("no lockfile: enforcement skipped", () => {
    test("npm install in a directory with no lockfile passes through", async () => {
      const dir = await makeTempDir()
      const result = await runHook("npm install", { cwd: dir })
      // No lockfile means PM=null → exits 0 with no output
      expect(result.stdout).toBe("")
    })

    test("pnpm lockfile enforces pnpm", async () => {
      const dir = await makeTempDir()
      await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
      const result = await runHook("npm install", { cwd: dir })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("pnpm")
    })

    test("bun runtime command in pnpm project passes through", async () => {
      const dir = await makeTempDir()
      await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
      const result = await runHook("bun ~/.claude/hooks/tasks-list.ts --check", { cwd: dir })
      expect(result.stdout).toBe("")
    })
  })
})
