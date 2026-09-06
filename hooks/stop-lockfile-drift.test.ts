import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { commitFile, makeTempGitRepo, useTempDir } from "../src/utils/test-utils.ts"
import {
  detectLockfile,
  findDriftedPackages,
  type PkgJson,
  pkgJsonDepsChanged,
} from "./stop-lockfile-drift/lockfile-detector.ts"
import type { LockfileDriftContext } from "./stop-lockfile-drift/types.ts"

const temp = useTempDir("swiz-lockfile-selection-")

function pkg(extra: Partial<PkgJson> = {}): PkgJson {
  return {
    name: "swiz",
    version: "0.1.0",
    scripts: { test: "bun test --concurrent --timeout=10000" },
    dependencies: { "@modelcontextprotocol/sdk": "1.27.1" },
    devDependencies: { typescript: "5.8.2" },
    ...extra,
  }
}

describe("pkgJsonDepsChanged", () => {
  test("script-only edit is not drift", () => {
    const oldPkg = pkg()
    const newPkg = pkg({
      scripts: { test: "bun test --concurrent --timeout=5000" },
    })
    expect(pkgJsonDepsChanged(oldPkg, newPkg)).toBe(false)
  })

  test("metadata-only edit is not drift", () => {
    const oldPkg = pkg({ name: "swiz" })
    const newPkg = pkg({ name: "swiz-cli", version: "0.2.0" })
    expect(pkgJsonDepsChanged(oldPkg, newPkg)).toBe(false)
  })

  test("new dependency is drift", () => {
    const oldPkg = pkg()
    const newPkg = pkg({
      dependencies: { "@modelcontextprotocol/sdk": "1.27.1", zod: "4.0.0" },
    })
    expect(pkgJsonDepsChanged(oldPkg, newPkg)).toBe(true)
  })

  test("version bump is drift", () => {
    const oldPkg = pkg()
    const newPkg = pkg({
      dependencies: { "@modelcontextprotocol/sdk": "1.28.0" },
    })
    expect(pkgJsonDepsChanged(oldPkg, newPkg)).toBe(true)
  })

  test("removed devDependency is drift", () => {
    const oldPkg = pkg()
    const newPkg = pkg({ devDependencies: {} })
    expect(pkgJsonDepsChanged(oldPkg, newPkg)).toBe(true)
  })

  test("packageManager-only change does not change dependency resolutions", () => {
    const oldPkg = pkg({ packageManager: "pnpm@10.30.1" })
    const newPkg = pkg({ packageManager: "pnpm@10.33.0" })
    expect(pkgJsonDepsChanged(oldPkg, newPkg)).toBe(false)
  })

  test("dependency changes remain drift when packageManager also changes", () => {
    expect(pkgJsonDepsChanged(pkg(), pkg({ packageManager: "bun@1.3.14", dependencies: {} }))).toBe(
      true
    )
  })

  test("identical objects are not drift", () => {
    expect(pkgJsonDepsChanged(pkg(), pkg())).toBe(false)
  })

  test("missing dep sections on both sides are not drift", () => {
    const oldPkg: PkgJson = { name: "x", version: "1.0.0" }
    const newPkg: PkgJson = { name: "x", version: "1.0.1" }
    expect(pkgJsonDepsChanged(oldPkg, newPkg)).toBe(false)
  })
})

