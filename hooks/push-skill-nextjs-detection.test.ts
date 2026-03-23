/**
 * Regression tests for the Next.js project-type detection and
 * route-conflict script status logic used in the /push skill template
 * (~/.claude/skills/push/SKILL.md).
 *
 * Detection is implemented via detectFrameworks() from hook-utils.ts.
 * The helper runDetection() below mirrors the logic the push skill uses:
 *   1. detectFrameworks(dir).has("nextjs")  — is this a Next.js project?
 *   2. Check scripts/check-route-conflicts.sh exists   — is the gate wired?
 *
 * Scenarios covered:
 *   C1  next.config.js  + script ABSENT  → "missing (Next.js project…)"
 *   C2  next.config.js  + script PRESENT → "present"
 *   C3  dependencies.next in package.json + script ABSENT  → "missing…"
 *   C4  devDependencies.next             + script PRESENT  → "present"
 *   C5  package.json WITHOUT next, no config file          → "N/A"
 *   C6  next.config.ts  + script ABSENT                   → "missing…"
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearFrameworkCache, detectFrameworks } from "./utils/hook-utils.ts"

// ─── Detection helper (mirrors push skill logic) ───────────────────────────────

async function runDetection(dir: string): Promise<string> {
  const frameworks = await detectFrameworks(dir)
  const isNextjs = frameworks.has("nextjs")
  if (!isNextjs) return "N/A (not a Next.js project)"
  const scriptPath = join(dir, "scripts", "check-route-conflicts.sh")
  if (existsSync(scriptPath)) return "scripts/check-route-conflicts.sh present"
  return "scripts/check-route-conflicts.sh missing (Next.js project — this gate is not wired up)"
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "push-skill-nextjs-"))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true })
})

afterEach(() => {
  clearFrameworkCache()
})

async function fixture(name: string): Promise<string> {
  const dir = join(tmpDir, name)
  await mkdir(dir, { recursive: true })
  return dir
}

// ─── Matrix tests ─────────────────────────────────────────────────────────────

describe("Next.js detection — next.config.* file detection", () => {
  test("C1: next.config.js present, script ABSENT → reports missing", async () => {
    const dir = await fixture("c1")
    await Bun.write(join(dir, "next.config.js"), "module.exports = {}")
    expect(await runDetection(dir)).toBe(
      "scripts/check-route-conflicts.sh missing (Next.js project — this gate is not wired up)"
    )
  })

  test("C2: next.config.js present, script PRESENT → reports present", async () => {
    const dir = await fixture("c2")
    await Bun.write(join(dir, "next.config.js"), "module.exports = {}")
    await mkdir(join(dir, "scripts"), { recursive: true })
    await Bun.write(join(dir, "scripts", "check-route-conflicts.sh"), "#!/bin/sh")
    expect(await runDetection(dir)).toBe("scripts/check-route-conflicts.sh present")
  })

  test("C6: next.config.ts present, script ABSENT → reports missing", async () => {
    const dir = await fixture("c6")
    await Bun.write(join(dir, "next.config.ts"), "export default {}")
    expect(await runDetection(dir)).toBe(
      "scripts/check-route-conflicts.sh missing (Next.js project — this gate is not wired up)"
    )
  })

  test("next.config.mjs present, script ABSENT → reports missing", async () => {
    const dir = await fixture("c-mjs")
    await Bun.write(join(dir, "next.config.mjs"), "export default {}")
    expect(await runDetection(dir)).toBe(
      "scripts/check-route-conflicts.sh missing (Next.js project — this gate is not wired up)"
    )
  })

  test("next.config.cjs present, script ABSENT → reports missing", async () => {
    const dir = await fixture("c-cjs")
    await Bun.write(join(dir, "next.config.cjs"), "module.exports = {}")
    expect(await runDetection(dir)).toBe(
      "scripts/check-route-conflicts.sh missing (Next.js project — this gate is not wired up)"
    )
  })
})

describe("Next.js detection — package.json dependency detection", () => {
  test("C3: dependencies.next present, script ABSENT → reports missing", async () => {
    const dir = await fixture("c3")
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0", react: "18.0.0" } })
    )
    expect(await runDetection(dir)).toBe(
      "scripts/check-route-conflicts.sh missing (Next.js project — this gate is not wired up)"
    )
  })

  test("C4: devDependencies.next present, script PRESENT → reports present", async () => {
    const dir = await fixture("c4")
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { next: "14.0.0" } })
    )
    await mkdir(join(dir, "scripts"), { recursive: true })
    await Bun.write(join(dir, "scripts", "check-route-conflicts.sh"), "#!/bin/sh")
    expect(await runDetection(dir)).toBe("scripts/check-route-conflicts.sh present")
  })
})

describe("Non-Next.js project detection", () => {
  test("C5: package.json without next, no config file → N/A", async () => {
    const dir = await fixture("c5")
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { react: "18.0.0" } })
    )
    expect(await runDetection(dir)).toBe("N/A (not a Next.js project)")
  })

  test("empty directory → N/A", async () => {
    const dir = await fixture("c-empty")
    expect(await runDetection(dir)).toBe("N/A (not a Next.js project)")
  })

  test("package.json with no deps → N/A", async () => {
    const dir = await fixture("c-no-deps")
    await Bun.write(join(dir, "package.json"), JSON.stringify({ name: "my-cli" }))
    expect(await runDetection(dir)).toBe("N/A (not a Next.js project)")
  })

  test("CLI project (like swiz) → N/A", async () => {
    const dir = await fixture("c-swiz-like")
    await Bun.write(
      join(dir, "package.json"),
      JSON.stringify({
        name: "swiz",
        devDependencies: { "@biomejs/biome": "1.0.0", lefthook: "2.0.0" },
      })
    )
    expect(await runDetection(dir)).toBe("N/A (not a Next.js project)")
  })
})
