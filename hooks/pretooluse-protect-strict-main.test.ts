import { describe, expect, test } from "bun:test"
import { isStrictMainDisableCommand } from "./pretooluse-protect-strict-main.ts"

describe("isStrictMainDisableCommand", () => {
  describe("blocks disable commands", () => {
    test("swiz settings disable strict-no-direct-main", () => {
      expect(isStrictMainDisableCommand("swiz settings disable strict-no-direct-main")).toBe(true)
    })

    test("swiz settings set strict-no-direct-main false", () => {
      expect(isStrictMainDisableCommand("swiz settings set strict-no-direct-main false")).toBe(true)
    })

    test("kebab-case alias: strict-main", () => {
      expect(isStrictMainDisableCommand("swiz settings disable strict-main")).toBe(true)
    })

    test("kebab-case alias: no-direct-main", () => {
      expect(isStrictMainDisableCommand("swiz settings disable no-direct-main")).toBe(true)
    })

    test("camelCase alias: strictNoDirectMain", () => {
      expect(isStrictMainDisableCommand("swiz settings disable strictNoDirectMain")).toBe(true)
    })

    test("snake_case alias: strict_no_direct_main", () => {
      expect(isStrictMainDisableCommand("swiz settings disable strict_no_direct_main")).toBe(true)
    })

    test("lowercase alias: strictnodirectmain", () => {
      expect(isStrictMainDisableCommand("swiz settings disable strictnodirectmain")).toBe(true)
    })
  })

  describe("allows non-disable commands", () => {
    test("git status", () => {
      expect(isStrictMainDisableCommand("git status")).toBe(false)
    })

    test("swiz settings enable strict-no-direct-main", () => {
      expect(isStrictMainDisableCommand("swiz settings enable strict-no-direct-main")).toBe(false)
    })

    test("swiz settings set strict-no-direct-main true", () => {
      expect(isStrictMainDisableCommand("swiz settings set strict-no-direct-main true")).toBe(false)
    })

    test("swiz settings disable some-other-setting", () => {
      expect(isStrictMainDisableCommand("swiz settings disable some-other-setting")).toBe(false)
    })

    test("echo with the command still matches (strict-is-safer)", () => {
      // The function matches anywhere in the string — this is intentional.
      // An agent has no legitimate reason to echo this command pattern.
      expect(isStrictMainDisableCommand("echo swiz settings disable strict-no-direct-main")).toBe(
        true
      )
    })
  })
})
