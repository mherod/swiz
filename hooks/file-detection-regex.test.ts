/**
 * Regression tests for file-detection regex patterns.
 * Prevents substring-matching vulnerabilities (e.g., my-eslint.config.ts matching the eslint config pattern).
 * Tests all filename-matching regexes used across hooks to ensure they correctly reject adversarial inputs.
 */
import { describe, expect, test } from "bun:test"
import { countEnforcements, isEslintConfigFile } from "./pretooluse-eslint-config-strength.ts"

// Import constants from hook-utils
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|kt|swift|php|cs|cpp|c|rs|vue|svelte)$/
const TEST_FILE_RE = /\.test\.|\.spec\.|__tests__|\/test\//

// Import from posttooluse-prettier-ts
const PRETTIER_TS = /\.(ts|tsx)$/

// ═══════════════════════════════════════════════════════════════════════════════
// isEslintConfigFile: Adversarial inputs to prevent reintroduction of substring bug
// ═══════════════════════════════════════════════════════════════════════════════

describe("isEslintConfigFile: adversarial inputs (substring prevention)", () => {
  describe("should reject (substring/invalid attempts)", () => {
    const invalid = [
      "my-eslint.config.ts", // Flat config with wrong prefix (should use (^|[/\\]) boundary)
      "not-eslint.config.js", // Flat config with wrong prefix
      "prettier-eslint.config.mjs", // Flat config with wrong prefix
      ".eslint.config.js", // Spurious dot prefix on flat config
      "eslint.config.tsx", // Invalid extension for flat config
      "eslint.config.json", // Unsupported extension for flat config
      "eslint.config.yaml", // Unsupported extension for flat config
      ".eslintrc.tsx", // Invalid legacy extension (tsx not supported)
      "eslintrc.json", // Missing dot prefix on legacy
    ];

    invalid.forEach((name) => {
      test(`${name}`, () => {
        expect(isEslintConfigFile(name)).toBe(false);
      });
    });
  });

  describe("should accept (valid patterns)", () => {
    const valid = [
      ".eslintrc",
      ".eslintrc.json",
      ".eslintrc.js",
      ".eslintrc.yml",
      "eslint.config.js",
      "eslint.config.ts",
      "eslint.config.mjs",
      "packages/eslint.config.js",
      "src/.eslintrc.json",
    ];

    valid.forEach((name) => {
      test(`${name}`, () => {
        expect(isEslintConfigFile(name)).toBe(true);
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE_EXT_RE: Verify safe suffix matching (no substring vulnerability)
// ═══════════════════════════════════════════════════════════════════════════════

describe("SOURCE_EXT_RE: file extension detection", () => {
  describe("valid source files", () => {
    const valid = [
      "index.ts",
      "utils.tsx",
      "script.js",
      "component.jsx",
      "config.mjs",
      "build.cjs",
      "data.py",
      "script.rb",
      "main.go",
      "App.java",
      "view.swift",
      "style.vue",
      "component.svelte",
      "src/utils.ts",
      "packages/lib/index.tsx",
      ".ts", // Edge case: file named just ".ts"
    ];

    valid.forEach((name) => {
      test(`${name}`, () => {
        expect(SOURCE_EXT_RE.test(name)).toBe(true);
      });
    });
  });

  describe("invalid source files (should not match)", () => {
    const invalid = [
      "file.txt",
      "data.json",
      "config.yaml",
      "image.png",
      "archive.zip",
      "Dockerfile",
      "Makefile",
      "README.md",
      "package.json",
      "tsconfig.json",
      "file.test.ts.bak", // Has .ts in middle but ends with .bak
      "script.ts.old",
      "typescript", // No extension
      ".gitignore",
      "file.d.txt", // Type definition but ends with .txt, not .ts
    ];

    invalid.forEach((name) => {
      test(`${name}`, () => {
        expect(SOURCE_EXT_RE.test(name)).toBe(false);
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST_FILE_RE: Verify pattern matching for test file detection
// ═══════════════════════════════════════════════════════════════════════════════

describe("TEST_FILE_RE: test file detection", () => {
  describe("test files (should match)", () => {
    const testFiles = [
      "utils.test.ts",
      "component.spec.tsx",
      "__tests__/utils.ts",
      "src/test/index.ts",
      "__tests__/integration/api.test.ts",
      "src/test/e2e/scenario.ts", // Requires /test/ with preceding path
      "foo.test.js",
      "bar.spec.jsx",
    ];

    testFiles.forEach((name) => {
      test(`${name}`, () => {
        expect(TEST_FILE_RE.test(name)).toBe(true);
      });
    });
  });

  describe("non-test files (should not match)", () => {
    const nonTestFiles = [
      "testing.ts", // Contains "test" but not as .test. or .spec.
      "contest.ts",
      "attestation.ts",
      "utils.ts",
      "index.tsx",
      "src/utils.ts",
      "backend.js",
      "tester.ts", // Similar to test but not exact pattern
      "test-data.json", // Starts with "test" but file is .json
    ];

    nonTestFiles.forEach((name) => {
      test(`${name}`, () => {
        expect(TEST_FILE_RE.test(name)).toBe(false);
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRETTIER_TS: Verify TypeScript file detection for prettier hook
// ═══════════════════════════════════════════════════════════════════════════════

describe("PRETTIER_TS regex: TypeScript file detection", () => {
  describe("TypeScript files (should match)", () => {
    const tsFiles = ["index.ts", "component.tsx", "src/utils.ts", ".ts"];

    tsFiles.forEach((name) => {
      test(`${name}`, () => {
        expect(PRETTIER_TS.test(name)).toBe(true);
      });
    });
  });

  describe("non-TypeScript files (should not match)", () => {
    const nonTsFiles = [
      "index.js",
      "component.jsx",
      "file.tsx.bak",
      "file.ts.old",
      "typescript-guide.md",
      "src/styles.css",
      "schema.json",
    ];

    nonTsFiles.forEach((name) => {
      test(`${name}`, () => {
        expect(PRETTIER_TS.test(name)).toBe(false);
      });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// countEnforcements: Verify keyword counting doesn't have false positives
// ═══════════════════════════════════════════════════════════════════════════════

describe("countEnforcements: keyword counting", () => {
  describe("counts keywords regardless of context", () => {
    test("counts 'warning' even in comments", () => {
      const r = countEnforcements('// warning: do not use\n"rule": "error"');
      expect(r.warnings).toBe(1); // Counts the comment too
      expect(r.errors).toBe(1);
    });

    test("counts 'error' in both comment and config", () => {
      const r = countEnforcements('// error: something failed\n"rule": "warning"');
      expect(r.warnings).toBe(1);
      expect(r.errors).toBe(1); // Counts the comment "error"
    });

    test("counts quoted keywords with varied spacing", () => {
      const r = countEnforcements('{ "rule" : "warning" , "other" : "error" }');
      expect(r.warnings).toBe(1);
      expect(r.errors).toBe(1);
    });

    test("counts partial word matches containing warning", () => {
      const r = countEnforcements('errorProneCode warningSign');
      expect(r.warnings).toBe(1); // "warningSign" contains "warning"
      expect(r.errors).toBe(1); // "errorProneCode" contains "error"
    });

    test("counts warn and off as well", () => {
      const r = countEnforcements('"rule": "warn", "other": "off"');
      expect(r.warnings).toBe(1); // "warn"
      expect(r.errors).toBe(1); // "off"
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-pattern consistency: All patterns should anchor correctly
// ═══════════════════════════════════════════════════════════════════════════════

describe("cross-pattern consistency: no substring vulnerabilities", () => {
  test("isEslintConfigFile rejects my-eslint.config.ts", () => {
    expect(isEslintConfigFile("my-eslint.config.ts")).toBe(false);
  });

  test("isEslintConfigFile accepts eslint.config.ts", () => {
    expect(isEslintConfigFile("eslint.config.ts")).toBe(true);
  });

  test("SOURCE_EXT_RE accepts my-file.ts (suffix is correct)", () => {
    expect(SOURCE_EXT_RE.test("my-file.ts")).toBe(true);
  });

  test("TEST_FILE_RE rejects my-test-file.ts (no .test. pattern)", () => {
    expect(TEST_FILE_RE.test("my-test-file.ts")).toBe(false);
  });

  test("TEST_FILE_RE accepts my-file.test.ts", () => {
    expect(TEST_FILE_RE.test("my-file.test.ts")).toBe(true);
  });

  test("PRETTIER_TS accepts my-prettier.ts (suffix is correct)", () => {
    expect(PRETTIER_TS.test("my-prettier.ts")).toBe(true);
  });
});
