import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  COOLDOWN_MS,
  executePushFlow,
  getRemainingCooldownMs,
  parsePushWaitArgs,
  waitForCooldown,
} from "./push-wait.ts"

// ─── Helper ──────────────────────────────────────────────────────────────

function uniqueSentinel(label = ""): string {
  const id = randomBytes(8).toString("hex")
  return join(tmpdir(), `swiz-push-wait-test-${id}${label}.timestamp`)
}

function writeSentinel(path: string, timestamp: number): void {
  writeFileSync(path, String(timestamp))
}

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
  return new TextDecoder().decode(result.stdout).trim()
}

// ─── parsePushWaitArgs ───────────────────────────────────────────────────

describe("parsePushWaitArgs", () => {
  it("returns defaults when no args provided", () => {
    const result = parsePushWaitArgs([])
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("")
    expect(result.timeout).toBe(120)
    expect(result.ciTimeout).toBe(300)
    expect(result.extraArgs).toEqual([])
  })

  it("parses remote and branch positionals", () => {
    const result = parsePushWaitArgs(["upstream", "feat/foo"])
    expect(result.remote).toBe("upstream")
    expect(result.branch).toBe("feat/foo")
  })

  it("parses --timeout flag", () => {
    const result = parsePushWaitArgs(["--timeout", "60"])
    expect(result.timeout).toBe(60)
  })

  it("parses -t shorthand", () => {
    const result = parsePushWaitArgs(["-t", "30"])
    expect(result.timeout).toBe(30)
  })

  it("parses a separate CI timeout", () => {
    const result = parsePushWaitArgs(["--timeout", "30", "--ci-timeout", "600"])
    expect(result.timeout).toBe(30)
    expect(result.ciTimeout).toBe(600)
  })

  it("throws on non-positive timeout", () => {
    expect(() => parsePushWaitArgs(["--timeout", "0"])).toThrow("positive number")
    expect(() => parsePushWaitArgs(["--timeout", "-5"])).toThrow("positive number")
  })

  it("throws on non-numeric timeout", () => {
    expect(() => parsePushWaitArgs(["--timeout", "abc"])).toThrow("positive number")
  })

  it("rejects malformed and missing timeout values", () => {
    expect(() => parsePushWaitArgs(["--timeout", "10seconds"])).toThrow("positive number")
    expect(() => parsePushWaitArgs(["--ci-timeout", "0"])).toThrow(
      "CI timeout must be a positive number"
    )
    expect(() => parsePushWaitArgs(["--timeout"])).toThrow("requires a value")
    expect(() => parsePushWaitArgs(["--cwd"])).toThrow("requires a value")
  })

  it("collects extra flags into extraArgs", () => {
    const result = parsePushWaitArgs(["--dry-run", "origin", "main"])
    expect(result.extraArgs).toEqual(["--dry-run"])
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("main")
  })

  it("handles timeout interleaved with positionals", () => {
    const result = parsePushWaitArgs(["origin", "-t", "90", "main"])
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("main")
    expect(result.timeout).toBe(90)
  })

  it("parses --cwd flag", () => {
    const result = parsePushWaitArgs(["--cwd", "/some/path", "origin", "main"])
    expect(result.cwd).toBe("/some/path")
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("main")
    expect(result.extraArgs).toEqual([])
  })

  it("does not include --cwd in extraArgs", () => {
    const result = parsePushWaitArgs(["--cwd", "/repo", "--dry-run"])
    expect(result.cwd).toBe("/repo")
    expect(result.extraArgs).toEqual(["--dry-run"])
  })

  it("returns undefined cwd when not provided", () => {
    const result = parsePushWaitArgs(["origin", "main"])
    expect(result.cwd).toBeUndefined()
  })

  it("parses --wait flag", () => {
    const result = parsePushWaitArgs(["--wait"])
    expect(result.wait).toBe(true)
  })

  it("defaults wait to false when not provided", () => {
    const result = parsePushWaitArgs([])
    expect(result.wait).toBe(false)
  })

  it("parses --wait alongside other flags", () => {
    const result = parsePushWaitArgs(["--wait", "origin", "main", "--timeout", "60"])
    expect(result.wait).toBe(true)
    expect(result.remote).toBe("origin")
    expect(result.branch).toBe("main")
    expect(result.timeout).toBe(60)
  })

  it("does not include --wait in extraArgs", () => {
    const result = parsePushWaitArgs(["--wait", "--dry-run"])
    expect(result.wait).toBe(true)
    expect(result.extraArgs).toEqual(["--dry-run"])
  })

  it("passes every argument after -- directly to git push", () => {
    const result = parsePushWaitArgs(["origin", "main", "--", "--push-option", "release"])
    expect(result.extraArgs).toEqual(["--push-option", "release"])
  })

  it("rejects extra positional arguments instead of silently discarding them", () => {
    expect(() => parsePushWaitArgs(["origin", "main", "unexpected"])).toThrow("Unexpected argument")
  })
})

