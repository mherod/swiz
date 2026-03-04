import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { evalCondition } from "../manifest.ts"

describe("evalCondition", () => {
  const ORIGINAL_ENV: Record<string, string | undefined> = {}

  beforeEach(() => {
    ORIGINAL_ENV["MY_VAR"] = process.env["MY_VAR"]
    ORIGINAL_ENV["CI"] = process.env["CI"]
    ORIGINAL_ENV["SKIP_HOOK"] = process.env["SKIP_HOOK"]
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
    it("returns true when condition is undefined", () => {
      expect(evalCondition(undefined)).toBe(true)
    })

    it("returns true when condition is empty string", () => {
      expect(evalCondition("")).toBe(true)
    })
  })

  describe("env:<VAR> — presence check", () => {
    it("returns true when env var is set to a non-empty value", () => {
      process.env["MY_VAR"] = "anything"
      expect(evalCondition("env:MY_VAR")).toBe(true)
    })

    it("returns false when env var is unset", () => {
      delete process.env["MY_VAR"]
      expect(evalCondition("env:MY_VAR")).toBe(false)
    })

    it("returns false when env var is set to empty string", () => {
      process.env["MY_VAR"] = ""
      expect(evalCondition("env:MY_VAR")).toBe(false)
    })
  })

  describe("env:<VAR>=<value> — equality check", () => {
    it("returns true when env var equals expected value", () => {
      process.env["CI"] = "true"
      expect(evalCondition("env:CI=true")).toBe(true)
    })

    it("returns false when env var does not equal expected value", () => {
      process.env["CI"] = "false"
      expect(evalCondition("env:CI=true")).toBe(false)
    })

    it("returns false when env var is unset", () => {
      delete process.env["CI"]
      expect(evalCondition("env:CI=true")).toBe(false)
    })

    it("matches empty string value explicitly", () => {
      process.env["MY_VAR"] = ""
      expect(evalCondition("env:MY_VAR=")).toBe(true)
    })
  })

  describe("env:<VAR>!=<value> — inequality check", () => {
    it("returns true when env var does not equal value", () => {
      process.env["CI"] = "false"
      expect(evalCondition("env:CI!=true")).toBe(true)
    })

    it("returns false when env var equals the excluded value", () => {
      process.env["CI"] = "true"
      expect(evalCondition("env:CI!=true")).toBe(false)
    })

    it("returns true when env var is unset (not equal to value)", () => {
      delete process.env["CI"]
      expect(evalCondition("env:CI!=true")).toBe(true)
    })

    it("typical CI-skip pattern: skip hook when CI=true", () => {
      process.env["CI"] = "true"
      // condition "env:CI!=true" means "run this hook when NOT in CI"
      expect(evalCondition("env:CI!=true")).toBe(false)

      process.env["CI"] = ""
      expect(evalCondition("env:CI!=true")).toBe(true)

      delete process.env["CI"]
      expect(evalCondition("env:CI!=true")).toBe(true)
    })
  })

  describe("unknown syntax — fail-open", () => {
    it("returns true for completely unknown syntax", () => {
      expect(evalCondition("unknown:WHATEVER")).toBe(true)
    })

    it("returns true for random garbage", () => {
      expect(evalCondition("not-a-condition")).toBe(true)
    })
  })
})
