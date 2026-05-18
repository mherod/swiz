import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { useTempDir } from "../src/utils/test-utils.ts"
import { evaluateFileTruncationGuard } from "./posttooluse-file-truncation-guard.ts"

const { create: createTempDir } = useTempDir("swiz-trunc-guard-")

async function gitExec(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`)
}

async function createRepoWithFile(
  content: string,
  filename = "target.ts"
): Promise<{ cwd: string; filePath: string }> {
  const cwd = await createTempDir()
  await gitExec(["init"], cwd)
  await gitExec(["config", "user.email", "test@test.com"], cwd)
  await gitExec(["config", "user.name", "Test"], cwd)
  const filePath = join(cwd, filename)
  await writeFile(filePath, content)
  await gitExec(["add", filename], cwd)
  await gitExec(["commit", "-m", "initial"], cwd)
  return { cwd, filePath }
}

function makeInput(filePath: string, cwd: string, toolName = "Edit") {
  return { tool_name: toolName, tool_input: { file_path: filePath }, cwd, session_id: "test" }
}

function lines(n: number): string {
  return `${Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n")}\n`
}

describe("posttooluse-file-truncation-guard", () => {
  test("returns {} when no file_path in input", async () => {
    const result = await evaluateFileTruncationGuard({
      tool_name: "Edit",
      tool_input: {},
      cwd: "/tmp",
      session_id: "test",
    })
    expect(result).toEqual({})
  })

  test("returns {} when file does not exist", async () => {
    const cwd = await createTempDir()
    const result = await evaluateFileTruncationGuard(makeInput(join(cwd, "nonexistent.ts"), cwd))
    expect(result).toEqual({})
  })

  test("returns {} when file is new (not in HEAD, no diff)", async () => {
    const cwd = await createTempDir()
    await gitExec(["init"], cwd)
    await gitExec(["config", "user.email", "test@test.com"], cwd)
    await gitExec(["config", "user.name", "Test"], cwd)
    await gitExec(["commit", "--allow-empty", "-m", "init"], cwd)
    const filePath = join(cwd, "new.ts")
    await writeFile(filePath, lines(200))
    const result = await evaluateFileTruncationGuard(makeInput(filePath, cwd))
    expect(result).toEqual({})
  })

  test("returns {} when loss is below the 50-line threshold", async () => {
    const { cwd, filePath } = await createRepoWithFile(lines(100))
    await writeFile(filePath, lines(80))
    const result = await evaluateFileTruncationGuard(makeInput(filePath, cwd))
    expect(result).toEqual({})
  })

  test("returns {} when loss exceeds 50 lines but is below 50% of original", async () => {
    const { cwd, filePath } = await createRepoWithFile(lines(500))
    await writeFile(filePath, lines(440))
    const result = await evaluateFileTruncationGuard(makeInput(filePath, cwd))
    expect(result).toEqual({})
  })

  test("injects additionalContext when file shrinks by ≥50 lines and ≥50%", async () => {
    const { cwd, filePath } = await createRepoWithFile(lines(200))
    await writeFile(filePath, "// truncated\n")
    const result = await evaluateFileTruncationGuard(makeInput(filePath, cwd))
    const hso = (result as Record<string, any>).hookSpecificOutput as Record<string, any>
    expect(hso?.additionalContext).toContain("lost")
    expect(hso?.additionalContext).toContain("target.ts")
    expect(hso?.additionalContext).toContain("git checkout HEAD")
  })

  test("Write tool also triggers warning on truncation", async () => {
    const { cwd, filePath } = await createRepoWithFile(lines(200))
    await writeFile(filePath, "// rewritten small\n")
    const result = await evaluateFileTruncationGuard(makeInput(filePath, cwd, "Write"))
    const hso = (result as Record<string, any>).hookSpecificOutput as Record<string, any>
    expect(hso?.additionalContext).toContain("lost")
  })

  test("no warning when file grows larger than HEAD", async () => {
    const { cwd, filePath } = await createRepoWithFile(lines(10))
    await writeFile(filePath, lines(300))
    const result = await evaluateFileTruncationGuard(makeInput(filePath, cwd))
    expect(result).toEqual({})
  })
})
