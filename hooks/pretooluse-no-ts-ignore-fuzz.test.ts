/**
 * Fuzz-style regression suite for pretooluse-no-ts-ignore.
 *
 * Covers evasion patterns not addressed in the main test suites:
 *   - Mixed tab/space indentation in JSDoc lines
 *   - CRLF line endings inside JSDoc blocks
 *   - Blank JSDoc lines immediately before the directive
 *   - No whitespace between * and @ (e.g. "*@directive")
 *   - Directives sandwiched between content lines in JSDoc
 *   - Double-asterisk prefix ("** @directive") — known limitation, documented as "allow"
 *   - Unicode whitespace in JSDoc line prefix
 *
 * Keywords are split across array joins to prevent the hook from triggering on
 * this test file itself when it is written or edited.
 */

import { describe, expect, test } from "bun:test"
import { runFileEditHook } from "./test-utils.ts"

const KW_IGNORE = ["ts", "ignore"].join("-")
const KW_EXPECT = ["ts", "expect", "error"].join("-")
const KW_NOCHECK = ["ts", "nocheck"].join("-")

const HOOK = "hooks/pretooluse-ts-quality.ts"

function runHook(opts: { filePath?: string; newString?: string; content?: string }) {
  return runFileEditHook(HOOK, opts)
}

// ─── Mixed tab/space JSDoc indentation ───────────────────────────────────────

