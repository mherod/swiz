import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { useTempDir } from "../src/utils/test-utils.ts"

// Use absolute path so the script is found regardless of spawn CWD.
const HOOK_PATH = resolve(process.cwd(), "hooks/pretooluse-no-npm.ts")

const _tmp = useTempDir()
async function makeTempDir(suffix = ""): Promise<string> {
  return await _tmp.create(`swiz-detect-pm${suffix}-`)
}

/**
 * Spawn the no-npm hook from a given CWD and check whether `npm install`
 * is blocked or passes through. This exercises detectPackageManager() end-to-end
 * because the hook calls it using SWIZ_PROJECT_CWD (if set) or process.cwd().
 */
async function npmDecisionInDir(
  dir: string
): Promise<{ decision: string | undefined; reason: string | undefined }> {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install" } })
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: dir,
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited
  if (!out.trim()) return { decision: undefined, reason: undefined }
  const parsed = JSON.parse(out.trim())
  const hso = parsed.hookSpecificOutput
  return {
    decision: hso?.permissionDecision ?? parsed.decision,
    reason: hso?.permissionDecisionReason ?? parsed.reason,
  }
}

/** Same but for `pnpm install` — used to confirm PM detection without relying on deny message text. */
async function pnpmDecisionInDir(dir: string): Promise<string | undefined> {
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "pnpm install" } })
  const proc = Bun.spawn(["bun", HOOK_PATH], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: dir,
  })
  await proc.stdin.write(payload)
  await proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited
  if (!out.trim()) return undefined
  const parsed = JSON.parse(out.trim())
  return parsed.hookSpecificOutput?.permissionDecision ?? parsed.decision
}

// ─── package.json packageManager field (primary detection) ─────────────────