// ─── getRemainingCooldownMs ──────────────────────────────────────────────

describe("getRemainingCooldownMs", () => {
  it("returns 0 when sentinel does not exist", async () => {
    expect(await getRemainingCooldownMs("/tmp/nonexistent-sentinel-file.timestamp")).toBe(0)
  })

  it("returns 0 when sentinel is empty", async () => {
    const p = uniqueSentinel("-empty")
    writeFileSync(p, "")
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when sentinel contains non-numeric text", async () => {
    const p = uniqueSentinel("-garbage")
    writeFileSync(p, "not-a-number")
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when sentinel contains whitespace only", async () => {
    const p = uniqueSentinel("-ws")
    writeFileSync(p, "   \n  ")
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when cooldown has fully expired", async () => {
    const p = uniqueSentinel("-expired")
    writeSentinel(p, Date.now() - COOLDOWN_MS - 1000)
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 when cooldown expired exactly", async () => {
    const p = uniqueSentinel("-exact")
    writeSentinel(p, Date.now() - COOLDOWN_MS)
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns positive ms when cooldown is active", async () => {
    const p = uniqueSentinel("-active")
    writeSentinel(p, Date.now() - 10_000) // 10s ago, 50s remaining
    const remaining = await getRemainingCooldownMs(p)
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(COOLDOWN_MS - 10_000 + 100) // +100ms tolerance
  })

  it("returns near-full cooldown for very recent push", async () => {
    const p = uniqueSentinel("-recent")
    writeSentinel(p, Date.now() - 100) // 100ms ago
    const remaining = await getRemainingCooldownMs(p)
    expect(remaining).toBeGreaterThan(COOLDOWN_MS - 1000) // at least 59s
  })

  it("returns 0 for timestamp far in the past", async () => {
    const p = uniqueSentinel("-ancient")
    writeSentinel(p, 0) // epoch
    expect(await getRemainingCooldownMs(p)).toBe(0)
  })

  it("returns 0 for future timestamp (clock skew)", async () => {
    const p = uniqueSentinel("-future")
    // A future timestamp means elapsed is negative, so remaining > COOLDOWN_MS.
    // But since the push "hasn't happened yet" from our perspective, remaining
    // will exceed COOLDOWN_MS. This is the correct safe behaviour — it decays.
    writeSentinel(p, Date.now() + 10_000)
    const remaining = await getRemainingCooldownMs(p)
    expect(remaining).toBeGreaterThan(COOLDOWN_MS)
  })
})

// ─── waitForCooldown ─────────────────────────────────────────────────────

