import { describe, expect, test } from "bun:test"

// The keyword is split to avoid triggering the hook we are testing.
// The hook itself uses the same technique: ["eslint", "disable"].join("-")
const KW = ["eslint", "disable"].join("-")

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

  const proc = Bun.spawn(["bun", "hooks/pretooluse-no-eslint-disable.ts"], {
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("pretooluse-no-eslint-disable: comment spacing variants", () => {
  test("blocks standard format: // KW-next-line", async () => {
    const result = await runHook({ newString: `// ${KW}-next-line no-console\nconsole.log('x');` })
    expect(result.decision).toBe("deny")
  })

  test("blocks with no space after //: //KW", async () => {
    const result = await runHook({ newString: `//${KW} no-console` })
    expect(result.decision).toBe("deny")
  })

  test("blocks with multiple spaces: //  KW", async () => {
    const result = await runHook({ newString: `//  ${KW}-next-line` })
    expect(result.decision).toBe("deny")
  })

  test("blocks block comment: /* KW */", async () => {
    const result = await runHook({ newString: `/* ${KW} no-console */` })
    expect(result.decision).toBe("deny")
  })

  test("blocks block comment with no space: /*KW*/", async () => {
    const result = await runHook({ newString: `/*${KW}*/` })
    expect(result.decision).toBe("deny")
  })

  test("allows clean TypeScript content", async () => {
    const result = await runHook({
      newString: "export function greet(name: string) {\n  return `Hello ${name}`;\n}",
    })
    expect(result.decision).toBe("allow")
  })

  test("allows KW in a string literal (not preceded by comment marker)", async () => {
    const result = await runHook({ newString: `const msg = "${KW} is forbidden";` })
    expect(result.decision).toBe("allow")
  })

  test("allows KW in a non-TS file (exits silently)", async () => {
    const result = await runHook({
      filePath: "src/config.json",
      newString: `// ${KW} no-console`,
    })
    expect(result.decision).toBeUndefined()
  })

  test("allows KW in a .js file (only .ts/.tsx are checked)", async () => {
    const result = await runHook({
      filePath: "src/app.js",
      newString: `// ${KW}-next-line no-console`,
    })
    expect(result.decision).toBeUndefined()
  })

  test("checks content field as fallback when new_string is absent", async () => {
    const result = await runHook({ content: `// ${KW} no-console` })
    expect(result.decision).toBe("deny")
  })

  test("blocks in .tsx files", async () => {
    const result = await runHook({
      filePath: "src/App.tsx",
      newString: `// ${KW}-next-line react/prop-types`,
    })
    expect(result.decision).toBe("deny")
  })
})

// ─── NFKC homoglyph bypass prevention ──────────────────────────────────────

describe("pretooluse-no-eslint-disable: NFKC homoglyph bypass", () => {
  // U+FF0F FULLWIDTH SOLIDUS → NFKC normalizes to /
  const FW_SLASH = String.fromCodePoint(0xff0f)

  test("blocks fullwidth // comment prefix (NFKC → //)", async () => {
    const result = await runHook({
      newString: `${FW_SLASH}${FW_SLASH} ${KW} no-console`,
    })
    expect(result.decision).toBe("deny")
  })

  // U+FF0A FULLWIDTH ASTERISK → NFKC normalizes to *
  const FW_STAR = String.fromCodePoint(0xff0a)

  test("blocks fullwidth /* comment prefix (NFKC → /*)", async () => {
    const result = await runHook({
      newString: `/${FW_STAR} ${KW} no-console ${FW_STAR}/`,
    })
    expect(result.decision).toBe("deny")
  })
})
