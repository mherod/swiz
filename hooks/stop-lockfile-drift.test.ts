import { describe, expect, test } from "bun:test"
import { type PkgJson, pkgJsonDepsChanged } from "./stop-lockfile-drift/lockfile-detector.ts"

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

  test("packageManager change is drift", () => {
    const oldPkg = pkg({ packageManager: "pnpm@10.30.1" })
    const newPkg = pkg({ packageManager: "pnpm@10.33.0" })
    expect(pkgJsonDepsChanged(oldPkg, newPkg)).toBe(true)
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
