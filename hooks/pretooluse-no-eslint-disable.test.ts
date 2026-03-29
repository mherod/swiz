import { describe, expect, test } from "bun:test"
import { runFileEditHook } from "../src/utils/test-utils.ts"

// The keyword is split to avoid triggering the hook we are testing.
// The hook itself uses the same technique: ["eslint", "disable"].join("-")
const KW = ["eslint", "disable"].join("-")
const BIOME_KW = ["biome", "ignore"].join("-")
const OXLINT_KW = ["oxlint", "disable"].join("-")
const DENO_LINT_IGNORE_KW = ["deno", "lint", "ignore"].join("-")
const DENO_LINT_IGNORE_FILE_KW = ["deno", "lint", "ignore", "file"].join("-")
const STYLELINT_KW = ["stylelint", "disable"].join("-")
const MARKDOWNLINT_KW = ["markdownlint", "disable"].join("-")

const HOOK = "hooks/pretooluse-ts-quality.ts"

function runHook(opts: {
  filePath?: string
  newString?: string
  content?: string
  toolName?: string
}) {
  return runFileEditHook(HOOK, opts)
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

  test("blocks biome line comment disable", async () => {
    const result = await runHook({ newString: `// ${BIOME_KW} lint/suspicious/noExplicitAny` })
    expect(result.decision).toBe("deny")
  })

  test("blocks biome block comment disable", async () => {
    const result = await runHook({ newString: `/* ${BIOME_KW} lint/suspicious/noExplicitAny */` })
    expect(result.decision).toBe("deny")
  })

  test("allows biome keyword in string literal", async () => {
    const result = await runHook({ newString: `const msg = "${BIOME_KW}";` })
    expect(result.decision).toBe("allow")
  })

  test("blocks oxlint disable comment", async () => {
    const result = await runHook({ newString: `// ${OXLINT_KW}-next-line no-console` })
    expect(result.decision).toBe("deny")
  })

  test("blocks deno lint ignore comment", async () => {
    const result = await runHook({ newString: `// ${DENO_LINT_IGNORE_KW} no-explicit-any` })
    expect(result.decision).toBe("deny")
  })

  test("blocks deno lint ignore file comment", async () => {
    const result = await runHook({ newString: `// ${DENO_LINT_IGNORE_FILE_KW}` })
    expect(result.decision).toBe("deny")
  })

  test("blocks stylelint disable comment", async () => {
    const result = await runHook({ newString: `/* ${STYLELINT_KW} no-descending-specificity */` })
    expect(result.decision).toBe("deny")
  })

  test("blocks markdownlint disable comment", async () => {
    const result = await runHook({ newString: `// ${MARKDOWNLINT_KW}-next-line MD013` })
    expect(result.decision).toBe("deny")
  })

  test("blocks tslint:disable comment", async () => {
    const result = await runHook({ newString: "// tslint:disable:semicolon" })
    expect(result.decision).toBe("deny")
  })

  test("blocks pylint disable comment", async () => {
    const result = await runHook({ newString: "// pylint: disable=unused-variable" })
    expect(result.decision).toBe("deny")
  })

  test("includes matched suppression pattern in deny reason", async () => {
    const result = await runHook({ newString: `// ${STYLELINT_KW} no-descending-specificity` })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain(
      `Matched forbidden lint suppression pattern: \`${STYLELINT_KW}\``
    )
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
