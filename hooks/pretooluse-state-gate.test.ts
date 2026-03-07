import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { useTempDir } from "./test-utils.ts"

const HOOK_PATH = resolve(process.cwd(), "hooks/pretooluse-state-gate.ts")

const { create: makeTempDir } = useTempDir("swiz-state-gate-")

async function writeState(dir: string, state: string): Promise<void> {
  const configDir = join(dir, ".swiz")
  await mkdir(configDir, { recursive: true })
  await Bun.write(join(configDir, "state.json"), JSON.stringify({ state }))
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

  describe("developing state (no blocks)", () => {
    test("allows Bash", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "developing")
      const result = await runHook("Bash", { command: "echo hello", cwd: dir })
      expect(result.stdout).toBe("")
    })

    test("allows Edit", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "developing")
      const result = await runHook("Edit", { cwd: dir })
      expect(result.stdout).toBe("")
    })
  })

  describe("reviewing state (no blocks)", () => {
    test("allows Bash", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "reviewing")
      const result = await runHook("Bash", { command: "echo hello", cwd: dir })
      expect(result.stdout).toBe("")
    })

    test("allows Edit", async () => {
      const dir = await makeTempDir()
      await writeState(dir, "reviewing")
      const result = await runHook("Edit", { cwd: dir })
      expect(result.stdout).toBe("")
    })
  })
})
