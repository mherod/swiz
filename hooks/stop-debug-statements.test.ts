import { describe, expect, test } from "bun:test"

// Test the GENERATED_FILE_RE and INFRA_FILE_RE exclusion logic in isolation,
// mirroring the filter applied in stop-debug-statements.ts.

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|py|rb|go|java|kt|swift)$/
const TEST_FILE_RE = /\.(test|spec)\.|__tests__/
const INFRA_FILE_RE = /hooks\/|\/commands\/|\/cli\.|index\.ts$|dispatch\.ts$/
const GENERATED_FILE_RE = /main\.dart\.js$|\.dart\.js$|\.min\.js$|\.bundle\.js$|\.chunk\.js$/

// Debug patterns (mirrors stop-debug-statements.ts)
const JS_DEBUG_RE = /\bconsole\.(log|debug|trace|dir|table)\b/
const _JS_COMMENT_RE = /\/\/.*console\./
const DEBUGGER_RE = /\bdebugger\b/
const PY_PRINT_RE = /\bprint\s*\(/
const RUBY_DEBUG_RE = /\b(?:binding\.pry|byebug)\b/

function isScanned(filePath: string): boolean {
  return (
    SOURCE_EXT_RE.test(filePath) &&
    !TEST_FILE_RE.test(filePath) &&
    !INFRA_FILE_RE.test(filePath) &&
    !GENERATED_FILE_RE.test(filePath)
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
  })

  describe("TEST_FILE_RE — test files are excluded", () => {
    test("*.test.ts is excluded", () => {
      expect(isScanned("src/utils.test.ts")).toBe(false)
    })

    test("*.spec.js is excluded", () => {
      expect(isScanned("src/utils.spec.js")).toBe(false)
    })
  })

  describe("normal source files are scanned", () => {
    test("TypeScript source file is scanned", () => {
      expect(isScanned("src/lib/session.ts")).toBe(true)
    })

    test("JavaScript source file is scanned", () => {
      expect(isScanned("src/utils.js")).toBe(true)
    })

    test("Python file is scanned", () => {
      expect(isScanned("scripts/migrate.py")).toBe(true)
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
