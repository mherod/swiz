import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { useTempDir } from "./test-utils.ts"

const HOOK_PATH = resolve(process.cwd(), "hooks/pretooluse-state-gate.ts")

const { create: makeTempDir } = useTempDir("swiz-state-gate-")

async function writeState(dir: string, state: string): Promise<void> {
  const configDir = join(dir, ".swiz")
  await mkdir(configDir, { recursive: true })
  await Bun.write(join(configDir, "config.json"), JSON.stringify({ state }))
}

async function runHook(
  toolName: string,
  opts: { command?: string; cwd?: string } = {}
): Promise<{ decision?: string; reason?: string; stdout: string }> {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: opts.command ? { command: opts.command } : {},
    cwd: opts.cwd,
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

describe("pretooluse-state-gate", () => {
  describe("no state configured", () => {
    test("allows Bash when no .swiz/config.json exists", async () => {
      const dir = await makeTempDir()
      const result = await runHook("Bash", { command: "echo hello", cwd: dir })
      expect(result.stdout).toBe("")
    })

    test("allows Edit when no .swiz/config.json exists", async () => {
      const dir = await makeTempDir()
      const result = await runHook("Edit", { cwd: dir })
      expect(result.stdout).toBe("")
    })
  })

  describe("in-development state (no blocks)", () => {
    test("allows Bash", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "in-development")
      const result = await runHook("Bash", { command: "echo hello", cwd: dir })
      expect(result.stdout).toBe("")
    })

    test("allows Edit", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "in-development")
      const result = await runHook("Edit", { cwd: dir })
      expect(result.stdout).toBe("")
    })
  })

  describe("released state (blocks code changes and shell)", () => {
    test("blocks Bash", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "released")
      const result = await runHook("Bash", { command: "echo hello", cwd: dir })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("released")
    })

    test("blocks Edit", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "released")
      const result = await runHook("Edit", { cwd: dir })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("released")
    })

    test("blocks Write", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "released")
      const result = await runHook("Write", { cwd: dir })
      expect(result.decision).toBe("deny")
    })

    test("allows Read (not a blocked category)", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "released")
      const result = await runHook("Read", { cwd: dir })
      expect(result.stdout).toBe("")
    })

    test("allows Grep (not a blocked category)", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "released")
      const result = await runHook("Grep", { cwd: dir })
      expect(result.stdout).toBe("")
    })

    test("allows TaskCreate (not a blocked category)", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "released")
      const result = await runHook("TaskCreate", { cwd: dir })
      expect(result.stdout).toBe("")
    })
  })

  describe("swiz command exemption (deadlock prevention)", () => {
    test("allows swiz state set in released state", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "released")
      const result = await runHook("Bash", { command: "swiz state set in-development", cwd: dir })
      expect(result.stdout).toBe("")
    })

    test("allows swiz tasks in released state", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "released")
      const result = await runHook("Bash", { command: "swiz tasks complete-all", cwd: dir })
      expect(result.stdout).toBe("")
    })

    test("allows swiz status in released state", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "released")
      const result = await runHook("Bash", { command: "swiz status", cwd: dir })
      expect(result.stdout).toBe("")
    })

    test("still blocks non-swiz Bash in released state", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "released")
      const result = await runHook("Bash", { command: "git push origin main", cwd: dir })
      expect(result.decision).toBe("deny")
    })

    test("still blocks Edit in released state (not a shell tool)", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "released")
      const result = await runHook("Edit", { cwd: dir })
      expect(result.decision).toBe("deny")
    })
  })

  describe("paused state (no blocks defined)", () => {
    test("allows Bash in paused state", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "paused")
      const result = await runHook("Bash", { command: "echo hello", cwd: dir })
      expect(result.stdout).toBe("")
    })

    test("allows Edit in paused state", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "paused")
      const result = await runHook("Edit", { cwd: dir })
      expect(result.stdout).toBe("")
    })
  })
})
