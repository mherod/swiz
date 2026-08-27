import { describe, expect, test } from "bun:test"
import {
  inferShellReadPresentation,
  inferWrappedToolPresentation,
} from "./session-browser-utils.ts"

describe("inferShellReadPresentation", () => {
  test("recognizes a skill definition read from a direct shell command", () => {
    const path = "/Users/example/.agents/skills/morning-standup/SKILL.md"

    expect(inferShellReadPresentation(`cat ${path}`)).toEqual({
      name: "Skill read",
      category: "skill",
      path,
      summary: "morning-standup",
    })
  })

  test("recognizes a memory read inside an exec_command wrapper", () => {
    const path = "/Users/example/.codex/memories/rollout_summaries/2026-08-26-example.md"
    const code = `const result = await tools.exec_command({cmd:"cat ${path}"});text(result)`

    expect(inferShellReadPresentation(code)).toEqual({
      name: "Memory read",
      category: "file",
      path,
      summary: "rollout_summaries/2026-08-26-example.md",
    })
  })

  test("recognizes quoted skill paths", () => {
    expect(
      inferShellReadPresentation('cat "/Users/example/.codex/skills/commit/SKILL.md"')
    ).toEqual({
      name: "Skill read",
      category: "skill",
      path: "/Users/example/.codex/skills/commit/SKILL.md",
      summary: "commit",
    })
  })

  test("leaves ordinary file reads and compound commands classified as exec", () => {
    expect(inferShellReadPresentation("cat /repo/README.md")).toBeNull()
    expect(
      inferShellReadPresentation("cat /Users/example/.agents/skills/commit/SKILL.md; git status")
    ).toBeNull()
    expect(
      inferShellReadPresentation("cat /Users/example/.codex/memories/MEMORY.md | head")
    ).toBeNull()
  })
})

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
