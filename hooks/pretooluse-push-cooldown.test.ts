/**
 * Tests for push-cooldown force-bypass detection.
 *
 * Two layers:
 *   1. FORCE_PUSH_RE (regex) — regression tests for the documented bypass patterns
 *   2. hasGitPushForceFlag (token-based) — authoritative parser used by the hook,
 *      including edge cases the regex cannot handle correctly
 */
import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProjectIdentity } from "../src/project-identity.ts"
import type { ShellHookInput } from "../src/schemas.ts"
import { swizPushCooldownSentinelPath } from "../src/temp-paths.ts"
import { FORCE_PUSH_RE, hasGitPushForceFlag } from "../src/utils/git-utils.ts"
import { evaluatePosttoolusePushCooldown } from "./posttooluse-push-cooldown.ts"
import { evaluatePretoolusePushCooldown } from "./pretooluse-push-cooldown.ts"

// ── FORCE_PUSH_RE regression tests ───────────────────────────────────────────

describe("FORCE_PUSH_RE — regex bypass detection (regression)", () => {
  describe("bypasses cooldown (should match)", () => {
    it("matches --force", () => {
      expect(FORCE_PUSH_RE.test("git push --force origin main")).toBe(true)
    })
    it("matches --force-with-lease", () => {
      expect(FORCE_PUSH_RE.test("git push --force-with-lease origin main")).toBe(true)
    })
    it("matches --force-with-lease=<ref>", () => {
      expect(FORCE_PUSH_RE.test("git push --force-with-lease=abc123 origin main")).toBe(true)
    })
    it("matches --force-if-includes", () => {
      expect(FORCE_PUSH_RE.test("git push --force-if-includes origin main")).toBe(true)
    })
    it("matches short -f flag", () => {
      expect(FORCE_PUSH_RE.test("git push -f origin main")).toBe(true)
    })
    it("matches combined short flags containing f", () => {
      expect(FORCE_PUSH_RE.test("git push -fu origin main")).toBe(true)
    })
  })

  describe("does NOT bypass cooldown (should not match)", () => {
    it("does not match plain git push", () => {
      expect(FORCE_PUSH_RE.test("git push origin main")).toBe(false)
    })
    it("does not match git push with --set-upstream", () => {
      expect(FORCE_PUSH_RE.test("git push --set-upstream origin main")).toBe(false)
    })
    it("does not match git push with -u", () => {
      expect(FORCE_PUSH_RE.test("git push -u origin main")).toBe(false)
    })
    it("does not match git fetch --force", () => {
      expect(FORCE_PUSH_RE.test("git fetch --force")).toBe(false)
    })
  })
})

// ── hasGitPushForceFlag token-based parser tests ──────────────────────────────

describe("hasGitPushForceFlag — token-based parser", () => {
  describe("standard force flags", () => {
    it("detects --force", () => {
      expect(hasGitPushForceFlag("git push --force origin main")).toBe(true)
    })
    it("detects --force-with-lease", () => {
      expect(hasGitPushForceFlag("git push --force-with-lease origin main")).toBe(true)
    })
    it("detects --force-with-lease=<ref>", () => {
      expect(hasGitPushForceFlag("git push --force-with-lease=abc123 origin main")).toBe(true)
    })
    it("detects --force-if-includes", () => {
      expect(hasGitPushForceFlag("git push --force-if-includes origin main")).toBe(true)
    })
    it("detects -f", () => {
      expect(hasGitPushForceFlag("git push -f origin main")).toBe(true)
    })
    it("detects combined short flag -fu", () => {
      expect(hasGitPushForceFlag("git push -fu origin main")).toBe(true)
    })
  })

  describe("force flag in any operand position", () => {
    it("detects --force after remote and branch", () => {
      expect(hasGitPushForceFlag("git push origin main --force")).toBe(true)
    })
    it("detects --force-with-lease between remote and refspec", () => {
      expect(hasGitPushForceFlag("git push origin --force-with-lease main")).toBe(true)
    })
    it("detects --force before remote", () => {
      expect(hasGitPushForceFlag("git push --force")).toBe(true)
    })
  })

  describe("-- end-of-flags sentinel (edge cases regex gets wrong)", () => {
    it("does NOT treat --force after -- as a flag", () => {
      // `git push -- --force` means `--force` is a refspec, not a flag
      expect(hasGitPushForceFlag("git push -- --force")).toBe(false)
    })
    it("does NOT treat --force-with-lease after -- as a flag", () => {
      expect(hasGitPushForceFlag("git push origin -- --force-with-lease")).toBe(false)
    })
    it("detects --force BEFORE -- even when -- is present", () => {
      expect(hasGitPushForceFlag("git push --force -- origin main")).toBe(true)
    })
  })

  describe("git global options before subcommand", () => {
    it("detects --force when git has -C <dir>", () => {
      expect(hasGitPushForceFlag("git -C /some/path push --force")).toBe(true)
    })
    it("detects --force when git has -c key=val", () => {
      expect(hasGitPushForceFlag("git -c push.default=simple push --force")).toBe(true)
    })
    it("no false positive for git -C path without push", () => {
      expect(hasGitPushForceFlag("git -C /path status")).toBe(false)
    })
  })

  describe("chained commands", () => {
    it("detects --force in && chain", () => {
      expect(hasGitPushForceFlag("git add . && git commit -m 'wip' && git push --force")).toBe(true)
    })
    it("detects --force in || chain", () => {
      expect(hasGitPushForceFlag("git push --force || echo failed")).toBe(true)
    })
    it("detects --force in ; chain", () => {
      expect(hasGitPushForceFlag("echo 'pushing'; git push -f origin main")).toBe(true)
    })
    it("detects --force in newline-separated chain", () => {
      expect(hasGitPushForceFlag("git fetch\ngit push --force-with-lease")).toBe(true)
    })
    it("no false positive for non-push command with force flag in chain", () => {
      expect(hasGitPushForceFlag("git fetch --force && git status")).toBe(false)
    })
  })

  describe("non-force pushes — no bypass", () => {
    it("plain git push", () => {
      expect(hasGitPushForceFlag("git push origin main")).toBe(false)
    })
    it("git push --set-upstream", () => {
      expect(hasGitPushForceFlag("git push --set-upstream origin main")).toBe(false)
    })
    it("git push -u", () => {
      expect(hasGitPushForceFlag("git push -u origin main")).toBe(false)
    })
    it("git push --tags", () => {
      expect(hasGitPushForceFlag("git push --tags")).toBe(false)
    })
    it("git fetch --force is not a push", () => {
      expect(hasGitPushForceFlag("git fetch --force")).toBe(false)
    })
    it("echo string mentioning --force is not a push", () => {
      expect(hasGitPushForceFlag("echo 'run git push --force to override'")).toBe(false)
    })
  })

  describe("quoted arguments", () => {
    it("handles single-quoted remote name", () => {
      expect(hasGitPushForceFlag("git push --force 'origin' 'main'")).toBe(true)
    })
    it("handles double-quoted refspec", () => {
      expect(hasGitPushForceFlag('git push --force-with-lease "origin" "main"')).toBe(true)
    })
    it("no force in quoted refspec containing the word force", () => {
      expect(hasGitPushForceFlag('git push origin "refs/heads/--force"')).toBe(false)
    })
  })
})

