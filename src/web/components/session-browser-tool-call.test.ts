import { describe, expect, test } from "bun:test"
import { inferWrappedToolPresentation } from "./session-browser-utils.ts"

describe("inferWrappedToolPresentation", () => {
  test("recognizes one direct update_plan call inside an exec wrapper", () => {
    const code = [
      "const r = await tools.update_plan({",
      '  explanation: "Plan the work",',
      '  plan: [{ step: "Inspect", status: "in_progress" }],',
      "});",
      "text(r);",
    ].join("\n")

    expect(inferWrappedToolPresentation(code)).toEqual({
      name: "update_plan",
      category: "task",
    })
  })

  test("ignores quoted and commented tool-call examples", () => {
    const code = [
      'const example = "await tools.update_plan({ plan: [] })";',
      "// const r = await tools.update_plan({ plan: [] });",
      "text(example);",
    ].join("\n")

    expect(inferWrappedToolPresentation(code)).toBeNull()
  })

  test("keeps multi-tool wrappers classified as exec", () => {
    const code = [
      "const first = await tools.update_plan({ plan: [] });",
      'const second = await tools.exec_command({ cmd: "git status" });',
      "text(first);",
      "text(second);",
    ].join("\n")

    expect(inferWrappedToolPresentation(code)).toBeNull()
  })
})
