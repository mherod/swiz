import { describe, expect, test } from "bun:test"
import { withGitClient } from "../src/git/client.ts"
import { MockGitClient } from "../src/git/mock-client.ts"
import { evaluatePretooluseTrunkModeWorktreeCreation } from "./pretooluse-trunk-mode-worktree-creation.ts"

interface HookResult {
  systemMessage?: string
  hookSpecificOutput?: {
    permissionDecision?: string
    permissionDecisionReason?: string
  }
}

const CWD = "/test/trunk-mode-worktree-creation"
const REFS = [
  "main",
  "codex/existing-pr",
  "HEAD",
  "origin/existing-pr",
  "refs/remotes/origin/existing-pr",
]

function mockGit(refs = REFS, repo = CWD): MockGitClient {
  return new MockGitClient((args, options) => {
    expect(options.cwd).toBe(CWD)
    const index = args.indexOf("rev-parse")
    expect(index).toBeGreaterThanOrEqual(0)
    const query = args.slice(index + 1)
    if (query[0] === "--show-toplevel") return repo
    expect(query.slice(0, 2)).toEqual(["--verify", "--end-of-options"])
    return refs.some((ref) => query[2] === `${ref}^{commit}`) ? "abc123" : { exitCode: 1 }
  })
}

async function runHook(
  command: string,
  options: {
    gitRepo?: boolean
    toolName?: string
    trunkMode?: boolean
    client?: MockGitClient
    settingsCwds?: string[]
    trunkRepos?: string[]
    defaultBranch?: string
  } = {}
): Promise<HookResult> {
  const cwd = CWD
  return await withGitClient(options.client ?? mockGit(), () =>
    evaluatePretooluseTrunkModeWorktreeCreation(
      {
        cwd,
        tool_name: options.toolName ?? "Bash",
        tool_input: { command },
      },
      {
        runtime: {
          isGitRepo: () => Promise.resolve(options.gitRepo ?? true),
          readProjectSettings: (target) => {
            options.settingsCwds?.push(target)
            return Promise.resolve({
              defaultBranch: options.defaultBranch ?? "main",
              trunkMode: options.trunkRepos
                ? options.trunkRepos.includes(target)
                : (options.trunkMode ?? true),
            })
          },
        },
      }
    )
  )
}

