import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createTestRepo,
  neutralAgentEnvOverrides,
  runHookInProcess,
} from "../src/utils/test-utils.ts"

async function createFakeGhBin(opts: {
  hasPr: boolean
  reviewState?: "CHANGES_REQUESTED" | "APPROVED"
}): Promise<string> {
  const fakeBin = await mkdtemp(join(tmpdir(), "pretooluse-pr-changes-gh-"))
  const ghPath = join(fakeBin, "gh")

  const prList = opts.hasPr ? '[{"number":42,"title":"Test PR"}]' : "[]"
  const reviews = opts.reviewState
    ? `[{"state":"${opts.reviewState}","user":{"login":"reviewer"},"body":"please fix","submitted_at":"2024-01-01T00:00:00Z"}]`
    : "[]"

  await writeFile(
    ghPath,
    `#!/bin/sh
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo "owner/repo"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '${prList}'
  exit 0
fi
if [ "$1" = "api" ]; then
  echo '${reviews}'
  exit 0
fi
echo ""
exit 0
`
  )
  await chmod(ghPath, 0o755)
  return fakeBin
}

async function runHook(
  cwd: string,
  command: string,
  fakeBin: string
): Promise<{ raw: string; parsed: Record<string, unknown> | null; decision: string }> {
  // Exercise branch policy with isolated HOME/env, without a second Bun test process.
  const result = await runHookInProcess(
    "hooks/pretooluse-pr-changes-branch-guard.ts",
    { tool_name: "Bash", tool_input: { command }, cwd },
    {
      cwd,
      env: neutralAgentEnvOverrides({
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        AI_TEST_NO_BACKEND: "1",
        SWIZ_NO_DAEMON: "1",
      }),
    }
  )
  expect(result.exitCode).toBe(0)
  return { raw: result.stdout, parsed: result.json ?? null, decision: result.decision ?? "allow" }
}

describe("pretooluse-pr-changes-branch-guard", () => {
  test("blocks git checkout when PR has CHANGES_REQUESTED", async () => {
    const repo = await createTestRepo("https://github.com/owner/repo.git", {
      featureBranch: "feat/my-feature",
    })
    const fakeBin = await createFakeGhBin({ hasPr: true, reviewState: "CHANGES_REQUESTED" })
    try {
      const result = await runHook(repo, "git checkout main", fakeBin)
      expect(result.decision).toBe("deny")
      expect(JSON.stringify(result.parsed)).toContain("changes requested")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })

  test("blocks git switch when PR has CHANGES_REQUESTED", async () => {
    const repo = await createTestRepo("https://github.com/owner/repo.git", {
      featureBranch: "feat/my-feature",
    })
    const fakeBin = await createFakeGhBin({ hasPr: true, reviewState: "CHANGES_REQUESTED" })
    try {
      const result = await runHook(repo, "git switch main", fakeBin)
      expect(result.decision).toBe("deny")
      expect(JSON.stringify(result.parsed)).toContain("changes requested")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })

  test("blocks gh pr checkout when PR has CHANGES_REQUESTED", async () => {
    const repo = await createTestRepo("https://github.com/owner/repo.git", {
      featureBranch: "feat/my-feature",
    })
    const fakeBin = await createFakeGhBin({ hasPr: true, reviewState: "CHANGES_REQUESTED" })
    try {
      const result = await runHook(repo, "gh pr checkout 99", fakeBin)
      expect(result.decision).toBe("deny")
      expect(JSON.stringify(result.parsed)).toContain("changes requested")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })

  test("allows git checkout when no open PR exists", async () => {
    const repo = await createTestRepo("https://github.com/owner/repo.git", {
      featureBranch: "feat/my-feature",
    })
    const fakeBin = await createFakeGhBin({ hasPr: false })
    try {
      const result = await runHook(repo, "git checkout main", fakeBin)
      expect(result.decision).toBe("allow")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })

  test("allows git checkout when PR reviews are only APPROVED", async () => {
    const repo = await createTestRepo("https://github.com/owner/repo.git", {
      featureBranch: "feat/my-feature",
    })
    const fakeBin = await createFakeGhBin({ hasPr: true, reviewState: "APPROVED" })
    try {
      const result = await runHook(repo, "git checkout main", fakeBin)
      expect(result.decision).toBe("allow")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })

  test("allows non-checkout commands even with CHANGES_REQUESTED", async () => {
    const repo = await createTestRepo("https://github.com/owner/repo.git", {
      featureBranch: "feat/my-feature",
    })
    const fakeBin = await createFakeGhBin({ hasPr: true, reviewState: "CHANGES_REQUESTED" })
    try {
      const result = await runHook(repo, 'git commit -m "wip"', fakeBin)
      expect(result.decision).toBe("allow")
    } finally {
      await Promise.all([
        rm(repo, { recursive: true, force: true }),
        rm(fakeBin, { recursive: true, force: true }),
      ])
    }
  })
})