describe("lockfile selection", () => {
  test.each([
    { manager: "bun", locks: ["bun.lock"], selected: "bun.lock" },
    { manager: "bun", locks: ["bun.lockb"], selected: "bun.lockb" },
    { manager: "bun", locks: ["bun.lock", "pnpm-lock.yaml"], selected: "bun.lock" },
    { manager: "bun", locks: ["bun.lock", "bun.lockb"], selected: "bun.lock" },
    { manager: "pnpm", locks: ["bun.lock", "pnpm-lock.yaml"], selected: "pnpm-lock.yaml" },
    { manager: "pnpm", locks: ["shrinkwrap.yaml"], selected: "shrinkwrap.yaml" },
    { manager: "npm", locks: ["bun.lock", "package-lock.json"], selected: "package-lock.json" },
    { manager: "yarn", locks: ["bun.lock", "yarn.lock"], selected: "yarn.lock" },
  ])("selects $selected for declared $manager", async ({ manager, locks, selected }) => {
    const cwd = await temp.create()
    await Bun.write(
      join(cwd, "package.json"),
      JSON.stringify({ packageManager: `${manager}@1.0.0` })
    )
    for (const lockfile of locks) await Bun.write(join(cwd, lockfile), "lock fixture")
    expect(await detectLockfile(cwd, ".")).toEqual({
      lockfile: selected,
      installCmd: `${manager} install`,
    })
  })

  test("does not prescribe a different manager when the declared lockfile is absent", async () => {
    const cwd = await temp.create()
    await Bun.write(join(cwd, "package.json"), JSON.stringify({ packageManager: "bun@1.3.14" }))
    await Bun.write(join(cwd, "pnpm-lock.yaml"), "legacy lock")
    expect(await detectLockfile(cwd, ".")).toBeNull()
  })

  test("honours a nested package manager instead of the root manager", async () => {
    const cwd = await temp.create()
    await Bun.write(join(cwd, "package.json"), JSON.stringify({ packageManager: "bun@1.3.14" }))
    await Bun.write(
      join(cwd, "packages/app/package.json"),
      JSON.stringify({ packageManager: "npm@11.0.0" })
    )
    await Bun.write(join(cwd, "packages/app/bun.lock"), "legacy lock")
    await Bun.write(join(cwd, "packages/app/package-lock.json"), "npm lock")
    expect(await detectLockfile(cwd, "packages/app")).toEqual({
      lockfile: "packages/app/package-lock.json",
      installCmd: "npm install",
    })
  })
})

async function driftFixture(
  options: { nested?: boolean; metadataOnly?: boolean } = {}
): Promise<LockfileDriftContext> {
  const cwd = await makeTempGitRepo(temp, { seedCommits: 0 })
  const pkgFile = options.nested ? "packages/app/package.json" : "package.json"
  await commitFile(cwd, pkgFile, JSON.stringify(pkg()))
  await Bun.write(join(cwd, "package.json"), JSON.stringify(pkg({ packageManager: "bun@1.3.14" })))
  await Bun.write(join(cwd, "bun.lock"), "bun lock")
  await Bun.write(join(cwd, "pnpm-lock.yaml"), "legacy lock")
  if (options.nested) await Bun.write(join(cwd, "packages/app/bun.lock"), "nested lock")
  const next = options.metadataOnly
    ? pkg({ packageManager: "bun@1.3.14" })
    : pkg({ packageManager: "bun@1.3.14", dependencies: { "@modelcontextprotocol/sdk": "1.28.0" } })
  await Bun.write(join(cwd, pkgFile), JSON.stringify(next))
  return { cwd, sessionId: null, range: "HEAD", changedFiles: new Set([pkgFile]) }
}

describe("Bun dependency drift", () => {
  test("requires the Bun lockfile when dependency versions change", async () => {
    const context = await driftFixture()
    expect(await findDriftedPackages(context)).toEqual([
      { pkgFile: "package.json", lockfile: "bun.lock", installCmd: "bun install" },
    ])
  })

  test("accepts a declaration-only edit with unchanged dependency maps", async () => {
    expect(await findDriftedPackages(await driftFixture({ metadataOnly: true }))).toEqual([])
  })

  test("accepts an updated Bun lockfile", async () => {
    const context = await driftFixture()
    context.changedFiles.add("bun.lock")
    expect(await findDriftedPackages(context)).toEqual([])
  })

  test("an unrelated root lockfile cannot cover nested Bun dependency changes", async () => {
    const context = await driftFixture({ nested: true })
    context.changedFiles.add("pnpm-lock.yaml")
    expect(await findDriftedPackages(context)).toEqual([
      {
        pkgFile: "packages/app/package.json",
        lockfile: "packages/app/bun.lock",
        installCmd: "bun install",
      },
    ])
  })

  test("an updated root Bun lockfile covers nested package changes", async () => {
    const context = await driftFixture({ nested: true })
    context.changedFiles.add("bun.lock")
    expect(await findDriftedPackages(context)).toEqual([])
  })
})
