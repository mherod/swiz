/**
 * Exhaustive regression suite for TypeScript-recognized suppression forms.
 *
 * Property tested:
 *   For every comment form that TypeScript's compiler recognises as a
 *   suppression directive, the hook MUST also block the edit.
 *   tsc_recognizes(form) → hook_blocks(form)
 *
 * Empirically verified with tsc 5.x that TypeScript recognises:
 *   ts-ignore       — line comment (all spacing variants, trailing text ok)
 *                     single-line block comment (spacing variants, trailing text ok)
 *   ts-nocheck      — line comment ONLY (block comment form NOT recognised by TS)
 *   ts-expect-error — same as ts-ignore (line + single-line block)
 *
 * ts-nocheck block comment forms are included as an extra conservative
 * section — TypeScript does not recognise them, but the hook blocks them as
 * attempted suppressions regardless.
 *
 * Keywords are split across array joins to prevent the hook from triggering on
 * this test file itself when it is written or edited.
 */

import { describe, expect, test } from "bun:test"
import { runFileEditHook } from "./test-utils.ts"

const KW_IGNORE = ["ts", "ignore"].join("-")
const KW_EXPECT = ["ts", "expect", "error"].join("-")
const KW_NOCHECK = ["ts", "nocheck"].join("-")

const HOOK = "hooks/pretooluse-no-ts-ignore.ts"

function runHook(opts: { filePath?: string; newString: string }) {
  return runFileEditHook(HOOK, opts)
}

// ─── @ts-expect-error — line comment forms (TypeScript-recognised) ─────────────────
//
// TypeScript recognises the directive in line comments with any amount of
// whitespace between the opener and the at-sign, and allows trailing text
// after the directive.  All of these forms MUST be blocked by the hook.

describe(`pretooluse-no-ts-ignore: @${KW_IGNORE} line comment spacing variants`, () => {
  const CASES: [string, string][] = [
    ["no space (//@directive)", `//@${KW_IGNORE}\nconst x: string = 1`],
    ["one space (// @directive)", `// @${KW_IGNORE}\nconst x: string = 1`],
    ["two spaces (//  @directive)", `//  @${KW_IGNORE}\nconst x: string = 1`],
    ["tab between opener and at-sign", `//\t@${KW_IGNORE}\nconst x: string = 1`],
    [
      "trailing text after directive",
      `// @${KW_IGNORE} some explanation here\nconst x: string = 1`,
    ],
    ["colon after directive", `// @${KW_IGNORE}: some explanation here\nconst x: string = 1`],
    [
      "multiple spaces plus trailing text",
      `//   @${KW_IGNORE}   trailing spaces\nconst x: string = 1`,
    ],
    ["not first line in file", `const ok = 1\n// @${KW_IGNORE}\nconst x: string = 1`],
  ]

  for (const [label, input] of CASES) {
    test(`blocks: ${label}`, async () => {
      const result = await runHook({ newString: input })
      expect(result.decision).toBe("deny")
    })
  }
})

// ─── @ts-expect-error — single-line block comment forms (TypeScript-recognised) ────
//
// TypeScript also recognises the directive in single-line block comments,
// including forms with no spaces, extra spaces, tab, or trailing text.
// All MUST be blocked by the hook.

describe(`pretooluse-no-ts-ignore: @${KW_IGNORE} single-line block comment variants`, () => {
  const CASES: [string, string][] = [
    ["no spaces around directive", `/*@${KW_IGNORE}*/\nconst x: string = 1`],
    ["space before at-sign", `/* @${KW_IGNORE} */\nconst x: string = 1`],
    ["extra spaces on both sides", `/*  @${KW_IGNORE}  */\nconst x: string = 1`],
    ["tab before at-sign", `/*\t@${KW_IGNORE}*/\nconst x: string = 1`],
    ["trailing text before close", `/* @${KW_IGNORE} trailing text */\nconst x: string = 1`],
    ["colon description before close", `/* @${KW_IGNORE}: description */\nconst x: string = 1`],
  ]

  for (const [label, input] of CASES) {
    test(`blocks: ${label}`, async () => {
      const result = await runHook({ newString: input })
      expect(result.decision).toBe("deny")
    })
  }
})

// ─── @ts-nocheck — line comment forms (TypeScript-recognised) ────────────────
//
// TypeScript recognises ts-nocheck ONLY in line comments.  Block comment
// forms are NOT recognised by TypeScript.  All line comment variants here
// MUST be blocked by the hook since TypeScript honours them.

describe(`pretooluse-no-ts-ignore: @${KW_NOCHECK} line comment spacing variants`, () => {
  const CASES: [string, string][] = [
    ["no space (//@directive)", `//@${KW_NOCHECK}\nconst x: string = 1`],
    ["one space (// @directive)", `// @${KW_NOCHECK}\nconst x: string = 1`],
    ["two spaces (//  @directive)", `//  @${KW_NOCHECK}\nconst x: string = 1`],
    ["tab between opener and at-sign", `//\t@${KW_NOCHECK}\nconst x: string = 1`],
    ["trailing text after directive", `// @${KW_NOCHECK} some text\nconst x: string = 1`],
    ["colon after directive", `// @${KW_NOCHECK}: some text\nconst x: string = 1`],
    ["at top of file with code below", `// @${KW_NOCHECK}\nexport const x = 1`],
  ]

  for (const [label, input] of CASES) {
    test(`blocks: ${label}`, async () => {
      const result = await runHook({ newString: input })
      expect(result.decision).toBe("deny")
    })
  }
})

