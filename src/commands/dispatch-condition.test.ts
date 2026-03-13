import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _clearFrameworkCache } from "../detect-frameworks.ts"
import { evalCondition } from "../manifest.ts"

describe("evalCondition", () => {
  const ORIGINAL_ENV: Record<string, string | undefined> = {}

  beforeEach(() => {
    ORIGINAL_ENV.MY_VAR = process.env.MY_VAR
    ORIGINAL_ENV.CI = process.env.CI
    ORIGINAL_ENV.SKIP_HOOK = process.env.SKIP_HOOK
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
      if (val === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = val
      }
    }
  })

  describe("undefined / empty condition", () => {
    it("returns true when condition is undefined", async () => {
      expect(await evalCondition(undefined)).toBe(true)
    })

    it("returns true when condition is empty string", async () => {
      expect(await evalCondition("")).toBe(true)
    })
  })

  describe("env:<VAR> — presence check", () => {
    it("returns true when env var is set to a non-empty value", async () => {
      process.env.MY_VAR = "anything"
      expect(await evalCondition("env:MY_VAR")).toBe(true)
    })

    it("returns false when env var is unset", async () => {
      delete process.env.MY_VAR
      expect(await evalCondition("env:MY_VAR")).toBe(false)
    })

    it("returns false when env var is set to empty string", async () => {
      process.env.MY_VAR = ""
      expect(await evalCondition("env:MY_VAR")).toBe(false)
    })
  })

  describe("env:<VAR>=<value> — equality check", () => {
    it("returns true when env var equals expected value", async () => {
      process.env.CI = "true"
      expect(await evalCondition("env:CI=true")).toBe(true)
    })

    it("returns false when env var does not equal expected value", async () => {
      process.env.CI = "false"
      expect(await evalCondition("env:CI=true")).toBe(false)
    })

    it("returns false when env var is unset", async () => {
      delete process.env.CI
      expect(await evalCondition("env:CI=true")).toBe(false)
    })

    it("matches empty string value explicitly", async () => {
      process.env.MY_VAR = ""
      expect(await evalCondition("env:MY_VAR=")).toBe(true)
    })
  })

  describe("env:<VAR>!=<value> — inequality check", () => {
    it("returns true when env var does not equal value", async () => {
      process.env.CI = "false"
      expect(await evalCondition("env:CI!=true")).toBe(true)
    })

    it("returns false when env var equals the excluded value", async () => {
      process.env.CI = "true"
      expect(await evalCondition("env:CI!=true")).toBe(false)
    })

    it("returns true when env var is unset (not equal to value)", async () => {
      delete process.env.CI
      expect(await evalCondition("env:CI!=true")).toBe(true)
    })

    it("typical CI-skip pattern: skip hook when CI=true", async () => {
      process.env.CI = "true"
      // condition "env:CI!=true" means "run this hook when NOT in CI"
      expect(await evalCondition("env:CI!=true")).toBe(false)

      process.env.CI = ""
      expect(await evalCondition("env:CI!=true")).toBe(true)

      delete process.env.CI
      expect(await evalCondition("env:CI!=true")).toBe(true)
    })
  })

  describe("unknown syntax — fail-open", () => {
    it("returns true for completely unknown syntax", async () => {
      expect(await evalCondition("unknown:WHATEVER")).toBe(true)
    })

    it("returns true for random garbage", async () => {
      expect(await evalCondition("not-a-condition")).toBe(true)
    })
  })

  describe("framework:<name> — framework detection", () => {
    let tmpDir: string

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "swiz-eval-condition-framework-"))
    })

    afterAll(async () => {
      await rm(tmpDir, { recursive: true })
    })

    afterEach(() => {
      _clearFrameworkCache()
    })

    it("returns false for 'framework:nextjs' when not a Next.js project", async () => {
      const dir = await mkdir(join(tmpDir, "plain"), { recursive: true }).then(() =>
        join(tmpDir, "plain")
      )
      const origCwd = process.cwd()
      process.chdir(dir)
      try {
        expect(await evalCondition("framework:nextjs")).toBe(false)
      } finally {
        process.chdir(origCwd)
        _clearFrameworkCache()
      }
    })

    it("returns true for 'framework:nextjs' when next.config.js exists in cwd", async () => {
      const dir = join(tmpDir, "nextjs-project")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "next.config.js"), "module.exports = {}")
      const origCwd = process.cwd()
      process.chdir(dir)
      try {
        expect(await evalCondition("framework:nextjs")).toBe(true)
      } finally {
        process.chdir(origCwd)
        _clearFrameworkCache()
      }
    })

    it("returns true for 'framework:go' when go.mod exists in cwd", async () => {
      const dir = join(tmpDir, "go-project")
      await mkdir(dir, { recursive: true })
      await Bun.write(join(dir, "go.mod"), "module example.com/app\n\ngo 1.21\n")
      const origCwd = process.cwd()
      process.chdir(dir)
      try {
        expect(await evalCondition("framework:go")).toBe(true)
      } finally {
        process.chdir(origCwd)
        _clearFrameworkCache()
      }
    })

    it("returns true (fail-open) for an unknown framework name", async () => {
      expect(await evalCondition("framework:not-a-real-framework")).toBe(true)
    })
  })
})
