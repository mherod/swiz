import { beforeAll, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runBashHook, useTempDir } from "../src/utils/test-utils.ts"

const HOOK = "hooks/pretooluse-no-npm.ts"

const { create: makeTempDir } = useTempDir("swiz-no-npm-")

/** Temp project: pnpm-lock only (swiz repo root has bun.lock → bun wins for PM detection). */
let pnpmOnlyCwd: string

beforeAll(async () => {
  const dir = await makeTempDir("swiz-no-npm-pnpm-only-")
  await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
  pnpmOnlyCwd = dir
})

function runHook(command: string, opts: { toolName?: string; cwd?: string } = {}) {
  return runBashHook(HOOK, command, { cwd: pnpmOnlyCwd, ...opts })
}

describe("pretooluse-no-npm (pnpm project)", () => {
  describe("npm commands are blocked", () => {
    test("npm install is denied", async () => {
      const result = await runHook("npm install")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("pnpm")
    })

    test("npm install <pkg> is denied", async () => {
      const result = await runHook("npm install lodash")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("pnpm add")
    })

    test("npm install -D is denied", async () => {
      const result = await runHook("npm install -D typescript")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("pnpm add -D")
    })

    test("npm run dev is denied", async () => {
      const result = await runHook("npm run dev")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("pnpm run")
    })

    test("npm test is denied", async () => {
      const result = await runHook("npm test")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("pnpm test")
    })
  })

  describe("npx is blocked", () => {
    test("npx some-tool is denied", async () => {
      const result = await runHook("npx some-tool")
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("pnpm dlx")
    })

    test("npx tsc is denied", async () => {
      const result = await runHook("npx tsc --noEmit")
      expect(result.decision).toBe("deny")
    })
  })

  describe("pnpm commands are allowed", () => {
    test("pnpm install passes through", async () => {
      const result = await runHook("pnpm install")
      expect(result.decision).toBe("allow")
    })

    test("pnpm dlx passes through", async () => {
      const result = await runHook("pnpm dlx tsc")
      expect(result.decision).toBe("allow")
    })

    test("pnpm test passes through", async () => {
      const result = await runHook("pnpm test")
      expect(result.decision).toBe("allow")
    })

    test("pnpm run dev passes through", async () => {
      const result = await runHook("pnpm run dev")
      expect(result.decision).toBe("allow")
    })

    test("bun install also passes through (plausible alternative)", async () => {
      const result = await runHook("bun install")
      expect(result.decision).toBe("allow")
    })
  })

  describe("non-shell tools are ignored", () => {
    test("Edit tool with npm command exits silently", async () => {
      const result = await runHook("npm install", { toolName: "Edit" })
      expect(result.stdout).toBe("")
    })
  })

  describe("no lockfile: enforcement skipped", () => {
    test("npm install in a directory with no lockfile passes through", async () => {
      const dir = await makeTempDir()
      const result = await runHook("npm install", { cwd: dir })
      // No lockfile means PM=null → exits 0 with no output
      expect(result.stdout).toBe("")
    })

    test("pnpm lockfile enforces pnpm", async () => {
      const dir = await makeTempDir()
      await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
      const result = await runHook("npm install", { cwd: dir })
      expect(result.decision).toBe("deny")
      expect(result.reason).toContain("pnpm")
    })

    test("bun runtime command in pnpm project passes through", async () => {
      const dir = await makeTempDir()
      await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n")
      const result = await runHook("swiz tasks list", { cwd: dir })
      expect(result.stdout).toBe("")
    })
  })
})
