import { describe, expect, test } from "bun:test"
import { runBashHook } from "../src/utils/test-utils.ts"

const HOOK = "hooks/pretooluse-no-git-checks.ts"

function runHook(command: string, opts: { toolName?: string } = {}) {
  return runBashHook(HOOK, command, opts)
}

describe("pretooluse-no-git-checks", () => {
  describe("blocks --no-git-checks with npm and pnpm", () => {
    test("npm publish --no-git-checks is denied", async () => {
      const result = await runHook("npm publish --no-git-checks")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("--no-git-checks")
    })

    test("pnpm publish --no-git-checks is denied", async () => {
      const result = await runHook("pnpm publish --no-git-checks")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("--no-git-checks")
    })

    test("pnpm -r publish --no-git-checks is denied", async () => {
      const result = await runHook("pnpm -r publish --no-git-checks")
      expect(result.decision).toBe("deny")
    })

    test("pnpm publish --no-git-checks=true is denied", async () => {
      const result = await runHook("pnpm publish --no-git-checks=true")
      expect(result.decision).toBe("deny")
    })

    test("denial message explains the fix path", async () => {
      const result = await runHook("npm publish --no-git-checks")
      expect(result.reason).toContain("Commit or stash")
      expect(result.reason).toContain("publish")
    })
  })

  describe("blocks env-var equivalent", () => {
    test("npm_config_no_git_checks=1 npm publish is denied", async () => {
      const result = await runHook("npm_config_no_git_checks=1 npm publish")
      expect(result.decision).toBe("deny")
    })

    test("pnpm_config_no_git_checks=true pnpm publish is denied", async () => {
      const result = await runHook("pnpm_config_no_git_checks=true pnpm publish")
      expect(result.decision).toBe("deny")
    })

    test("env npm_config_no_git_checks=1 npm publish is denied", async () => {
      const result = await runHook("env npm_config_no_git_checks=1 npm publish")
      expect(result.decision).toBe("deny")
    })
  })

  describe("allows benign commands", () => {
    test("npm publish without flag passes through", async () => {
      const result = await runHook("npm publish")
      expect(result.decision).not.toBe("deny")
    })

    test("pnpm install passes through", async () => {
      const result = await runHook("pnpm install")
      expect(result.decision).not.toBe("deny")
    })

    test("bun publish --no-git-checks passes through (bun does not own this flag)", async () => {
      const result = await runHook("bun publish --no-git-checks")
      expect(result.decision).not.toBe("deny")
    })

    test("matching token inside a quoted string is ignored", async () => {
      const result = await runHook("echo 'pnpm publish --no-git-checks'")
      expect(result.decision).not.toBe("deny")
    })
  })

  describe("non-shell tools are ignored", () => {
    test("Edit tool with the same command exits silently", async () => {
      const result = await runHook("npm publish --no-git-checks", { toolName: "Edit" })
      expect(result.stdout).toBe("")
    })
  })
})