describe("pretooluse-trunk-mode-worktree-creation", () => {
  test("allows a verified existing PR branch without changing the primary checkout", async () => {
    const client = mockGit()
    const result = await runHook("git worktree add ../pr-review codex/existing-pr", { client })
    expect(result).toEqual({})
    // No checkout, stash, reset or index writes; other hooks and Git retain their safety checks.
    expect(client.calls.map(({ args }) => args[0])).toEqual(["rev-parse", "rev-parse"])
  })
  for (const command of [
    "git worktree add ../feature",
    "git worktree add -b feat/worktree ../feature",
    "git worktree add ../feature missing",
    "git worktree add --detach ../review refs/remotes/origin/missing",
    "git worktree add -B codex/existing-pr ../review main",
    "git worktree add -Bcodex/existing-pr ../review main",
    "git worktree add -qbfeat/new ../review main",
    "git worktree add --orphan ../review",
    "git worktree add --track ../review origin/existing-pr",
    "git worktree add --guess-remote ../review",
    "git worktree add --force ../review codex/existing-pr",
    "git worktree add -df ../review HEAD",
    "git worktree add ../review codex/existing-pr; git worktree add -b new ../new main",
    'git worktree add --reason="main" ../missing',
  ]) {
    test(`blocks worktree creation with ${command}`, async () => {
      const result = await runHook(command)

      expect(result.hookSpecificOutput?.permissionDecision).toBe("deny")
      const reason = result.hookSpecificOutput?.permissionDecisionReason ?? ""
      expect(reason).toContain("Trunk mode")
      expect(reason).toContain("no git worktree was created")
      expect(reason).toContain("git switch <existing-branch>")
      expect(reason).toContain("git worktree add <path> <existing-branch>")
      expect(reason).toContain("refs/remotes/origin/<existing-PR-branch>")
      expect(reason).toContain("commit on `main`")
      expect(reason).toContain("git push origin main")
      expect(reason).toContain("Do not create a feature branch or a new PR")
      expect(reason).toContain("Preserve unrelated or peer work before switching")
      expect(reason).toContain("For an existing PR, update its branch and PR")
      expect(reason).toContain("Do not leave unpublished commits on a detached HEAD")
      expect(result.systemMessage).toContain(
        "implement, verify, commit and push new work directly on main"
      )
      expect(result.systemMessage).toContain(
        "Existing branches/worktrees are for recovery or existing PR work"
      )
    })
  }

  for (const command of [
    'git --no-pager worktree add "../PR review" codex/existing-pr',
    "git worktree add --detach ../review refs/remotes/origin/existing-pr",
    "git worktree add ../review origin/existing-pr",
    "git worktree add -d ../review HEAD",
    "git worktree add --lock --reason 'PR; review && verification' ../review codex/existing-pr",
    "git worktree add --no-checkout -- ../review codex/existing-pr",
    "git status && git worktree add ../review codex/existing-pr",
    "command git worktree add ../review codex/existing-pr",
  ]) {
    test(`allows verified existing refs: ${command}`, async () => {
      expect(await runHook(command)).toEqual({})
    })
  }

  test("uses Git's target repository for policy and ref verification", async () => {
    const settingsCwds: string[] = []
    const target = "/test/repo with spaces"
    const client = mockGit(REFS, target)
    const command =
      'git -C "/test" -C "repo with spaces" -C "" -c advice.detachedHead=false worktree add "../PR review" codex/existing-pr'
    expect(await runHook(command, { client, settingsCwds, trunkRepos: [target] })).toEqual({})
    expect(settingsCwds).toEqual([target])
    const globals = [
      "-C",
      "/test",
      "-C",
      "repo with spaces",
      "-C",
      "",
      "-c",
      "advice.detachedHead=false",
    ]
    expect(client.calls.map(({ args }) => args)).toEqual([
      [...globals, "rev-parse", "--show-toplevel"],
      [...globals, "rev-parse", "--verify", "--end-of-options", "codex/existing-pr^{commit}"],
    ])
  })

  test("checks every repository in a chain independently", async () => {
    const settingsCwds: string[] = []
    const client = new MockGitClient((args) =>
      args.includes("--show-toplevel") ? args[1]! : { exitCode: 1 }
    )
    const result = await runHook(
      'git -C /test/free worktree add ../new; git -C "/test/trunk" worktree add ../new',
      {
        client,
        settingsCwds,
        trunkRepos: ["/test/trunk"],
      }
    )
    expect([...new Set(settingsCwds)]).toEqual(["/test/free", "/test/trunk"])
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  test("uses target repo policy even when source repo enables trunk mode", async () => {
    expect(
      await runHook("git -C /test/free worktree add -b new ../new", {
        client: mockGit([], "/test/free"),
        trunkRepos: [CWD],
      })
    ).toEqual({})
  })

  test("names the target repository's configured default branch in both output channels", async () => {
    const result = await runHook("git -C ../other worktree add -b feature ../review", {
      client: mockGit([], "/test/other"),
      defaultBranch: "trunk",
    })
    expect(result.systemMessage).toContain("directly on trunk")
    const reason = result.hookSpecificOutput?.permissionDecisionReason ?? ""
    expect(reason).toContain("git push origin trunk")
    expect(reason).not.toContain("git push origin main")
    expect(reason).toContain("preserve any git -C options")
  })

  test("denies refs missing from the target repo without attempting mutations", async () => {
    const client = mockGit([], "/test/other")
    const result = await runHook("git -C ../other worktree add ../review codex/existing-pr", {
      client,
    })
    expect(result.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(client.calls).toHaveLength(2)
  })

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
