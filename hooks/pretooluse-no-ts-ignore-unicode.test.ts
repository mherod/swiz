/**
 * Property-based fuzz suite for pretooluse-no-ts-ignore — Unicode and
 * control-character comment-prefix evasions.
 *
 * Parametric tables verify a single property per group:
 *
 *   GROUP A — Unicode Zs + extended whitespace between `//` and `@directive`
 *             All characters are matched by JS regex `\s`, so the hook MUST block.
 *             TypeScript itself also treats these as whitespace in directives.
 *
 *   GROUP B — Non-`\s` invisible / format characters between `//` and `@directive`
 *             Not matched by `\s`; the hook correctly allows.
 *             TypeScript also does NOT treat these as directive whitespace.
 *
 *   GROUP C — ASCII control characters (non-whitespace, U+0001..U+001F minus \t\n\v\f\r)
 *             between `//` and `@directive`.  Not in `\s`; hook correctly allows.
 *
 *   GROUP D — `@` homoglyphs replacing the literal `@` in the directive.
 *             NFKC-normalizable homoglyphs (＠, ﹫) are now blocked.
 *             Non-NFKC homoglyphs (🅐) remain allowed.
 *
 *   GROUP E — Unicode Zs characters in the JSDoc line prefix (before `*`)
 *             `^\s*\*\s*@directive` — `\s*` before `*` must still match, blocking.
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

function runHook(opts: { filePath?: string; newString?: string }) {
  return runFileEditHook(HOOK, opts)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uStr(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`
}

// ─── GROUP A: Unicode \s-matched whitespace — all must be blocked ─────────────
//
// ECMAScript `\s` matches WhiteSpace (U+0009, U+000B, U+000C, U+FEFF, and all
// Unicode Zs "Space_Separator" code points) plus LineTerminator (U+000A, U+000D,
// U+2028, U+2029).  Placing any of these between `//` and `@directive` triggers
// the hook's `//\s*@directive` pattern.
//
// Note: LF (U+000A) / CR (U+000D) would split the line; testing non-line-breaking
// Zs characters is sufficient to verify the property without multi-line edge cases.

const ZS_AND_EXTENDED_WS: [number, string][] = [
  [0x00a0, "NO-BREAK SPACE"],
  [0x1680, "OGHAM SPACE MARK"],
  [0x2000, "EN QUAD"],
  [0x2001, "EM QUAD"],
  [0x2002, "EN SPACE"],
  [0x2003, "EM SPACE"],
  [0x2004, "THREE-PER-EM SPACE"],
  [0x2005, "FOUR-PER-EM SPACE"],
  [0x2006, "SIX-PER-EM SPACE"],
  [0x2007, "FIGURE SPACE"],
  [0x2008, "PUNCTUATION SPACE"],
  [0x2009, "THIN SPACE"],
  [0x200a, "HAIR SPACE"],
  [0x202f, "NARROW NO-BREAK SPACE"],
  [0x205f, "MEDIUM MATHEMATICAL SPACE"],
  [0x3000, "IDEOGRAPHIC SPACE"],
  [0xfeff, "BOM / ZERO-WIDTH NO-BREAK SPACE"], // explicitly WhiteSpace in ES spec
  [0x2028, "LINE SEPARATOR"], // LineTerminator, also in \s
  [0x2029, "PARAGRAPH SEPARATOR"], // LineTerminator, also in \s
]

describe(`pretooluse-no-ts-ignore: GROUP A — Unicode \\s whitespace in // is blocked`, () => {
  for (const [cp, name] of ZS_AND_EXTENDED_WS) {
    const char = String.fromCodePoint(cp)
    test(`${uStr(cp)} ${name} before @directive is blocked`, async () => {
      const result = await runHook({ newString: `//${char}@${KW_IGNORE}` })
      expect(result.decision).toBe("deny")
    })
  }
})

describe(`pretooluse-no-ts-ignore: GROUP A — Unicode \\s whitespace with @${KW_NOCHECK}`, () => {
  // Spot-check three representatives across the Zs range
  for (const [cp, name] of [
    ZS_AND_EXTENDED_WS[0]!,
    ZS_AND_EXTENDED_WS[8]!,
    ZS_AND_EXTENDED_WS[15]!,
  ]) {
    const char = String.fromCodePoint(cp)
    test(`${uStr(cp)} ${name} before @nocheck directive is blocked`, async () => {
      const result = await runHook({ newString: `//${char}@${KW_NOCHECK}` })
      expect(result.decision).toBe("deny")
    })
  }
})

describe(`pretooluse-no-ts-ignore: GROUP A — Unicode \\s whitespace with bare @${KW_EXPECT}`, () => {
  // Spot-check to verify bare expect-error is also caught through Unicode whitespace
  for (const [cp, name] of [ZS_AND_EXTENDED_WS[0]!, ZS_AND_EXTENDED_WS[16]!]) {
    const char = String.fromCodePoint(cp)
    test(`${uStr(cp)} ${name} before bare @expect directive is blocked`, async () => {
      const result = await runHook({ newString: `//${char}@${KW_EXPECT}` })
      expect(result.decision).toBe("deny")
    })
  }
})

// ─── GROUP B: Non-\s invisible/format chars — hook correctly allows ───────────
//
// These characters are in the Unicode Cf "Format" category, not Zs "Space_Separator",
// so they are NOT matched by `\s`.  The regex `//\s*@directive` requires `\s*` between
// `//` and `@`, which stops at the first non-\s character.  No match → "allow".
//
// TypeScript's own directive parser uses isWhiteSpaceSingleLine() which also excludes
// these characters, so the hook correctly mirrors TypeScript semantics here.

const NON_S_INVISIBLE: [number, string][] = [
  [0x200b, "ZERO-WIDTH SPACE"],
  [0x200c, "ZERO-WIDTH NON-JOINER"],
  [0x200d, "ZERO-WIDTH JOINER"],
  [0x200e, "LEFT-TO-RIGHT MARK"],
  [0x200f, "RIGHT-TO-LEFT MARK"],
  [0x2060, "WORD JOINER"],
  [0x2061, "FUNCTION APPLICATION"],
  [0x2062, "INVISIBLE TIMES"],
  [0x2063, "INVISIBLE SEPARATOR"],
  [0x2064, "INVISIBLE PLUS"],
  [0x00ad, "SOFT HYPHEN"],
  [0x034f, "COMBINING GRAPHEME JOINER"],
]

describe(`pretooluse-no-ts-ignore: GROUP B — non-\\s invisible chars are not false positives`, () => {
  for (const [cp, name] of NON_S_INVISIBLE) {
    const char = String.fromCodePoint(cp)
    test(`${uStr(cp)} ${name} between // and @ is allowed (TypeScript also ignores)`, async () => {
      const result = await runHook({ newString: `//${char}@${KW_IGNORE}` })
      expect(result.decision).toBe("allow")
    })
  }
})

// ─── GROUP C: ASCII non-whitespace control characters — hook correctly allows ──
//
// U+0001..U+001F excluding the five ASCII whitespace control codes:
//   U+0009 TAB, U+000A LF, U+000B VT, U+000C FF, U+000D CR
// None of these are in `\s`; inserting them between `//` and `@` breaks the match.
// TypeScript ignores them as well.

const ASCII_WS_SET = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d])
const CTRL_NON_WS: [number, string][] = Array.from({ length: 31 }, (_, i) => i + 1)
  .filter((cp) => !ASCII_WS_SET.has(cp))
  .map((cp) => [cp, `ASCII CTRL ${uStr(cp)}`])

describe(`pretooluse-no-ts-ignore: GROUP C — ASCII control characters are not false positives`, () => {
  for (const [cp, name] of CTRL_NON_WS) {
    const char = String.fromCodePoint(cp)
    test(`${name} between // and @ is allowed`, async () => {
      const result = await runHook({ newString: `//${char}@${KW_IGNORE}` })
      expect(result.decision).toBe("allow")
    })
  }
})

// ─── GROUP D: @ homoglyphs — NFKC-normalizable ones are now blocked ──────────
//
// The hook NFKC-normalizes input before checking.  Homoglyphs that normalize
// to U+0040 `@` (e.g., fullwidth ＠, small ﹫) are now caught and blocked.
// Homoglyphs that do NOT normalize to `@` remain allowed.

const NFKC_AT_HOMOGLYPHS: [number, string][] = [
  [0xff20, "FULLWIDTH COMMERCIAL AT"],
  [0xfe6b, "SMALL COMMERCIAL AT"],
]

const NON_NFKC_AT_HOMOGLYPHS: [number, string][] = [
  [0x1f150, "NEGATIVE CIRCLED LATIN CAPITAL LETTER A"], // visual lookalike, no NFKC mapping to @
]

describe(`pretooluse-no-ts-ignore: GROUP D — NFKC @ homoglyphs are blocked`, () => {
  for (const [cp, name] of NFKC_AT_HOMOGLYPHS) {
    const homoglyph = String.fromCodePoint(cp)
    test(`${uStr(cp)} ${name} as @ substitute is blocked (NFKC → @)`, async () => {
      const result = await runHook({
        newString: `// ${homoglyph}${KW_IGNORE} this is not a real directive`,
      })
      expect(result.decision).toBe("deny")
    })
  }
})

describe(`pretooluse-no-ts-ignore: GROUP D — non-NFKC @ homoglyphs are allowed`, () => {
  for (const [cp, name] of NON_NFKC_AT_HOMOGLYPHS) {
    const homoglyph = String.fromCodePoint(cp)
    test(`${uStr(cp)} ${name} as @ substitute is allowed`, async () => {
      const result = await runHook({
        newString: `// ${homoglyph}${KW_IGNORE} this is not a real directive`,
      })
      expect(result.decision).toBe("allow")
    })
  }
})

// ─── GROUP E: Unicode \s whitespace in JSDoc * prefix — must be blocked ───────
//
// The JSDoc branch `^\s*\*\s*@directive` uses `^\s*` before `\*`.  Placing a
// Unicode Zs character at the start of a JSDoc line (before the `*`) must still
// trigger a block.

const ZS_SUBSET_FOR_JSDOC: [number, string][] = [
  [0x00a0, "NO-BREAK SPACE"],
  [0x1680, "OGHAM SPACE MARK"],
  [0x2003, "EM SPACE"],
  [0x3000, "IDEOGRAPHIC SPACE"],
  [0xfeff, "BOM"],
  [0x202f, "NARROW NO-BREAK SPACE"],
]

describe(`pretooluse-no-ts-ignore: GROUP E — Unicode \\s in JSDoc * prefix is blocked`, () => {
  for (const [cp, name] of ZS_SUBSET_FOR_JSDOC) {
    const char = String.fromCodePoint(cp)
    test(`${uStr(cp)} ${name} before * in JSDoc catches @${KW_IGNORE}`, async () => {
      const result = await runHook({ newString: `/**\n${char}* @${KW_IGNORE}\n */` })
      expect(result.decision).toBe("deny")
    })
  }
})

describe(`pretooluse-no-ts-ignore: GROUP E — Unicode \\s in JSDoc * prefix with @${KW_NOCHECK}`, () => {
  const char = String.fromCodePoint(0x3000) // IDEOGRAPHIC SPACE
  test(`${uStr(0x3000)} IDEOGRAPHIC SPACE before * in JSDoc catches @${KW_NOCHECK}`, async () => {
    const result = await runHook({ newString: `/**\n${char}* @${KW_NOCHECK}\n */` })
    expect(result.decision).toBe("deny")
  })
})

// ─── GROUP F: Non-\s chars in JSDoc * prefix — hook correctly allows ──────────
//
// If a non-\s char precedes `*` on a JSDoc line, `^\s*\*` no longer matches,
// so the directive on that line is not caught.  TypeScript also wouldn't treat it
// as a suppression, so allowing is correct.

describe(`pretooluse-no-ts-ignore: GROUP F — non-\\s before * in JSDoc is allowed`, () => {
  test(`ZERO-WIDTH SPACE (non-\\s) before * in JSDoc is allowed`, async () => {
    const zwsp = "\u200B"
    const result = await runHook({ newString: `/**\n${zwsp}* @${KW_IGNORE}\n */` })
    expect(result.decision).toBe("allow")
  })

  test(`SOFT HYPHEN (non-\\s) before * in JSDoc is allowed`, async () => {
    const shy = "\u00AD"
    const result = await runHook({ newString: `/**\n${shy}* @${KW_IGNORE}\n */` })
    expect(result.decision).toBe("allow")
  })
})
