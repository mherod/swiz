/**
 * Unit tests for isEslintConfigFile regex and countEnforcements.
 * Tests all supported file formats to prevent regressions on the regex.
 */
import { describe, expect, test } from "bun:test"
import { countEnforcements, isEslintConfigFile } from "./pretooluse-eslint-config-strength.ts"

// ═══════════════════════════════════════════════════════════════════════════════
// isEslintConfigFile: Modern flat config formats
// ═══════════════════════════════════════════════════════════════════════════════

describe("isEslintConfigFile: modern flat config", () => {
  test("eslint.config.js", () => {
    expect(isEslintConfigFile("eslint.config.js")).toBe(true)
  })

  test("eslint.config.mjs", () => {
    expect(isEslintConfigFile("eslint.config.mjs")).toBe(true)
  })

  test("eslint.config.cjs", () => {
    expect(isEslintConfigFile("eslint.config.cjs")).toBe(true)
  })

  test("eslint.config.ts", () => {
    expect(isEslintConfigFile("eslint.config.ts")).toBe(true)
  })

  test("eslint.config.mts", () => {
    expect(isEslintConfigFile("eslint.config.mts")).toBe(true)
  })

  test("eslint.config.cts", () => {
    expect(isEslintConfigFile("eslint.config.cts")).toBe(true)
  })

  test("nested path: src/eslint.config.js", () => {
    expect(isEslintConfigFile("src/eslint.config.js")).toBe(true)
  })

  test("nested path: packages/app/eslint.config.ts", () => {
    expect(isEslintConfigFile("packages/app/eslint.config.ts")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// isEslintConfigFile: Legacy .eslintrc formats
// ═══════════════════════════════════════════════════════════════════════════════

describe("isEslintConfigFile: legacy .eslintrc formats", () => {
  test(".eslintrc (no extension)", () => {
    expect(isEslintConfigFile(".eslintrc")).toBe(true)
  })

  test(".eslintrc.json", () => {
    expect(isEslintConfigFile(".eslintrc.json")).toBe(true)
  })

  test(".eslintrc.js", () => {
    expect(isEslintConfigFile(".eslintrc.js")).toBe(true)
  })

  test(".eslintrc.cjs", () => {
    expect(isEslintConfigFile(".eslintrc.cjs")).toBe(true)
  })

  test(".eslintrc.yml", () => {
    expect(isEslintConfigFile(".eslintrc.yml")).toBe(true)
  })

  test(".eslintrc.yaml", () => {
    expect(isEslintConfigFile(".eslintrc.yaml")).toBe(true)
  })

  test("nested path: config/.eslintrc.json", () => {
    expect(isEslintConfigFile("config/.eslintrc.json")).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// isEslintConfigFile: Negative cases (should NOT match)
// ═══════════════════════════════════════════════════════════════════════════════

describe("isEslintConfigFile: negative cases", () => {
  test("regular TypeScript file", () => {
    expect(isEslintConfigFile("src/index.ts")).toBe(false)
  })

  test("regular JavaScript file", () => {
    expect(isEslintConfigFile("src/utils.js")).toBe(false)
  })

  test("package.json", () => {
    expect(isEslintConfigFile("package.json")).toBe(false)
  })

  test("tsconfig.json", () => {
    expect(isEslintConfigFile("tsconfig.json")).toBe(false)
  })

  test("not-eslint.config.js (similar name, different prefix)", () => {
    expect(isEslintConfigFile("not-eslint.config.js")).toBe(false)
  })

  test("my-eslint.config.ts (prefixed name)", () => {
    expect(isEslintConfigFile("my-eslint.config.ts")).toBe(false)
  })

  test("eslint.config.json (unsupported extension)", () => {
    expect(isEslintConfigFile("eslint.config.json")).toBe(false)
  })

  test("eslint.config.yaml (unsupported for flat config)", () => {
    expect(isEslintConfigFile("eslint.config.yaml")).toBe(false)
  })

  test(".eslintrc.ts (unsupported legacy extension)", () => {
    expect(isEslintConfigFile(".eslintrc.ts")).toBe(false)
  })

  test(".eslintrc.mjs (unsupported legacy extension)", () => {
    expect(isEslintConfigFile(".eslintrc.mjs")).toBe(false)
  })

  test("eslintrc.json (missing dot prefix for legacy)", () => {
    expect(isEslintConfigFile("eslintrc.json")).toBe(false)
  })

  test("empty string", () => {
    expect(isEslintConfigFile("")).toBe(false)
  })

  test("eslint.config (no extension)", () => {
    expect(isEslintConfigFile("eslint.config")).toBe(false)
  })

  test(".eslint.config.js (spurious dot prefix)", () => {
    expect(isEslintConfigFile(".eslint.config.js")).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// countEnforcements: keyword counting
// ═══════════════════════════════════════════════════════════════════════════════

describe("countEnforcements", () => {
  test("counts quoted 'warning' keywords", () => {
    const r = countEnforcements('"no-unused-vars": "warning", "semi": "warning"')
    expect(r.warnings).toBe(2)
    expect(r.errors).toBe(0)
  })

  test("counts quoted 'error' keywords", () => {
    const r = countEnforcements('"no-unused-vars": "error", "semi": "error"')
    expect(r.warnings).toBe(0)
    expect(r.errors).toBe(2)
  })

  test("counts 'off' as errors", () => {
    const r = countEnforcements('"no-unused-vars": "off"')
    expect(r.warnings).toBe(0)
    expect(r.errors).toBe(1)
  })

  test("counts 'warn' as warnings", () => {
    const r = countEnforcements('"no-unused-vars": "warn"')
    expect(r.warnings).toBe(1)
    expect(r.errors).toBe(0)
  })

  test("counts mixed warning and error keywords", () => {
    const r = countEnforcements('"a": "warning", "b": "error", "c": "off", "d": "warn"')
    expect(r.warnings).toBe(2) // "warning" + "warn"
    expect(r.errors).toBe(2) // "error" + "off"
  })

  test("empty string returns zero counts", () => {
    const r = countEnforcements("")
    expect(r.warnings).toBe(0)
    expect(r.errors).toBe(0)
  })

  test("content without eslint keywords returns zero", () => {
    const r = countEnforcements('{"name": "my-app", "version": "1.0.0"}')
    expect(r.warnings).toBe(0)
    expect(r.errors).toBe(0)
  })

  test("single-quoted values are counted", () => {
    const r = countEnforcements("'no-unused-vars': 'warning', 'semi': 'error'")
    expect(r.warnings).toBe(1)
    expect(r.errors).toBe(1)
  })

  test("case insensitive matching", () => {
    const r = countEnforcements('"a": "WARNING", "b": "Error", "c": "OFF"')
    expect(r.warnings).toBe(1)
    expect(r.errors).toBe(2)
  })
})