describe("detectPackageManager — package.json packageManager field", () => {
  test('packageManager: "pnpm@10.29.3" → detects pnpm, npm is blocked', async () => {
    const dir = await makeTempDir("-pkg-pnpm")
    await writeFile(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.29.3" }))
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm")
  })

  test('packageManager: "npm@9.8.1" → detects npm, npm install allowed', async () => {
    const dir = await makeTempDir("-pkg-npm")
    await writeFile(join(dir, "package.json"), JSON.stringify({ packageManager: "npm@9.8.1" }))
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("allow") // npm is allowed (plausible invocation)
  })

  test('packageManager: "yarn@3.6.0" → detects yarn, npm is blocked', async () => {
    const dir = await makeTempDir("-pkg-yarn")
    await writeFile(join(dir, "package.json"), JSON.stringify({ packageManager: "yarn@3.6.0" }))
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("yarn")
  })

  test('packageManager: "bun@1.0.0" → detects bun, npm is blocked', async () => {
    const dir = await makeTempDir("-pkg-bun")
    await writeFile(join(dir, "package.json"), JSON.stringify({ packageManager: "bun@1.0.0" }))
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bun")
  })

  test("packageManager field takes priority over lock files", async () => {
    const dir = await makeTempDir("-pkg-priority")
    // package.json says pnpm, but lock files suggest bun
    await writeFile(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.29.3" }))
    await writeFile(join(dir, "bun.lock"), "")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm") // packageManager field wins
  })
})

// ─── .npmrc pnpm-specific config detection (secondary detection) ──────────────

describe("detectPackageManager — .npmrc pnpm config hints", () => {
  test(".npmrc with node-linker=hoisted → detects pnpm", async () => {
    const dir = await makeTempDir("-npmrc-hoisted")
    await writeFile(join(dir, ".npmrc"), "node-linker=hoisted\n")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm")
  })

  test(".npmrc with shamefully-hoist=true → detects pnpm", async () => {
    const dir = await makeTempDir("-npmrc-shameful")
    await writeFile(join(dir, ".npmrc"), "shamefully-hoist=true\n")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm")
  })

  test(".npmrc with strict-peer-dependencies=false → detects pnpm", async () => {
    const dir = await makeTempDir("-npmrc-strict")
    await writeFile(join(dir, ".npmrc"), "strict-peer-dependencies=false\n")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm")
  })

  test(".npmrc with multiple pnpm config keys → detects pnpm", async () => {
    const dir = await makeTempDir("-npmrc-multi")
    await writeFile(
      join(dir, ".npmrc"),
      "node-linker=hoisted\nshamefully-hoist=true\nstrict-peer-dependencies=false\n"
    )
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm")
  })

  test(".npmrc without pnpm keys → passes through (falls to lock files)", async () => {
    const dir = await makeTempDir("-npmrc-no-pnpm")
    await writeFile(join(dir, ".npmrc"), "registry=https://registry.npmjs.org\n")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBeUndefined() // No PM detected
  })

  test(".npmrc pnpm config takes priority over lock files", async () => {
    const dir = await makeTempDir("-npmrc-priority")
    // .npmrc says pnpm, but lock files suggest yarn
    await writeFile(join(dir, ".npmrc"), "node-linker=hoisted\n")
    await writeFile(join(dir, "yarn.lock"), "")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm") // .npmrc config wins
  })
})

// ─── Priority ordering (packageManager > .npmrc > lock files) ────────────────

describe("detectPackageManager — detection priority", () => {
  test("packageManager field overrides .npmrc config", async () => {
    const dir = await makeTempDir("-priority-pkg-npmrc")
    // package.json says npm, .npmrc says pnpm
    await writeFile(join(dir, "package.json"), JSON.stringify({ packageManager: "npm@9.8.1" }))
    await writeFile(join(dir, ".npmrc"), "node-linker=hoisted\n")
    const result = await npmDecisionInDir(dir)
    // npm is allowed (passes through), pnpm detection never runs
    expect(result.decision).toBe("allow")
  })

  test("packageManager field overrides all lock files", async () => {
    const dir = await makeTempDir("-priority-pkg-locks")
    // package.json says yarn, all lock files present
    await writeFile(join(dir, "package.json"), JSON.stringify({ packageManager: "yarn@3.6.0" }))
    await writeFile(join(dir, "bun.lock"), "")
    await writeFile(join(dir, "pnpm-lock.yaml"), "")
    await writeFile(join(dir, "package-lock.json"), "{}")
    await writeFile(join(dir, "npm-shrinkwrap.json"), "{}")
    await writeFile(join(dir, ".pnp.cjs"), "")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("yarn") // packageManager field is used
  })
})

// ─── Walk-up behavior for new detection methods ───────────────────────────────

describe("detectPackageManager — walk-up for package.json and .npmrc", () => {
  test("package.json in parent directory is found", async () => {
    const parent = await makeTempDir("-walk-pkg-parent")
    const child = join(parent, "packages", "app")
    await mkdir(child, { recursive: true })
    await writeFile(
      join(parent, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.29.3" })
    )
    const result = await npmDecisionInDir(child)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm")
  })

  test(".npmrc in parent directory is found", async () => {
    const parent = await makeTempDir("-walk-npmrc-parent")
    const child = join(parent, "subdir")
    await mkdir(child, { recursive: true })
    await writeFile(join(parent, ".npmrc"), "node-linker=hoisted\n")
    const result = await npmDecisionInDir(child)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm")
  })

  test("child package.json takes priority over parent package.json", async () => {
    const parent = await makeTempDir("-walk-pkg-precedence")
    const child = join(parent, "child")
    await mkdir(child)
    await writeFile(join(parent, "package.json"), JSON.stringify({ packageManager: "yarn@3.6.0" }))
    await writeFile(join(child, "package.json"), JSON.stringify({ packageManager: "pnpm@10.29.3" }))
    const result = await npmDecisionInDir(child)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm") // child wins
  })

  test("child .npmrc takes priority over parent .npmrc", async () => {
    const parent = await makeTempDir("-walk-npmrc-precedence")
    const child = join(parent, "child")
    await mkdir(child)
    await writeFile(join(parent, ".npmrc"), "registry=https://npm.com\n")
    await writeFile(join(child, ".npmrc"), "node-linker=hoisted\n")
    const result = await npmDecisionInDir(child)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm") // child's pnpm config wins
  })
})

// ─── No lockfile ─────────────────────────────────────────────────────────────

describe("detectPackageManager — no lockfile", () => {
  test("returns null → hook allows everything", async () => {
    const dir = await makeTempDir("-empty")
    // npm install should pass through (can't enforce without knowing the PM)
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBeUndefined()
  })
})

// ─── bun lockfile variants ───────────────────────────────────────────────────

describe("detectPackageManager — bun lockfiles", () => {
  test("bun.lock → detects bun, npm is blocked", async () => {
    const dir = await makeTempDir("-bunlock")
    await writeFile(join(dir, "bun.lock"), "")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bun")
  })

  test("bun.lockb → detects bun, npm is blocked", async () => {
    const dir = await makeTempDir("-bunlockb")
    await writeFile(join(dir, "bun.lockb"), "")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bun")
  })

  test("bun.lock → pnpm install remains allowed (plausible alternative)", async () => {
    const dir = await makeTempDir("-bunlock-pnpm")
    await writeFile(join(dir, "bun.lock"), "")
    const decision = await pnpmDecisionInDir(dir)
    expect(decision).toBe("allow")
  })
})

// ─── Other package managers ───────────────────────────────────────────────────

describe("detectPackageManager — pnpm / yarn / npm", () => {
  test("pnpm-lock.yaml → pnpm detected, npm blocked", async () => {
    const dir = await makeTempDir("-pnpm")
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm")
  })

  test("yarn.lock → yarn detected, npm blocked", async () => {
    const dir = await makeTempDir("-yarn")
    await writeFile(join(dir, "yarn.lock"), "")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("yarn")
  })

  test("shrinkwrap.yaml → pnpm detected, npm blocked", async () => {
    const dir = await makeTempDir("-pnpm-shrinkwrap")
    await writeFile(join(dir, "shrinkwrap.yaml"), "lockfileVersion: 6.0\n")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm")
  })

  test(".pnp.cjs → yarn detected, npm blocked", async () => {
    const dir = await makeTempDir("-yarn-pnp")
    await writeFile(join(dir, ".pnp.cjs"), "module.exports = {};\n")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("yarn")
  })

  test("package-lock.json → npm detected, npm install is allowed", async () => {
    const dir = await makeTempDir("-npm")
    await writeFile(join(dir, "package-lock.json"), "{}")
    // npm is the project PM → hook should pass npm through
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("allow")
  })

  test("npm-shrinkwrap.json → npm detected, npm install is allowed", async () => {
    const dir = await makeTempDir("-npm-shrinkwrap")
    await writeFile(join(dir, "npm-shrinkwrap.json"), "{}")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("allow")
  })
})

// ─── Nested lockfile (walk-up) ────────────────────────────────────────────────

describe("detectPackageManager — lockfile in parent directory", () => {
  test("bun.lock in parent is found when CWD is a subdirectory", async () => {
    const parent = await makeTempDir("-parent")
    const child = join(parent, "packages", "app")
    await mkdir(child, { recursive: true })
    await writeFile(join(parent, "bun.lock"), "")
    // CWD has no lockfile; parent does → should walk up and detect bun
    const result = await npmDecisionInDir(child)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bun")
  })

  test("pnpm-lock.yaml two levels up is still found", async () => {
    const root = await makeTempDir("-root")
    const deep = join(root, "a", "b", "c")
    await mkdir(deep, { recursive: true })
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
    const result = await npmDecisionInDir(deep)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm")
  })

  test("child lockfile takes precedence over parent lockfile", async () => {
    const parent = await makeTempDir("-precedence")
    const child = join(parent, "child")
    await mkdir(child)
    // Parent has pnpm, child has bun → child wins
    await writeFile(join(parent, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
    await writeFile(join(child, "bun.lock"), "")
    const result = await npmDecisionInDir(child)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bun") // bun wins, not pnpm
  })
})

// ─── Conflicting lockfiles (priority order) ───────────────────────────────────

describe("detectPackageManager — conflicting lockfiles in same directory", () => {
  test("bun.lock + pnpm-lock.yaml → bun wins (checked first)", async () => {
    const dir = await makeTempDir("-conflict-bun-pnpm")
    await writeFile(join(dir, "bun.lock"), "")
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
    const result = await npmDecisionInDir(dir)
    expect(result.reason).toContain("bun")
    // pnpm install should pass through (treated as plausible alternative)
    const pnpmDecision = await pnpmDecisionInDir(dir)
    expect(pnpmDecision).toBe("allow")
  })

  test("pnpm-lock.yaml + yarn.lock → pnpm wins", async () => {
    const dir = await makeTempDir("-conflict-pnpm-yarn")
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
    await writeFile(join(dir, "yarn.lock"), "")
    const result = await npmDecisionInDir(dir)
    expect(result.reason).toContain("pnpm")
  })

  test("yarn.lock + package-lock.json → yarn wins", async () => {
    const dir = await makeTempDir("-conflict-yarn-npm")
    await writeFile(join(dir, "yarn.lock"), "")
    await writeFile(join(dir, "package-lock.json"), "{}")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("yarn")
  })

  test("shrinkwrap.yaml + npm-shrinkwrap.json → pnpm wins", async () => {
    const dir = await makeTempDir("-conflict-pnpm-npm")
    await writeFile(join(dir, "shrinkwrap.yaml"), "lockfileVersion: 6.0\n")
    await writeFile(join(dir, "npm-shrinkwrap.json"), "{}")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("pnpm")
  })

  test("bun.lockb + bun.lock → both detect bun (either file is sufficient)", async () => {
    const dir = await makeTempDir("-both-bun")
    await writeFile(join(dir, "bun.lockb"), "")
    await writeFile(join(dir, "bun.lock"), "")
    const result = await npmDecisionInDir(dir)
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("bun")
  })
})
