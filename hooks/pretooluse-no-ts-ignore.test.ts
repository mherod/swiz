import { describe, expect, test } from "bun:test"
import { runFileEditHook } from "../src/utils/test-utils.ts"

// Keywords split to avoid self-triggering the hook when this file is edited.
const KW_IGNORE = ["ts", "ignore"].join("-")
const KW_EXPECT = ["ts", "expect", "error"].join("-")
const HOOK = "hooks/pretooluse-ts-quality.ts"

// ─── Hook runner ─────────────────────────────────────────────────────────────

async function runHook(opts: {
  filePath?: string
  newString?: string
  content?: string
  toolName?: string
}) {
  return runFileEditHook(HOOK, opts)
}

// ─── @ts-expect-error blocking ──────────────────────────────────────────────────────

describe(`pretooluse-no-ts-ignore: @${KW_IGNORE} is always blocked`, () => {
  test("blocks standard line comment", async () => {
    const result = await runHook({ newString: `// @${KW_IGNORE}\nconst x: string = 1` })
    expect(result.decision).toBe("deny")
  })

  test("blocks with no space after //", async () => {
    const result = await runHook({ newString: `//@${KW_IGNORE}` })
    expect(result.decision).toBe("deny")
  })

  test("blocks with multiple spaces before directive", async () => {
    const result = await runHook({ newString: `//   @${KW_IGNORE}` })
    expect(result.decision).toBe("deny")
  })

  // Description uses variable to avoid literal block-comment pattern in source
  test(`blocks block comment form: /* @${KW_IGNORE} */`, async () => {
    const result = await runHook({ newString: `/* @${KW_IGNORE} */` })
    expect(result.decision).toBe("deny")
  })

  test(`blocks block comment with no space: /*@${KW_IGNORE}*/`, async () => {
    const result = await runHook({ newString: `/*@${KW_IGNORE}*/` })
    expect(result.decision).toBe("deny")
  })

  test("blocks in .tsx files", async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `// @${KW_IGNORE}\nreturn <div />`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`denial reason names the @${KW_IGNORE} directive`, async () => {
    const result = await runHook({ newString: `// @${KW_IGNORE}` })
    expect(result.reason).toContain(`@${KW_IGNORE}`)
  })

  test(`denial reason suggests @${KW_EXPECT} as alternative`, async () => {
    const result = await runHook({ newString: `// @${KW_IGNORE}` })
    expect(result.reason).toContain(`@${KW_EXPECT}`)
  })

  test("blocks via content field when new_string is absent", async () => {
    const result = await runHook({ content: `// @${KW_IGNORE}` })
    expect(result.decision).toBe("deny")
  })

  test("blocks when directive appears mid-file (not on first line)", async () => {
    const result = await runHook({
      newString: `const a = 1\nconst b = 2\n// @${KW_IGNORE}\nconst c: string = 3`,
    })
    expect(result.decision).toBe("deny")
  })
})

// ─── @ts-expect-error: bare form blocked ─────────────────────────────────────

describe(`pretooluse-no-ts-ignore: bare @${KW_EXPECT} is blocked`, () => {
  test("blocks bare directive with no description", async () => {
    const result = await runHook({ newString: `// @${KW_EXPECT}\nconst x: string = 1` })
    expect(result.decision).toBe("deny")
  })

  test("blocks bare directive with only trailing whitespace", async () => {
    const result = await runHook({ newString: `// @${KW_EXPECT}   ` })
    expect(result.decision).toBe("deny")
  })

  test("blocks bare directive in .tsx file", async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `// @${KW_EXPECT}\nreturn <div />`,
    })
    expect(result.decision).toBe("deny")
  })

  test("blocks bare directive via content fallback", async () => {
    const result = await runHook({ content: `// @${KW_EXPECT}` })
    expect(result.decision).toBe("deny")
  })
})

// ─── @ts-expect-error: documented form allowed ───────────────────────────────

