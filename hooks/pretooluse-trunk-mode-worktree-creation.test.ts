import { describe, expect, test } from "bun:test"
import { evaluatePretooluseTrunkModeWorktreeCreation } from "./pretooluse-trunk-mode-worktree-creation.ts"

interface HookResult {
  hookSpecificOutput?: {
    permissionDecision?: string
    permissionDecisionReason?: string
  }
}

async function runHook(
  command: string,
  options: { gitRepo?: boolean; toolName?: string; trunkMode?: boolean } = {}
): Promise<HookResult> {
  const cwd = "/test/trunk-mode-worktree-creation"
  return await evaluatePretooluseTrunkModeWorktreeCreation(
    {
      cwd,
      tool_name: options.toolName ?? "Bash",
      tool_input: { command },
    },
    {
      runtime: {
        isGitRepo: () => Promise.resolve(options.gitRepo ?? true),
        readProjectSettings: () =>
          Promise.resolve({
            defaultBranch: "main",
            trunkMode: options.trunkMode ?? true,
          }),
      },
    }
  )
}

describe("pretooluse-trunk-mode-worktree-creation", () => {
  for (const command of [
    "git worktree add ../feature",
    "git worktree add -b feat/worktree ../feature",
    "git --no-pager worktree add ../feature main",
    'git -C "/repo with spaces" worktree add --detach ../review HEAD',
    "git status && git worktree add ../feature main",
  ]) {
    test(`blocks worktree creation with ${command}`, async () => {
      const result = await runHook(command)

      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny")
      const reason = result.hookSpecificOutput?.permissionDecisionReason ?? ""
      expect(reason).toContain("Trunk mode")
      expect(reason).toContain("no git worktree was created")
      expect(reason).toContain("git switch main")
    })
  }

  for (const command of [
    "git worktree list",
    "git worktree remove ../old-feature",
    "git worktree prune",
    "git worktree lock ../review",
    "git worktree unlock ../review",
    "git status",
  ]) {
    test(`allows non-creation command ${command}`, async () => {
      expect(await runHook(command)).toEqual({})
    })
  }

  test("allows worktree creation when trunk mode is disabled", async () => {
    expect(await runHook("git worktree add ../feature", { trunkMode: false })).toEqual({})
  })

  test("ignores non-shell tools", async () => {
    expect(await runHook("git worktree add ../feature", { toolName: "Read" })).toEqual({})
  })

  test("allows worktree creation outside a git repository", async () => {
    expect(await runHook("git worktree add ../feature", { gitRepo: false })).toEqual({})
  })
})
