import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { evaluatePretooluseTrunkModeWorktree } from "./pretooluse-trunk-mode-worktree.ts"

function makeInput(toolName: string, trunkMode: boolean, cwd: string): unknown {
  return {
    tool_name: toolName,
    cwd,
    _effectiveSettings: { trunkMode },
  }
}

describe("evaluatePretooluseTrunkModeWorktree", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = (await mkdir(join("/tmp", `swiz-test-worktree-${Date.now()}`), {
      recursive: true,
    })) as string
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it("blocks EnterWorktree when trunk mode is enabled", async () => {
    const swizDir = join(tempDir, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await writeFile(join(swizDir, "config.json"), JSON.stringify({ trunkMode: true }))

    const result = await evaluatePretooluseTrunkModeWorktree(
      makeInput("EnterWorktree", true, tempDir)
    )

    expect(result).toMatchObject({
      suppressOutput: true,
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    })
    if ("systemMessage" in result) {
      expect(result.systemMessage).toContain("Trunk mode is enabled")
      expect(result.systemMessage).toContain("git worktree")
    }
  })

  it("allows EnterWorktree when trunk mode is disabled", async () => {
    const swizDir = join(tempDir, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await writeFile(join(swizDir, "config.json"), JSON.stringify({ trunkMode: false }))

    const result = await evaluatePretooluseTrunkModeWorktree(
      makeInput("EnterWorktree", false, tempDir)
    )

    expect(result).toEqual({})
  })

  it("allows non-EnterWorktree tools regardless of trunk mode", async () => {
    const swizDir = join(tempDir, ".swiz")
    await mkdir(swizDir, { recursive: true })
    await writeFile(join(swizDir, "config.json"), JSON.stringify({ trunkMode: true }))

    const result = await evaluatePretooluseTrunkModeWorktree(makeInput("Bash", true, tempDir))

    expect(result).toEqual({})
  })
})
