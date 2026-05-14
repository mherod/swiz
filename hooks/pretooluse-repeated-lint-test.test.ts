import { describe, expect, test } from "bun:test"
import { classifyCommand, detectOverfiltering } from "./pretooluse-repeated-lint-test.ts"

describe("classifyCommand — quoted body content isolation", () => {
  test("does not classify gh issue create --body with embedded test command as test", () => {
    expect(classifyCommand(`gh issue create --body "bun test --reporter=dots"`)).toBeNull()
  })

  test("does not classify gh issue create --body with embedded lint command as lint", () => {
    expect(classifyCommand(`gh issue create --body "run bun run lint to verify"`)).toBeNull()
  })

  test("does not classify gh issue create --body with embedded build command as build", () => {
    expect(classifyCommand(`gh issue create --body "pnpm run build confirms the fix"`)).toBeNull()
  })

  test("does not classify gh issue create --body with single-quoted body as test", () => {
    expect(classifyCommand(`gh issue create --body 'bun test --concurrent'`)).toBeNull()
  })

  test("does not classify gh pr comment with embedded test mention as test", () => {
    expect(
      classifyCommand(`gh pr comment 123 --body "acceptance: run bun test and verify"`)
    ).toBeNull()
  })
})

describe("classifyCommand — real commands still classified correctly", () => {
  test("classifies bun test as test", () => {
    expect(classifyCommand("bun test")).toBe("test")
  })

  test("classifies bun run test as test", () => {
    expect(classifyCommand("bun run test")).toBe("test")
  })

  test("classifies pnpm run lint as lint", () => {
    expect(classifyCommand("pnpm run lint")).toBe("lint")
  })

  test("classifies bun run typecheck as typecheck", () => {
    expect(classifyCommand("bun run typecheck")).toBe("typecheck")
  })

  test("classifies bun run build as build", () => {
    expect(classifyCommand("bun run build")).toBe("build")
  })
})

describe("detectOverfiltering — quoted pipe characters do not trigger false positives", () => {
  test("does not fire for gh command body containing pipe characters", () => {
    // classifyCommand would return null for this gh command, so detectOverfiltering
    // would not be reached in practice — but confirm it returns null when called directly
    // with a kind and a command whose pipe is inside a quoted body.
    const cmd = `gh issue create --body "pipe foo | tail -1 strips context" | cat`
    // When called with an actual kind (simulating a scenario where classification
    // somehow returned a kind), the pipe check fires on the real outer pipe, not the
    // body-embedded one.  The outer `| cat` does not match tail/head/grep patterns.
    expect(detectOverfiltering(cmd, "test")).toBeNull()
  })

  test("still fires for a real test command piped through tail with too few lines", () => {
    expect(detectOverfiltering("bun test | tail -3", "test")).not.toBeNull()
  })

  test("still fires for a real lint command piped through head with too few lines", () => {
    expect(detectOverfiltering("pnpm run lint | head -5", "lint")).not.toBeNull()
  })

  test("allows test commands piped through tail with sufficient lines", () => {
    expect(detectOverfiltering("bun test | tail -15", "test")).toBeNull()
  })
})