describe(`pretooluse-no-ts-ignore: @${KW_EXPECT} with description is allowed`, () => {
  test("allows colon-prefixed description", async () => {
    const result = await runHook({
      newString: `// @${KW_EXPECT}: upstream pkg has wrong return type\nconst x: string = getStr()`,
    })
    expect(result.decision).toBe("allow")
  })

  test("allows description without colon", async () => {
    const result = await runHook({
      newString: `// @${KW_EXPECT} broken third-party types\nconst x = badLib()`,
    })
    expect(result.decision).toBe("allow")
  })

  test("allows description in .tsx file", async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `// @${KW_EXPECT}: missing overload in @types/react\nreturn <div />`,
    })
    expect(result.decision).toBe("allow")
  })

  test("allows multiple documented suppressions in one file", async () => {
    const result = await runHook({
      newString: [
        `// @${KW_EXPECT}: reason one`,
        `const a: string = 1`,
        `// @${KW_EXPECT}: reason two`,
        `const b: number = "x"`,
      ].join("\n"),
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── Non-TypeScript file passthrough ─────────────────────────────────────────

describe("pretooluse-no-ts-ignore: non-TS files pass through silently", () => {
  test("ignores .js files (no decision emitted)", async () => {
    const result = await runHook({
      filePath: "src/app.js",
      newString: `// @${KW_IGNORE}`,
    })
    expect(result.decision).toBeUndefined()
  })

  test("ignores .json files", async () => {
    const result = await runHook({
      filePath: "config.json",
      newString: `// @${KW_IGNORE}`,
    })
    expect(result.decision).toBeUndefined()
  })

  test("ignores .sh files", async () => {
    const result = await runHook({
      filePath: "scripts/setup.sh",
      newString: `# @${KW_IGNORE}`,
    })
    expect(result.decision).toBeUndefined()
  })

  test("ignores .md files", async () => {
    const result = await runHook({
      filePath: "README.md",
      newString: `Use the directive to suppress errors.`,
    })
    expect(result.decision).toBeUndefined()
  })
})

// ─── Clean TypeScript content allowed ────────────────────────────────────────

describe("pretooluse-no-ts-ignore: clean TS content is allowed", () => {
  test("allows normal TypeScript code", async () => {
    const result = await runHook({
      newString: "export function greet(name: string): string {\n  return `Hello ${name}`\n}",
    })
    expect(result.decision).toBe("allow")
  })

  test("allows directive keyword in a string literal (not a comment)", async () => {
    const result = await runHook({
      newString: `const msg = "do not use the suppress directive in production"`,
    })
    expect(result.decision).toBe("allow")
  })

  test("allows Write tool (not just Edit)", async () => {
    const result = await runHook({
      toolName: "Write",
      content: "export const x = 1",
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── Whitespace variants ──────────────────────────────────────────────────────

describe("pretooluse-no-ts-ignore: unusual whitespace is caught", () => {
  test(`tab between // and @${KW_IGNORE} is blocked`, async () => {
    const result = await runHook({ newString: `//\t@${KW_IGNORE}` })
    expect(result.decision).toBe("deny")
  })

  test(`tab between // and @${KW_EXPECT} (bare) is blocked`, async () => {
    const result = await runHook({ newString: `//\t@${KW_EXPECT}` })
    expect(result.decision).toBe("deny")
  })

  test(`mixed tab+space before @${KW_IGNORE} is blocked`, async () => {
    const result = await runHook({ newString: `// \t @${KW_IGNORE}` })
    expect(result.decision).toBe("deny")
  })

  test(`@${KW_EXPECT} with CRLF line ending (bare) is blocked`, async () => {
    // \r is matched by \s*, so the bare check still fires
    const result = await runHook({ newString: `// @${KW_EXPECT}\r\nconst x = 1` })
    expect(result.decision).toBe("deny")
  })

  test(`@${KW_EXPECT} with trailing tab (bare) is blocked`, async () => {
    const result = await runHook({ newString: `// @${KW_EXPECT}\t` })
    expect(result.decision).toBe("deny")
  })

  test(`@${KW_EXPECT} with description survives CRLF`, async () => {
    const result = await runHook({
      newString: `// @${KW_EXPECT}: upstream types wrong\r\nconst x = 1`,
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── Inline trailing comments ─────────────────────────────────────────────────

describe("pretooluse-no-ts-ignore: inline trailing comments are caught", () => {
  test(`inline trailing @${KW_IGNORE} after code is blocked`, async () => {
    const result = await runHook({ newString: `const x: string = 1 // @${KW_IGNORE}` })
    expect(result.decision).toBe("deny")
  })

  test(`inline trailing bare @${KW_EXPECT} after code is blocked`, async () => {
    const result = await runHook({ newString: `const x: string = 1 // @${KW_EXPECT}` })
    expect(result.decision).toBe("deny")
  })

  test(`inline trailing @${KW_EXPECT} with description is allowed`, async () => {
    const result = await runHook({
      newString: `const x: string = 1 // @${KW_EXPECT}: bad lib types`,
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── JSX / TSX block comment variants ────────────────────────────────────────

describe(`pretooluse-no-ts-ignore: JSX block comments in .tsx are caught`, () => {
  test(`JSX comment {/* @${KW_IGNORE} */} is blocked`, async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `{/* @${KW_IGNORE} */}\nreturn <div />`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`JSX bare @${KW_EXPECT} block comment is blocked`, async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `{/* @${KW_EXPECT} */}\nreturn <div />`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`JSX @${KW_EXPECT} with description is allowed`, async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `{/* @${KW_EXPECT}: missing JSX overload */}\nreturn <div />`,
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── Mixed directive edge cases ───────────────────────────────────────────────

describe("pretooluse-no-ts-ignore: mixed directives in one file", () => {
  test(`@${KW_IGNORE} alongside documented @${KW_EXPECT} still denies`, async () => {
    // ts-ignore must be caught even if a valid ts-expect-error is also present
    const result = await runHook({
      newString: [
        `// @${KW_IGNORE}`,
        `const a: string = 1`,
        `// @${KW_EXPECT}: valid reason`,
        `const b: number = "x"`,
      ].join("\n"),
    })
    expect(result.decision).toBe("deny")
  })

  test(`two bare @${KW_EXPECT} directives are both caught`, async () => {
    const result = await runHook({
      newString: [`// @${KW_EXPECT}`, `const a = 1`, `// @${KW_EXPECT}`, `const b = 2`].join("\n"),
    })
    expect(result.decision).toBe("deny")
  })

  test(`directive keyword in a URL path is not a false positive`, async () => {
    // URL contains the token but is not preceded directly by // with only whitespace
    const result = await runHook({
      newString: `// See https://github.com/issues/@${KW_IGNORE}-workaround for context`,
    })
    // "// See https://..." — after // there is " See", not @ts-expect-error immediately
    expect(result.decision).toBe("allow")
  })

  test(`@${KW_EXPECT} with only a colon (no text) is currently allowed`, async () => {
    // Documents current behaviour: a lone ":" satisfies the non-whitespace check.
    // If this should be tightened, update the hook regex and flip to "deny".
    const result = await runHook({ newString: `// @${KW_EXPECT}:` })
    expect(result.decision).toBe("allow")
  })
})
