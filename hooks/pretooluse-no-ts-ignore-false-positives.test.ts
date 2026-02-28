// False-positive regression suite for pretooluse-no-ts-ignore.
//
// Verifies that directive-like strings appearing in NON-DIRECTIVE comment
// contexts are correctly allowed — i.e. cases where TypeScript's parser would
// never treat the text as a suppression directive.
//
// Two categories of false-positive context are tested:
//
//   A) Block-comment syntax inside a line comment
//      A `//` line comment can contain text that looks like `/*@directive*/`.
//      TypeScript never sees the `/*` as a block-comment opener because the
//      line comment starts first.  The hook must NOT block these.
//
//   B) Inline `//` that precedes a block-comment-like string on the same line
//      When `//` appears before `/*` on the same line, everything from `//`
//      onward is a line comment.  Again, TypeScript does not treat the `/*`
//      as a block-comment opener and the hook must not block it.
//
// Denial regression guards are also included to confirm that real directives
// (actual block comments and line comments with no preceding non-whitespace
// text) are still blocked after the fix.
//
// Keywords are split across array joins to prevent the hook from triggering
// on this test file itself when it is written or edited.

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

async function runHook(opts: { filePath?: string; newString: string }): Promise<HookResult> {
  const payload = JSON.stringify({
    tool_name: "Edit",
    tool_input: {
      file_path: opts.filePath ?? "src/app.ts",
      new_string: opts.newString,
    },
  })

  const proc = Bun.spawn(["bun", "hooks/pretooluse-no-ts-ignore.ts"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(payload)
  proc.stdin.end()

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

// ─── GROUP A: block-comment syntax inside a line comment ─────────────────────
//
// The entire content of each test string IS a // line comment.
// TypeScript never parses these as real block-comment directives.
// The hook must allow all of them.

describe(`pretooluse-no-ts-ignore: block-comment directive text inside // comment`, () => {
  test(`@${KW_IGNORE} in /*...*/ syntax inside // comment is allowed`, async () => {
    const result = await runHook({
      newString: `// see docs: /*@${KW_IGNORE}*/ silences the next line`,
    })
    expect(result.decision).toBe("allow")
  })

  test(`spaced /*  @${KW_IGNORE}  */ inside // comment is allowed`, async () => {
    const result = await runHook({
      newString: `// example: /*  @${KW_IGNORE}  */ with extra spaces`,
    })
    expect(result.decision).toBe("allow")
  })

  test(`@${KW_NOCHECK} in /*...*/ syntax inside // comment is allowed`, async () => {
    const result = await runHook({
      newString: `// the /*@${KW_NOCHECK}*/ form disables all type checking`,
    })
    expect(result.decision).toBe("allow")
  })

  test(`bare /*@${KW_EXPECT}*/ inside // comment is allowed`, async () => {
    const result = await runHook({
      newString: `// without description: /*@${KW_EXPECT}*/ is also blocked`,
    })
    expect(result.decision).toBe("allow")
  })

  test(`multiple block-comment examples inside // comment are allowed`, async () => {
    const result = await runHook({
      newString: `// forms: /*@${KW_IGNORE}*/ /* @${KW_NOCHECK} */ /* @${KW_EXPECT} */`,
    })
    expect(result.decision).toBe("allow")
  })

  test(`@${KW_IGNORE} block form after // at end of code line is allowed`, async () => {
    // The // appears mid-line after code, and /* appears after it.
    const result = await runHook({
      newString: `const x = getValue(); // suppress with /* @${KW_IGNORE} */ — don't do this`,
    })
    expect(result.decision).toBe("allow")
  })

  test(`@${KW_NOCHECK} block form after // at end of code line is allowed`, async () => {
    const result = await runHook({
      newString: `export {}; // note: /* @${KW_NOCHECK} */ disables whole file`,
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── GROUP B: // before /* on the same non-comment line ──────────────────────
//
// Code lines where // appears before /* — TypeScript treats // as opening a
// line comment, so everything after it (including /*) is comment text.

describe(`pretooluse-no-ts-ignore: // precedes /* on same code line`, () => {
  test(`inline // before /* @${KW_IGNORE} */ is allowed`, async () => {
    const result = await runHook({
      newString: `const fn = () => doWork(); // docs: /* @${KW_IGNORE} */ usage`,
    })
    expect(result.decision).toBe("allow")
  })

  test(`inline // before bare /* @${KW_EXPECT} */ is allowed`, async () => {
    const result = await runHook({
      newString: `return result; // never do: /* @${KW_EXPECT} */ without description`,
    })
    expect(result.decision).toBe("allow")
  })
})

// ─── GROUP C: denial regression guards ───────────────────────────────────────
//
// Real directives must still be blocked after the fix.
// These cases confirm the fix did not over-relax the hook.

describe(`pretooluse-no-ts-ignore: real directives are still denied after fix`, () => {
  test(`real /* @${KW_IGNORE} */ block comment on its own is denied`, async () => {
    const result = await runHook({
      newString: `/* @${KW_IGNORE} */\nconst x: string = 1`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`real /* @${KW_NOCHECK} */ is denied`, async () => {
    const result = await runHook({
      newString: `/* @${KW_NOCHECK} */\nexport const x = 1`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`real bare /* @${KW_EXPECT} */ is denied`, async () => {
    const result = await runHook({
      newString: `/* @${KW_EXPECT} */\nconst x: string = 1`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`/* @${KW_IGNORE} */ after code with no // is denied`, async () => {
    const result = await runHook({
      newString: `doWork(); /* @${KW_IGNORE} */\nconst x: string = 1`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`cross-line block comment /*\\n@${KW_IGNORE} is denied (conservative)`, async () => {
    const result = await runHook({
      newString: `/*\n@${KW_IGNORE}\n*/\nconst x: string = 1`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`// @${KW_IGNORE} line comment is still denied`, async () => {
    const result = await runHook({
      newString: `// @${KW_IGNORE}\nconst x: string = 1`,
    })
    expect(result.decision).toBe("deny")
  })

  test(`// @${KW_NOCHECK} line comment is still denied`, async () => {
    const result = await runHook({
      newString: `// @${KW_NOCHECK}\nexport const x = 1`,
    })
    expect(result.decision).toBe("deny")
  })
})
