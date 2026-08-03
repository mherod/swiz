import { describe, expect, test } from "bun:test"
import { evaluateGateRequiredSkills } from "./gate-required-skills.ts"

describe("gate-required skills doctor check", () => {
  test("passes when every registered skill resolves", () => {
    const result = evaluateGateRequiredSkills(() => true)

    expect(result).toEqual({
      name: "Gate-required skills",
      status: "pass",
      detail: "all 16 fail-open gate requirements resolve to installed skills",
    })
  })

  test("reports every missing skill with its owning hook", () => {
    const missing = new Set(["push", "apply-rsc"])
    const result = evaluateGateRequiredSkills((name) => !missing.has(name))

    expect(result.status).toBe("warn")
    expect(result.detail).toContain("push (pretooluse-skill-invocation-gate)")
    expect(result.detail).toContain("apply-rsc (pretooluse-apply-rsc-gate)")
    expect(result.detail).toContain("install each skill or remove its owning gate rule")
    expect(result.detail).not.toContain("commit (pretooluse-skill-invocation-gate)")
  })
})
