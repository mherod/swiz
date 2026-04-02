import { describe, expect, test } from "bun:test"
import { runFileEditHook } from "../src/utils/test-utils.ts"
import { countTodoMarkers } from "./pretooluse-todo-tracker.ts"

// ─── Unit tests for countTodoMarkers ─────────────────────────────────────────

describe("countTodoMarkers: counts comment-context debt markers", () => {
  test("counts // " + "TODO comment", () => {
    expect(countTodoMarkers("// " + "TODO: fix this")).toBe(1)
  })

  test("counts // " + "FIXME comment", () => {
    expect(countTodoMarkers("// " + "FIXME: bad code")).toBe(1)
  })

  test("counts // " + "HACK comment", () => {
    expect(countTodoMarkers("// " + "HACK: workaround")).toBe(1)
  })

  test("counts // " + "XXX comment", () => {
    expect(countTodoMarkers("// " + "XXX: watch out")).toBe(1)
  })

  test("counts // " + "WORKAROUND comment", () => {
    // Split to avoid triggering the hook when editing this test file
    expect(countTodoMarkers("// " + "WORKAROUND: temp fix")).toBe(1)
  })

  test("counts /* " + "TODO */ block comment", () => {
    expect(countTodoMarkers("/* " + "TODO: refactor */")).toBe(1)
  })

  test("counts # " + "TODO in Python/shell comment style", () => {
    expect(countTodoMarkers("# " + "TODO: fix later")).toBe(1)
  })

  test("does NOT count " + "TODO in plain string (no comment marker)", () => {
    expect(countTodoMarkers('const msg = "' + 'TODO: handle error"')).toBe(0)
  })

  test("does NOT count " + "TODO in regex literal (line starts with /)", () => {
    expect(countTodoMarkers("/" + "TODO/")).toBe(0)
  })

  test("does NOT count " + "TODO in variable name", () => {
    expect(countTodoMarkers("const todoList = []")).toBe(0)
  })

  test("counts multiple markers across lines", () => {
    const content = ["// " + "TODO: fix this", "// " + "FIXME: and this", "const x = 1"].join("\n")
    expect(countTodoMarkers(content)).toBe(2)
  })

  test("is case-insensitive", () => {
    expect(countTodoMarkers("// " + "todo: lowercase")).toBe(1)
    expect(countTodoMarkers("// " + "Todo: mixed")).toBe(1)
  })
})

// ─── Hook runner ─────────────────────────────────────────────────────────────

const HOOK = "hooks/pretooluse-todo-tracker.ts"

async function runHook(opts: {
  filePath?: string
  newString?: string
  oldString?: string
  content?: string
  toolName?: string
}) {
  return await runFileEditHook(HOOK, opts)
}

// ─── Integration tests ────────────────────────────────────────────────────────

describe("pretooluse-todo-tracker: blocks net-new debt markers", () => {
  test("blocks new // " + "TODO comment in source file", async () => {
    const result = await runHook({ newString: "// " + "TODO: fix this" })
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("TO" + "DO")
  })

  test("blocks new // " + "FIXME comment", async () => {
    const result = await runHook({ newString: "// " + "FIXME: broken" })
    expect(result.decision).toBe("deny")
  })

  test("blocks new // " + "HACK comment", async () => {
    const result = await runHook({ newString: "// " + "HACK: temp" })
    expect(result.decision).toBe("deny")
  })

  test("blocks new // " + "XXX comment", async () => {
    const result = await runHook({ newString: "// " + "XXX: review" })
    expect(result.decision).toBe("deny")
  })

  test("blocks via content field (Write tool)", async () => {
    const result = await runHook({
      toolName: "Write",
      content: "// " + "TODO: rewrite",
    })
    expect(result.decision).toBe("deny")
  })

  test("allows when " + "TODO was already in old_string (delta = 0)", async () => {
    const result = await runHook({
      oldString: "// " + "TODO: existing marker",
      newString: "// " + "TODO: existing marker\nconst x = 1",
    })
    expect(result.decision).toBe("allow")
  })

  test("blocks when new content has more markers than old", async () => {
    const result = await runHook({
      oldString: "// " + "TODO: one",
      newString: "// " + "TODO: one\n// " + "FIXME: two",
    })
    expect(result.decision).toBe("deny")
  })

  test("allows when removing a marker (delta negative)", async () => {
    const result = await runHook({
      oldString: "// " + "TODO: old\n// " + "FIXME: also old",
      newString: "// " + "TODO: old",
    })
    expect(result.decision).toBe("allow")
  })
})

describe("pretooluse-todo-tracker: allowlisted paths are exempt", () => {
  test("allows edits to hook source files (excluded by EXCLUDE_PATH_RE)", async () => {
    const result = await runHook({
      filePath: "hooks/stop-todo-tracker.ts",
      newString: "// " + "TODO: improve detection",
    })
    expect(result.decision).toBe("allow")
  })

  test("allows edits to test files (TEST_FILE_RE)", async () => {
    const result = await runHook({
      filePath: "src/utils.test.ts",
      newString: "// " + "TODO: add more test cases",
    })
    expect(result.decision).toBe("allow")
  })

  test("allows edits to non-source files (no recognised extension)", async () => {
    const result = await runHook({
      filePath: "docs/notes.md",
      newString: "TO" + "DO: document this",
    })
    expect(result.decision).toBe("allow")
  })

  test("allows edits to generated files (GENERATED_FILE_RE)", async () => {
    const result = await runHook({
      filePath: "dist/app.min.js",
      newString: "// " + "TODO: minified comment",
    })
    expect(result.decision).toBe("allow")
  })

  test("allows edits to node_modules (EXCLUDE_PATH_RE)", async () => {
    const result = await runHook({
      filePath: "node_modules/lib/index.ts",
      newString: "// " + "TODO: upstream fix",
    })
    expect(result.decision).toBe("allow")
  })
})

describe("pretooluse-todo-tracker: false positive prevention", () => {
  test("allows " + "TODO in a string literal (no comment marker)", async () => {
    const result = await runHook({ newString: 'const msg = "' + 'TODO: handle error"' })
    expect(result.decision).toBe("allow")
  })

  test("allows " + "TODO in a regex literal (starts with /)", async () => {
    const result = await runHook({ newString: "/" + "TODO/" })
    expect(result.decision).toBe("allow")
  })

  test("allows " + "TODO as part of a variable name", async () => {
    const result = await runHook({ newString: "const todoList = []" })
    expect(result.decision).toBe("allow")
  })

  test("allows clean source code with no markers", async () => {
    const result = await runHook({
      newString: "export function greet(name: string) {\n  return `Hello ${name}`\n}",
    })
    expect(result.decision).toBe("allow")
  })
})

describe("pretooluse-todo-tracker: NFKC normalization bypass prevention", () => {
  // U+FF0F FULLWIDTH SOLIDUS → NFKC normalizes to /
  const FW_SLASH = String.fromCodePoint(0xff0f)

  test("blocks " + "TODO with fullwidth // comment prefix (NFKC → //)", async () => {
    const result = await runHook({
      newString: `${FW_SLASH}${FW_SLASH} ` + "TODO: sneaky",
    })
    expect(result.decision).toBe("deny")
  })
})