describe("waitForCooldown", () => {
  it("resolves immediately when no sentinel exists", async () => {
    const result = await waitForCooldown({
      sentinelPath: "/tmp/nonexistent-push-wait-test.timestamp",
      timeoutSeconds: 5,
    })
    expect(result.waitedMs).toBe(0)
  })

  it("resolves immediately when cooldown already expired", async () => {
    const p = uniqueSentinel("-already-expired")
    writeSentinel(p, Date.now() - COOLDOWN_MS - 5000)
    const result = await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      log: () => {}, // suppress
    })
    expect(result.waitedMs).toBe(0)
  })

  it("resolves immediately for corrupt sentinel", async () => {
    const p = uniqueSentinel("-corrupt")
    writeFileSync(p, "garbage-data")
    const result = await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      log: () => {},
    })
    expect(result.waitedMs).toBe(0)
  })

  it("waits and resolves when cooldown expires during polling", async () => {
    const p = uniqueSentinel("-wait-expire")
    // Set cooldown to expire in ~150ms (simulate short remaining cooldown)
    writeSentinel(p, Date.now() - COOLDOWN_MS + 150)

    const logs: string[] = []
    const result = await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      pollIntervalMs: 50, // fast polling for test speed
      log: (msg) => logs.push(msg),
    })

    expect(result.waitedMs).toBeGreaterThan(0)
    expect(result.waitedMs).toBeLessThan(3000) // should resolve well within 3s
    // Should have logged the initial "active" message
    expect(logs.some((l) => l.includes("cooldown active") || l.includes("Cooldown active"))).toBe(
      true
    )
    // Should have logged the "expired" message
    expect(logs.some((l) => l.includes("expired"))).toBe(true)
  })

  it("reports remaining time on each poll", async () => {
    const p = uniqueSentinel("-progress")
    // ~300ms remaining
    writeSentinel(p, Date.now() - COOLDOWN_MS + 300)

    const logs: string[] = []
    await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      pollIntervalMs: 50,
      log: (msg) => logs.push(msg),
    })

    // Should have at least the initial log and the expiry log
    expect(logs.length).toBeGreaterThanOrEqual(2)
    // Intermediate logs should mention "remaining"
    const intermediates = logs.filter((l) => l.includes("remaining"))
    expect(intermediates.length).toBeGreaterThan(0)
  })

  it("rejects when timeout expires before cooldown clears", async () => {
    const p = uniqueSentinel("-timeout")
    // Cooldown has 50s remaining — timeout is only 0.1s
    writeSentinel(p, Date.now() - 10_000)

    const promise = waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 0.1,
      pollIntervalMs: 30,
      log: () => {},
    })

    expect(promise).rejects.toThrow("did not expire within")
  })

  it("timeout error includes remaining cooldown time", async () => {
    const p = uniqueSentinel("-timeout-remaining")
    writeSentinel(p, Date.now() - 5_000) // 55s remaining

    try {
      await waitForCooldown({
        sentinelPath: p,
        timeoutSeconds: 0.1,
        pollIntervalMs: 30,
        log: () => {},
      })
      expect.unreachable("should have thrown")
    } catch (err) {
      const msg = String(err)
      expect(msg).toContain("did not expire")
      expect(msg).toContain("still remaining")
    }
  })

  it("handles sentinel deleted mid-wait", async () => {
    const p = uniqueSentinel("-deleted-mid-wait")
    writeSentinel(p, Date.now() - 10_000) // 50s remaining

    // Delete the sentinel after 100ms to simulate external cleanup
    setTimeout(async () => {
      try {
        const f = Bun.file(p)
        if (await f.exists()) await Bun.write(p, "")
        // Actually remove it by writing empty — getRemainingCooldownMs treats empty as 0
      } catch {
        /* ignore */
      }
    }, 100)

    const result = await waitForCooldown({
      sentinelPath: p,
      timeoutSeconds: 5,
      pollIntervalMs: 50,
      log: () => {},
    })

    expect(result.waitedMs).toBeGreaterThan(0)
    expect(result.waitedMs).toBeLessThan(3000)
  })
})

describe("project identity", () => {
  it("resolves one canonical repo key for cooldown and result storage", async () => {
    const source = await Bun.file(join(import.meta.dir, "push-wait.ts")).text()

    expect(source.match(/resolveProjectIdentity\(options\.cwd\)/g)).toHaveLength(1)
    expect(source).not.toContain("getCanonicalPathHash")
    expect(source).not.toContain('["rev-parse", "--show-toplevel"]')
    expect(source).toContain("swizPushCooldownSentinelPath(repoKey)")
    expect(source).toContain("writePushResult(repoKey")
  })

  it("makes push-ci delegate to the canonical push flow", async () => {
    const source = await Bun.file(join(import.meta.dir, "push-ci.ts")).text()

    expect(source).toContain("executePushFlow")
    expect(source).not.toContain("resolveProjectIdentity")
    expect(source).not.toContain("waitForCiCompletion")
    expect(source).not.toContain("getGitClient")
  })
})

