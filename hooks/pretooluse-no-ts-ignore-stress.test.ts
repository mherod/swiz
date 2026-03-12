/**
 * Stress-test regression suite for pretooluse-no-ts-ignore.
 *
 * Covers multiline block comments, nested JSX, @ts-nocheck, malformed/unclosed
 * blocks, template-literal behaviour, and documents known regex limitations.
 *
 * Keywords are split across array joins to prevent the hook from triggering on
 * this test file itself when it is written or edited.
 */

import { describe, expect, test } from "bun:test"

const KW_IGNORE = ["ts", "ignore"].join("-")
const KW_EXPECT = ["ts", "expect", "error"].join("-")
const KW_NOCHECK = ["ts", "nocheck"].join("-")

// ─── Hook runner ─────────────────────────────────────────────────────────────

interface HookResult {
  decision?: string
  reason?: string
  rawOutput: string
}

async function runHook(opts: {
  filePath?: string
  newString?: string
  content?: string
}): Promise<HookResult> {
  const payload = JSON.stringify({
    tool_name: "Edit",
    tool_input: {
      file_path: opts.filePath ?? "src/app.ts",
      new_string: opts.newString,
      content: opts.content,
    },
  })

  const proc = Bun.spawn(["bun", "hooks/pretooluse-no-ts-ignore.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  void proc.stdin.write(payload)
  void proc.stdin.end()

  const rawOutput = await new Response(proc.stdout).text()
  await proc.exited

  if (!rawOutput.trim()) return { rawOutput }
  try {
    const parsed = JSON.parse(rawOutput.trim())
    const hso = parsed.hookSpecificOutput
    return {
      decision: hso?.permissionDecision ?? parsed.decision,
      reason: hso?.permissionDecisionReason ?? parsed.reason,
      rawOutput,
    }
  } catch {
    return { rawOutput }
  }
}

// ─── @ts-nocheck blocking ─────────────────────────────────────────────────────

describe(`pretooluse-no-ts-ignore: @${KW_NOCHECK} is always blocked`, () => {
  test("blocks line comment at top of file", async () => {
    const result = await runHook({
      newString: `// @${KW_NOCHECK}\n\nexport const x: string = 1`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`blocks block comment form`, async () => {
    const result = await runHook({ newString: `/* @${KW_NOCHECK} */\nexport const x = 1` })
    expect(result.decision).toBe("deny")
  })

  test("blocks with no space after //", async () => {
    const result = await runHook({ newString: `//@${KW_NOCHECK}` })
    expect(result.decision).toBe("deny")
  })

  test("blocks with tab whitespace", async () => {
    const result = await runHook({ newString: `//\t@${KW_NOCHECK}` })
    expect(result.decision).toBe("deny")
  })

  test("blocks in .tsx file", async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `// @${KW_NOCHECK}\nexport default function App() { return <div /> }`,
    })
    expect(result.decision).toBe("deny")
  })

  test("denial reason names the directive", async () => {
    const result = await runHook({ newString: `// @${KW_NOCHECK}` })
    expect(result.reason).toContain(`@${KW_NOCHECK}`)
  })

  test("does not trigger on .js files (no decision)", async () => {
    const result = await runHook({
      filePath: "src/app.js",
      newString: `// @${KW_NOCHECK}`,
    })
    expect(result.decision).toBeUndefined()
  })

  test("does not false-positive on the word 'nocheck' without @", async () => {
    const result = await runHook({ newString: `// nocheck is not a directive` })
    expect(result.decision).toBe("allow")
  })
})

// ─── Multiline block comment patterns ────────────────────────────────────────

describe("pretooluse-no-ts-ignore: multiline block comments", () => {
  test(`newline right after /* catches @${KW_IGNORE}`, async () => {
    // newline is whitespace — \s* matches it, then directive is caught
    const result = await runHook({ newString: `/*\n@${KW_IGNORE}\n*/` })
    expect(result.decision).toBe("deny")
  })

  test(`bare @${KW_EXPECT} spanning to next line for */ is caught`, async () => {
    // the bare-directive check uses \s*$ which matches end-of-line before \n
    const result = await runHook({ newString: `/* @${KW_EXPECT}\n*/` })
    expect(result.decision).toBe("deny")
  })

  test(`@${KW_EXPECT} with description spanning to next line is allowed`, async () => {
    const result = await runHook({ newString: `/* @${KW_EXPECT}: bad lib\n*/` })
    expect(result.decision).toBe("allow")
  })

  test(`JSDoc " * @${KW_IGNORE}" style is caught`, async () => {
    // [\s*]* in the block-comment branch skips " * " JSDoc line prefixes
    const result = await runHook({ newString: `/**\n * @${KW_IGNORE}\n */\nconst x = 1` })
    expect(result.decision).toBe("deny")
  })

  test(`JSDoc " * @${KW_NOCHECK}" style is caught`, async () => {
    const result = await runHook({ newString: `/**\n * @${KW_NOCHECK}\n */\nexport const x = 1` })
    expect(result.decision).toBe("deny")
  })

  test(`JSDoc bare " * @${KW_EXPECT}" with no description is caught`, async () => {
    const result = await runHook({ newString: `/**\n * @${KW_EXPECT}\n */\nconst x = 1` })
    expect(result.decision).toBe("deny")
  })

  test(`JSDoc " * @${KW_EXPECT}: reason" with description is allowed`, async () => {
    const result = await runHook({
      newString: `/**\n * @${KW_EXPECT}: upstream types wrong\n */\nconst x = badLib()`,
    })
    expect(result.decision).toBe("allow")
  })

  test(`deeply nested JSDoc with @${KW_IGNORE} on second line is caught`, async () => {
    const result = await runHook({
      newString: `/**\n * Some doc\n * @${KW_IGNORE}\n */\nconst x = 1`,
    })
    expect(result.decision).toBe("deny")
  })
})

// ─── Malformed / unclosed block comments ─────────────────────────────────────

describe("pretooluse-no-ts-ignore: malformed and unclosed block comments", () => {
  test(`unclosed block comment /*@${KW_IGNORE} is caught`, async () => {
    // The regex does not require a closing */ — the opening /* is enough
    const result = await runHook({ newString: `/*@${KW_IGNORE}` })
    expect(result.decision).toBe("deny")
  })

  test(`unclosed bare @${KW_EXPECT} block comment is caught`, async () => {
    const result = await runHook({ newString: `/* @${KW_EXPECT}` })
    expect(result.decision).toBe("deny")
  })

  test(`double line comment triggers on the inner //`, async () => {
    // The second // followed by the directive triggers the match
    const result = await runHook({ newString: `// // @${KW_IGNORE}` })
    expect(result.decision).toBe("deny")
  })

  test(`non-whitespace text between /* and directive prevents match`, async () => {
    // e.g. "/* some text, @ts-expect-error */" — \s* stops at 's', no match.
    // TypeScript itself also would not treat this as a suppression comment.
    const result = await runHook({ newString: `/* some text, @${KW_IGNORE} */` })
    expect(result.decision).toBe("allow")
  })
})

// ─── Nested JSX patterns ─────────────────────────────────────────────────────

describe("pretooluse-no-ts-ignore: nested JSX comment patterns", () => {
  test(`JSX suppress-ignore directive with trailing text is still blocked`, async () => {
    // The directive is unconditionally blocked regardless of trailing content
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `{/* @${KW_IGNORE} trailing text is irrelevant */}\nreturn <div />`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`JSX @${KW_NOCHECK} directive is blocked`, async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `{/* @${KW_NOCHECK} */}\nexport default function App() {}`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`JSX bare @${KW_EXPECT} inline is blocked`, async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `<div\n  {/* @${KW_EXPECT} */}\n/>`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`JSX @${KW_EXPECT} with description inline is allowed`, async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `<div\n  {/* @${KW_EXPECT}: missing JSX prop overload */}\n/>`,
    })
    expect(result.decision).toBe("allow")
  })

  test(`deeply nested JSX block with directive is blocked`, async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: [
        "function App() {",
        "  return (",
        "    <Outer>",
        "      <Inner>",
        `        {/* @${KW_IGNORE} */}`,
        "        <Child />",
        "      </Inner>",
        "    </Outer>",
        "  )",
        "}",
      ].join("\n"),
    })
    expect(result.decision).toBe("deny")
  })
})