// ─── @ts-nocheck — block comment forms (conservative) ────────────────────────
//
// TypeScript does NOT recognise the directive in block comment form.
// The hook blocks these anyway as conservative suppression-attempt detection.

describe(`pretooluse-no-ts-ignore: @${KW_NOCHECK} block comment forms (conservative)`, () => {
  const CASES: [string, string][] = [
    ["no spaces around directive", `/*@${KW_NOCHECK}*/\nconst x = 1`],
    ["space before at-sign", `/* @${KW_NOCHECK} */\nconst x = 1`],
    ["extra spaces on both sides", `/*  @${KW_NOCHECK}  */\nconst x = 1`],
  ]

  for (const [label, input] of CASES) {
    test(`blocks (conservative): ${label}`, async () => {
      const result = await runHook({ newString: input })
      expect(result.decision).toBe("deny")
    })
  }
})

// ─── bare @ts-expect-error — line comment forms (TypeScript-recognised) ───────
//
// TypeScript recognises bare ts-expect-error in line comments.  The hook
// blocks bare forms (no description) and allows forms with a description.
// This section verifies the deny branch for line comment forms.

describe(`pretooluse-no-ts-ignore: bare @${KW_EXPECT} line comment spacing variants`, () => {
  const CASES: [string, string][] = [
    ["no space (//@directive)", `//@${KW_EXPECT}\nconst x: string = 1`],
    ["one space (// @directive)", `// @${KW_EXPECT}\nconst x: string = 1`],
    ["two spaces (//  @directive)", `//  @${KW_EXPECT}\nconst x: string = 1`],
    ["tab between opener and at-sign", `//\t@${KW_EXPECT}\nconst x: string = 1`],
    ["only trailing whitespace after directive", `// @${KW_EXPECT}   \nconst x: string = 1`],
  ]

  for (const [label, input] of CASES) {
    test(`blocks bare: ${label}`, async () => {
      const result = await runHook({ newString: input })
      expect(result.decision).toBe("deny")
    })
  }
})

// ─── bare @ts-expect-error — block comment forms (TypeScript-recognised) ─────
//
// TypeScript also recognises ts-expect-error in single-line block comments.
// Bare block comment forms (no description) MUST be blocked.

describe(`pretooluse-no-ts-ignore: bare @${KW_EXPECT} single-line block comment variants`, () => {
  const CASES: [string, string][] = [
    ["no spaces around directive", `/*@${KW_EXPECT}*/\nconst x: string = 1`],
    ["space before at-sign", `/* @${KW_EXPECT} */\nconst x: string = 1`],
    ["extra spaces on both sides", `/*  @${KW_EXPECT}  */\nconst x: string = 1`],
    ["tab before at-sign", `/*\t@${KW_EXPECT}*/\nconst x: string = 1`],
    ["unclosed block comment", `/* @${KW_EXPECT}\nconst x: string = 1`],
  ]

  for (const [label, input] of CASES) {
    test(`blocks bare block: ${label}`, async () => {
      const result = await runHook({ newString: input })
      expect(result.decision).toBe("deny")
    })
  }
})

// ─── documented @ts-expect-error — must be allowed ───────────────────────────
//
// A ts-expect-error with a non-whitespace description is explicitly allowed.
// These are regression guards ensuring the hook does NOT over-block documented
// suppressions, which are the correct and required form.

describe(`pretooluse-no-ts-ignore: documented @${KW_EXPECT} forms are allowed`, () => {
  const CASES: [string, string][] = [
    [
      "colon plus description (line)",
      `// @${KW_EXPECT}: upstream types don't include overload\nconst x: string = 1`,
    ],
    [
      "space plus description without colon (line)",
      `// @${KW_EXPECT} upstream types are wrong\nconst x: string = 1`,
    ],
    ["tab plus description (line)", `//\t@${KW_EXPECT}: bad lib\nconst x: string = 1`],
    [
      "two spaces before at-sign plus description (line)",
      `//  @${KW_EXPECT}: extra space before at-sign\nconst x: string = 1`,
    ],
    [
      "block comment with description",
      `/* @${KW_EXPECT}: third-party lib issue */\nconst x: string = 1`,
    ],
    [
      "block comment colon plus description",
      `/* @${KW_EXPECT}: upstream types missing overload */\nconst x: string = 1`,
    ],
    [
      "JSDoc interior line with description",
      `/**\n * @${KW_EXPECT}: bad upstream lib\n */\nconst x = 1`,
    ],
  ]

  for (const [label, input] of CASES) {
    test(`allows: ${label}`, async () => {
      const result = await runHook({ newString: input })
      expect(result.decision).toBe("allow")
    })
  }
})