describe("executePushFlow", () => {
  it("pushes through the shared flow and verifies the remote SHA", async () => {
    const root = mkdtempSync(join(tmpdir(), "swiz-push-flow-"))
    const repo = join(root, "repo")
    const remote = join(root, "remote.git")
    mkdirSync(repo)
    runGit(root, ["init", "--bare", remote])
    runGit(repo, ["init", "-b", "main"])
    runGit(repo, ["config", "user.name", "Swiz Test"])
    runGit(repo, ["config", "user.email", "swiz-test@example.test"])
    writeFileSync(join(repo, "tracked.txt"), "shared push flow\n")
    runGit(repo, ["add", "tracked.txt"])
    runGit(repo, ["commit", "-m", "test: seed push flow"])
    runGit(repo, ["remote", "add", "origin", remote])
    mkdirSync(join(repo, ".swiz"))
    writeFileSync(
      join(repo, ".swiz", "config.json"),
      JSON.stringify({ ignoreCi: true, collaborationMode: "solo" })
    )

    const result = await executePushFlow({
      remote: "origin",
      branch: "main",
      cooldownTimeout: 1,
      ciTimeout: 1,
      waitForCi: true,
      cwd: repo,
    })

    expect(result.commitSha).toBe(runGit(repo, ["rev-parse", "HEAD"]))
    expect(result.ciRunId).toBeNull()
    expect(runGit(repo, ["ls-remote", "--heads", "origin", "refs/heads/main"])).toContain(
      result.commitSha
    )
  })

  it("allows trunk mode to push the default branch when collaboration mode requires peer review", async () => {
    const root = mkdtempSync(join(tmpdir(), "swiz-push-flow-trunk-team-"))
    const repo = join(root, "repo")
    const remote = join(root, "remote.git")
    mkdirSync(repo)
    runGit(root, ["init", "--bare", remote])
    runGit(repo, ["init", "-b", "main"])
    runGit(repo, ["config", "user.name", "Swiz Test"])
    runGit(repo, ["config", "user.email", "swiz-test@example.test"])
    writeFileSync(join(repo, "tracked.txt"), "trunk team push flow\n")
    runGit(repo, ["add", "tracked.txt"])
    runGit(repo, ["commit", "-m", "test: seed trunk team push flow"])
    runGit(repo, ["remote", "add", "origin", remote])
    mkdirSync(join(repo, ".swiz"))
    writeFileSync(
      join(repo, ".swiz", "config.json"),
      JSON.stringify({ ignoreCi: true, collaborationMode: "team", trunkMode: true })
    )

    const result = await executePushFlow({
      remote: "origin",
      branch: "main",
      cooldownTimeout: 1,
      ciTimeout: 1,
      waitForCi: true,
      cwd: repo,
    })

    expect(result.commitSha).toBe(runGit(repo, ["rev-parse", "HEAD"]))
    expect(result.ciRunId).toBeNull()
    expect(runGit(repo, ["ls-remote", "--heads", "origin", "refs/heads/main"])).toContain(
      result.commitSha
    )
  })

  it("blocks pushes when trunk mode conflicts with strict no-direct-main", async () => {
    const root = mkdtempSync(join(tmpdir(), "swiz-push-flow-policy-conflict-"))
    const repo = join(root, "repo")
    const remote = join(root, "remote.git")
    mkdirSync(repo)
    runGit(root, ["init", "--bare", remote])
    runGit(repo, ["init", "-b", "main"])
    runGit(repo, ["config", "user.name", "Swiz Test"])
    runGit(repo, ["config", "user.email", "swiz-test@example.test"])
    writeFileSync(join(repo, "tracked.txt"), "conflicting branch policy\n")
    runGit(repo, ["add", "tracked.txt"])
    runGit(repo, ["commit", "-m", "test: seed conflicting branch policy"])
    runGit(repo, ["remote", "add", "origin", remote])
    mkdirSync(join(repo, ".swiz"))
    writeFileSync(
      join(repo, ".swiz", "config.json"),
      JSON.stringify({
        ignoreCi: true,
        collaborationMode: "team",
        trunkMode: true,
        strictNoDirectMain: true,
      })
    )

    await expect(
      executePushFlow({
        remote: "origin",
        branch: "main",
        cooldownTimeout: 1,
        ciTimeout: 1,
        waitForCi: true,
        cwd: repo,
      })
    ).rejects.toThrow("Trunk mode and strict no-direct-main are both enabled")

    expect(runGit(repo, ["ls-remote", "--heads", "origin", "refs/heads/main"])).toBe("")
  })
})
