/**
 * Unit tests for the FORCE_PUSH_RE regex exported from pretooluse-push-cooldown.ts.
 *
 * Verifies that all documented force-push bypass flags are recognised, and that
 * non-force push commands are NOT falsely matched.
 */
import { describe, expect, it } from "bun:test"
import { FORCE_PUSH_RE } from "./hook-utils.ts"

describe("FORCE_PUSH_RE — force bypass detection", () => {
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

    it("matches --force before remote/branch", () => {
      expect(FORCE_PUSH_RE.test("git push --force")).toBe(true)
    })

    it("matches --force-with-lease before remote/branch", () => {
      expect(FORCE_PUSH_RE.test("git push --force-with-lease")).toBe(true)
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

    it("does not match git push with --tags only", () => {
      expect(FORCE_PUSH_RE.test("git push --tags")).toBe(false)
    })

    it("does not match non-push git commands", () => {
      expect(FORCE_PUSH_RE.test("git fetch --force")).toBe(false)
    })
  })
})
