import { describe, expect, test } from "bun:test"

// Keywords split to avoid self-triggering the hook when this file is edited.
const KW_IGNORE = ["ts", "ignore"].join("-")
const KW_EXPECT = ["ts", "expect", "error"].join("-")

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
  toolName?: string
}): Promise<HookResult> {
  const payload = JSON.stringify({
    tool_name: opts.toolName ?? "Edit",
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

// ─── @ts-ignore blocking ──────────────────────────────────────────────────────

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
