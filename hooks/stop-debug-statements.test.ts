import { describe, expect, test } from "bun:test"
import { SOURCE_EXT_RE, TEST_FILE_RE } from "./hook-utils.ts"
import {
  CONFIG_FILE_RE,
  DEBUGGER_RE,
  ESLINT_DEBUGGER_RULE_RE,
  GENERATED_FILE_RE,
  INFRA_FILE_RE,
  JS_DEBUG_RE,
  PY_PRINT_RE,
  RUBY_DEBUG_RE,
} from "./stop-debug-statements.ts"

function isScanned(filePath: string): boolean {
  return (
    SOURCE_EXT_RE.test(filePath) &&
    !TEST_FILE_RE.test(filePath) &&
    !INFRA_FILE_RE.test(filePath) &&
    !GENERATED_FILE_RE.test(filePath) &&
    !CONFIG_FILE_RE.test(filePath)
  )
}

describe("stop-debug-statements file filter", () => {
  describe("GENERATED_FILE_RE — compiled artifacts are excluded", () => {
    test("main.dart.js is excluded", () => {
      expect(isScanned("apps/portal/src/main.dart.js")).toBe(false)
    })

    test("nested main.dart.js is excluded", () => {
      expect(isScanned("apps/amp.raptor-london.co.uk/src/main.dart.js")).toBe(false)
    })

    test("any *.dart.js file is excluded", () => {
      expect(isScanned("build/output.dart.js")).toBe(false)
    })

    test("*.min.js is excluded", () => {
      expect(isScanned("public/vendor.min.js")).toBe(false)
    })

    test("*.bundle.js is excluded", () => {
      expect(isScanned("dist/app.bundle.js")).toBe(false)
    })

    test("*.chunk.js is excluded (webpack output)", () => {
      expect(isScanned("dist/123.chunk.js")).toBe(false)
    })
  })

  describe("INFRA_FILE_RE — infrastructure files are excluded", () => {
    test("hooks/ files are excluded", () => {
      expect(isScanned("hooks/stop-debug-statements.ts")).toBe(false)
    })

    test("commands/ files are excluded", () => {
      expect(isScanned("src/commands/status.ts")).toBe(false)
    })

    test("index.ts is excluded", () => {
      expect(isScanned("index.ts")).toBe(false)
    })

    test("dispatch.ts is excluded", () => {
      expect(isScanned("dispatch.ts")).toBe(false)
    })

    test("src/dispatch/ files are excluded", () => {
      expect(isScanned("src/dispatch/engine.ts")).toBe(false)
      expect(isScanned("src/dispatch/replay.ts")).toBe(false)
      expect(isScanned("src/dispatch/filters.ts")).toBe(false)
    })
  })

  describe("TEST_FILE_RE — test files are excluded", () => {
    test("*.test.ts is excluded", () => {
      expect(isScanned("src/utils.test.ts")).toBe(false)
    })

    test("*.spec.js is excluded", () => {
      expect(isScanned("src/utils.spec.js")).toBe(false)
    })

    test("files under /test/ directory are excluded", () => {
      expect(isScanned("src/test/helper.ts")).toBe(false)
      expect(isScanned("packages/core/test/fixtures.ts")).toBe(false)
    })
  })

  describe("CONFIG_FILE_RE — config files are excluded (issue #14)", () => {
    test("eslint.config.js is excluded", () => {
      expect(isScanned("eslint.config.js")).toBe(false)
    })

    test("eslint.config.mjs is excluded", () => {
      expect(isScanned("eslint.config.mjs")).toBe(false)
    })

    test("eslint.config.ts is excluded", () => {
      expect(isScanned("eslint.config.ts")).toBe(false)
    })

    test("vite.config.ts is excluded", () => {
      expect(isScanned("vite.config.ts")).toBe(false)
    })

    test("vitest.config.ts is excluded", () => {
      expect(isScanned("vitest.config.ts")).toBe(false)
    })

    test("jest.config.js is excluded", () => {
      expect(isScanned("jest.config.js")).toBe(false)
    })

    test("webpack.config.js is excluded", () => {
      expect(isScanned("webpack.config.js")).toBe(false)
    })

    test("babel.config.js is excluded", () => {
      expect(isScanned("babel.config.js")).toBe(false)
    })

    test("next.config.mjs is excluded", () => {
      expect(isScanned("next.config.mjs")).toBe(false)
    })

    test("tailwind.config.ts is excluded", () => {
      expect(isScanned("tailwind.config.ts")).toBe(false)
    })

    test(".eslintrc.js is excluded", () => {
      expect(isScanned(".eslintrc.js")).toBe(false)
    })

    test(".eslintrc.cjs is excluded", () => {
      expect(isScanned(".eslintrc.cjs")).toBe(false)
    })

    test(".eslintrc.json is excluded", () => {
      expect(isScanned(".eslintrc.json")).toBe(false)
    })

    test("nested .eslintrc.js is excluded", () => {
      expect(isScanned("packages/ui/.eslintrc.js")).toBe(false)
    })

    test("nested eslint.config.mjs is excluded", () => {
      expect(isScanned("apps/web/eslint.config.mjs")).toBe(false)
    })

    test(".prettierrc.js is excluded", () => {
      expect(isScanned(".prettierrc.js")).toBe(false)
    })

    test(".stylelintrc.mjs is excluded", () => {
      expect(isScanned(".stylelintrc.mjs")).toBe(false)
    })

    // CJS variants
    test("postcss.config.cjs is excluded", () => {
      expect(isScanned("postcss.config.cjs")).toBe(false)
    })

    test(".eslintrc.mjs is excluded", () => {
      expect(isScanned(".eslintrc.mjs")).toBe(false)
    })

    // Less common tooling configs
    test("rollup.config.js is excluded", () => {
      expect(isScanned("rollup.config.js")).toBe(false)
    })

    test("svelte.config.js is excluded", () => {
      expect(isScanned("svelte.config.js")).toBe(false)
    })

    test("nuxt.config.ts is excluded", () => {
      expect(isScanned("nuxt.config.ts")).toBe(false)
    })

    test("drizzle.config.ts is excluded", () => {
      expect(isScanned("drizzle.config.ts")).toBe(false)
    })

    test("knip.config.ts is excluded", () => {
      expect(isScanned("knip.config.ts")).toBe(false)
    })

    test("playwright.config.ts is excluded", () => {
      expect(isScanned("playwright.config.ts")).toBe(false)
    })

    test(".commitlintrc.js is excluded", () => {
      expect(isScanned(".commitlintrc.js")).toBe(false)
    })

    test(".lintstagedrc.mjs is excluded", () => {
      expect(isScanned(".lintstagedrc.mjs")).toBe(false)
    })

    // Monorepo nested configs
    test("nested postcss.config.cjs in packages/ is excluded", () => {
      expect(isScanned("packages/ui/postcss.config.cjs")).toBe(false)
    })

    test("nested .commitlintrc.ts in apps/ is excluded", () => {
      expect(isScanned("apps/web/.commitlintrc.ts")).toBe(false)
    })

    // Edge cases that must NOT be excluded
    test("regular source file with 'config' in path is still scanned", () => {
      expect(isScanned("src/config/logger.ts")).toBe(true)
    })

    test("config.ts as a module (not *.config.ts) is still scanned", () => {
      expect(isScanned("src/config.ts")).toBe(true)
    })

    test("file named debugger.ts is still scanned", () => {
      expect(isScanned("src/debugger.ts")).toBe(true)
    })

    test("debugger-utils.ts is still scanned", () => {
      expect(isScanned("src/debugger-utils.ts")).toBe(true)
    })

    test("console.ts module is still scanned", () => {
      expect(isScanned("src/console.ts")).toBe(true)
    })

    // CJS extension: CONFIG_FILE_RE is the operative exclusion (SOURCE_EXT_RE accepts .cjs)
    test(".eslintrc.cjs is excluded by CONFIG_FILE_RE, not SOURCE_EXT_RE", () => {
      expect(SOURCE_EXT_RE.test(".eslintrc.cjs")).toBe(true) // .cjs IS a source extension
      expect(CONFIG_FILE_RE.test(".eslintrc.cjs")).toBe(true) // CONFIG_FILE_RE catches it
      expect(isScanned(".eslintrc.cjs")).toBe(false) // excluded
    })

    // .vue/.svelte config files — CONFIG_FILE_RE does not cover these extensions,
    // so they pass through and ARE scanned. This is acceptable because nuxt.config.vue
    // and svelte.config.svelte do not exist in practice (those frameworks use .ts/.js).
    test("nuxt.config.vue is scanned (CONFIG_FILE_RE only covers js/mjs/cjs/ts)", () => {
      expect(SOURCE_EXT_RE.test("nuxt.config.vue")).toBe(true) // .vue IS a source extension
      expect(CONFIG_FILE_RE.test("nuxt.config.vue")).toBe(false) // CONFIG_FILE_RE misses .vue
      expect(isScanned("nuxt.config.vue")).toBe(true)
    })
  })

  describe("normal source files are scanned", () => {
    test("TypeScript source file is scanned", () => {
      expect(isScanned("src/lib/session.ts")).toBe(true)
    })

    test("JavaScript source file is scanned", () => {
      expect(isScanned("src/utils.js")).toBe(true)
    })

    test("Python file outside scripts/ is scanned", () => {
      expect(isScanned("src/utils.py")).toBe(true)
    })

    test("scripts/ files are excluded (intentional CLI output)", () => {
      expect(isScanned("scripts/migrate.py")).toBe(false)
      expect(isScanned("functions/scripts/migrate-database.ts")).toBe(false)
      expect(isScanned("packages/lib/scripts/seed-data.ts")).toBe(false)
    })

    test("CJS source file is scanned", () => {
      expect(isScanned("src/utils.cjs")).toBe(true)
    })

    test("Vue SFC is scanned", () => {
      expect(isScanned("src/components/App.vue")).toBe(true)
    })

    test("Svelte component is scanned", () => {
      expect(isScanned("src/components/App.svelte")).toBe(true)
    })

    test("regular .js file (not minified/dart) is scanned", () => {
      expect(isScanned("src/analytics.js")).toBe(true)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Debug statement patterns — verify proper anchoring and no false positives
// ═══════════════════════════════════════════════════════════════════════════════

describe("JS_DEBUG_RE: JavaScript console methods with word boundaries", () => {
  describe("should match valid console calls", () => {
    const valid = [
      "console.log('message')",
      "console.debug(variable)",
      "console.trace()",
      "console.dir(obj)",
      "console.table(data)",
    ]

    valid.forEach((code) => {
      test(`${code}`, () => {
        expect(JS_DEBUG_RE.test(code)).toBe(true)
      })
    })
  })

  describe("should not match production logging methods", () => {
    const production = [
      "console.warn('deprecated')",
      "console.error('fatal')",
      "console.info('startup')",
    ]

    production.forEach((code) => {
      test(`${code}`, () => {
        expect(JS_DEBUG_RE.test(code)).toBe(false)
      })
    })
  })

  describe("should not match similar identifiers", () => {
    const invalid = [
      "myConsole.log()", // Different object
      "console_log()", // Underscore, not dot
      "logConsole()", // Different method
    ]

    invalid.forEach((code) => {
      test(`${code}`, () => {
        expect(JS_DEBUG_RE.test(code)).toBe(false)
      })
    })
  })
})

describe("DEBUGGER_RE: debugger statement with word boundaries", () => {
  test("debugger statement", () => {
    expect(DEBUGGER_RE.test("debugger;")).toBe(true)
  })

  test("debugger alone", () => {
    expect(DEBUGGER_RE.test("debugger")).toBe(true)
  })

  test("should not match similar words", () => {
    expect(DEBUGGER_RE.test("notadebugger")).toBe(false)
    expect(DEBUGGER_RE.test("debuggered")).toBe(false)
  })

  test("should not match compound identifiers containing debugger", () => {
    expect(DEBUGGER_RE.test("debuggerPort")).toBe(false)
    expect(DEBUGGER_RE.test("isDebuggerAttached")).toBe(false)
    expect(DEBUGGER_RE.test("startDebuggerSession")).toBe(false)
  })

  describe("ESLint rule config exclusion (issue #14)", () => {
    function isDebuggerFinding(content: string): boolean {
      return DEBUGGER_RE.test(content) && !ESLINT_DEBUGGER_RULE_RE.test(content)
    }

    test("standalone debugger statement is still flagged", () => {
      expect(isDebuggerFinding("debugger;")).toBe(true)
      expect(isDebuggerFinding("  debugger")).toBe(true)
    })

    test('"no-debugger": "warn" is not flagged', () => {
      expect(isDebuggerFinding('"no-debugger": "warn"')).toBe(false)
    })

    test('"no-debugger": "error" is not flagged', () => {
      expect(isDebuggerFinding('"no-debugger": "error"')).toBe(false)
    })

    test("'no-debugger': 'warn' (single quotes) is not flagged", () => {
      expect(isDebuggerFinding("'no-debugger': 'warn'")).toBe(false)
    })

    test('"no-debugger": "off" is not flagged', () => {
      expect(isDebuggerFinding('"no-debugger": "off"')).toBe(false)
    })
  })
})

describe("PY_PRINT_RE: Python print() with word boundary", () => {
  test("print()", () => {
    expect(PY_PRINT_RE.test("print()")).toBe(true)
  })

  test("print with argument", () => {
    expect(PY_PRINT_RE.test('print("hello")')).toBe(true)
  })

  test("print with spaces before parens", () => {
    expect(PY_PRINT_RE.test("print  ( )")).toBe(true)
  })

  test("should not match if print is part of a word", () => {
    expect(PY_PRINT_RE.test("myprint()")).toBe(false)
    expect(PY_PRINT_RE.test("printer()")).toBe(false)
  })
})

describe("JS_DEBUG_RE: config-name false positives (regression)", () => {
  test('"no-console" rule name does not match', () => {
    expect(JS_DEBUG_RE.test('"no-console": "error"')).toBe(false)
  })

  test('"no-console" with allow list does not match', () => {
    expect(JS_DEBUG_RE.test('"no-console": ["error", { allow: ["warn", "error"] }]')).toBe(false)
  })

  test('ban list containing "console.log" string literal matches (defense-in-depth: caught by file filter)', () => {
    // This line WOULD match JS_DEBUG_RE — but it only appears in config files,
    // which are excluded at the file level by CONFIG_FILE_RE.
    expect(JS_DEBUG_RE.test('ban: ["console.log", "console.debug"]')).toBe(true)
  })

  test("error message mentioning console.log matches (defense-in-depth: caught by file filter)", () => {
    // String literals describing banned patterns match the regex.
    // Config files are excluded at file level; in app code this is unusual enough to flag.
    expect(JS_DEBUG_RE.test('description: "Prevents console.log usage"')).toBe(true)
  })
})

describe("DEBUGGER_RE: config-name false positives beyond no-debugger (regression)", () => {
  function isDebuggerFinding(content: string): boolean {
    return DEBUGGER_RE.test(content) && !ESLINT_DEBUGGER_RULE_RE.test(content)
  }

  test('import from "eslint-plugin-no-debugger" is excluded', () => {
    const line = 'import noDebugger from "eslint-plugin-no-debugger"'
    expect(isDebuggerFinding(line)).toBe(false)
  })

  test('require("eslint-plugin-no-debugger") is excluded', () => {
    const line = 'const plugin = require("eslint-plugin-no-debugger")'
    expect(isDebuggerFinding(line)).toBe(false)
  })

  test("comment mentioning no-debugger rule is excluded", () => {
    expect(isDebuggerFinding("// Enable the no-debugger rule for production")).toBe(false)
  })

  test('"@typescript-eslint/no-debugger" scoped rule is excluded', () => {
    expect(isDebuggerFinding('"@typescript-eslint/no-debugger": "error"')).toBe(false)
  })

  test("rules array containing no-debugger is excluded", () => {
    expect(isDebuggerFinding('rules: ["no-debugger", "no-console"]')).toBe(false)
  })

  test("JSDoc mentioning no-debugger is excluded", () => {
    expect(isDebuggerFinding(" * Enforces the no-debugger ESLint rule")).toBe(false)
  })

  // Real debugger statements must still be caught
  test("standalone debugger in non-config context is still caught", () => {
    expect(isDebuggerFinding("  debugger;")).toBe(true)
    expect(isDebuggerFinding("debugger")).toBe(true)
    expect(isDebuggerFinding("if (x) debugger")).toBe(true)
  })

  test("debugger inside conditional is still caught", () => {
    expect(isDebuggerFinding("if (process.env.DEBUG) debugger;")).toBe(true)
  })

  test("debugger with leading whitespace variants is still caught", () => {
    expect(isDebuggerFinding("    debugger")).toBe(true)
    expect(isDebuggerFinding("\tdebugger;")).toBe(true)
  })
})

describe("RUBY_DEBUG_RE: Ruby debuggers with word boundaries (regression test)", () => {
  describe("should match valid Ruby debugger calls", () => {
    const valid = ["binding.pry", "byebug", "binding.pry  # debug", "byebug if condition"]

    valid.forEach((code) => {
      test(`${code}`, () => {
        expect(RUBY_DEBUG_RE.test(code)).toBe(true)
      })
    })
  })

  describe("should NOT match similar identifiers (substring vulnerability prevention)", () => {
    const invalid = [
      "notbyebug", // Part of a longer word — OLD PATTERN WOULD MATCH THIS
      "byebugger", // Similar but different — OLD PATTERN WOULD MATCH THIS
      "my_byebug_helper", // Similar — OLD PATTERN WOULD MATCH THIS
      "notbinding.pry", // Different method
      "binding.pryyy", // Misspelled
    ]

    invalid.forEach((code) => {
      test(`${code} should not match`, () => {
        expect(RUBY_DEBUG_RE.test(code)).toBe(false)
      })
    })
  })
})
