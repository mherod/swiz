import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { useTempDir } from "./utils/test-utils.ts"

const HOOK_PATH = resolve(process.cwd(), "hooks/pretooluse-ts-edit-state-gate.ts")

const { create: makeTempDir } = useTempDir("swiz-ts-edit-state-gate-")

async function writeState(dir: string, state: string): Promise<void> {
  const configDir = join(dir, ".swiz")
  await mkdir(configDir, { recursive: true })
  await Bun.write(join(configDir, "state.json"), JSON.stringify({ state }))
}

async function runHook(
  toolName: string,
  opts: { filePath?: string; cwd?: string } = {}
): Promise<{ decision?: string; reason?: string; stdout: string }> {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: opts.filePath !== undefined ? { file_path: opts.filePath } : {},
    cwd: opts.cwd,
  })
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd ?? process.cwd(),
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()
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

describe("pretooluse-ts-edit-state-gate", () => {
  test("allows .ts edit when no project state is set", async () => {
    const dir = await makeTempDir()
    const result = await runHook("Edit", { filePath: "src/foo.ts", cwd: dir })
    expect(result.stdout).toBe("")
  })

  test("allows .md edit in planning state", async () => {
    const dir = await makeTempDir()
    await writeState(dir, "planning")
    const result = await runHook("Edit", { filePath: "README.md", cwd: dir })
    expect(result.stdout).toBe("")
  })

  test("blocks .ts edit in planning state", async () => {
    const dir = await makeTempDir()
    await writeState(dir, "planning")
    const result = await runHook("Edit", { filePath: "src/foo.ts", cwd: dir })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("planning")
    expect(result.reason).toContain("swiz state set developing")
  })

  test("blocks .tsx edit in planning state", async () => {
    const dir = await makeTempDir()
    await writeState(dir, "planning")
    const result = await runHook("Write", { filePath: "src/App.tsx", cwd: dir })
    expect(result.decision).toBe("deny")
  })

  test("allows .ts edit in developing state", async () => {
    const dir = await makeTempDir()
    await writeState(dir, "developing")
    const result = await runHook("Edit", { filePath: "src/foo.ts", cwd: dir })
    expect(result.stdout).toBe("")
  })

  test("allows .ts edit in reviewing state", async () => {
    const dir = await makeTempDir()
    await writeState(dir, "reviewing")
    const result = await runHook("Edit", { filePath: "src/foo.ts", cwd: dir })
    expect(result.stdout).toBe("")
  })

  test("allows .ts edit in addressing-feedback state", async () => {
    const dir = await makeTempDir()
    await writeState(dir, "addressing-feedback")
    const result = await runHook("Edit", { filePath: "src/foo.ts", cwd: dir })
    expect(result.stdout).toBe("")
  })

  test("does not fire for non-edit tools", async () => {
    const dir = await makeTempDir()
    await writeState(dir, "planning")
    const result = await runHook("Read", { filePath: "src/foo.ts", cwd: dir })
    expect(result.stdout).toBe("")
  })
})