describe("project identity", () => {
  it("uses the canonical cwd fallback outside a Git repository", async () => {
    const base = await mkdtemp(join(tmpdir(), "swiz-prepush-identity-"))
    const cwd = join(base, "plain")
    await mkdir(cwd, { recursive: true })
    const { repoKey } = await resolveProjectIdentity(cwd)
    const sentinelPath = swizPushCooldownSentinelPath(repoKey)
    await rm(sentinelPath, { force: true })

    try {
      const result = await evaluatePretoolusePushCooldown({
        cwd,
        tool_name: "Bash",
        tool_input: { command: "git push origin main", cwd },
      } as ShellHookInput)

      expect(
        "hookSpecificOutput" in result ? result.hookSpecificOutput?.permissionDecision : undefined
      ).toBe("allow")
    } finally {
      await Promise.all([
        rm(sentinelPath, { force: true }),
        rm(base, { recursive: true, force: true }),
      ])
    }
  })
})

describe("arming-session attribution (#847)", () => {
  async function withRepo(fn: (cwd: string, sentinelPath: string) => Promise<void>) {
    const base = await mkdtemp(join(tmpdir(), "swiz-push-attr-"))
    const cwd = join(base, "plain")
    await mkdir(cwd, { recursive: true })
    const { repoKey } = await resolveProjectIdentity(cwd)
    const sentinelPath = swizPushCooldownSentinelPath(repoKey)
    await rm(sentinelPath, { force: true })
    try {
      await fn(cwd, sentinelPath)
    } finally {
      await Promise.all([
        rm(sentinelPath, { force: true }),
        rm(base, { recursive: true, force: true }),
      ])
    }
  }

  async function pushAs(cwd: string, sessionId?: string) {
    const result = await evaluatePretoolusePushCooldown({
      cwd,
      ...(sessionId ? { session_id: sessionId } : {}),
      tool_name: "Bash",
      tool_input: { command: "git push origin main", cwd },
    } as ShellHookInput)
    const out = "hookSpecificOutput" in result ? result.hookSpecificOutput : undefined
    return { decision: out?.permissionDecision, reason: out?.permissionDecisionReason ?? "" }
  }

  async function armAs(cwd: string, sessionId?: string) {
    await evaluatePosttoolusePushCooldown({
      cwd,
      ...(sessionId ? { session_id: sessionId } : {}),
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
      tool_response: "",
    })
  }

  it("delays a peer session and names the session that armed the cooldown", () =>
    withRepo(async (cwd) => {
      await armAs(cwd, "session-a")
      const peer = await pushAs(cwd, "session-b")
      expect(peer.decision).toBe("deny")
      expect(peer.reason).toContain("by another session (`session-a`)")
      expect(peer.reason).not.toContain("by this session")
    }))

  it("tells the arming session that it armed the cooldown", () =>
    withRepo(async (cwd) => {
      await armAs(cwd, "session-a")
      const same = await pushAs(cwd, "session-a")
      expect(same.decision).toBe("deny")
      expect(same.reason).toContain("by this session")
    }))

  it("reports unknown provenance for a legacy timestamp sentinel without changing the decision", () =>
    withRepo(async (cwd, sentinelPath) => {
      await Bun.write(sentinelPath, String(Date.now()))
      const peer = await pushAs(cwd, "session-b")
      expect(peer.decision).toBe("deny")
      expect(peer.reason).toContain("by an unknown session")
    }))

  it("allows a push once a corrupt sentinel is found", () =>
    withRepo(async (cwd, sentinelPath) => {
      await Bun.write(sentinelPath, "{not json")
      expect((await pushAs(cwd, "session-b")).decision).toBe("allow")
    }))
})