describe(`pretooluse-no-ts-ignore: mixed indentation in JSDoc`, () => {
  test(`tab-only line prefix catches @${KW_IGNORE}`, async () => {
    // "/**\n\t* @ts-expect-error\n */" — tab before asterisk
    const result = await runHook({ newString: `/**\n\t* @${KW_IGNORE}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`tab+space line prefix catches @${KW_IGNORE}`, async () => {
    // "/**\n\t * @ts-expect-error\n */" — tab then space then asterisk
    const result = await runHook({ newString: `/**\n\t * @${KW_IGNORE}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`tab+space prefix catches @${KW_NOCHECK}`, async () => {
    const result = await runHook({ newString: `/**\n\t * @${KW_NOCHECK}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`tab-only prefix catches bare @${KW_EXPECT}`, async () => {
    const result = await runHook({ newString: `/**\n\t* @${KW_EXPECT}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`tab+space prefix with description allows @${KW_EXPECT}`, async () => {
    const result = await runHook({
      newString: `/**\n\t * @${KW_EXPECT}: upstream types are wrong\n */`,
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── CRLF line endings ────────────────────────────────────────────────────────

describe(`pretooluse-no-ts-ignore: CRLF line endings in JSDoc`, () => {
  test(`CRLF in JSDoc catches @${KW_IGNORE}`, async () => {
    // "/**\r\n * @ts-expect-error\r\n */" — Windows line endings throughout
    const result = await runHook({ newString: `/**\r\n * @${KW_IGNORE}\r\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`CRLF in JSDoc catches @${KW_NOCHECK}`, async () => {
    const result = await runHook({ newString: `/**\r\n * @${KW_NOCHECK}\r\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`CRLF in JSDoc catches bare @${KW_EXPECT}`, async () => {
    const result = await runHook({ newString: `/**\r\n * @${KW_EXPECT}\r\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`CRLF in JSDoc allows documented @${KW_EXPECT}`, async () => {
    const result = await runHook({
      newString: `/**\r\n * @${KW_EXPECT}: third-party types wrong\r\n */`,
    })
    expect(result.decision).toBe("allow")
  })

  test(`mixed LF and CRLF with directive catches @${KW_IGNORE}`, async () => {
    // Opening on LF, directive on CRLF
    const result = await runHook({ newString: `/**\n * @${KW_IGNORE}\r\n */` })
    expect(result.decision).toBe("deny")
  })
})

// ─── Blank JSDoc lines before directive ──────────────────────────────────────

describe(`pretooluse-no-ts-ignore: blank JSDoc lines before directive`, () => {
  test(`blank * line before @${KW_IGNORE} is caught`, async () => {
    // "/**\n *\n * @ts-expect-error\n */"
    const result = await runHook({ newString: `/**\n *\n * @${KW_IGNORE}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`two blank * lines before @${KW_IGNORE} are caught`, async () => {
    const result = await runHook({ newString: `/**\n *\n *\n * @${KW_IGNORE}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`blank line (no *) before @${KW_NOCHECK} is caught`, async () => {
    // Bare empty line in the block
    const result = await runHook({ newString: `/**\n\n * @${KW_NOCHECK}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`blank * line before bare @${KW_EXPECT} is caught`, async () => {
    const result = await runHook({ newString: `/**\n *\n * @${KW_EXPECT}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`blank * line before documented @${KW_EXPECT} is allowed`, async () => {
    const result = await runHook({
      newString: `/**\n *\n * @${KW_EXPECT}: broken upstream lib\n */`,
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── No whitespace between * and @ ───────────────────────────────────────────

describe(`pretooluse-no-ts-ignore: no-space asterisk prefix "*@directive"`, () => {
  test(`"*@${KW_IGNORE}" (no space) is caught`, async () => {
    // "/**\n *@ts-expect-error\n */" — * immediately followed by @
    const result = await runHook({ newString: `/**\n *@${KW_IGNORE}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`"*@${KW_NOCHECK}" (no space) is caught`, async () => {
    const result = await runHook({ newString: `/**\n *@${KW_NOCHECK}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`"*@${KW_EXPECT}" bare (no space) is caught`, async () => {
    const result = await runHook({ newString: `/**\n *@${KW_EXPECT}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`"*@${KW_EXPECT}: description" (no space) is allowed`, async () => {
    const result = await runHook({ newString: `/**\n *@${KW_EXPECT}: no space but has desc\n */` })
    expect(result.decision).toBe("allow")
  })
})

// ─── Sandwiched directives ────────────────────────────────────────────────────

describe(`pretooluse-no-ts-ignore: directive sandwiched between content lines`, () => {
  test(`@${KW_IGNORE} between two content lines is caught`, async () => {
    const result = await runHook({
      newString: `/**\n * Before content.\n * @${KW_IGNORE}\n * After content.\n */`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`@${KW_NOCHECK} deep in a multi-line JSDoc is caught`, async () => {
    const result = await runHook({
      newString: [
        "/**",
        " * Line one.",
        " * Line two.",
        ` * @${KW_NOCHECK}`,
        " * Line three.",
        " */",
        "export const x = 1",
      ].join("\n"),
    })
    expect(result.decision).toBe("deny")
  })

  test(`bare @${KW_EXPECT} between content lines is caught`, async () => {
    const result = await runHook({
      newString: `/**\n * Description.\n * @${KW_EXPECT}\n * More text.\n */`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`documented @${KW_EXPECT} between content lines is allowed`, async () => {
    const result = await runHook({
      newString: `/**\n * Description.\n * @${KW_EXPECT}: upstream lib issue\n * More text.\n */`,
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── Double-asterisk prefix ───────────────────────────────────────────────────
//
// The JSDoc branch uses ^\s*\*+\s*@directive (\*+ = one or more asterisks) so
// that extra leading asterisks in JSDoc interior lines are caught as attempted
// suppression directives.  The hook is intentionally more conservative than
// TypeScript's own parser (which does not recognise multi-line JSDoc block
// comment forms as directives): blocking attempted suppressions regardless of
// whether TypeScript would honour them is the correct policy.

describe(`pretooluse-no-ts-ignore: double-asterisk JSDoc prefix is caught`, () => {
  test(`"** @${KW_IGNORE}" is caught`, async () => {
    const result = await runHook({ newString: `/**\n ** @${KW_IGNORE}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`"** @${KW_NOCHECK}" is caught`, async () => {
    const result = await runHook({ newString: `/**\n ** @${KW_NOCHECK}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`"** @${KW_EXPECT}" bare is caught`, async () => {
    const result = await runHook({ newString: `/**\n ** @${KW_EXPECT}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`"*** @${KW_IGNORE}" (triple asterisk) is caught`, async () => {
    const result = await runHook({ newString: `/**\n *** @${KW_IGNORE}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`"** @${KW_EXPECT}: description" with description is allowed`, async () => {
    const result = await runHook({
      newString: `/**\n ** @${KW_EXPECT}: extra stars, still needs description\n */`,
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── Unicode whitespace in JSDoc prefix ──────────────────────────────────────

describe(`pretooluse-no-ts-ignore: unicode whitespace in JSDoc line prefix`, () => {
  test(`non-breaking space before * catches @${KW_IGNORE}`, async () => {
    // U+00A0 NON-BREAKING SPACE — matched by \s in JS regex
    const NBSP = "\u00A0"
    const result = await runHook({ newString: `/**\n${NBSP}* @${KW_IGNORE}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`en-space before * catches @${KW_IGNORE}`, async () => {
    // U+2002 EN SPACE — matched by \s in JS regex
    const EN_SP = "\u2002"
    const result = await runHook({ newString: `/**\n${EN_SP}* @${KW_IGNORE}\n */` })
    expect(result.decision).toBe("deny")
  })

  test(`zero-width space before @ does not produce false positive`, async () => {
    // U+200B ZERO-WIDTH SPACE between // and the non-directive text
    // Should be allowed — no directive present
    const ZWSP = "\u200B"
    const result = await runHook({
      newString: `// ${ZWSP}regular comment, no directive`,
    })
    expect(result.decision).toBe("allow")
  })
})
