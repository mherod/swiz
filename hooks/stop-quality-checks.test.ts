import { describe, expect, test } from "bun:test"
import { findScript, LINT_SCRIPTS, TYPECHECK_SCRIPTS } from "./stop-quality-checks.ts"

describe("stop-quality-checks: findScript", () => {
  describe("lint script discovery", () => {
    test("finds 'lint' when present", () => {
      expect(findScript({ lint: "biome check ." }, LINT_SCRIPTS)).toBe("lint")
    })

    test("finds 'lint:check' when 'lint' is absent", () => {
      expect(findScript({ "lint:check": "biome check ." }, LINT_SCRIPTS)).toBe("lint:check")
    })

    test("finds 'eslint' when higher-priority names are absent", () => {
      expect(findScript({ eslint: "eslint src" }, LINT_SCRIPTS)).toBe("eslint")
    })

    test("finds 'biome:check' as lowest-priority lint fallback", () => {
      expect(findScript({ "biome:check": "biome check ." }, LINT_SCRIPTS)).toBe("biome:check")
    })

    test("returns first match when multiple lint scripts present", () => {
      expect(findScript({ lint: "biome check .", eslint: "eslint src" }, LINT_SCRIPTS)).toBe("lint")
    })

    test("returns null when no lint script present", () => {
      expect(findScript({ build: "tsc -p tsconfig.build.json" }, LINT_SCRIPTS)).toBeNull()
    })

    test("returns null for empty scripts object", () => {
      expect(findScript({}, LINT_SCRIPTS)).toBeNull()
    })

    test("ignores non-string script values", () => {
      expect(findScript({ lint: 42 as unknown as string }, LINT_SCRIPTS)).toBeNull()
    })
  })

  describe("typecheck script discovery", () => {
    test("finds 'typecheck' when present", () => {
      expect(findScript({ typecheck: "tsc --noEmit" }, TYPECHECK_SCRIPTS)).toBe("typecheck")
    })

    test("finds 'type-check' when 'typecheck' is absent", () => {
      expect(findScript({ "type-check": "tsc --noEmit" }, TYPECHECK_SCRIPTS)).toBe("type-check")
    })

    test("finds 'tsc' when higher-priority names are absent", () => {
      expect(findScript({ tsc: "tsc --noEmit" }, TYPECHECK_SCRIPTS)).toBe("tsc")
    })

    test("finds 'check:types' as lowest-priority typecheck fallback", () => {
      expect(findScript({ "check:types": "tsc --noEmit" }, TYPECHECK_SCRIPTS)).toBe("check:types")
    })

    test("returns first match when multiple typecheck scripts present", () => {
      expect(
        findScript({ typecheck: "tsc --noEmit", "type-check": "vue-tsc" }, TYPECHECK_SCRIPTS)
      ).toBe("typecheck")
    })

    test("returns null when no typecheck script present", () => {
      expect(findScript({ lint: "eslint src", build: "tsc" }, TYPECHECK_SCRIPTS)).toBeNull()
    })
  })

  describe("script name priority ordering", () => {
    test("LINT_SCRIPTS has lint as first priority", () => {
      expect(LINT_SCRIPTS[0]).toBe("lint")
    })

    test("TYPECHECK_SCRIPTS has typecheck as first priority", () => {
      expect(TYPECHECK_SCRIPTS[0]).toBe("typecheck")
    })

    test("both arrays are non-empty", () => {
      expect(LINT_SCRIPTS.length).toBeGreaterThan(0)
      expect(TYPECHECK_SCRIPTS.length).toBeGreaterThan(0)
    })
  })
})