// ─── Template literal behaviour (conservative blocking) ───────────────────────

describe("pretooluse-no-ts-ignore: template literals containing directives", () => {
  test(`template literal with the line-comment directive form is blocked`, async () => {
    // The hook scans raw text without understanding string/template context.
    // A backtick string that embeds the comment pattern is blocked conservatively.
    // To avoid this, use the split-variable technique in source files.
    const result = await runHook({
      newString: `const example = \`// @${KW_IGNORE}\``,
    })
    expect(result.decision).toBe("deny")
  })

  test(`template literal containing directive without // prefix is allowed`, async () => {
    // No // or /* prefix — the regex does not match
    const result = await runHook({
      newString: `const msg = \`do not use @${KW_IGNORE} in your code\``,
    })
    expect(result.decision).toBe("allow")
  })

  test(`template literal with documented @${KW_EXPECT}: reason is allowed`, async () => {
    const result = await runHook({
      newString: `const doc = \`// @${KW_EXPECT}: reason\` is the correct form`,
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── All three directives coexisting ─────────────────────────────────────────

describe("pretooluse-no-ts-ignore: files with multiple directive types", () => {
  test(`@${KW_NOCHECK} is caught even alongside valid @${KW_EXPECT}`, async () => {
    const result = await runHook({
      newString: [`// @${KW_NOCHECK}`, `// @${KW_EXPECT}: some reason`, "const x = 1"].join("\n"),
    })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain(`@${KW_NOCHECK}`)
  })

  test(`suppress-ignore directive is caught even when valid @${KW_EXPECT} also present`, async () => {
    const result = await runHook({
      newString: [
        `// @${KW_EXPECT}: valid documented suppression`,
        "const a = goodCode()",
        `// @${KW_IGNORE}`,
        "const b: string = 1",
      ].join("\n"),
    })
    expect(result.decision).toBe("deny")
  })

  test("file with only documented suppressions is allowed", async () => {
    const result = await runHook({
      newString: [
        `// @${KW_EXPECT}: upstream types missing overload`,
        "const a = libFn()",
        `// @${KW_EXPECT}: third-party types incorrect`,
        "const b = otherLib()",
      ].join("\n"),
    })
    expect(result.decision).toBe("allow")
  })
})
